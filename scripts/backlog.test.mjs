#!/usr/bin/env node
/**
 * TicketoScope — tests. Zéro dépendance : `node:test` uniquement.
 *
 *   node --test test.mjs
 *
 * Le générateur n'exporte rien (il s'exécute à l'import) : on le teste donc comme on
 * l'utilise, en sous-processus, sur un backlog jetable. C'est plus lent qu'un test
 * unitaire et c'est le bon choix — ça couvre le vrai chemin, arguments compris.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TOOL = fileURLToPath(new URL('./backlog.mjs', import.meta.url));

/** Un backlog jetable. Renvoie sa racine ; les tickets sont dans `<racine>/backlog`. */
function fixture(tickets = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tks-'));
  const dir = join(root, 'backlog');
  mkdirSync(join(dir, 'epics'), { recursive: true });
  for (const [name, content] of Object.entries(tickets)) {
    writeFileSync(join(dir, `${name}.md`), content, 'utf8');
  }
  return root;
}

function run(root, args = []) {
  const r = spawnSync(process.execPath, [TOOL, '--dir', join(root, 'backlog'), '--out', root, ...args],
    { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const index = (root) => readFileSync(join(root, 'BACKLOG.md'), 'utf8');

const TICKET = (id, extra = '', body = '') => `---
id: ${id}
hook: Une phrase de test.
status: todo
priority: P2
${extra}---

${body}
`;

// ─────────────────────────────────────────────── TKS-012 — drapeaux

test('--help affiche l\'usage, sort en 0 et n\'écrit rien', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  run(root);                                   // génération de référence
  const before = index(root);

  const r = run(root, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /node backlog\.mjs --ack/);
  // Le piège historique : --help tombait dans « else generate() » et réécrivait tout.
  assert.equal(index(root), before, 'BACKLOG.md doit être inchangé à l\'octet près');
  rmSync(root, { recursive: true, force: true });
});

test('un drapeau inconnu échoue franchement et n\'écrit rien', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  run(root);
  const before = index(root);

  const r = run(root, ['--zzz']);
  assert.equal(r.code, 1, 'doit sortir en erreur, pas en 0');
  assert.match(r.err, /--zzz/);
  assert.equal(index(root), before, 'BACKLOG.md doit être inchangé à l\'octet près');
  // Et surtout : ne PAS ressembler à un résultat.
  assert.doesNotMatch(r.out, /tickets ·/);
  rmSync(root, { recursive: true, force: true });
});

test('les options à valeur ne sont pas prises pour des drapeaux inconnus', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  const r = run(root, ['--port', '4399']);     // --dir et --out sont déjà passés par run()
  assert.equal(r.code, 0);
  assert.match(r.out, /1 tickets?/);
  rmSync(root, { recursive: true, force: true });
});

test('une note --ack peut commencer par des tirets sans être prise pour un drapeau', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', '', '## Journal\n\n- 💬 2026-07-28 — remarque à instruire'),
  });
  const r = run(root, ['--ack', 'EX-001', '--corrigé en EX-002']);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(join(root, 'backlog', 'EX-001.md'), 'utf8'), /↳ ✓ .* — --corrigé en EX-002/);
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────── TKS-015 — cocher sans navigateur

const ticket = (root, id) => readFileSync(join(root, 'backlog', `${id}.md`), 'utf8');
const ACTION = 'navigateur — Vérifier que le compteur se remplit';

test('--done coche l\'action, --undo la remet — à l\'octet près', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001', `owner: cto\naction: ${ACTION}\n`, 'Le corps.') });
  const before = ticket(root, 'EX-001');

  const d = run(root, ['--done', 'EX-001']);
  assert.equal(d.code, 0, d.err);
  assert.match(ticket(root, 'EX-001'), new RegExp(`- ✅ \\d{4}-\\d{2}-\\d{2} — ${ACTION}`));
  assert.doesNotMatch(ticket(root, 'EX-001'), /^action: /m);

  const u = run(root, ['--undo', 'EX-001']);
  assert.equal(u.code, 0, u.err);
  assert.equal(ticket(root, 'EX-001'), before, 'l\'aller-retour doit être neutre');
  rmSync(root, { recursive: true, force: true });
});

test('--undo consomme le commentaire de l\'entrée, pas seulement sa première ligne', () => {
  // Le piège documenté sur `undoAction` : ne retirer que la ligne « ✅ » laisserait le
  // « > » orphelin, rattaché à l'entrée précédente — c'est-à-dire une FAUSSE trace.
  const root = fixture({ 'EX-001': TICKET('EX-001', `owner: cto\naction: ${ACTION}\n`, 'Le corps.') });
  const before = ticket(root, 'EX-001');

  run(root, ['--done', 'EX-001', 'pas trouvé l\'écran, à revoir']);
  assert.match(ticket(root, 'EX-001'), /\n {2}> pas trouvé l'écran, à revoir/);

  run(root, ['--undo', 'EX-001']);
  assert.equal(ticket(root, 'EX-001'), before, 'aucun commentaire orphelin ne doit rester');
  rmSync(root, { recursive: true, force: true });
});

test('la note de --done est facultative, celle de --ack ne l\'est pas', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001', `owner: cto\naction: ${ACTION}\n`) });
  // Cocher sans commenter est permis sur la page : la ligne de commande dit la même règle.
  assert.equal(run(root, ['--done', 'EX-001']).code, 0);
  assert.equal(run(root, ['--ack', 'EX-001']).code, 1, 'une note d\'accusé vide reste refusée');
  rmSync(root, { recursive: true, force: true });
});

test('--comment écrit une remarque en attente, et refuse un texte vide', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });

  const vide = run(root, ['--comment', 'EX-001', '   ']);
  assert.equal(vide.code, 1);
  assert.match(vide.err, /vide/);

  const ok = run(root, ['--comment', 'EX-001', 'le compteur reste à zéro']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ticket(root, 'EX-001'), /- 💬 \d{4}-\d{2}-\d{2} — le compteur reste à zéro/);
  assert.match(index(root), /Remarques en attente \(1\)/, 'elle naît en attente, comme au clic');
  rmSync(root, { recursive: true, force: true });
});

test('un commentaire qui PARLE d\'un drapeau ne le déclenche pas', () => {
  // `ARGV.includes('--undo')` suffisait tant que les charges utiles étaient des notes.
  // Sur un outil dont le backlog parle de ses propres drapeaux, ça ne suffit plus.
  const root = fixture({ 'EX-001': TICKET('EX-001', `owner: cto\naction: ${ACTION}\n`) });
  const r = run(root, ['--comment', 'EX-001', 'il faudrait un --undo en ligne de commande']);
  assert.equal(r.code, 0, r.err);
  assert.match(ticket(root, 'EX-001'), /- 💬 .* — il faudrait un --undo en ligne de commande/);
  assert.match(ticket(root, 'EX-001'), /^action: /m, 'l\'action ne doit pas avoir bougé');
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────── TKS-011 — remarques en attente

test('une remarque en attente remonte VERBATIM en tête d\'index', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', '', '## Journal\n\n- 💬 2026-07-28 — pas trouvé l\'écran dans le back-office'),
  });
  run(root);
  const md = index(root);

  assert.match(md, /## 💬 Remarques en attente \(1\)/);
  assert.match(md, /\[EX-001\] 💬 2026-07-28 — « pas trouvé l'écran dans le back-office »/);
  // Un compteur seul obligerait à rouvrir le ticket : c'est le coût qu'on supprime.
  assert.match(md, /--ack <ID>/);
  // Avant les actions humaines : une remarque non instruite est ce qui se perd.
  assert.ok(md.indexOf('Remarques en attente') < md.indexOf('## Actifs'));
  rmSync(root, { recursive: true, force: true });
});

test('une remarque accrochée à une action dit à quelle action', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', '', '## Journal\n\n- ✅ 2026-07-28 — navigateur — Vérifier le compteur\n  > l\'écran n\'existe pas'),
  });
  run(root);
  assert.match(index(root), /« l'écran n'existe pas » _\(sur : navigateur — Vérifier le compteur\)_/);
  rmSync(root, { recursive: true, force: true });
});

test('une remarque très longue est bornée dans l\'index, pas dans le ticket', () => {
  // Cas réel : un log de test collé en commentaire produisait une ligne d'index de plus de
  // 2 000 caractères — dans le fichier dont tout l'intérêt est d'être compact.
  const long = 'log '.repeat(400).trim();
  const root = fixture({ 'EX-001': TICKET('EX-001', '', `## Journal\n\n- 💬 2026-07-28 — ${long}`) });
  run(root);
  const line = index(root).split('\n').find((l) => l.startsWith('- [EX-001]'));
  assert.ok(line.length < 260, `ligne trop longue : ${line.length}`);
  assert.match(line, /…\s»/, 'la coupe doit se voir');
  // Le texte entier reste dans le ticket : on borne l'aperçu, on ne perd rien.
  assert.match(readFileSync(join(root, 'backlog', 'EX-001.md'), 'utf8'), new RegExp(long.slice(-40)));
  rmSync(root, { recursive: true, force: true });
});

test('sans remarque en attente, le bloc n\'existe pas du tout', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  run(root);
  const md = index(root);
  assert.doesNotMatch(md, /Remarques en attente/);
  // La consigne --ack est contextuelle : elle ne se lit pas les 364 autres jours.
  assert.doesNotMatch(md, /--ack <ID>/);
  rmSync(root, { recursive: true, force: true });
});

test('--ack retire la remarque de l\'index', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', '', '## Journal\n\n- 💬 2026-07-28 — remarque à instruire'),
  });
  run(root);
  assert.match(index(root), /Remarques en attente/);

  const r = run(root, ['--ack', 'EX-001', 'clos : le comportement est attendu']);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(index(root), /Remarques en attente/);
  rmSync(root, { recursive: true, force: true });
});

test('un bloc de code qui DOCUMENTE le journal ne produit pas de fausse remarque', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', '', '```\n- 💬 2026-07-28 — ceci est un exemple\n```'),
  });
  run(root);
  // Le journal ne commence qu'à son titre « ## Journal » : pas de section, pas d'entrée.
  assert.doesNotMatch(index(root), /Remarques en attente/);
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────── TKS-013 — le contrat dans le backlog

test('--init dépose PROTOCOLE.md, et il n\'est pas compté comme un ticket', () => {
  const root = mkdtempSync(join(tmpdir(), 'tks-'));
  const r = run(root, ['--init']);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(root, 'backlog', 'PROTOCOLE.md')));

  const g = run(root);
  assert.match(g.out, /^1 tickets?/, 'PROTOCOLE.md ne doit pas gonfler le compte de tickets');
  assert.doesNotMatch(g.err, /sans hook/, 'ni produire un avertissement');
  assert.match(index(root), /backlog\/PROTOCOLE\.md/, 'l\'en-tête doit y renvoyer');
  rmSync(root, { recursive: true, force: true });
});

test('sans PROTOCOLE.md, l\'en-tête n\'invente pas la ligne', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  run(root);
  assert.doesNotMatch(index(root), /PROTOCOLE\.md/);
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────── le sas « À trancher »

const triageFile = (root) => readFileSync(join(root, 'backlog', 'A-TRANCHER.md'), 'utf8');

test('une note sans rattachement se dépose et remonte en tête d\'index', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  const r = run(root, ['--note', 'le bouton de retour ne revient pas au bon écran']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /N1/);
  assert.match(triageFile(root), /^- 💡 \[N1\] \d{4}-\d{2}-\d{2} — le bouton de retour/m);

  run(root);
  const md = index(root);
  assert.match(md, /## 🧾 À trancher \(1\)/);
  assert.match(md, /\[N1\].*« le bouton de retour ne revient pas au bon écran »/);
  // Tout en haut : ces remarques n'ont même pas de ticket d'accueil.
  assert.ok(md.indexOf('À trancher') < md.indexOf('## Actifs'));
  rmSync(root, { recursive: true, force: true });
});

test('le rattachement est facultatif, et validé seulement s\'il est fourni', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });

  assert.equal(run(root, ['--note', 'EX-001', 'situé sur ce ticket']).code, 0);
  assert.match(triageFile(root), /- 💡 \[N1\] \[EX-001\] \d{4}-\d{2}-\d{2} — situé sur ce ticket/);

  const bad = run(root, ['--note', 'EX-999', 'texte']);
  // « EX-999 » n'est pas un identifiant connu : il n'est pas pris pour un rattachement,
  // il reste donc dans le texte. Une note ne doit jamais être PERDUE sur une faute de saisie.
  assert.equal(bad.code, 0, bad.err);
  assert.match(triageFile(root), /\[N2\] \d{4}-\d{2}-\d{2} — EX-999 texte/);
  rmSync(root, { recursive: true, force: true });
});

test('une note vide est refusée', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  const r = run(root, ['--note', '   ']);
  assert.equal(r.code, 1);
  assert.match(r.err, /vide/);
  rmSync(root, { recursive: true, force: true });
});

test('--triage exige une raison et retire la note de l\'index', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  run(root, ['--note', 'une idée à instruire']);
  run(root);
  assert.match(index(root), /À trancher \(1\)/);

  assert.equal(run(root, ['--triage', 'N1']).code, 1, 'sans raison, ça doit échouer');
  assert.match(index(root), /À trancher \(1\)/, 'et ne rien changer');

  const ok = run(root, ['--triage', 'N1', 'ouvert en EX-002']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(triageFile(root), /↳ ✓ \d{4}-\d{2}-\d{2} — ouvert en EX-002/);
  assert.doesNotMatch(index(root), /À trancher/);
  rmSync(root, { recursive: true, force: true });
});

test('les numéros ne sont jamais réutilisés, même après tranchage', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  run(root, ['--note', 'première']);
  run(root, ['--triage', 'N1', 'écartée : hors sujet']);
  run(root, ['--note', 'seconde']);
  // Réutiliser N1 ferait pointer deux décisions distinctes sur le même identifiant.
  assert.match(triageFile(root), /\[N2\] \d{4}-\d{2}-\d{2} — seconde/);
  assert.equal(run(root, ['--triage', 'N1', 'encore']).code, 1, 'une note déjà tranchée ne se retranche pas');
  rmSync(root, { recursive: true, force: true });
});

test('A-TRANCHER.md n\'est pas lu comme un ticket', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  run(root, ['--note', 'une note']);
  const g = run(root);
  assert.match(g.out, /^1 tickets?/);
  assert.doesNotMatch(g.err, /sans hook/);
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────── la page web

const html = (root) => readFileSync(join(root, 'backlog.html'), 'utf8');

/**
 * Le JS client vit dans un template literal : une backtick ou un `${` glissé dans un
 * commentaire casse la page SANS casser le générateur — `node --check` passe, la page
 * est muette. C'est l'étape 3 de la recette R1, ici automatisée.
 */
test('le JS client de la page compile', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', '', '## Journal\n\n- 💬 2026-07-28 — une remarque'),
  });
  run(root);
  const src = html(root).match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(src, 'le bloc de script client doit être présent');
  assert.doesNotThrow(() => new Function(src[1]));
  rmSync(root, { recursive: true, force: true });
});

test('la page embarque les remarques en attente et les annonce en en-tête', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', '', '## Journal\n\n- 💬 2026-07-28 — pas trouvé l\'écran'),
  });
  run(root);
  const h = html(root);
  assert.match(h, /id="pending"/, 'le bandeau doit exister dans la page');
  assert.match(h, /💬 1 en attente/, 'et être annoncé dans l\'en-tête');
  // La page et BACKLOG.md lisent le même calcul : ils ne peuvent pas diverger.
  assert.match(h, /"pending":\[\{"id":"EX-001"/);
  rmSync(root, { recursive: true, force: true });
});

test('sans remarque, la page n\'annonce rien', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  run(root);
  const h = html(root);
  assert.match(h, /"pending":\[\]/);
  // Ancré sur le BALISAGE, pas sur le texte : la source du client est toujours embarquée
  // dans la page, et elle contient forcément les libellés qu'elle sait produire.
  assert.doesNotMatch(h, /class="alert rem"/);
  rmSync(root, { recursive: true, force: true });
});

test('--init n\'écrase pas un PROTOCOLE.md amendé', () => {
  const root = mkdtempSync(join(tmpdir(), 'tks-'));
  run(root, ['--init']);
  const file = join(root, 'backlog', 'PROTOCOLE.md');
  writeFileSync(file, '# amendé par le projet', 'utf8');
  run(root, ['--init']);
  assert.equal(readFileSync(file, 'utf8'), '# amendé par le projet');
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────── Séances de test

/** Une séance dans le backlog jetable. `fixture()` ne connaît que les tickets. */
function seance(root, id, content) {
  const dir = join(root, 'backlog', 'seances');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), content, 'utf8');
}

const SEANCE = (id, body) => `---
id: ${id}
title: Devant la borne
when: ~1 h · sur place
---

${body}
`;

test('une séance compte ses étapes ouvertes, sans compter ce qui n\'en est pas une', () => {
  const root = fixture({
    // une action ouverte : reste à cocher
    'EX-001': TICKET('EX-001', 'action: borne — Vérifier le démarrage\n'),
    // action déjà cochée (elle est passée dans le journal) : faite
    'EX-002': TICKET('EX-002', '', '## Journal\n\n- ✅ 2026-07-28 — borne — Brancher l\'écran'),
    // ni action en attente ni action passée : c'est une MENTION, pas une étape
    'EX-003': TICKET('EX-003'),
  });
  seance(root, 'S1', SEANCE('S1', '1. [[EX-001]]\n2. [[EX-002]]\n\nHors séance : [[EX-003]].'));
  run(root);

  const line = index(root).split('\n').find((l) => l.startsWith('- [S1]'));
  assert.ok(line, 'la séance doit apparaître dans l\'index');
  // 2 étapes réelles (EX-003 n'en est pas une), dont 1 encore à cocher
  assert.match(line, /1 étape sur 2 à cocher/);
  assert.match(line, /backlog\/seances\/S1\.md/, 'l\'index dit où lire le plan');
  rmSync(root, { recursive: true, force: true });
});

test('une séance entièrement cochée quitte l\'index — rien de terminé n\'y reste', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', '', '## Journal\n\n- ✅ 2026-07-28 — borne — Brancher l\'écran'),
  });
  seance(root, 'S1', SEANCE('S1', '1. [[EX-001]]'));
  run(root);
  assert.doesNotMatch(index(root), /Séances de test/);
  // Elle reste lisible sur la page : c'est là qu'on relit ce qu'on a fait.
  assert.match(html(root), /"seances":\[\{"id":"S1"/);
  rmSync(root, { recursive: true, force: true });
});

test('une séance qui cite un ticket inconnu le signale, comme un ticket le ferait', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001', 'action: borne — Vérifier\n') });
  seance(root, 'S1', SEANCE('S1', '1. [[EX-001]]\n2. [[EX-404]]'));
  const r = run(root);
  assert.match(r.err, /seances\/S1 : référence inconnue « EX-404 »/);
  rmSync(root, { recursive: true, force: true });
});

test('une séance sans aucune action citée est signalée plutôt que de disparaître', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001') });
  seance(root, 'S1', SEANCE('S1', 'Du texte, et rien qui cite une action.'));
  const r = run(root);
  assert.match(r.err, /seances\/S1 : aucune action citée/);
  rmSync(root, { recursive: true, force: true });
});

test('un identifiant cité dans un bloc de code n\'est pas une étape', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', 'action: borne — Vérifier\n'),
    'EX-002': TICKET('EX-002', 'action: borne — Autre chose\n'),
  });
  seance(root, 'S1', SEANCE('S1', '1. [[EX-001]]\n\n```sh\nnode backlog.mjs --done EX-002\n```'));
  run(root);
  const line = index(root).split('\n').find((l) => l.startsWith('- [S1]'));
  assert.match(line, /1 étape sur 1 à cocher/, 'EX-002 n\'est cité que dans un exemple de commande');
  rmSync(root, { recursive: true, force: true });
});

test('la page porte l\'état de chaque étape, pour barrer ce qui est fait', () => {
  const root = fixture({
    'EX-001': TICKET('EX-001', 'action: borne — Vérifier\n'),
    'EX-002': TICKET('EX-002', '', '## Journal\n\n- ✅ 2026-07-28 — borne — Brancher'),
  });
  seance(root, 'S1', SEANCE('S1', '1. [[EX-001]]\n2. [[EX-002]]'));
  run(root);
  const h = html(root);
  assert.match(h, /\{"id":"EX-001","state":"open"\}/);
  assert.match(h, /\{"id":"EX-002","state":"checked"\}/);
  rmSync(root, { recursive: true, force: true });
});

test('l\'ordre d\'une séance survit au rendu : une liste numérotée reste numérotée', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001', 'action: borne — Vérifier\n') });
  // Une séance qui reprend la numérotation d'une autre ne doit pas se renuméroter à 1.
  seance(root, 'S1', SEANCE('S1', '10. Première étape de cette séance\n11. [[EX-001]]'));
  run(root);
  // `<` est réécrit en < dans le JSON embarqué : on cherche donc la forme échappée.
  const h = html(root);
  assert.match(h, /\\u003col start=\\"10\\">/, 'le numéro de départ vient du source');
  assert.doesNotMatch(h, /10\. Première étape/, 'et non d\'un paragraphe où l\'ordre se perd');
  rmSync(root, { recursive: true, force: true });
});

test('« Mes actions » peut se filtrer par priorité, avec le même état que le kanban', () => {
  const root = fixture({ 'EX-001': TICKET('EX-001', 'action: borne — Vérifier\n') });
  run(root);
  const bar = html(root).match(/<div class="filters" id="afilters"[\s\S]*?<\/div>/)[0];
  for (const p of ['P0', 'P1', 'P2', 'P3']) assert.match(bar, new RegExp(`data-prio="${p}"`));
  // MÊME attribut que la barre du kanban : c'est ce qui garantit un seul état partagé.
  assert.match(bar, /id="foldall"/, 'et de quoi replier les groupes d\'un coup');
  rmSync(root, { recursive: true, force: true });
});
