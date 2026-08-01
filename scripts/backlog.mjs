#!/usr/bin/env node
/**
 * TicketoScope — un registre de tickets à coût marginal plat.
 *
 * Un ticket = un fichier Markdown avec frontmatter. Le générateur en tire :
 *   - BACKLOG.md   : une ligne par ticket (la surface de scan, volontairement compacte)
 *   - backlog.html : vues web (kanban, fils, blocages, roadmap, historique git, actions)
 *
 * Zéro dépendance : Node natif uniquement.
 *
 *   node backlog.mjs                → régénère BACKLOG.md + backlog.html
 *   node backlog.mjs --serve        → http://localhost:4321, auto-reload sur modification
 *   node backlog.mjs --init         → crée un dossier backlog/ d'exemple
 *   node backlog.mjs --ack <ID> "…" → marque les remarques d'un ticket prises en compte
 *   node backlog.mjs --help         → l'usage, sans rien écrire
 *
 * Options : --dir <backlog> --out <.> --port <4321>
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, watch } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

// ─────────────────────────────────────────────────────────── configuration

const ARGV = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : fallback;
};

const DIR = resolve(opt('--dir', 'backlog'));
const OUT = resolve(opt('--out', '.'));
const PORT = Number(opt('--port', 4321));

const STATUSES = ['todo', 'doing', 'done', 'dropped'];
const STATUS_LABEL = { todo: 'À faire', doing: 'En cours', done: 'Fait', dropped: 'Abandonné' };
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
// Un pictogramme par préfixe d'identifiant — à adapter par projet. Le fallback vaut pour tout le reste.
const ACTION_TOOLS = ['supabase','cloudflare','borne','navigateur','git','contenu','recette','matériel'];
const TYPE_ICON = { BUG: '🐛', SEC: '🔒', DOC: '📄', CIN: '🎬', _: '🎫' };

/**
 * Fichiers du dossier backlog/ qui ne sont PAS des tickets.
 *
 * Le dossier est balayé par extension : sans cette liste, un `PROTOCOLE.md` ou un
 * `README.md` déposé à côté des tickets deviendrait un ticket fantôme « (sans hook) »,
 * compté dans l'index et signalé en avertissement à chaque génération.
 */
const NOT_A_TICKET = new Set(['PROTOCOLE.md', 'README.md', 'A-TRANCHER.md']);

/** Le sas : des remarques qui n'ont pas encore de ticket. Voir `readTriage`. */
const TRIAGE_FILE = 'A-TRANCHER.md';

// ─────────────────────────────────────────────────────────── lecture

/** Frontmatter minimal : `clé: valeur`, valeur `[a, b]` = liste. Pas de YAML complet, volontairement. */
function parseFrontmatter(raw, file) {
  if (!raw.startsWith('---')) return [{}, raw, [`${file} : pas de frontmatter`]];
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return [{}, raw, [`${file} : frontmatter non fermé`]];
  const head = raw.slice(4, end);
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1);
  const meta = {};
  const warn = [];
  for (const line of head.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const c = line.indexOf(':');
    if (c < 0) { warn.push(`${file} : ligne de frontmatter ignorée « ${line.trim()} »`); continue; }
    const key = line.slice(0, c).trim();
    let value = line.slice(c + 1).trim();
    if (value.startsWith('[')) {
      meta[key] = value.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      meta[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return [meta, body, warn];
}

function read() {
  if (!existsSync(DIR)) {
    console.error(`Aucun dossier « ${DIR} ». Lance « node backlog.mjs --init » pour le créer.`);
    process.exit(1);
  }
  const warnings = [];
  const tickets = [];
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.md') && !NOT_A_TICKET.has(f)).sort()) {
    const [meta, body, w] = parseFrontmatter(readFileSync(join(DIR, f), 'utf8'), f);
    warnings.push(...w);
    const id = meta.id || basename(f, '.md');
    if (!meta.hook) warnings.push(`${f} : pas de « hook » — c'est le champ le plus important`);
    if (meta.status && !STATUSES.includes(meta.status)) warnings.push(`${f} : status inconnu « ${meta.status} »`);
    if (meta.priority && !PRIORITIES.includes(meta.priority)) warnings.push(`${f} : priorité inconnue « ${meta.priority} »`);
    if (meta.action) {
      const [tool] = meta.action.split('—').map((x) => x.trim());
      if (!ACTION_TOOLS.includes(tool)) warnings.push(`${f} : action sans outil connu (« ${tool} ») — attendu : ${ACTION_TOOLS.join(', ')}`);
      if (meta.action.length > 110) warnings.push(`${f} : action trop longue (${meta.action.length} car.) — une ligne, à l'impératif`);
    }
    tickets.push({
      id,
      hook: meta.hook || '(sans hook)',
      epic: meta.epic || null,
      created: meta.created || null,
      origin: meta.origin || null,
      status: STATUSES.includes(meta.status) ? meta.status : 'todo',
      priority: PRIORITIES.includes(meta.priority) ? meta.priority : 'P2',
      owner: meta.owner || '',
      layer: meta.layer || '',
      action: meta.action || '',
      follows: meta.follows || null,
      blocks: meta.blocks || [],
      blocked_by: meta.blocked_by || [],
      icon: TYPE_ICON[(id.match(/^([A-Z]+)-/) || [])[1]] || TYPE_ICON._,
      body: body.trim(),
    });
  }

  const epics = [];
  const epicDir = join(DIR, 'epics');
  if (existsSync(epicDir)) {
    for (const f of readdirSync(epicDir).filter((f) => f.endsWith('.md')).sort()) {
      const [meta, body, w] = parseFrontmatter(readFileSync(join(epicDir, f), 'utf8'), `epics/${f}`);
      warnings.push(...w);
      epics.push({ id: meta.id || basename(f, '.md'), title: meta.title || basename(f, '.md'),
        phase: meta.phase || '', body: body.trim() });
    }
  }

  const recipes = [];
  const recipeDir = join(DIR, 'recipes');
  if (existsSync(recipeDir)) {
    for (const f of readdirSync(recipeDir).filter((f) => f.endsWith('.md')).sort()) {
      const [meta, body, w] = parseFrontmatter(readFileSync(join(recipeDir, f), 'utf8'), `recipes/${f}`);
      warnings.push(...w);
      recipes.push({ id: meta.id || basename(f, '.md'), title: meta.title || basename(f, '.md'),
        when: meta.when || '', body: body.trim() });
    }
  }

  // Intégrité référentielle : une référence pendante est une erreur de saisie, pas un détail.
  const known = new Set(tickets.map((t) => t.id));
  const knownEpics = new Set(epics.map((e) => e.id));
  for (const t of tickets) {
    for (const ref of [...t.blocks, ...t.blocked_by, ...(t.follows ? [t.follows] : [])]) {
      if (!known.has(ref)) warnings.push(`${t.id} : référence inconnue « ${ref} »`);
    }
    if (t.epic && !knownEpics.has(t.epic)) warnings.push(`${t.id} : épique « ${t.epic} » sans fichier epics/${t.epic}.md`);
  }
  return { tickets, epics, recipes, warnings };
}

// ─────────────────────────────────────────────────────────── historique git

/**
 * Lit l'historique du dépôt courant et calcule une disposition en couloirs (lanes),
 * comme un « git log --graph » : chaque commit reçoit une colonne, les fusions et les
 * bifurcations tracent des lignes entre colonnes. Zéro dépendance : on parse la sortie
 * de `git log`. Renvoie `null` hors d'un dépôt git (la vue s'efface alors proprement).
 *
 * Ordre : `--date-order` donne récent → ancien ; un parent étant toujours plus ancien,
 * il est traité APRÈS son enfant. On réserve donc le couloir d'un parent au moment où
 * l'on place l'enfant ; le couloir est retrouvé quand on atteint le parent.
 */
function gitHistory({ max = 400 } = {}) {
  const US = '\x1f', RS = '\x1e'; // séparateurs improbables dans un message de commit
  let raw;
  try {
    raw = execFileSync('git', [
      'log', '--all', '--date-order', `--max-count=${max}`,
      `--pretty=format:%H${US}%h${US}%P${US}%an${US}%aI${US}%D${US}%s${RS}`,
    ], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null; // pas un dépôt git, ou git indisponible
  }

  const commits = raw.split(RS).map((r) => r.replace(/^\n/, '')).filter((r) => r.trim()).map((rec) => {
    const [H, h, P, author, date, D, subject] = rec.split(US);
    return {
      H, h, author, date, subject: subject ?? '',
      parents: P ? P.trim().split(/\s+/) : [],
      refs: D ? D.split(',').map((s) => s.trim()).filter(Boolean) : [],
    };
  });
  if (commits.length === 0) return null;

  const rowByHash = new Map(commits.map((c) => [c.H, true]));
  const lanes = []; // lanes[i] = hash attendu dans ce couloir, ou null si libre
  const freeLane = () => { const i = lanes.indexOf(null); return i >= 0 ? i : lanes.push(null) - 1; };
  let laneCount = 0;
  for (const c of commits) {
    let col = lanes.indexOf(c.H);
    if (col < 0) { col = freeLane(); lanes[col] = c.H; } // tête de branche : nouveau couloir
    c.col = col;
    // Les autres couloirs qui attendaient ce même commit (fusions) se replient sur `col`.
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === c.H) lanes[i] = null;
    // Premier parent = continuité du couloir ; parents de fusion = nouveaux couloirs.
    const [p0, ...rest] = c.parents;
    lanes[col] = p0 && rowByHash.has(p0) ? p0 : null; // parent hors fenêtre → on libère le couloir
    for (const p of rest) if (rowByHash.has(p) && !lanes.includes(p)) lanes[freeLane()] = p;
    laneCount = Math.max(laneCount, lanes.length);
  }

  const edgeList = [];
  for (const c of commits) {
    for (const p of c.parents) {
      if (rowByHash.has(p)) edgeList.push({ from: c.H, to: p, merge: c.parents.length > 1 });
    }
  }
  const merges = commits.filter((c) => c.parents.length > 1).length;
  return {
    commits: commits.map((c) => ({ H: c.H, h: c.h, col: c.col, parents: c.parents, author: c.author, date: c.date, refs: c.refs, subject: c.subject })),
    edges: edgeList, laneCount, merges, truncated: commits.length >= max,
    activity: gitActivity(),
  };
}

/**
 * Activité par jour = nombre de commits/jour, sur ~53 semaines glissantes. KPI le moins
 * coûteux qu'on tire de git : on ne lit que la DATE de chaque commit (`--pretty=%ad`),
 * jamais le contenu — donc pas d'analyse de diff. Sert de « heatmap de contributions ».
 * Renvoie une carte { 'YYYY-MM-DD': n }, ou null hors dépôt git.
 */
function gitActivity({ weeks = 53 } = {}) {
  const since = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString().slice(0, 10);
  let raw;
  try {
    raw = execFileSync('git', ['log', '--all', `--since=${since}`, '--pretty=format:%ad', '--date=format:%Y-%m-%d'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null;
  }
  const counts = {};
  for (const line of raw.split('\n')) { const d = line.trim(); if (d) counts[d] = (counts[d] || 0) + 1; }
  return counts;
}

/** Une arête déclarée d'un seul côté vaut des deux : on ne veut pas d'un graphe qui dépend du sens de saisie. */
function edges(tickets) {
  const set = new Set();
  const known = new Set(tickets.map((t) => t.id));
  for (const t of tickets) {
    for (const b of t.blocks) if (known.has(b)) set.add(`${t.id}>${b}`);
    for (const b of t.blocked_by) if (known.has(b)) set.add(`${b}>${t.id}`);
  }
  return [...set].map((s) => { const [from, to] = s.split('>'); return { from, to }; });
}

/**
 * Les tickets encore vivants bloqués en aval de chacun — l'urgence n'est jamais saisie
 * à la main.
 *
 * Renvoie des ENSEMBLES d'identifiants, pas des compteurs. Deux actions du même outil
 * peuvent libérer le même ticket : sommer leurs compteurs pour peser un groupe le
 * compterait deux fois, et le chiffre affiché mentirait précisément là où on lui
 * demande de trancher.
 */
function impacts(tickets) {
  const E = edges(tickets);
  const alive = new Set(tickets.filter((t) => t.status !== 'done' && t.status !== 'dropped').map((t) => t.id));
  const out = {};
  const down = (id, seen, acc) => {
    for (const e of E) {
      if (e.from !== id || seen.has(e.to)) continue;
      seen.add(e.to);
      if (alive.has(e.to)) acc.add(e.to);
      down(e.to, seen, acc);
    }
    return acc;
  };
  for (const t of tickets) out[t.id] = down(t.id, new Set([t.id]), new Set());
  return out;
}

/**
 * L'ordre des actions — UNE seule règle, appliquée aux lignes comme aux groupes :
 *
 *   P0 d'abord, puis ce qui débloque le plus, puis la priorité.
 *
 * P0 n'est pas un cran de plus sur l'échelle. C'est la seule priorité que la page
 * remplit en aplat plein, et la seule qui veuille dire « ça brûle » : une action P0
 * enterrée sous deux groupes serait une erreur de lecture, pas un arbitrage. En
 * dessous, l'ampleur CALCULÉE est un meilleur guide que P1/P2/P3, qui sont des
 * estimations posées à la main — c'est le choix d'origine de l'outil, conservé.
 *
 * Deux niveaux triés par deux règles différentes, ce serait une liste qu'on doit
 * réapprendre à chaque session.
 */
const byUrgency = (pa, fa, pb, fb) =>
  (pa === 'P0' ? 0 : 1) - (pb === 'P0' ? 0 : 1) || fb - fa || pa.localeCompare(pb);

/** Les actions ouvertes, regroupées par outil : on ouvre Supabase une fois, on enchaîne. */
function actions(tickets) {
  const imp = impacts(tickets);
  return tickets.filter((t) => t.action).map((t) => {
    const i = t.action.indexOf('—');
    const frees = [...(imp[t.id] || [])];
    return {
      id: t.id, icon: t.icon, priority: t.priority, epic: t.epic,
      tool: i < 0 ? 'divers' : t.action.slice(0, i).trim(),
      text: i < 0 ? t.action.trim() : t.action.slice(i + 1).trim(),
      unblocks: frees.length,
      // Les identifiants voyagent avec l'action : la page regroupe elle-même par outil,
      // et sans eux elle ne pourrait pas dédoublonner ce qu'un groupe libère.
      frees,
    };
  }).sort((a, b) => byUrgency(a.priority, a.unblocks, b.priority, b.unblocks) || a.id.localeCompare(b.id));
}

/**
 * Ce qu'un groupe d'actions pèse : sa priorité la plus haute, le nombre de tickets
 * DISTINCTS qu'il libère en tout, et ce que sa plus grosse action libère à elle seule.
 *
 * `max` sert à ne PAS répéter : les actions étant triées par la même règle, la première
 * ligne d'un groupe porte déjà sa priorité la plus haute, et le plus souvent son plus
 * gros levier. Afficher le total en tête ne se justifie que s'il dépasse cette ligne —
 * c'est-à-dire quand plusieurs actions libèrent des tickets DIFFÉRENTS.
 *
 * `P0 < P1 < P2 < P3` dans l'ordre des chaînes : la comparaison lexicale suffit, pas
 * besoin d'une table de rangs à tenir synchronisée avec `PRIORITIES`.
 */
function toolWeight(acts) {
  const frees = new Set();
  for (const a of acts) for (const id of a.frees) frees.add(id);
  return {
    top: acts.reduce((m, a) => (a.priority < m ? a.priority : m), 'P3'),
    frees: frees.size,
    max: acts.reduce((m, a) => (a.unblocks > m ? a.unblocks : m), 0),
  };
}

/**
 * Groupe par outil, puis ORDONNE LES GROUPES avec la règle de `byUrgency`.
 *
 * L'ordre était « le groupe le plus fourni d'abord » — un critère de logistique, pas
 * d'urgence. Conséquence : le groupe portant l'action qui libère cinq tickets pouvait
 * se retrouver en bas de page, sous un groupe de six broutilles. Le regroupement par
 * outil est conservé (on ouvre Supabase une fois, on enchaîne) ; seul son ORDRE change.
 */
function byTool(list) {
  const g = {};
  for (const a of list) (g[a.tool] ||= []).push(a);
  return Object.entries(g).map(([tool, acts]) => [tool, acts, toolWeight(acts)])
    .sort((a, b) => byUrgency(a[2].top, a[2].frees, b[2].top, b[2].frees)
      || b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/**
 * Les remarques écrites et pas encore prises en compte, tous tickets confondus.
 *
 * Cette donnée existait déjà — `parseJournal` pose `pending`, et la page web s'en sert
 * pour son badge — mais elle n'était écrite NULLE PART dans `BACKLOG.md`. Or l'index est
 * le seul fichier qu'un agent a pour consigne de lire au démarrage : une remarque était
 * donc invisible à qui suivait la consigne, et introuvable autrement qu'en fouillant le
 * code du générateur. C'est ce que ça corrige.
 *
 * Le VERBATIM remonte, pas un compteur : « 2 remarques en attente » obligerait à rouvrir
 * chaque ticket, c'est-à-dire à repayer exactement le coût qu'on supprime ici.
 *
 * Ordre : ticket dont la remarque est la plus récente d'abord. Reprendre un fil, c'est
 * chercher ce qui vient de se dire — pas ce qui est le plus prioritaire.
 */
function pendingRemarks(tickets) {
  const groups = [];
  for (const t of tickets) {
    const items = parseJournal(t.body)
      .filter((e) => e.pending)
      // `💬` porte sa remarque sur la ligne même ; `✅` la porte dans ses lignes `>`,
      // et son texte n'est alors que l'action à laquelle elle est accrochée.
      .map((e) => ({
        kind: e.kind,
        date: e.date,
        text: (e.kind === 'comment' ? [e.text, e.comment].filter(Boolean).join(' — ') : e.comment)
          .replace(/\s*\n\s*/g, ' · ').trim(),
        about: e.kind === 'action' ? e.text : '',
      }));
    if (items.length) {
      groups.push({ id: t.id, icon: t.icon, priority: t.priority, items,
        last: items.reduce((m, e) => (e.date > m ? e.date : m), '') });
    }
  }
  return groups.sort((a, b) => b.last.localeCompare(a.last) || a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────────────────── markdown minimal

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // un seul passage : sinon la 2ᵉ passe re-linkerait l'intérieur des ancres produites par la 1ʳᵉ
    .replace(/\[\[([A-Z]{2,5}-[\w+]+)\]\]|\b([A-Z]{2,5}-\d+)\b/g,
      (_, wiki, bare) => { const id = wiki || bare; return `<a href="#" data-goto="${id}">${id}</a>`; });
}

/** Sous-ensemble suffisant pour des corps de tickets : titres, listes, tableaux, italique de ligne. */
function md(src) {
  const lines = src.split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (!para.length) return;
    const txt = para.join(' ');
    // un paragraphe entièrement entre underscores est une note de contexte : le source s'en sert beaucoup
    const em = txt.match(/^_(.+)_$/s);
    out.push(em ? `<p><em>${inline(em[1])}</em></p>` : `<p>${inline(txt)}</p>`);
    para = [];
  };
  const flushList = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Bloc de code clôturé. Doit passer AVANT tout le reste : un ticket documente
    // souvent un format, un message d'erreur ou une commande, et ces lignes ne sont
    // pas du Markdown. Sans ce cas, « - x » devenait une puce et « # y » un titre —
    // le bloc s'affichait en vrac, et les backticks restaient à l'écran.
    const fence = line.match(/^\s*(?:```|~~~)(.*)$/);
    if (fence) {
      flush();
      const close = /^\s*(?:```|~~~)\s*$/;
      const buf = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      // i pointe sur la clôture (ou la fin : un bloc non fermé se rend quand même).
      const lang = fence[1].trim().replace(/[^\w-]/g, '');
      out.push(`<pre${lang ? ` data-lang="${lang}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) { flush(); continue; }

    const h = line.match(/^(#{2,4})\s+(.*)$/);
    if (h) { flush(); const lvl = h[1].length + 1; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }

    if (line.trimStart().startsWith('|')) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) { rows.push(lines[i].trim()); i++; }
      i--;
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s|:-]+\|$/.test(r));
      const [head, ...rest] = body;
      out.push('<table><thead><tr>' + cells(head).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rest.map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }

    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { flushPara(); (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }

    // continuation d'un item de liste (le source enroule ses lignes)
    if (list && /^\s{2,}\S/.test(line)) { list[list.length - 1] = list[list.length - 1].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`); continue; }

    flushList();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────── BACKLOG.md

const ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const byEpicPrioId = (a, b) =>
  (a.epic || 'zzz').localeCompare(b.epic || 'zzz') || ORDER[a.priority] - ORDER[b.priority] || a.id.localeCompare(b.id);

/**
 * Borne le verbatim d'une remarque dans l'index.
 *
 * ⚠️ Trouvé en conditions réelles, pas en théorie : une remarque contenant un log de test
 * collé faisait une ligne d'index de plus de 2 000 caractères — et l'index est précisément
 * la surface qu'on garde compacte. Le texte entier reste dans le ticket, qui est fait pour
 * ça ; l'index n'en porte que de quoi reconnaître de quoi il s'agit.
 *
 * Coupé sur une frontière de mot, sinon la troncature tombe au milieu d'un identifiant et
 * l'aperçu devient illisible là où il devait aider.
 */
const INDEX_QUOTE_MAX = 180;
function quoteForIndex(text) {
  const s = String(text ?? '').trim();
  if (s.length <= INDEX_QUOTE_MAX) return s;
  const cut = s.slice(0, INDEX_QUOTE_MAX);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > INDEX_QUOTE_MAX * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

function renderIndex({ tickets, epics, recipes }) {
  const titles = Object.fromEntries(epics.map((e) => [e.id, e.title]));
  const line = (t) => `- ${t.icon} [${t.id}] ${t.priority} · ${t.status} · ${t.hook}${t.epic ? ` — ${t.epic}` : ''}`;
  const active = tickets.filter((t) => t.status === 'todo' || t.status === 'doing').sort(byEpicPrioId);
  const closed = tickets.filter((t) => t.status === 'done' || t.status === 'dropped').sort(byEpicPrioId);
  const counts = STATUSES.map((s) => `${tickets.filter((t) => t.status === s).length} ${s}`).join(' · ');

  const head = [];

  // Tout en haut : ces remarques-là n'ont même pas de ticket d'accueil. Ce sont donc
  // celles qui se perdent le plus vite, et la seule chose qui les retient est d'être
  // comptées ici jusqu'à ce qu'on les tranche.
  const notes = readTriage().filter((e) => e.open);
  if (notes.length) {
    head.push(`## 🧾 À trancher (${notes.length})`, '');
    for (const e of notes) {
      head.push(`- [${e.id}] ${e.date} — « ${quoteForIndex(e.text)} »${e.about ? ` _(situé par lui sur : ${e.about})_` : ''}`);
    }
    head.push('', '→ Chacune doit devenir un ticket ou être écartée : '
      + '`node backlog.mjs --triage <ID> "ce qui en a été fait"`', '');
  }

  // En PREMIER, avant les actions : une remarque en attente est ce qui se perd. Une action
  // non faite reste une action non faite ; une remarque non instruite finit oubliée.
  const remarks = pendingRemarks(tickets);
  if (remarks.length) {
    const n = remarks.reduce((s, g) => s + g.items.length, 0);
    head.push(`## 💬 Remarques en attente (${n})`, '');
    for (const g of remarks) {
      for (const e of g.items) {
        head.push(`- [${g.id}] ${e.kind === 'comment' ? '💬' : '✅'} ${e.date} — « ${quoteForIndex(e.text)} »`
          + (e.about ? ` _(sur : ${quoteForIndex(e.about)})_` : ''));
      }
    }
    // Consigne CONTEXTUELLE : elle n'apparaît que le jour où elle sert. L'en-tête est la
    // surface de scan — y loger une instruction permanente la ferait lire pour rien 364
    // jours sur 365.
    head.push('', '→ Après arbitrage : `node backlog.mjs --ack <ID> "ce qui en a été fait"`', '');
  }

  const acts = actions(tickets);
  if (acts.length) {
    head.push(`## ⏳ Actions à faire — humaines (${acts.length})`, '');
    for (const [tool, list, w] of byTool(acts)) {
      // Ni la priorité ni le levier ne sont répétés ici : la première ligne du groupe
      // les porte déjà, juste en dessous. Seul le total apparaît, et seulement s'il
      // dit quelque chose qu'aucune ligne ne dit.
      head.push(`### ${tool} — ${list.length} action${list.length > 1 ? 's' : ''}`
        + (w.frees > w.max ? ` · débloque ${w.frees} tickets en tout` : ''));
      // « débloque 0 » sur chaque ligne, c'est onze caractères qui ne disent rien, payés
      // à chaque lecture d'index. Le silence dit la même chose et coûte zéro.
      for (const a of list) {
        head.push(`- [${a.id}] ${a.priority}${a.unblocks ? ` · débloque ${a.unblocks}` : ''} · ${a.text}`);
      }
      head.push('');
    }
    // La règle de tri, écrite une fois : sans elle, l'ordre de la liste ressemble à un
    // hasard et se relit à chaque session.
    head.push('→ Ordre (groupes et lignes) : P0 d\'abord, puis ce qui débloque le plus, puis la priorité. '
      + 'Cocher : `node backlog.mjs --done <ID> ["…"]`', '');
  }

  return [
    '# BACKLOG — index généré',
    `_${tickets.length} tickets : ${counts}. Généré le ${new Date().toISOString().slice(0, 10)} par TicketoScope._`,
    '',
    '> ⚠️ **Ne jamais éditer ce fichier à la main** — il est écrasé à chaque génération.',
    `> Un ticket = un fichier : \`${basename(DIR)}/<ID>.md\`. Le détail ne se lit que si l'on travaille dessus.`,
    `> Épiques : ${epics.map((e) => `${e.id} (${titles[e.id]})`).join(' · ') || '—'}`,
    ...(recipes.length ? [`> Recettes disponibles (procédures, à ouvrir seulement au besoin) : ${recipes.map((r) => `${r.id} ${r.title}`).join(' · ')}`] : []),
    // Le contrat d'usage n'est pas une règle de projet, c'est une propriété de l'outil :
    // il vit avec le backlog, pas dans la mémoire de chaque agent qui le reconstitue.
    ...(existsSync(join(DIR, 'PROTOCOLE.md')) ? [`> Contrat et discipline : \`${basename(DIR)}/PROTOCOLE.md\` — à lire une fois, au démarrage du projet.`] : []),
    '',
    ...head,
    '## Actifs',
    ...active.map(line),
    '',
    '## Clos',
    ...closed.map(line),
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────── page HTML

const CSS = `
:root{
  --bg:#f7f7f5; --panel:#fff; --ink:#16171a; --muted:#6b6f76; --line:#e3e3df;
  --p0:#7a1104; --p1:#c4341c; --p2:#a6700a; --p3:#7d838c;
  --accent:#2f5d50; --shadow:0 1px 2px rgba(16,17,26,.06),0 4px 12px rgba(16,17,26,.04);
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#111214; --panel:#191b1e; --ink:#e9e9e6; --muted:#9aa0a8; --line:#2a2d31;
  --p0:#ff4a24; --p1:#ff8f73; --p2:#e0ab4e; --p3:#7f868f;
  --accent:#7fc2ad; --shadow:0 1px 2px rgba(0,0,0,.4),0 6px 18px rgba(0,0,0,.25);
}}
:root[data-theme=dark]{
  --bg:#111214; --panel:#191b1e; --ink:#e9e9e6; --muted:#9aa0a8; --line:#2a2d31;
  --p0:#ff4a24; --p1:#ff8f73; --p2:#e0ab4e; --p3:#7f868f;
  --accent:#7fc2ad; --shadow:0 1px 2px rgba(0,0,0,.4),0 6px 18px rgba(0,0,0,.25);
}
:root[data-theme=light]{
  --bg:#f7f7f5; --panel:#fff; --ink:#16171a; --muted:#6b6f76; --line:#e3e3df;
  --p0:#7a1104; --p1:#c4341c; --p2:#a6700a; --p3:#7d838c; --accent:#2f5d50;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Inter,Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
a{color:var(--accent)}
code,.id{font-family:ui-monospace,"SF Mono",Menlo,monospace}
header{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:14px 22px 0}
.top{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
h1{font-size:15px;margin:0;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
.meta{color:var(--muted);font-size:12px}
.spacer{flex:1}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.tabs{display:flex;gap:2px;margin-top:12px}
.tab{padding:8px 14px;border-radius:7px 7px 0 0;color:var(--muted);border:1px solid transparent;border-bottom:0}
.tab[aria-selected=true]{color:var(--ink);background:var(--panel);border-color:var(--line);font-weight:600}
.ghost{border:1px solid var(--line);border-radius:7px;padding:5px 10px;font-size:12px;color:var(--muted)}
.ghost:hover{color:var(--ink)}
main{padding:22px}
.filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
[hidden]{display:none !important}   /* sinon display:flex écrase l'attribut hidden */
input[type=search]{font:inherit;padding:7px 11px;border:1px solid var(--line);border-radius:7px;
  background:var(--panel);color:var(--ink);min-width:230px}
.chip{border:1px solid var(--line);border-radius:999px;padding:4px 11px;font-size:12px;color:var(--muted);
  background:var(--panel);opacity:.5}
.chip[aria-pressed=true]{opacity:1;color:var(--ink);font-weight:600;
  border-color:color-mix(in srgb,var(--ink) 32%,var(--line));
  background:color-mix(in srgb,var(--ink) 6%,var(--panel))}
.chip:not([aria-pressed=true]){text-decoration:line-through}

.board{display:grid;grid-template-columns:repeat(4,minmax(210px,1fr));gap:14px;align-items:start}
.col{min-width:0}
.colhead{display:flex;gap:8px;align-items:baseline;padding:0 2px 9px;position:sticky;top:96px;
  background:linear-gradient(var(--bg) 72%,transparent)}
.colhead b{font-size:12px;letter-spacing:.09em;text-transform:uppercase}
.colhead span{color:var(--muted);font-size:12px}
.card{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:9px;
  padding:10px 12px 10px 14px;margin-bottom:9px;box-shadow:var(--shadow);cursor:pointer;overflow:hidden}
.card:hover{border-color:color-mix(in srgb,var(--ink) 30%,var(--line))}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--p2)}
.card.P0::before{background:var(--p0)}.card.P1::before{background:var(--p1)}
.card.P2::before{background:var(--p2)}.card.P3::before{background:var(--p3)}
.card.done,.card.dropped{opacity:.5}
.card.done .id,.card.dropped .id{text-decoration:line-through}
.card code,.node code,.gnode code,.hook code{background:color-mix(in srgb,var(--ink) 9%,transparent);padding:0 3px;border-radius:3px;font-size:.92em}
.card .row{display:flex;gap:7px;align-items:center;font-size:11.5px;color:var(--muted);margin-bottom:4px}
.id{font-size:11.5px;font-weight:600;color:var(--ink);letter-spacing:-.01em}
.prio{font-weight:700;font-size:10px;letter-spacing:.05em;padding:1.5px 6px;border-radius:999px;
  border:1px solid transparent;background:color-mix(in srgb,var(--p2) 15%,transparent);
  color:var(--p2);border-color:color-mix(in srgb,var(--p2) 40%,transparent)}
.P0 .prio{background:var(--p0);color:#fff;border-color:var(--p0)}
.P1 .prio{background:color-mix(in srgb,var(--p1) 17%,transparent);color:var(--p1);border-color:color-mix(in srgb,var(--p1) 45%,transparent)}
.P2 .prio{background:color-mix(in srgb,var(--p2) 15%,transparent);color:var(--p2);border-color:color-mix(in srgb,var(--p2) 40%,transparent)}
.P3 .prio{background:transparent;color:var(--p3);border-color:color-mix(in srgb,var(--p3) 35%,transparent)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:-1px}
.hook{font-size:13px;line-height:1.42}
.badge{border:1px solid var(--line);border-radius:5px;padding:0 5px;font-size:10.5px;letter-spacing:.03em}

.thread{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:18px 20px;margin-bottom:16px;box-shadow:var(--shadow)}
.thread h2{margin:0 0 2px;font-size:14px;letter-spacing:.04em}
.thread h2 .k{color:var(--muted);font-weight:400;margin-left:8px;font-size:12px}
.prose{color:var(--muted);font-size:12.5px;max-width:74ch}
.prose p{margin:.5em 0}.prose ul{margin:.5em 0;padding-left:1.1em}.prose h3,.prose h4{color:var(--ink);font-size:12.5px;margin:1em 0 .3em}
.prose table{border-collapse:collapse;margin:.6em 0;font-size:12px}
.prose th,.prose td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.prose code{background:color-mix(in srgb,var(--ink) 7%,transparent);padding:.5px 4px;border-radius:4px;font-size:11.5px}
.tl{margin-top:14px;border-left:1px solid var(--line);padding-left:0}
.node{position:relative;padding:7px 0 7px 20px;cursor:pointer}
.node::before{content:"";position:absolute;left:-4.5px;top:14px;width:8px;height:8px;border-radius:50%;
  background:var(--p2);border:2px solid var(--panel)}
.node.P0::before{background:var(--p0)}.node.P1::before{background:var(--p1)}.node.P3::before{background:var(--p3)}
.node.done::before,.node.dropped::before{background:var(--line)}
.node.done,.node.dropped{opacity:.55}
.node .h{font-size:13px}
.node .s{font-size:11.5px;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.follows{color:var(--accent)}

#graph{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:11px;
  padding:22px;box-shadow:var(--shadow);overflow:auto}
.layers{display:flex;gap:64px;align-items:flex-start;position:relative;z-index:2;min-width:min-content}
.layer{display:flex;flex-direction:column;gap:12px;min-width:190px}
.layer .lab{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
.gnode{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px;cursor:pointer;position:relative}
.gnode.P0{border-left:4px solid var(--p0)}.gnode.P1{border-left:4px solid var(--p1)}
.gnode.P2{border-left:4px solid var(--p2)}.gnode.P3{border-left:4px solid var(--p3)}
.gnode.done,.gnode.dropped{opacity:.5}
.gnode.dim{opacity:.22}
.gnode.off{opacity:.3;filter:saturate(.4)}
.gnode .hk{font-size:11.5px;color:var(--muted);margin-top:2px;max-width:26ch}
svg.wires{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:visible}
svg.wires path{fill:none;stroke:var(--p2);stroke-width:1.2;opacity:.55}
svg.wires path.hot{stroke:var(--p1);stroke-width:2;opacity:1}

dialog{border:1px solid var(--line);border-radius:13px;background:var(--panel);color:var(--ink);
  padding:0;max-width:min(760px,92vw);width:100%;box-shadow:0 24px 70px rgba(0,0,0,.28)}
dialog::backdrop{background:rgba(10,11,13,.42);backdrop-filter:blur(2px)}
.dh{display:flex;gap:10px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:var(--panel);z-index:2;flex-wrap:wrap}
.db{padding:16px 20px 24px;max-height:min(66vh,620px);overflow:auto}
.db h3,.db h4{margin:1.2em 0 .35em;font-size:13px}
.db p{margin:.55em 0}.db ul{margin:.5em 0;padding-left:1.15em}.db li{margin:.25em 0}
.db table{border-collapse:collapse;margin:.7em 0;font-size:12.5px;width:100%}
.db th,.db td{border:1px solid var(--line);padding:5px 9px;text-align:left;vertical-align:top}
.db code{background:color-mix(in srgb,var(--ink) 7%,transparent);padding:1px 4px;border-radius:4px;font-size:12px}
.empty{color:var(--muted);padding:26px 2px;font-size:13px}
.alert{background:color-mix(in srgb,var(--p1) 15%,transparent);color:var(--p1);border-radius:999px;
  padding:3px 10px;font-size:11.5px;font-weight:600;border:1px solid color-mix(in srgb,var(--p1) 40%,transparent)}
.pill{background:var(--p1);color:#fff;border-radius:999px;padding:0 6px;font-size:10px;margin-left:4px}
.alert.rem{background:color-mix(in srgb,#f59e0b 16%,transparent);color:#b45309;
  border-color:color-mix(in srgb,#f59e0b 45%,transparent)}
:root[data-theme=dark] .alert.rem{color:#e0ab4e}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .alert.rem{color:#e0ab4e}}
/* Le sas « À trancher » — zone d'ÉCRITURE, pas d'alerte : ni ambre ni rouge, mais le vert
   d'accent de l'outil. Ce qu'on y dépose n'est pas un problème, c'est une matière première. */
#triage{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--panel);
  border-radius:9px;padding:11px 14px;margin:0 0 14px;box-shadow:var(--shadow)}
.tnote{display:flex;gap:9px;align-items:baseline;padding:6px 2px;border-top:1px solid var(--line);font-size:13px}
.tnote:first-of-type{border-top:0}
.tref{font-size:11.5px;margin-left:6px;white-space:nowrap}
.trow{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:7px}
.tsel{font:inherit;font-size:12px;padding:5px 9px;border:1px solid var(--line);border-radius:7px;
  background:var(--bg);color:var(--ink);max-width:min(420px,60vw)}
#triage textarea{width:100%;font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--line);
  border-radius:7px;background:var(--bg);color:var(--ink);resize:vertical}
#triage .cform{margin-top:9px;padding-top:10px;border-top:1px solid var(--line)}
#triage .ph{cursor:pointer;margin:0}
#triage .tbody{margin-top:8px}
.tg{color:var(--muted);font-size:11px;width:14px;flex:none;padding:0}
/* Bandeau des remarques en attente — présent sur TOUTES les vues, jamais filtré.
   L'ambre (et pas le rouge des priorités) dit « en attente », pas « urgent » : une
   remarque non instruite n'est pas une alarme, c'est une dette qui se perd. */
#pending{border:1px solid color-mix(in srgb,#f59e0b 42%,var(--line));border-left:3px solid #f59e0b;
  background:color-mix(in srgb,#f59e0b 7%,var(--panel));border-radius:9px;padding:11px 14px;
  margin:0 0 14px;max-height:min(38vh,320px);overflow:auto}
/* Partagé par le sas et le bandeau : ces deux zones ont la même anatomie. */
.ph{display:flex;align-items:baseline;gap:9px;margin:0 0 6px;font-size:12.5px}
.ph b{font-size:13px}
.ph span{color:var(--muted);font-size:11.5px}
.prem{display:flex;gap:9px;align-items:baseline;padding:6px 2px;border-top:1px solid
  color-mix(in srgb,#f59e0b 22%,transparent);cursor:pointer;font-size:13px}
.prem:first-of-type{border-top:0}
.prem:hover{background:color-mix(in srgb,#f59e0b 9%,transparent)}
.pid{font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);flex:none}
.pt{flex:1;min-width:0}
.pa{color:var(--muted);font-size:11.5px}
.pf{font-size:11.5px;color:var(--muted);margin:8px 0 0;padding-top:7px;
  border-top:1px solid color-mix(in srgb,#f59e0b 22%,transparent)}
.pf code{background:color-mix(in srgb,var(--ink) 8%,transparent);padding:1px 5px;border-radius:4px}
/* ── Vue « Mes actions » : deux canaux, jamais mélangés ────────────────────────
   La COULEUR dit la priorité — la même échelle P0..P3 que le kanban, le même badge.
   Le POIDS dit l'ampleur — combien de tickets l'action libère.
   Peindre le levier en rouge lui aussi rendrait le rouge ambigu : on ne saurait plus
   s'il crie « urgent » (jugement posé à la main) ou « débloquant » (fait calculé).
   L'ambre reste réservé à l'attente, comme partout ailleurs dans la page. */
.act{position:relative;display:flex;gap:10px;align-items:flex-start;padding:9px 4px 9px 14px;
  border-top:1px solid var(--line);cursor:pointer}
.act:first-of-type{border-top:0}
/* La colonne du milieu prend toute la place restante : sans ça, l'identité du ticket
   ne peut pas être rejetée à droite, elle colle au texte. */
.act>span:first-of-type{flex:1;min-width:0}
/* Le même filet de priorité que sur une carte du kanban : reconnu sans être appris. */
.act::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:3px;border-radius:2px;background:var(--p2)}
.act.P0::before{background:var(--p0)}.act.P1::before{background:var(--p1)}
.act.P2::before{background:var(--p2)}.act.P3::before{background:var(--p3)}
/* Ce qui est fait ne réclame plus rien : le filet s'éteint. */
.act.past::before{background:var(--line)}
.act input{margin:2px 0 0;width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex:none}
.act .at{font-size:13px}
.act .am{font-size:11.5px;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:3px}
.act.gone{opacity:.35;text-decoration:line-through}
.act .chev{margin-left:auto;color:var(--muted);font-size:12px;flex:none;padding-left:8px}
.act .wait{color:#b45309;font-weight:600}
/* Trois paliers, pas un dégradé : comparer des nuances est plus lent que lire un
   chiffre. Rien / un peu / beaucoup — et le chiffre exact reste écrit. */
.frees{font-variant-numeric:tabular-nums;border:1px solid var(--line);border-radius:5px;padding:.5px 5px}
.frees.big{font-weight:700;color:var(--ink);border-color:color-mix(in srgb,var(--ink) 34%,transparent);
  background:color-mix(in srgb,var(--ink) 7%,transparent)}
/* Identité du ticket : nécessaire (elle se copie vers la ligne de commande), jamais
   première — elle ne sert qu'une fois la décision prise. Rejetée à droite, ensemble. */
.act .who{margin-left:auto;display:flex;gap:8px;align-items:center;color:var(--muted)}
.act .who .id{font-weight:600;color:var(--muted)}
/* Tiroir d'action : la consigne, l'historique, et de quoi répondre. */
.draw{border-top:1px dashed var(--line);padding:12px 4px 16px;cursor:default}
.drawhd{display:flex;align-items:baseline;gap:10px;margin:6px 0 8px;font-size:12px}
.drawhd b{font-size:12px;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}
.drawhd a{margin-left:auto;font-size:11.5px}
.drawhd .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:5px;
  padding:1px 6px;margin-left:2px;cursor:pointer;text-transform:none;letter-spacing:0}
.drawhd .code:hover{border-color:var(--accent)}
.drawbody{font-size:13px;line-height:1.5;max-height:320px;overflow:auto;
  padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:8px}
.drawbody :first-child{margin-top:0}.drawbody :last-child{margin-bottom:0}
.jrn{display:flex;flex-direction:column;gap:8px}
.jit{border-left:2px solid var(--line);padding:2px 0 2px 10px}
.jit.pend{border-left-color:#f59e0b}
.jh{display:flex;gap:8px;align-items:baseline;font-size:12px;flex-wrap:wrap}
.jd{color:var(--muted);font-variant-numeric:tabular-nums}
.jt{font-size:12.5px}
.jc{font-size:13px;margin:3px 0 0;padding-left:2px}
.jok{font-size:11.5px;color:#15803d;margin-top:3px}
.jw{font-size:11.5px;color:#b45309;margin-top:3px}
.cform{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.cform textarea{width:100%;font:inherit;font-size:13px;padding:8px 10px;resize:vertical;
  background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px}
.cform textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
.cform button{align-self:flex-start}
.cform .meta{font-size:11px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;
  overflow-x:auto;font-size:12px;line-height:1.5;margin:10px 0}
pre code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
.tool{display:flex;align-items:center;gap:9px;margin:0 0 6px;flex-wrap:wrap}
.tool b{font-size:12px;letter-spacing:.08em;text-transform:uppercase}
/* Le :not(.w) est nécessaire : les badges de poids portent leurs propres couleurs, et
   la règle du muted les effacerait. Elle ne vaut que pour la légende du groupe. */
.tool>span:not(.w){color:var(--muted);font-size:11.5px}
.tool .w .frees,.tool .w .prio{font-size:11px}
/* L'en-tête d'un groupe porte son poids : sans lui, l'ordre des groupes ressemble à
   un hasard, et un ordre qu'on ne peut pas vérifier ne se lit plus. */
.tool .w{margin-left:auto;display:flex;align-items:center;gap:7px}
.rrow{display:grid;grid-template-columns:44px 1fr minmax(120px,220px) 52px;gap:12px;align-items:center;
  padding:9px 4px 3px;border-top:1px solid var(--line)}
.rrow:first-of-type{border-top:0}
.rrow .rid{font:600 12px/1 ui-monospace,Menlo,monospace;color:var(--ink)}
.rrow .rt{font-size:13px}
.rrow .rc{font-size:11.5px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.rbar{display:flex;height:7px;border-radius:4px;overflow:hidden;background:var(--line)}
.rbar i{display:block}
.rbar .d{background:var(--accent)}
.rbar .g{background:color-mix(in srgb,var(--accent) 45%,transparent)}
.rsub{grid-column:2/5;display:flex;gap:6px;flex-wrap:wrap;align-items:center;
  font-size:11.5px;color:var(--muted);padding:0 4px 9px}
.tick{border:1px solid var(--line);border-radius:5px;padding:1px 6px;cursor:pointer;font-size:11px}
.tick:hover{border-color:var(--ink);color:var(--ink)}
.blk{color:var(--p1)}
.phase{display:flex;align-items:baseline;gap:10px;margin:0 0 6px}
.phase b{font-size:12px;letter-spacing:.09em;text-transform:uppercase}
.phase span{color:var(--muted);font-size:11.5px}
.ghsum{color:var(--muted);font-size:12px;margin-bottom:12px}
.ghwrap{display:grid;grid-template-columns:auto minmax(0,1fr);background:var(--panel);
  border:1px solid var(--line);border-radius:11px;box-shadow:var(--shadow);overflow:auto}
.ghsvg{display:block;flex:none}
.ghedge{fill:none;stroke-width:1.6;opacity:.85}
.ghedge.merge{stroke-dasharray:3 2;opacity:.7}
.ghedge.dim{opacity:.15}
.ghnode{stroke:var(--panel);stroke-width:2}
.ghnode.merge{stroke-width:2.5}
.ghnode.dim{opacity:.22}
.ghrows{padding:16px 0}                       /* padding-top = PADY, pour aligner sur le graphe */
.ghrow{height:30px;display:flex;align-items:center;gap:9px;padding:0 14px;overflow:hidden;white-space:nowrap}
.ghrow:hover{background:color-mix(in srgb,var(--ink) 5%,transparent)}
.ghrow.dim{opacity:.32}
.ghh{font-size:11.5px;color:var(--muted);flex:none}
.ghref{font-size:10.5px;padding:0 6px;border-radius:999px;flex:none;
  border:1px solid color-mix(in srgb,var(--accent) 45%,var(--line));color:var(--accent);
  background:color-mix(in srgb,var(--accent) 10%,transparent)}
.ghref.head{border-color:var(--p1);color:var(--p1);font-weight:600}
.ghref.tag{border-color:var(--p2);color:var(--p2);background:color-mix(in srgb,var(--p2) 10%,transparent)}
.ghsub{font-size:12.5px;overflow:hidden;text-overflow:ellipsis}
.ghmeta{margin-left:auto;font-size:11px;color:var(--muted);flex:none;font-variant-numeric:tabular-nums}
.ghcal{margin-bottom:18px}
.ghcalhead{display:flex;align-items:center;gap:12px;margin-bottom:4px;flex-wrap:wrap}
.ghcaltitle{color:var(--muted);font-size:12px}
.callab{fill:var(--muted);font-size:8px}
.calsvg{width:100%;display:block}
.calcell{stroke:var(--panel);stroke-width:1}
.callegend{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;margin-left:auto}
.calkeys{display:inline-flex;gap:3px}
.calkey{width:12px;height:12px;border-radius:2.5px;display:inline-block}
@media (max-width:900px){.board{grid-template-columns:1fr 1fr}}
@media (max-width:560px){.board{grid-template-columns:1fr}main{padding:14px}}
`;

const CLIENT = `
const D = JSON.parse(document.getElementById('data').textContent);
const T = D.tickets, E = D.epics, EDGES = D.edges, G = D.git;
const byId = Object.fromEntries(T.map(t => [t.id, t]));
let GEDGES = EDGES;
const epicTitle = Object.fromEntries(E.map(e => [e.id, e.title]));
let view = localStorage.getItem('tks.view') || 'kanban';
let q = '';
const hidden = new Set(JSON.parse(localStorage.getItem('tks.hidden') || '["done","dropped"]'));
const hiddenP = new Set(JSON.parse(localStorage.getItem('tks.hiddenP') || '[]'));
const hiddenL = new Set(JSON.parse(localStorage.getItem('tks.hiddenL') || '[]'));
const hiddenA = new Set(JSON.parse(localStorage.getItem('tks.hiddenA') || '["done"]'));

const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const escape = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
// un hook contient souvent un identifiant technique entre backticks : le rendre lisible, sans plus.
const fmt = s => escape(s).replace(/\`([^\`]+)\`/g, '<code>$1</code>');
const match = t => {
  if (hidden.has(t.status) || hiddenP.has(t.priority) || (t.layer && hiddenL.has(t.layer))) return false;
  if (!q) return true;
  const s = (t.id + ' ' + t.hook + ' ' + (t.epic||'') + ' ' + t.owner + ' ' + t.priority).toLowerCase();
  return s.includes(q);
};

function cardHTML(t) {
  return '<div class="row"><span>' + t.icon + '</span><span class="id">' + t.id + '</span>' +
    '<span class="prio">' + t.priority + '</span>' +
    (t.epic ? '<span class="badge">' + t.epic + '</span>' : '') +
    '<span class="spacer"></span>' + (t.owner ? '<span>' + escape(t.owner) + '</span>' : '') +
    '</div><div class="hook">' + fmt(t.hook) + '</div>';
}

function renderKanban(root) {
  const cols = ['todo','doing','done','dropped'].filter(s => !hidden.has(s));
  const board = el('div', 'board');
  board.style.gridTemplateColumns = 'repeat(' + Math.max(cols.length, 1) + ',minmax(210px,1fr))';
  if (!cols.length) { root.appendChild(el('div','empty','Tous les statuts sont masqués.')); return; }
  for (const st of cols) {
    const list = T.filter(t => t.status === st && match(t))
      .sort((a,b) => a.priority.localeCompare(b.priority) || (a.epic||'zz').localeCompare(b.epic||'zz') || a.id.localeCompare(b.id));
    const col = el('div', 'col');
    col.appendChild(el('div', 'colhead', '<b>' + D.labels[st] + '</b><span>' + list.length + '</span>'));
    if (!list.length) col.appendChild(el('div', 'empty', '—'));
    for (const t of list) {
      const c = el('div', 'card ' + t.priority + ' ' + t.status, cardHTML(t));
      c.onclick = () => openTicket(t.id);
      col.appendChild(c);
    }
    board.appendChild(col);
  }
  root.appendChild(board);
}

function renderThreads(root) {
  const groups = {};
  for (const t of T) (groups[t.epic || '—'] ||= []).push(t);
  // l'épique la plus récemment alimentée en premier : le récit vivant avant l'archive
  const recency = k => groups[k].reduce((m, t) => (t.created && t.created > m ? t.created : m), '');
  const keys = Object.keys(groups).sort((a, b) => recency(b).localeCompare(recency(a)) || a.localeCompare(b));
  let shown = 0;
  for (const k of keys) {
    const list = groups[k].filter(match)
      .sort((a,b) => (a.created||'9999').localeCompare(b.created||'9999') || a.id.localeCompare(b.id));
    if (!list.length) continue;
    shown++;
    const box = el('div', 'thread');
    box.appendChild(el('h2', null, escape(epicTitle[k] || k) + '<span class="k">' + k + ' · ' + list.length + '</span>'));
    const prose = D.epicBodies[k];
    if (prose) box.appendChild(el('div', 'prose', prose));
    const tl = el('div', 'tl');
    for (const t of list) {
      const n = el('div', 'node ' + t.priority + ' ' + t.status);
      const bits = [t.icon + ' ' + t.id, t.priority, D.labels[t.status]];
      if (t.created) bits.unshift(t.created);
      if (t.owner) bits.push('@' + t.owner);
      n.innerHTML = '<div class="h">' + fmt(t.hook) + '</div><div class="s"><span>' + bits.join(' · ') + '</span>' +
        (t.follows ? '<span class="follows">↳ suit ' + t.follows + '</span>' : '') +
        (t.origin ? '<span>' + escape(t.origin) + '</span>' : '') + '</div>';
      n.onclick = () => openTicket(t.id);
      tl.appendChild(n);
    }
    box.appendChild(tl);
    root.appendChild(box);
  }
  if (!shown) root.appendChild(el('div', 'empty', 'Aucun ticket ne correspond.'));
}

function renderGraph(root) {
  // Ici le filtre ÉCLAIRE, il ne retranche pas : une chaîne de blocage relie par nature des
  // priorités différentes (un P1 bloqué par un P3 reste l'information la plus utile de la vue).
  GEDGES = D.edges.filter(e => byId[e.from] && byId[e.to]);
  const involved = new Set();
  for (const e of GEDGES) { involved.add(e.from); involved.add(e.to); }
  if (!involved.size) { root.appendChild(el('div','empty','Aucun blocage déclaré.')); return; }
  const lit = [...involved].filter(id => match(byId[id])).length;
  if (lit < involved.size)
    root.appendChild(el('div', 'meta', 'Chaînes complètes conservées — ' + lit + ' des ' +
      involved.size + ' tickets liés correspondent au filtre, les autres restent en retrait.'));
  // profondeur = plus long chemin depuis une racine (ce qui ne bloque rien en amont)
  const depth = {};
  const incoming = {};
  for (const id of involved) incoming[id] = GEDGES.filter(e => e.to === id).map(e => e.from);
  const visit = (id, seen) => {
    if (depth[id] != null) return depth[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = incoming[id].length ? Math.max(...incoming[id].map(p => visit(p, seen))) + 1 : 0;
    seen.delete(id);
    return (depth[id] = d);
  };
  for (const id of involved) visit(id, new Set());
  const maxD = Math.max(...Object.values(depth));

  const wrap = el('div', 'layers');
  for (let d = 0; d <= maxD; d++) {
    const layer = el('div', 'layer');
    layer.appendChild(el('div', 'lab', d === 0 ? 'ne dépend de rien' : 'niveau ' + d));
    for (const id of [...involved].filter(i => depth[i] === d).sort()) {
      const t = byId[id];
      const n = el('div', 'gnode ' + t.priority + ' ' + t.status + (match(t) ? '' : ' off'),
        '<span>' + t.icon + '</span> <span class="id">' + id + '</span><div class="hk">' + fmt(t.hook) + '</div>');
      n.dataset.id = id;
      n.onclick = () => openTicket(id);
      n.onmouseenter = () => highlight(id);
      n.onmouseleave = () => highlight(null);
      layer.appendChild(n);
    }
    wrap.appendChild(layer);
  }
  const host = el('div'); host.id = 'graph';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'wires');
  host.appendChild(svg); host.appendChild(wrap);
  root.appendChild(host);
  requestAnimationFrame(() => wires(host, svg));
}

let rz;
addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => {
    const host = document.getElementById('graph');
    if (host) wires(host, host.querySelector('svg.wires'));
  }, 120);
});

function wires(host, svg) {
  svg.innerHTML = '';
  const base = host.getBoundingClientRect();
  const pos = {};
  for (const n of host.querySelectorAll('.gnode')) {
    const r = n.getBoundingClientRect();
    pos[n.dataset.id] = { x: r.left - base.left + host.scrollLeft, y: r.top - base.top + host.scrollTop, w: r.width, h: r.height };
  }
  for (const e of GEDGES) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
    const dx = Math.max(28, (x2 - x1) / 2);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + (x1+dx) + ',' + y1 + ' ' + (x2-dx) + ',' + y2 + ' ' + x2 + ',' + y2);
    p.dataset.from = e.from; p.dataset.to = e.to;
    svg.appendChild(p);
  }
  svg.setAttribute('width', host.scrollWidth); svg.setAttribute('height', host.scrollHeight);
}

function highlight(id) {
  for (const p of document.querySelectorAll('svg.wires path'))
    p.classList.toggle('hot', !!id && (p.dataset.from === id || p.dataset.to === id));
  for (const n of document.querySelectorAll('.gnode')) {
    if (!id) { n.classList.remove('dim'); continue; }
    const linked = n.dataset.id === id || GEDGES.some(e =>
      (e.from === id && e.to === n.dataset.id) || (e.to === id && e.from === n.dataset.id));
    n.classList.toggle('dim', !linked);
  }
}

// ─── Historique git : graphe des commits, branches et fusions (façon git log --graph)
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
// Couleur déterministe par couloir : teintes réparties, lisibles en clair comme en sombre.
const laneColor = col => 'hsl(' + ((col * 67) % 360) + ' 60% 55%)';
const relTime = iso => {
  const d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
  if (!isFinite(s)) return '';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min';
  if (s < 86400) return Math.round(s / 3600) + ' h';
  if (s < 2592000) return Math.round(s / 86400) + ' j';
  return d.toISOString().slice(0, 10);
};
const matchCommit = c => { if (!q) return true;
  return (c.h + ' ' + c.subject + ' ' + c.author + ' ' + c.refs.join(' ')).toLowerCase().includes(q); };

// Calendrier d'activité (heatmap de contributions, façon GitHub) : commits/jour sur ~53
// semaines. Pleine largeur : les carrés restent PETITS et carrés, c'est leur espacement
// horizontal qui s'étire pour occuper toute la largeur (mesurée au rendu + au resize).
// Intensité relative au jour le plus actif → dégradé bleu clair (#87d4f2) vers magenta.
const CAL_COLORS = ['rgba(130,130,145,.16)', '#87d4f2', '#a59bd7', '#c363bb', '#e12aa0'];
const DOW_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const MON_FR = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
const mondayRow = d => (d.getDay() + 6) % 7; // Lun=0 … Dim=6
let calRelayout = null; // réexécuté au resize pour re-répartir les colonnes

function commitCalendar(counts) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (52 * 7 + mondayRow(today))); // recule jusqu'à un lundi
  const days = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    days.push({ key, date: new Date(d), count: counts[key] || 0 });
  }
  const max = Math.max(1, ...days.map(x => x.count));
  const weeks = Math.ceil(days.length / 7);

  const svg = svgEl('svg', { class: 'calsvg' }); // largeur 100 % via CSS ; hauteur posée au layout
  // Répartition : la largeur d'une colonne = largeur dispo / nb semaines. Les carrés gardent
  // une petite taille fixe (≤ 10 px, hauteur totale ≤ ~100 px) et sont centrés dans leur colonne.
  const layout = () => {
    const Wpx = Math.round(svg.getBoundingClientRect().width);
    if (!Wpx) return;
    const LEFT = 22, TOP = 12, ROWGAP = 3;
    const colStep = (Wpx - LEFT) / weeks;
    const CELL = Math.max(6, Math.min(9, Math.floor(colStep) - 2));
    const rowStep = CELL + ROWGAP;
    const H = TOP + 7 * rowStep;
    svg.setAttribute('viewBox', '0 0 ' + Wpx + ' ' + H);
    svg.setAttribute('height', H);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    let lastMonth = -1;
    days.forEach((x, i) => {
      const col = Math.floor(i / 7), row = mondayRow(x.date);
      const lvl = x.count === 0 ? 0 : Math.min(4, Math.ceil(x.count / max * 4)); // 0 = rien ; 1..4 = quartiles
      const cx = LEFT + col * colStep + (colStep - CELL) / 2;
      const rect = svgEl('rect', { x: cx, y: TOP + row * rowStep, width: CELL, height: CELL, rx: 2, fill: CAL_COLORS[lvl], class: 'calcell' });
      const t = svgEl('title', {}); t.textContent = x.count + (x.count === 1 ? ' commit' : ' commits') + ' · ' + x.key;
      rect.appendChild(t); svg.appendChild(rect);
      if (row === 0 && x.date.getMonth() !== lastMonth) {
        lastMonth = x.date.getMonth();
        const lab = svgEl('text', { x: cx, y: TOP - 4, class: 'callab' }); lab.textContent = MON_FR[lastMonth]; svg.appendChild(lab);
      }
    });
    for (const r of [0, 2, 4]) { const lab = svgEl('text', { x: 0, y: TOP + r * rowStep + CELL - 1, class: 'callab' }); lab.textContent = DOW_FR[r]; svg.appendChild(lab); }
  };
  calRelayout = layout;
  requestAnimationFrame(layout);

  const total = days.reduce((n, x) => n + x.count, 0), active = days.filter(x => x.count).length;
  const legend = el('span', 'callegend', 'Moins');
  const keys = el('span', 'calkeys');
  for (const c of CAL_COLORS) { const s = el('span', 'calkey'); s.style.background = c; keys.appendChild(s); }
  legend.appendChild(keys); legend.appendChild(document.createTextNode('Plus'));
  const head = el('div', 'ghcalhead');
  head.appendChild(el('span', 'ghcaltitle', total + ' commits · ' + active + ' jour' + (active > 1 ? 's' : '') + ' actif' + (active > 1 ? 's' : '') + ' · 53 sem.'));
  head.appendChild(legend);
  const wrap = el('div', 'ghcal');
  wrap.appendChild(head); wrap.appendChild(svg);
  return wrap;
}
addEventListener('resize', () => { if (calRelayout) requestAnimationFrame(calRelayout); });

function renderHistory(root) {
  if (!G || !G.commits.length) { root.appendChild(el('div', 'empty', 'Aucun historique git dans ce dossier.')); return; }
  if (G.activity) root.appendChild(commitCalendar(G.activity));
  const ROW = 30, COLW = 20, PADX = 20, PADY = 16, R = 4.5;
  const rowOf = {}; G.commits.forEach((c, i) => rowOf[c.H] = i);
  const X = col => PADX + col * COLW, Y = i => PADY + i * ROW + ROW / 2;
  const graphW = PADX * 2 + Math.max(1, G.laneCount) * COLW;
  const totalH = PADY * 2 + G.commits.length * ROW;

  root.appendChild(el('div', 'ghsum',
    G.commits.length + (G.truncated ? '+' : '') + ' commits · ' + G.merges + ' fusions · ' +
    G.laneCount + ' couloir' + (G.laneCount > 1 ? 's' : '') + (G.truncated ? ' · tronqué aux ' + G.commits.length + ' plus récents' : '')));

  const wrap = el('div', 'ghwrap');
  const svg = svgEl('svg', { class: 'ghsvg', width: graphW, height: totalH, viewBox: '0 0 ' + graphW + ' ' + totalH });

  // Arêtes enfant → parent : verticales dans le même couloir, courbées lors d'un changement.
  for (const e of G.edges) {
    const a = G.commits[rowOf[e.from]], b = G.commits[rowOf[e.to]];
    if (!a || !b) continue;
    const x1 = X(a.col), y1 = Y(rowOf[e.from]), x2 = X(b.col), y2 = Y(rowOf[e.to]);
    const d = a.col === b.col ? 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2
      : 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + ((y1 + y2) / 2) + ' ' + x2 + ',' + ((y1 + y2) / 2) + ' ' + x2 + ',' + y2;
    const dim = q && !matchCommit(a) && !matchCommit(b);
    svg.appendChild(svgEl('path', { d, class: 'ghedge' + (e.merge ? ' merge' : '') + (dim ? ' dim' : ''), stroke: laneColor(Math.min(a.col, b.col)) }));
  }
  // Nœuds : un cercle par commit ; les fusions (≥2 parents) sont un peu plus grosses.
  G.commits.forEach((c, i) => {
    const merge = c.parents.length > 1;
    svg.appendChild(svgEl('circle', { cx: X(c.col), cy: Y(i), r: merge ? R + 1.5 : R,
      fill: laneColor(c.col), class: 'ghnode' + (merge ? ' merge' : '') + (q && !matchCommit(c) ? ' dim' : '') }));
  });
  wrap.appendChild(svg);

  // Colonne de droite : métadonnées alignées ligne à ligne avec le graphe.
  const rows = el('div', 'ghrows');
  for (const c of G.commits) {
    const refs = c.refs.map(r => {
      const head = r === 'HEAD' || r.startsWith('HEAD ->');
      const tag = r.startsWith('tag:');
      const label = r.replace(/^tag:\s*/, '').replace(/^HEAD -> /, '');
      return '<span class="ghref' + (tag ? ' tag' : head ? ' head' : '') + '">' + escape(label) + '</span>';
    }).join('');
    const row = el('div', 'ghrow' + (q && !matchCommit(c) ? ' dim' : ''),
      '<code class="ghh">' + escape(c.h) + '</code>' + refs +
      '<span class="ghsub">' + fmt(c.subject) + '</span>' +
      '<span class="ghmeta">' + escape(c.author) + ' · ' + relTime(c.date) + '</span>');
    rows.appendChild(row);
  }
  wrap.appendChild(rows);
  root.appendChild(wrap);
}

function renderRoadmap(root) {
  const phaseRank = p => { const m = (p || '').match(/\d+/); return m ? +m[0] : 98; };
  const label = p => !p ? 'Sans phase' : (/^[0-9]/.test(p) ? 'Phase ' + p : p.charAt(0).toUpperCase() + p.slice(1));
  const groups = {};
  for (const e of E) (groups[e.phase || ''] ||= []).push(e);
  const keys = Object.keys(groups).sort((a, b) => phaseRank(a) - phaseRank(b) || a.localeCompare(b));

  const epicOf = id => (byId[id] || {}).epic;
  const between = {};
  for (const e of D.edges) {
    const a = epicOf(e.from), b = epicOf(e.to);
    if (!a || !b || a === b) continue;
    (between[a] ||= { blocks: new Set(), by: new Set() }).blocks.add(b);
    (between[b] ||= { blocks: new Set(), by: new Set() }).by.add(a);
  }

  const row = (e, box) => {
    const list = T.filter(t => t.epic === e.id && t.status !== 'dropped');
    if (q && !((e.id + ' ' + e.title).toLowerCase().includes(q) || list.some(match))) return;
    const done = list.filter(t => t.status === 'done').length;
    const doing = list.filter(t => t.status === 'doing').length;
    const n = list.length || 1;
    const r = el('div', 'rrow');
    r.innerHTML = '<div class="rid">' + e.id + '</div><div class="rt">' + escape(e.title) + '</div>' +
      '<div class="rbar"><i class="d" style="width:' + (done / n * 100) + '%"></i>' +
      '<i class="g" style="width:' + (doing / n * 100) + '%"></i></div>' +
      '<div class="rc">' + done + '/' + list.length + '</div>';
    box.appendChild(r);

    const sub = el('div', 'rsub');
    const rel = between[e.id];
    if (rel && rel.by.size) sub.appendChild(el('span', 'blk', '⛔ bloquée par ' + [...rel.by].join(', ')));
    if (rel && rel.blocks.size) sub.appendChild(el('span', null, '↦ bloque ' + [...rel.blocks].join(', ')));
    const urgent = list.filter(t => t.status !== 'done' && (t.priority === 'P0' || t.priority === 'P1'));
    if (urgent.length) {
      sub.appendChild(el('span', null, 'reste'));
      for (const t of urgent) {
        const c = el('span', 'tick ' + t.priority, t.icon + ' ' + t.id);
        c.onclick = () => openTicket(t.id);
        sub.appendChild(c);
      }
    }
    if (sub.childNodes.length) box.appendChild(sub);
  };

  for (const k of keys) {
    const box = el('div', 'thread');
    const fns = groups[k].sort((a, b) => (+a.id.slice(1) || 0) - (+b.id.slice(1) || 0));
    const all = T.filter(t => fns.some(e => e.id === t.epic) && t.status !== 'dropped');
    const ph = el('div', 'phase');
    ph.innerHTML = '<b>' + label(k) + '</b><span>' + fns.length + (fns.length > 1 ? ' fonctions · ' : ' fonction · ') +
      all.filter(t => t.status === 'done').length + '/' + all.length + ' tickets faits</span>';
    box.appendChild(ph);
    for (const e of fns) row(e, box);
    if (box.childNodes.length > 1) root.appendChild(box);
  }
}

function renderRecipes(root) {
  if (!D.recipes.length) { root.appendChild(el('div', 'empty', 'Aucune recette.')); return; }
  for (const r of D.recipes) {
    const box = el('div', 'thread');
    box.appendChild(el('h2', null, escape(r.title) + '<span class="k">' + r.id + '</span>'));
    if (r.when) box.appendChild(el('div', 'meta', escape(r.when)));
    box.appendChild(el('div', 'prose db', D.recipeBodies[r.id] || ''));
    root.appendChild(box);
  }
}

/**
 * Ce que pèse un groupe d'actions : sa priorité la plus haute, et les tickets DISTINCTS
 * qu'il libère. Miroir exact de toolWeight() côté générateur — la page regroupe
 * elle-même (elle filtre les cochées), elle doit donc savoir compter pareil.
 */
function weigh(acts) {
  const frees = new Set();
  for (const a of acts) for (const id of (a.frees || [])) frees.add(id);
  return {
    top: acts.reduce((m, a) => (a.priority < m ? a.priority : m), 'P3'),
    frees: frees.size,
    max: acts.reduce((m, a) => (a.unblocks > m ? a.unblocks : m), 0),
  };
}

/**
 * Le chiffre que tu veux voir en premier, gradué en trois paliers — voir le CSS.
 *
 * Zéro n'écrit RIEN. « ne débloque rien d'autre » se lisait comme une réponse
 * rassurante sur deux ou trois lignes ; sur un vrai backlog il s'empile dix fois de
 * suite dans le même groupe et devient du papier peint, qui affaiblit les deux vrais
 * leviers juste au-dessus. Les actions étant triées levier en tête, l'ABSENCE de
 * pastille se lit sans ambiguïté — et elle laisse la place à ce qui, lui, dit quelque chose.
 */
function freesChip(n, total) {
  if (!n) return '';
  return '<span class="frees' + (n >= 3 ? ' big' : '') + '" title="Tickets encore ouverts '
    + (total ? 'que ce groupe libère' : 'que cette action libère') + '">'
    + '🔓 débloque ' + n + ' ticket' + (n > 1 ? 's' : '') + (total ? ' en tout' : '') + '</span>';
}

function renderActions(root) {
  const acts = hiddenA.has('todo') ? [] : D.actions.filter(a => !DONE.has(a.id));
  if (!hiddenA.has('done')) doneList(root);
  if (hiddenA.has('todo')) return;
  if (!acts.length) { root.appendChild(el('div','empty','Rien ne t\\'attend. Le goulot, ce n\\'est pas toi.')); return; }
  const groups = {};
  for (const a of acts) (groups[a.tool] ||= []).push(a);
  // Même règle qu'à l'intérieur d'un groupe (voir byUrgency côté générateur) : P0
  // d'abord, puis ce qui débloque le plus. Trier par NOMBRE d'actions, comme avant,
  // enterrait le gros levier sous un groupe de broutilles.
  const W = {};
  for (const k of Object.keys(groups)) W[k] = weigh(groups[k]);
  const keys = Object.keys(groups).sort((x, y) =>
    (W[x].top === 'P0' ? 0 : 1) - (W[y].top === 'P0' ? 0 : 1) || W[y].frees - W[x].frees
    || W[x].top.localeCompare(W[y].top) || groups[y].length - groups[x].length || x.localeCompare(y));

  if (!D.live) root.appendChild(el('div', 'empty',
    'Page statique : les cases ne peuvent pas s\\'enregistrer. Lance « node scripts/backlog.mjs --serve » pour cocher.'));

  for (const k of keys) {
    const box = el('div', 'thread');
    const t = el('div', 'tool ' + W[k].top);
    // Rien n'est répété ici. Les lignes étant triées par la même règle, la première
    // d'entre elles — à quelques pixels sous cet en-tête — porte déjà la priorité la
    // plus haute du groupe et, presque toujours, son plus gros levier. Le total ne
    // s'affiche donc que s'il dépasse cette ligne, c'est-à-dire quand plusieurs
    // actions du groupe libèrent des tickets DIFFÉRENTS. Le reste du temps, l'en-tête
    // se tait : deux fois la même information, c'est une information qu'on cesse de lire.
    t.innerHTML = '<b>' + escape(k) + '</b><span>' + groups[k].length + ' action' +
      (groups[k].length > 1 ? 's' : '') + ' — à faire d\\'un seul tenant</span>' +
      (W[k].frees > W[k].max ? '<span class="w">' + freesChip(W[k].frees, true) + '</span>' : '');
    box.appendChild(t);
    for (const a of groups[k]) {
      const pend = (D.journals[a.id] || []).filter(e => e.pending).length;
      const row = el('div', 'act ' + a.priority);
      // Ordre de lecture = ordre de décision : ce qui la classe d'abord (priorité,
      // ampleur, remarques qui attendent), son identité seulement ensuite.
      row.innerHTML = '<input type="checkbox"' + (D.live ? '' : ' disabled') + '>' +
        '<span><span class="at">' + fmt(a.text) + '</span><span class="am">' +
        '<span class="prio">' + a.priority + '</span>' + freesChip(a.unblocks) +
        (pend ? '<span class="wait">💬 ' + pend + ' remarque' + (pend > 1 ? 's' : '') + ' en attente</span>' : '') +
        '<span class="who">' + (a.epic ? '<span>' + a.epic + '</span>' : '') +
        '<span class="id">' + a.icon + ' ' + a.id + '</span></span>' +
        '</span></span><span class="chev">▾</span>';
      // Cocher emporte le texte en cours de saisie : sinon on perd la remarque
      // de celui qui écrit d'abord et coche ensuite — l'ordre le plus naturel.
      row.querySelector('input').onchange = () => send(a, row, false, dr.pendingText && dr.pendingText());
      const dr = drawer(a.id, a.text);
      row.onclick = ev => {
        if (ev.target.tagName === 'INPUT') return;
        const open = dr.hidden;
        dr.hidden = !open;
        row.querySelector('.chev').textContent = open ? '▴' : '▾';
      };
      row.title = 'Cliquer pour dérouler · cocher la case pour marquer fait';
      box.appendChild(row);
      box.appendChild(dr);
    }
    root.appendChild(box);
  }
}

/**
 * Tiroir d'une action : ce qu'il faut faire, l'historique des échanges, et de quoi
 * ajouter une remarque.
 *
 * Le « quoi faire » est le CORPS DU TICKET — pas un champ séparé. Une consigne qui
 * vivrait à part finirait par contredire le ticket : une seule source, forcément à jour.
 */
function drawer(id, actionText) {
  const d = el('div', 'draw');
  d.hidden = true;
  d.onclick = ev => ev.stopPropagation();          // cliquer dedans ne referme pas

  // L'identifiant du ticket EST le code de l'action : le format n'autorise qu'une
  // action en attente par ticket, donc « EX-117 » la désigne sans ambiguïté. Pas de
  // numérotation parallèle — ce serait une seconde identité à tenir synchronisée.
  const head = el('div', 'drawhd');
  head.innerHTML = '<b>Action <span class="code" title="Cliquer pour copier">' + id + '</span></b>' +
    '<a href="#" class="ghost" data-goto="' + id + '">ouvrir le ticket</a>';
  head.querySelector('.code').onclick = ev => {
    ev.stopPropagation();
    const c = ev.target;
    navigator.clipboard.writeText(id).then(() => {
      const was = c.textContent;
      c.textContent = 'copié ✓';
      setTimeout(() => { c.textContent = was; }, 900);
    }).catch(() => { /* presse-papiers refusé : l'identifiant reste lisible à l'écran */ });
  };
  d.appendChild(head);
  d.appendChild(el('div', 'drawbody', D.bodies[id] || '<p class="meta">(pas de consigne écrite)</p>'));

  const j = (D.journals[id] || []);
  if (j.length) {
    d.appendChild(el('div', 'drawhd', '<b>Historique</b>'));
    const log = el('div', 'jrn');
    for (const e of j) {
      const it = el('div', 'jit' + (e.pending ? ' pend' : ''));
      let h = '<div class="jh"><span class="jk">' + (e.kind === 'action' ? '✅' : '💬') + '</span>' +
        '<span class="jd">' + e.date + '</span><span class="jt">' + escape(e.text) + '</span></div>';
      if (e.comment) h += '<div class="jc">' + escape(e.comment).replace(/\\n/g, '<br>') + '</div>';
      if (e.ack) h += '<div class="jok">✓ pris en compte — ' + escape(e.ack) + '</div>';
      else if (e.pending) h += '<div class="jw">⏳ en attente — sera marquée quand ce sera traité</div>';
      it.innerHTML = h;
      log.appendChild(it);
    }
    d.appendChild(log);
  }

  if (!D.live) {
    d.appendChild(el('div', 'empty', 'Page statique : lance « --serve » pour commenter.'));
    return d;
  }
  const form = el('div', 'cform');
  const ta = document.createElement('textarea');
  ta.rows = 2;
  ta.placeholder = 'Ce que tu as constaté…';
  ta.onclick = ev => ev.stopPropagation();
  const btn = document.createElement('button');
  btn.className = 'ghost'; btn.textContent = '+ ajouter un commentaire';
  const hint = el('span', 'meta',
    'Joint au ticket. Si tu coches l\\'action, le texte est rattaché à « ' + escape(actionText) + ' ».');
  btn.onclick = async () => {
    const txt = ta.value.trim();
    if (!txt) { ta.focus(); return; }
    btn.disabled = true;
    try {
      const r = await fetch('/api/comment', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id, comment: txt }),
      });
      if (!r.ok) throw new Error(await r.text());
      ta.value = '';                                 // fs.watch régénère, la page se recharge
    } catch (e) {
      alert('Impossible d\\'enregistrer : ' + e.message);
    } finally { btn.disabled = false; }
  };
  form.appendChild(ta); form.appendChild(btn); form.appendChild(hint);
  d.appendChild(form);
  // Le texte saisi part avec la case si on coche sans avoir cliqué le bouton.
  d.pendingText = () => ta.value.trim();
  return d;
}

/**
 * Bandeau des remarques en attente — rendu UNE fois, hors du cycle des vues.
 *
 * Une remarque n'était visible que dans le tiroir d'une action, dans l'onglet « Mes
 * actions ». Conséquence : un commentaire libre posé sur un ticket SANS action
 * n'apparaissait nulle part — il fallait ouvrir le ticket et le repérer au milieu du
 * corps. C'est exactement ce qu'un système de remarques ne doit pas faire.
 *
 * Volontairement hors de « render() » et hors des filtres : les filtres servent à explorer
 * le backlog, pas à décider ce qu'on a le droit d'oublier. Une remarque masquée par un
 * filtre de priorité serait une remarque perdue.
 */
/**
 * Le sas « À trancher » : ce qui s'écrit ici n'a pas de ticket d'accueil.
 *
 * C'est la seule zone d'écriture LIBRE de l'outil, et elle existe parce que la règle
 * inverse — « toute remarque se rattache à un ticket existant » — supposait que le
 * tout-venant se disait ailleurs. Il ne se disait pas ailleurs : il se perdait.
 *
 * Le rattachement est facultatif et le restera. Imposer de choisir une cible avant
 * d'écrire, c'est demander d'instruire avant d'avoir noté — et c'est précisément le
 * moment où l'on renonce à noter.
 */
function renderTriage() {
  const host = document.getElementById('triage');
  const open = D.triage || [];

  // Replié par défaut. C'est une zone d'ÉCRITURE : elle n'a pas à occuper le haut de
  // l'écran en permanence comme le fait une alerte. Mais le COMPTE reste toujours visible,
  // replié compris — c'est lui, et lui seul, qui tient la promesse « rien ne dort ici ».
  let shown = localStorage.getItem('tks.triage') === '1';
  const head = el('div', 'ph');
  head.innerHTML = '<button class="tg" aria-expanded="false">▸</button><b>🧾 ' +
    (open.length ? open.length + ' remarque' + (open.length > 1 ? 's' : '') + ' à trancher'
                 : 'Rien à trancher') + '</b>' +
    '<span>sans ticket — chacune doit en devenir un, ou être écartée</span><span class="spacer"></span>';
  const add = document.createElement('button');
  add.className = 'ghost'; add.textContent = '+ Commentaire / Ticket';
  head.appendChild(add);
  host.appendChild(head);

  const body = el('div', 'tbody');
  let h = '';
  for (const e of open) {
    h += '<div class="tnote"><span class="pid">' + e.id + '</span>' +
      '<span class="pt">' + escape(e.text) +
      (e.about ? ' <a href="#" data-goto="' + e.about + '" class="tref">↦ ' + escape(e.about) + '</a>' : '') +
      '</span><span class="pa">' + e.date + '</span></div>';
  }
  body.innerHTML = h;
  host.appendChild(body);

  const toggle = (on) => {
    shown = on;
    body.hidden = !on;
    head.querySelector('.tg').textContent = on ? '▾' : '▸';
    head.querySelector('.tg').setAttribute('aria-expanded', String(on));
    localStorage.setItem('tks.triage', on ? '1' : '0');
  };
  head.onclick = ev => { if (ev.target !== add) toggle(!shown); };
  add.onclick = () => {
    toggle(true);
    const ta = body.querySelector('textarea');
    if (ta) ta.focus();
  };
  toggle(shown);

  if (D.live) {
    const form = el('div', 'cform');
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Une remarque, une idée, un constat — sans avoir à choisir de ticket…';
    const sel = document.createElement('select');
    sel.className = 'tsel';
    sel.innerHTML = '<option value="">— sans rattachement —</option>' +
      (D.refs || []).map(r => '<option value="' + r.id + '">' + r.id + ' — ' +
        escape(r.label).slice(0, 70) + '</option>').join('');
    const btn = document.createElement('button');
    btn.className = 'ghost'; btn.textContent = '+ déposer';
    btn.onclick = async () => {
      const txt = ta.value.trim();
      if (!txt) { ta.focus(); return; }
      btn.disabled = true;
      try {
        const r = await fetch('/api/note', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ comment: txt, about: sel.value }),
        });
        if (!r.ok) throw new Error(await r.text());
        ta.value = '';                                  // fs.watch régénère, la page se recharge
      } catch (e) {
        alert('Impossible d\\'enregistrer : ' + e.message);
      } finally { btn.disabled = false; }
    };
    form.appendChild(ta);
    const row = el('div', 'trow');
    row.appendChild(sel); row.appendChild(btn);
    row.appendChild(el('span', 'meta', 'Le rattachement est facultatif — il sert à me situer, pas à classer.'));
    form.appendChild(row);
    body.appendChild(form);
  } else if (!open.length) {
    // Page statique et rien en attente : le sas n'a rien à dire, et on ne peut pas y écrire.
    host.hidden = true;
  }
}

function renderPending() {
  const host = document.getElementById('pending');
  const groups = D.pending || [];
  if (!groups.length) { host.hidden = true; return; }
  const n = groups.reduce((s, g) => s + g.items.length, 0);
  let h = '<div class="ph"><b>💬 ' + n + ' remarque' + (n > 1 ? 's' : '') + ' en attente</b>' +
    '<span>écrites ici, pas encore instruites</span></div>';
  for (const g of groups) {
    for (const e of g.items) {
      h += '<div class="prem" data-goto="' + g.id + '" title="Ouvrir ' + g.id + '">' +
        '<span class="pid">' + (e.kind === 'comment' ? '💬' : '✅') + ' ' + g.id + '</span>' +
        '<span class="pt">' + escape(e.text) +
        (e.about ? '<span class="pa"> — sur : ' + escape(e.about) + '</span>' : '') +
        '</span><span class="pa">' + e.date + '</span></div>';
    }
  }
  // Rappeler la règle là où la tentation est la plus forte : on voit la liste, on voudrait
  // une case à cocher. « Pris en compte » est un arbitrage, pas un accusé de lecture.
  h += '<p class="pf">Se marquent en ligne de commande, avec une note qui dit ce qui en a été ' +
    'fait : <code>node backlog.mjs --ack &lt;ID&gt; "…"</code></p>';
  host.innerHTML = h;
  host.hidden = false;
}

function doneList(root) {
  const list = D.doneActions || [];
  if (!list.length) { root.appendChild(el('div', 'empty', 'Rien de coché pour le moment.')); return; }
  const box = el('div', 'thread');
  box.appendChild(el('div', 'tool', '<b>Fait</b><span>' + list.length + ' action' +
    (list.length > 1 ? 's' : '') + ' cochées — journalisées dans leur ticket</span>'));
  for (const a of list) {
    const row = el('div', 'act past');
    row.innerHTML = '<input type="checkbox" checked' + (D.live ? '' : ' disabled') + '>' +
      '<span><span class="at">' + fmt(a.text) + '</span><span class="am">' +
      '<span>' + a.date + '</span><span>' + escape(a.tool) + '</span>' +
      '<span class="who"><span class="id">' + a.icon + ' ' + a.id + '</span></span></span></span>';
    row.style.opacity = '.6';
    row.querySelector('input').onchange = () => send(a, row, true);
    row.onclick = ev => { if (ev.target.tagName !== 'INPUT') openTicket(a.id); };
    row.title = 'Cliquer pour voir le détail · décocher pour remettre en attente';
    box.appendChild(row);
  }
  root.appendChild(box);
}

const DONE = new Set();
async function send(a, row, undo, comment) {
  row.classList.toggle('gone', !undo);
  try {
    const r = await fetch(undo ? '/api/action/undo' : '/api/action/done', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: a.id, comment: comment || '' }),
    });
    if (!r.ok) throw new Error(await r.text());
    if (undo) DONE.delete(a.id); else DONE.add(a.id);   // fs.watch régénère, la page se recharge seule
    badge();
  } catch (e) {
    row.classList.remove('gone');
    row.querySelector('input').checked = undo;
    alert('Impossible d\\'enregistrer : ' + e.message);
  }
}

function badge() {
  const n = D.actions.filter(a => !DONE.has(a.id)).length;
  document.title = (n ? '(' + n + ') ' : '') + 'Backlog — ' + T.length + ' tickets';
  const b = document.querySelector('.alert');
  if (b) b.textContent = n ? '⏳ ' + n + ' actions' : '✓ aucune action en attente';
  const p = document.querySelector('.tab[data-view=actions] .pill');
  if (p) p.textContent = n;
}

const dlg = document.querySelector('dialog');
function openTicket(id) {
  const t = byId[id];
  if (!t) return;
  const rel = [];
  if (t.follows) rel.push('suit ' + t.follows);
  const blocks = EDGES.filter(e => e.from === id).map(e => e.to);
  const blockedBy = EDGES.filter(e => e.to === id).map(e => e.from);
  if (blocks.length) rel.push('bloque ' + blocks.join(', '));
  if (blockedBy.length) rel.push('bloqué par ' + blockedBy.join(', '));
  dlg.querySelector('.dh').innerHTML =
    '<span>' + t.icon + '</span><span class="id">' + t.id + '</span><span class="prio">' + t.priority + '</span>' +
    '<span class="badge">' + D.labels[t.status] + '</span>' +
    (t.epic ? '<span class="badge">' + t.epic + '</span>' : '') +
    (t.owner ? '<span class="meta">@' + escape(t.owner) + '</span>' : '') +
    (t.created ? '<span class="meta">' + t.created + '</span>' : '') +
    '<span class="spacer"></span><button class="ghost" onclick="this.closest(\\'dialog\\').close()">Fermer</button>';
  dlg.querySelector('.db').innerHTML =
    '<p style="font-size:15px;line-height:1.45">' + escape(t.hook) + '</p>' +
    (rel.length ? '<p class="meta">' + rel.join(' · ') + '</p>' : '') +
    (t.origin ? '<p class="meta">Origine : ' + escape(t.origin) + '</p>' : '') +
    '<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">' + (D.bodies[id] || '<p class="meta">(corps vide)</p>');
  dlg.showModal();
  dlg.querySelector('.db').scrollTop = 0;
}
document.addEventListener('click', ev => {
  const a = ev.target.closest('[data-goto]');
  if (a) { ev.preventDefault(); openTicket(a.dataset.goto); }
});

function render() {
  localStorage.setItem('tks.view', view);
  localStorage.setItem('tks.hidden', JSON.stringify([...hidden]));
  localStorage.setItem('tks.hiddenP', JSON.stringify([...hiddenP]));
  localStorage.setItem('tks.hiddenL', JSON.stringify([...hiddenL]));
  localStorage.setItem('tks.hiddenA', JSON.stringify([...hiddenA]));
  // chaque vue ne montre que les filtres qui la concernent
  // la roadmap mesure l'avancement RÉEL : la filtrer fausserait ses barres
  document.querySelector('.filters').hidden = view === 'actions' || view === 'roadmap' || view === 'history';
  document.querySelector('#afilters').hidden = view !== 'actions';
  for (const c of document.querySelectorAll('.chip[data-act]')) c.setAttribute('aria-pressed', String(!hiddenA.has(c.dataset.act)));
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  for (const c of document.querySelectorAll('.chip[data-status]')) c.setAttribute('aria-pressed', String(!hidden.has(c.dataset.status)));
  for (const c of document.querySelectorAll('.chip[data-prio]')) c.setAttribute('aria-pressed', String(!hiddenP.has(c.dataset.prio)));
  for (const c of document.querySelectorAll('.chip[data-layer]')) c.setAttribute('aria-pressed', String(!hiddenL.has(c.dataset.layer)));
  const root = document.getElementById('root');
  root.innerHTML = '';
  scrollTo({ top: 0 });
  if (view === 'kanban') renderKanban(root);
  else if (view === 'threads') renderThreads(root);
  else if (view === 'actions') renderActions(root);
  else if (view === 'recipes') renderRecipes(root);
  else if (view === 'roadmap') renderRoadmap(root);
  else if (view === 'history') renderHistory(root);
  else renderGraph(root);
}

for (const b of document.querySelectorAll('.tab')) b.onclick = () => { view = b.dataset.view; render(); };
for (const c of document.querySelectorAll('.chip[data-status]'))
  c.onclick = () => { const s = c.dataset.status; hidden.has(s) ? hidden.delete(s) : hidden.add(s); render(); };
for (const c of document.querySelectorAll('.chip[data-prio]'))
  c.onclick = () => { const p = c.dataset.prio; hiddenP.has(p) ? hiddenP.delete(p) : hiddenP.add(p); render(); };
for (const c of document.querySelectorAll('.chip[data-layer]'))
  c.onclick = () => { const l = c.dataset.layer; hiddenL.has(l) ? hiddenL.delete(l) : hiddenL.add(l); render(); };
for (const c of document.querySelectorAll('.chip[data-act]'))
  c.onclick = () => { const a = c.dataset.act; hiddenA.has(a) ? hiddenA.delete(a) : hiddenA.add(a); render(); };
document.querySelector('#q').oninput = ev => { q = ev.target.value.trim().toLowerCase(); render(); };
document.querySelector('#theme').onclick = () => {
  const cur = document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('tks.theme', next);
};
const saved = localStorage.getItem('tks.theme');
if (saved) document.documentElement.dataset.theme = saved;
addEventListener('keydown', ev => {
  if (ev.key === '/' && document.activeElement !== document.querySelector('#q')) { ev.preventDefault(); document.querySelector('#q').focus(); }
});
renderTriage();    // idem : le sas est une zone d'écriture, pas une vue
renderPending();   // hors du cycle des vues : le bandeau ne dépend ni de l'onglet ni des filtres
render();
`;

const LIVE = `
let v = null;
setInterval(async () => {
  try {
    const r = await fetch('/api/version');
    const n = await r.text();
    if (v === null) v = n; else if (n !== v) location.reload();
  } catch (e) { /* serveur arrêté : on réessaiera */ }
}, 900);
`;

function renderHtml({ tickets, epics, recipes }, { live }) {
  const data = {
    tickets: tickets.map(({ body, ...rest }) => rest),
    epics: epics.map(({ body, ...rest }) => rest),
    recipes: recipes.map(({ body, ...rest }) => rest),
    recipeBodies: Object.fromEntries(recipes.map((r) => [r.id, md(r.body)])),
    edges: edges(tickets),
    git: gitHistory(),
    labels: STATUS_LABEL,
    actions: actions(tickets),
    // Lu via `parseJournal` (donc borné à la section Journal) : un exemple de format
    // documenté dans le corps d'un ticket ne doit pas apparaître comme action faite.
    doneActions: tickets.flatMap((t) => parseJournal(t.body).filter((e) => e.kind === 'action').map((e) => {
      const i = e.text.indexOf('—');
      return { id: t.id, icon: t.icon, date: e.date,
        tool: i < 0 ? 'divers' : e.text.slice(0, i).trim(),
        text: i < 0 ? e.text.trim() : e.text.slice(i + 1).trim(),
        comment: e.comment, ack: e.ack };
    })).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)),
    live,
    // Journal structuré par ticket : c'est lui qui porte l'état « en attente » /
    // « pris en compte » des remarques, affiché dans le tiroir de chaque action.
    journals: Object.fromEntries(tickets.map((t) => [t.id, parseJournal(t.body)])),
    // Même source que le bloc en tête de BACKLOG.md : la page et l'index disent
    // forcément la même chose, parce qu'ils lisent le même calcul.
    pending: pendingRemarks(tickets),
    // Le sas. `refs` alimente la liste de rattachement proposée par le formulaire : c'est
    // la seule chose qui empêche de saisir un identifiant qui n'existe pas.
    triage: readTriage().filter((e) => e.open),
    refs: [...tickets.map((t) => ({ id: t.id, label: t.hook })),
      ...epics.map((e) => ({ id: e.id, label: e.title }))],
    bodies: Object.fromEntries(tickets.map((t) => [t.id, md(t.body)])),
    epicBodies: Object.fromEntries(epics.map((e) => [e.id, md(e.body)])),
  };
  const counts = STATUSES.map((s) => `${tickets.filter((t) => t.status === s).length} ${STATUS_LABEL[s].toLowerCase()}`).join(' · ');
  const nAct = data.actions.length;
  const nRem = data.pending.reduce((s, g) => s + g.items.length, 0);
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${nAct ? `(${nAct}) ` : ''}Backlog — ${tickets.length} tickets</title>
<style>${CSS}</style></head>
<body>
<header>
  <div class="top">
    <h1>Backlog</h1>
    <span class="meta">${tickets.length} tickets · ${counts}</span>
    ${nAct ? `<span class="alert">⏳ ${nAct} actions</span>` : ''}
    ${nRem ? `<span class="alert rem">💬 ${nRem} en attente</span>` : ''}
    <span class="spacer"></span>
    <input id="q" type="search" placeholder="Filtrer  ( / )" aria-label="Filtrer les tickets">
    <button id="theme" class="ghost" title="Clair / sombre">◐</button>
  </div>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" data-view="kanban">Kanban</button>
    <button class="tab" role="tab" data-view="threads">Fils par épique</button>
    <button class="tab" role="tab" data-view="graph">Graphe des blocages</button>
    <button class="tab" role="tab" data-view="roadmap">Roadmap</button>
    ${data.git ? '<button class="tab" role="tab" data-view="history">Historique</button>' : ''}
    <button class="tab" role="tab" data-view="actions">Mes actions${nAct ? ` <b class="pill">${nAct}</b>` : ''}</button>
    ${recipes.length ? '<button class="tab" role="tab" data-view="recipes">Recettes</button>' : ''}
  </div>
</header>
<main>
  <div id="triage"></div>
  <div id="pending" hidden></div>
  <div class="filters">
    ${STATUSES.map((s) => `<button class="chip" data-status="${s}">${STATUS_LABEL[s]}</button>`).join('\n    ')}
    <span style="width:10px"></span>
    ${PRIORITIES.map((p) => `<button class="chip ${p}" data-prio="${p}"><span class="dot" style="background:var(--${p.toLowerCase()})"></span>${p}</button>`).join('\n    ')}
    <span style="width:10px"></span>
    ${[...new Set(tickets.map((t) => t.layer).filter(Boolean))].sort()
      .map((l) => `<button class="chip" data-layer="${l}">${l}</button>`).join('\n    ')}
  </div>
  <div class="filters" id="afilters" hidden>
    <button class="chip" data-act="todo">À faire</button>
    <button class="chip" data-act="done">Fait</button>
  </div>
  <div id="root"></div>
</main>
<dialog><div class="dh"></div><div class="db"></div></dialog>
<script type="application/json" id="data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>${CLIENT}</script>
${live ? `<script>${LIVE}</script>` : ''}
</body></html>
`;
}

// ─────────────────────────────────────────────────────────── modes

function generate({ quiet } = {}) {
  const data = read();
  writeFileSync(join(OUT, 'BACKLOG.md'), renderIndex(data), 'utf8');
  writeFileSync(join(OUT, 'backlog.html'), renderHtml(data, { live: false }), 'utf8');
  if (!quiet) {
    console.log(`${data.tickets.length} tickets · ${data.epics.length} épiques · ${data.recipes.length} recettes → BACKLOG.md + backlog.html`);
    for (const w of data.warnings) console.warn(`  ⚠ ${w}`);
  }
  return data;
}

/*
 * ── Commentaires ──────────────────────────────────────────────────────────────
 *
 * Deux formes, une seule section `## Journal`, en ordre chronologique :
 *
 *   - ✅ 2026-07-28 — navigateur — Vérifier que le compteur se remplit
 *     > pas trouvé l'écran dans le back-office
 *   - 💬 2026-07-28 — la couleur est bien arrivée sur la machine
 *
 * `✅` = une action humaine faite, avec un commentaire FACULTATIF attaché.
 * `💬` = un commentaire libre sur le ticket, attaché à rien d'autre.
 *
 * Le lien est PHYSIQUE : le commentaire est écrit sous sa ligne d'action. Pas
 * d'identifiant de commentaire, pas de table, pas de jointure — le fichier est
 * l'enregistrement et git est l'historique. Ce qu'on ne fait volontairement pas :
 * fils de discussion, réponses, auteurs, mentions, réactions, résolu/non résolu.
 * Rien de tout cela ne sert à une personne seule, et chacun coûterait un schéma.
 */

/** Limite de longueur : un commentaire est une note, pas un document. */
const COMMENT_MAX = 2000;

/**
 * Nettoie un commentaire saisi et le rend en lignes de citation Markdown.
 *
 * Le texte vient d'un formulaire : il ne doit jamais pouvoir casser la structure
 * du fichier. On retire les caractères de contrôle, on borne la longueur, et on
 * préfixe CHAQUE ligne par « > » — sans quoi un retour à la ligne suivi d'un
 * « --- » ou d'un « ## » réécrirait le frontmatter ou inventerait une section.
 */
function quoteComment(text) {
  const clean = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, COMMENT_MAX);
  if (!clean) return '';
  return clean.split('\n').map((l) => `  > ${l.trim()}`.trimEnd()).join('\n');
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Résout l'identifiant en fichier — jamais de chemin construit depuis l'entrée. */
function ticketFile(id) {
  const safe = readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md'));
  if (!safe.includes(id)) throw new Error('identifiant inconnu');
  return join(DIR, `${id}.md`);
}

/** Ajoute une entrée au journal, en créant la section si elle n'existe pas. */
function appendJournal(raw, entry) {
  return raw.trimEnd() + (raw.includes('\n## Journal') ? '' : '\n\n## Journal') + `\n\n${entry}\n`;
}

/*
 * ── Prise en compte ───────────────────────────────────────────────────────────
 *
 * Une remarque écrite n'est pas une remarque traitée. Un commentaire naît donc
 * « en attente », et seule la ligne d'accusé le fait passer à « pris en compte » :
 *
 *   - 💬 2026-07-28 — pas trouvé l'écran dans le back-office
 *     ↳ ✓ 2026-07-28 — ouvert en EX-042 (l'écran n'existe pas encore)
 *
 * ⚠️ Règle de conception, délibérée : **l'accusé ne s'écrit QUE depuis la ligne de
 * commande** (`--ack`), jamais depuis la page web. La page sert à CONSTATER et à
 * COMMENTER ; décider qu'une remarque est traitée est un acte d'analyse, pas une
 * case à cocher. Sans cette règle, « pris en compte » finirait par vouloir dire
 * « lu », et l'indicateur ne vaudrait plus rien.
 *
 * Même raison pour laquelle la page ne change jamais le `status:` d'un ticket.
 */

/** Marque d'accusé. Détectée en tête de ligne, après l'indentation. */
const ACK_MARK = '↳ ✓';

/*
 * ── Le sas « À trancher » ─────────────────────────────────────────────────────
 *
 * Une remarque qui n'a PAS encore de ticket. Elle s'écrit depuis la page, seule, sans
 * qu'on ait à choisir un ticket d'accueil — puis elle est instruite et devient un ticket,
 * ou elle est écartée avec sa raison.
 *
 * ⚠️ Ceci renverse une règle antérieure explicite : « un commentaire se rattache TOUJOURS
 * à un ticket existant ; le tout-venant se dit dans le chat — sinon l'outil devient une
 * boîte de réception ». Ce que cette règle protégeait est réel et reste vrai : un magasin
 * parallèle qui accumule sans jamais se vider est pire que pas de magasin du tout.
 *
 * Ce qui a changé : le tout-venant ne se disait PAS dans le chat, il s'y perdait. Une
 * remarque lâchée en cours de session n'a pas de point de chute et disparaît avec le fil.
 *
 * D'où la contrainte de conception, qui est tout l'écart entre un sas et une boîte de
 * réception : **une entrée doit sortir**. Elle est comptée et affichée tant qu'elle n'a pas
 * été tranchée, elle ne peut être close qu'en LIGNE DE COMMANDE et avec une raison écrite
 * — jamais d'un clic. Rien ne dort ici.
 */

/**
 * `- 💡 [N3] [TKS-011] 2026-07-28 — le texte`
 *
 * Le second crochet est un **rattachement facultatif** : un ticket ou une épique que
 * l'exploitant désigne pour situer sa remarque. Facultatif par conception — l'obligation
 * de choisir une cible est exactement ce qui faisait qu'une remarque n'était pas écrite.
 * Champ séparé, et non préfixe dans le texte : sans quoi un « — » dans la remarque le
 * rendrait indécidable à la relecture.
 */
const NOTE_RE = /^- 💡 \[(N\d+)\](?: \[([A-Za-z][\w-]*)\])? (\d{4}-\d{2}-\d{2}) — (.*)$/;

/** Identifiants auxquels une note peut se rattacher : tickets et épiques, par leur fichier. */
function knownRefs() {
  const ids = readdirSync(DIR)
    .filter((f) => f.endsWith('.md') && !NOT_A_TICKET.has(f))
    .map((f) => basename(f, '.md'));
  const epicDir = join(DIR, 'epics');
  const eps = existsSync(epicDir)
    ? readdirSync(epicDir).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md'))
    : [];
  return { tickets: ids, epics: eps, all: new Set([...ids, ...eps]) };
}

/** Découpe le sas en entrées. Une entrée close porte une ligne `↳ ✓`. */
function readTriage() {
  const p = join(DIR, TRIAGE_FILE);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(NOTE_RE);
    if (!head) continue;
    const e = { id: head[1], about: head[2] || '', date: head[3], text: head[4].trim(), done: null, line: i };
    const more = [];
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j].match(/^ {2}(>|↳ ✓) ?(.*)$/);
      if (!cont) break;
      if (cont[1] === '>') more.push(cont[2]);
      else e.done = cont[2].trim();
      i = j;
    }
    if (more.length) e.text = [e.text, more.join(' ').trim()].filter(Boolean).join(' · ');
    e.open = !e.done;
    out.push(e);
  }
  return out;
}

/**
 * Ajoute une note au sas. Renvoie son identifiant.
 *
 * Le numéro est monotone sur TOUT le fichier, closes comprises : réutiliser le numéro
 * d'une entrée tranchée ferait pointer deux décisions distinctes sur le même identifiant,
 * et l'historique git deviendrait illisible.
 */
function addNote(text, about = '') {
  const ref = String(about ?? '').trim();
  // Validé SEULEMENT s'il est fourni. Un rattachement qui ne pointe nulle part vaut moins
  // que pas de rattachement du tout : il ferait croire à un contexte qui n'existe pas.
  if (ref && !knownRefs().all.has(ref)) throw new Error(`rattachement inconnu : ${ref}`);
  const clean = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, COMMENT_MAX);
  if (!clean) throw new Error('une note vide ne se tranche pas');
  const p = join(DIR, TRIAGE_FILE);
  const n = readTriage().reduce((m, e) => Math.max(m, Number(e.id.slice(1))), 0) + 1;
  const [first, ...rest] = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const entry = `- 💡 [N${n}]${ref ? ` [${ref}]` : ''} ${today()} — ${first}`
    + rest.map((l) => `\n  > ${l}`).join('');
  const header = `# À trancher

_Remarques sans ticket, écrites au fil de l'eau. Chaque entrée doit finir en ticket ou être
écartée avec sa raison : rien ne dort ici. Se tranche en ligne de commande —_
\`node backlog.mjs --triage <ID> "ce qui en a été fait"\`
`;
  const fresh = !existsSync(p);
  const raw = fresh ? header : readFileSync(p, 'utf8');
  writeFileSync(p, `${raw.trimEnd()}\n${fresh ? '\n' : ''}${entry}\n`, 'utf8');
  return `N${n}`;
}

/** Tranche une note : y écrit ce qu'elle est devenue. Ligne de commande uniquement. */
function triageNote(id, note) {
  const clean = String(note ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, COMMENT_MAX);
  if (!clean) throw new Error('dire ce qu\'une note est devenue est obligatoire — « vu » ne vaut rien');
  const p = join(DIR, TRIAGE_FILE);
  if (!existsSync(p)) throw new Error('aucune note à trancher');
  const entry = readTriage().find((e) => e.id === id);
  if (!entry) throw new Error(`note inconnue : ${id}`);
  if (entry.done) throw new Error(`${id} est déjà tranchée — ${entry.done}`);
  const lines = readFileSync(p, 'utf8').split('\n');
  let at = entry.line;
  while (at + 1 < lines.length && /^ {2}>/.test(lines[at + 1])) at++;
  lines.splice(at + 1, 0, `  ${ACK_MARK} ${today()} — ${clean}`);
  writeFileSync(p, lines.join('\n'), 'utf8');
}

/**
 * Découpe le journal en entrées structurées.
 *
 * Une entrée = une ligne `- ✅ …` ou `- 💬 …`, suivie de ses lignes de
 * continuation indentées (`>` = commentaire, `↳ ✓` = accusé).
 */
/**
 * Décalage de la section `## Journal` dans un corps de ticket, ou -1.
 *
 * ⚠️ Indispensable, et pas une optimisation : un ticket peut **documenter** le format
 * du journal dans un bloc de code (c'est le cas de celui qui décrit cette fonction).
 * Balayer tout le corps ferait passer ces EXEMPLES pour de vraies entrées — et `--ack`
 * irait écrire un accusé au milieu d'une documentation. Le journal commence à son
 * titre, un point c'est tout.
 */
function journalStart(body) {
  const m = String(body ?? '').match(/^## Journal\s*$/m);
  return m ? m.index + m[0].length : -1;
}

function parseJournal(body) {
  const out = [];
  const start = journalStart(body);
  if (start < 0) return out;
  const lines = String(body).slice(start).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^- (✅|💬) (\d{4}-\d{2}-\d{2}) — (.*)$/);
    if (!head) continue;
    const entry = { kind: head[1] === '✅' ? 'action' : 'comment', date: head[2], text: head[3].trim(), comment: [], ack: null, line: i };
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j].match(/^ {2}(>|↳ ✓) ?(.*)$/);
      if (!cont) break;
      if (cont[1] === '>') entry.comment.push(cont[2]);
      else entry.ack = cont[2].trim();
      i = j;
    }
    entry.comment = entry.comment.join('\n').trim();
    // « En attente » = porte une parole de l'exploitant et n'a pas encore d'accusé.
    entry.pending = !entry.ack && (entry.kind === 'comment' || entry.comment !== '');
    out.push(entry);
  }
  return out;
}

/**
 * Accuse réception des remarques en attente d'un ticket (ligne de commande).
 *
 * Traite TOUTES les entrées en attente du ticket avec la même note : on instruit
 * un ticket d'un bloc, pas remarque par remarque. Pour un traitement différencié,
 * éditer le fichier directement — il est fait pour être lu et écrit à la main.
 */
function ackComments(id, note) {
  const file = ticketFile(id);
  const raw = readFileSync(file, 'utf8');
  const clean = String(note ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, COMMENT_MAX);
  if (!clean) throw new Error('une note de prise en compte est obligatoire — dire « pris en compte » sans dire ce qui a été fait ne vaut rien');
  const entries = parseJournal(raw).filter((e) => e.pending);
  if (!entries.length) throw new Error('aucune remarque en attente sur ce ticket');
  const lines = raw.split('\n');
  // `parseJournal` numérote depuis le début de la SECTION ; on repasse en absolu.
  const base = raw.slice(0, journalStart(raw)).split('\n').length - 1;
  // De la fin vers le début : insérer par le haut décalerait les indices suivants.
  for (const e of [...entries].reverse()) {
    let at = base + e.line;
    while (at + 1 < lines.length && /^ {2}>/.test(lines[at + 1])) at++;
    lines.splice(at + 1, 0, `  ${ACK_MARK} ${today()} — ${clean}`);
  }
  writeFileSync(file, lines.join('\n'), 'utf8');
  return entries.length;
}

/** Coche une action : retire la ligne `action:` et journalise dans le corps du ticket. */
function completeAction(id, comment) {
  const file = ticketFile(id);
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^action: (.*)$/m);
  if (!m) throw new Error('aucune action en attente sur ce ticket');
  const quoted = quoteComment(comment);
  let out = raw.replace(/^action: .*\n/m, '');
  out = appendJournal(out, `- ✅ ${today()} — ${m[1].trim()}` + (quoted ? `\n${quoted}` : ''));
  writeFileSync(file, out, 'utf8');
  return m[1].trim();
}

/** Commentaire libre sur un ticket — n'a pas besoin d'une action en attente. */
function commentTicket(id, comment) {
  const file = ticketFile(id);
  const quoted = quoteComment(comment);
  if (!quoted) throw new Error('commentaire vide');
  // Le commentaire libre tient sur sa ligne : on retire le préfixe de citation de
  // la première ligne et on garde les suivantes en continuation indentée.
  const [first, ...rest] = quoted.split('\n');
  const entry = `- 💬 ${today()} — ${first.replace(/^ {2}> ?/, '')}` +
    (rest.length ? `\n${rest.join('\n')}` : '');
  writeFileSync(file, appendJournal(readFileSync(file, 'utf8'), entry), 'utf8');
  return true;
}

/**
 * Décoche : retire la dernière action cochée ET son commentaire, puis restaure
 * la ligne `action:`.
 *
 * ⚠️ Le piège : avant les commentaires, une entrée de journal tenait sur UNE ligne.
 * Elle peut désormais être suivie de lignes « > » qui lui appartiennent. Ne retirer
 * que la première laisserait un commentaire orphelin, rattaché à l'entrée
 * précédente — c'est-à-dire une fausse trace. On consomme donc la continuation.
 */
function undoAction(id) {
  const file = ticketFile(id);
  const raw = readFileSync(file, 'utf8');
  if (/^action: /m.test(raw)) throw new Error('ce ticket a déjà une action en attente');
  // Même précaution que `parseJournal` : ne JAMAIS chercher hors de la section
  // Journal, sinon un exemple documenté dans le corps passerait pour une entrée.
  const js = journalStart(raw);
  if (js < 0) throw new Error('aucune action cochée à annuler');
  const lines = [...raw.slice(js).matchAll(/^- ✅ \d{4}-\d{2}-\d{2} — (.+)$/gm)]
    .map((m) => Object.assign(m, { index: m.index + js }));
  if (!lines.length) throw new Error('aucune action cochée à annuler');
  const last = lines[lines.length - 1];
  const text = last[1].trim();
  // Étend la coupe aux lignes de commentaire qui suivent immédiatement l'entrée.
  let end = last.index + last[0].length;
  const after = raw.slice(end);
  const cont = after.match(/^(\n {2}>.*)+/);
  if (cont) end += cont[0].length;
  let out = raw.slice(0, last.index) + raw.slice(end);
  out = out.replace(/\n## Journal\s*$/, '\n');            // journal devenu vide
  out = out.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  out = out.replace(/^(owner: .*)$/m, `$1\naction: ${text}`);
  if (!/^action: /m.test(out)) out = out.replace(/^(hook: .*)$/m, `$1\naction: ${text}`);
  writeFileSync(file, out, 'utf8');
  return text;
}

function serve() {
  let version = Date.now();
  let timer = null;
  watch(DIR, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      version = Date.now();
      const d = read();
      writeFileSync(join(OUT, 'BACKLOG.md'), renderIndex(d), 'utf8');
      console.log(`↻ ${new Date().toLocaleTimeString('fr-FR')} — ${d.tickets.length} tickets`);
      for (const w of d.warnings) console.warn(`  ⚠ ${w}`);
    }, 120);
  });

  createServer((req, res) => {
    // La page web peut : cocher une action, la décocher, écrire un commentaire.
    // Elle ne peut PAS accuser réception ni changer un statut — voir ACK_MARK.
    const POST_ROUTES = ['/api/action/done', '/api/action/undo', '/api/comment', '/api/note'];
    if (req.method === 'POST' && POST_ROUTES.includes(req.url)) {
      const route = req.url;
      let body = '';
      // Enveloppe JSON + commentaire (≤ COMMENT_MAX) : marge large, mais bornée.
      req.on('data', (c) => { body += c; if (body.length > 8000) req.destroy(); });
      req.on('end', () => {
        try {
          const { id, comment, about } = JSON.parse(body);
          if (route === '/api/note') {
            // Seule route qui n'exige PAS d'identifiant de ticket : c'est tout son objet.
            // `about` est facultatif, et validé contre les fichiers existants par `addNote`.
            console.log(`  🧾 note déposée — ${addNote(comment, about)}`);
          } else if (route === '/api/comment') {
            commentTicket(id, comment);
            console.log(`  💬 commentaire — ${id}`);
          } else if (route === '/api/action/undo') {
            console.log(`  ↩︎ action décochée — ${undoAction(id)}`);
          } else {
            const done = completeAction(id, comment);
            console.log(`  ✅ action cochée — ${done}${comment ? ' (+ commentaire)' : ''}`);
          }
          res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
        } catch (e) {
          res.writeHead(400, { 'content-type': 'text/plain' }); res.end(e.message);
        }
      });
      return;
    }
    if (req.url === '/api/version') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end(String(version));
    }
    const data = read();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderHtml(data, { live: true }));
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`TicketoScope → http://localhost:${PORT}  (surveille ${DIR})`);
    generate({ quiet: true });
  });
}

function init() {
  mkdirSync(join(DIR, 'epics'), { recursive: true });
  const ticket = join(DIR, 'EX-001.md');
  if (!existsSync(ticket)) writeFileSync(ticket, `---
id: EX-001
hook: Une phrase, la seule chose lue tant qu'on ne travaille pas dessus.
epic: EX
created: ${new Date().toISOString().slice(0, 10)}
origin: d'où vient ce ticket
status: todo
priority: P2
owner: cto
---

Le corps est libre : analyse, options, arbitrages. Il n'est chargé que si l'on ouvre ce fichier —
c'est ce qui rend le coût marginal plat. Lier un autre ticket : [[EX-002]].
`, 'utf8');
  const epic = join(DIR, 'epics', 'EX.md');
  if (!existsSync(epic)) writeFileSync(epic, `---
id: EX
title: Exemple d'épique
---

Le récit et le contexte qui n'appartiennent à aucun ticket en particulier.
`, 'utf8');
  writeProtocol();
  console.log(`Squelette créé dans ${DIR}. Lance « node backlog.mjs --serve ».`);
}

/**
 * Dépose le contrat d'usage DANS le backlog.
 *
 * Ces règles ne sont pas des règles de projet : ce sont des propriétés de l'outil, vraies
 * partout où il tourne. Tant qu'elles vivaient dans le README — 190 lignes destinées à un
 * humain qui démarre — l'agent, dont la consigne est « lis BACKLOG.md et rien d'autre »,
 * ne les voyait jamais et les reconstituait à ses frais à chaque reprise de fil. Les loger
 * dans la mémoire d'un projet revient à les dupliquer par projet, et à les laisser diverger.
 *
 * Écrit une seule fois : un projet a le droit d'amender son propre contrat, et une
 * régénération n'a pas à écraser cet amendement.
 */
function writeProtocol() {
  const file = join(DIR, 'PROTOCOLE.md');
  if (existsSync(file)) return;
  writeFileSync(file, `# PROTOCOLE — le contrat TicketoScope

_À lire une fois, au démarrage du projet. Ce fichier n'est pas régénéré : amendez-le._

## Ce qui est généré, ce qui ne l'est pas

\`BACKLOG.md\` et \`backlog.html\` sont **produits** par le générateur. **Ne jamais les éditer
à la main** : ils sont écrasés à chaque génération. La source, c'est \`${basename(DIR)}/<ID>.md\` —
un ticket, un fichier. Les épiques vivent dans \`${basename(DIR)}/epics/<ID>.md\`, les recettes
dans \`${basename(DIR)}/recipes/<ID>.md\`. Après toute modification : relancer le générateur.

## Frontmatter

\`\`\`yaml
id · hook · epic · layer · created · origin
status (todo|doing|done|dropped) · priority (P0..P3) · owner
follows · blocks · blocked_by · action
\`\`\`

Le \`hook\` est **une phrase** — la seule chose exposée dans l'index, et donc le champ qui
tient le coût. S'il en faut deux, le corps est là pour ça.

\`epic\` = une **fonction du produit**. \`layer\` = **où ça se code**. Deux axes, jamais
mélangés dans le même champ.

\`action:\` = ce que **seul un humain** peut faire, préfixé par l'outil concerné
(${ACTION_TOOLS.slice(0, 4).join(' — … / ')} — …). Une ligne à l'impératif, ≤ 110 caractères.
**Jamais de secret ni d'identifiant** : le backlog peut être versionné en public.

## Lecture — le régime qui rend le coût plat

Au démarrage d'une session : lire \`BACKLOG.md\` (en-tête, remarques en attente, actions,
index) et **rien d'autre**. N'ouvrir \`${basename(DIR)}/<ID>.md\` que pour le ticket sur lequel
on travaille. 300 tickets coûtent alors autant par opération que 30.

## Remarques et prise en compte

Une remarque s'écrit depuis la page web ou en ligne de commande, sous l'action ou le ticket
qu'elle concerne — le lien est **physique**, il n'y a ni identifiant de commentaire ni jointure.
Elle naît « en attente » et remonte en tête de \`BACKLOG.md\` tant qu'elle n'est pas instruite.

| Geste | Page web | Ligne de commande |
|---|---|---|
| Cocher une action faite | ✅ | \`--done <ID> ["…"]\` |
| Décocher la dernière action | ✅ | \`--undo <ID>\` |
| Écrire une remarque | ✅ | \`--comment <ID> "…"\` |
| Déclarer « pris en compte » | ❌ | \`--ack <ID> "…"\` |
| Changer le \`status:\` d'un ticket | ❌ | ✅ (édition du fichier) |

Les deux premières lignes sont **le même geste sur deux surfaces** : ce qui se coche d'un clic se
coche aussi sans écran. Les deux dernières ne sont **pas** un geste de la page, et c'est
délibéré — ce sont des actes d'analyse.

La note de \`--ack\` est **obligatoire** et doit dire **ce qui a été fait**, pas « vu ». Sans
cette séparation, « pris en compte » finirait par vouloir dire « lu ». Celle de \`--done\` est
facultative : l'action porte déjà son libellé, rien ne se perd si on coche sans commenter.

Instruire une remarque, c'est **trancher** : soit elle clôt son ticket, soit elle en ouvre un
nouveau. Une remarque sans accusé reste affichée en attente, et l'indicateur perd son sens.

## À trancher — le sas

\`${basename(DIR)}/A-TRANCHER.md\` accueille les remarques qui n'ont **pas encore** de ticket : une
idée, un constat, une demande, écrits au fil de l'eau depuis la page (bouton « + Commentaire /
Ticket », replié par défaut) ou en ligne de commande.

\`\`\`sh
node backlog.mjs --note "le bouton de retour ne revient pas au bon écran"
node backlog.mjs --note EX-001 "vu sur iPhone : ça déborde"   # rattachement FACULTATIF
node backlog.mjs --triage N1 "ouvert en EX-021"               # ou : "écartée : hors sujet"
\`\`\`

Le rattachement à un ticket ou une épique est **facultatif** — il sert à situer, pas à classer.
Obliger à choisir une cible avant d'écrire, c'est demander d'instruire avant d'avoir noté.

**Une entrée doit sortir.** Elle est comptée en tête de \`BACKLOG.md\` tant qu'elle n'est pas
tranchée, et elle ne se tranche qu'en ligne de commande, avec une raison écrite. C'est ce qui
sépare un sas d'une boîte de réception : si le compte monte durablement, l'outil a dérivé.

## Discipline

- Rien de terminé ne reste dans l'index.
- Une remarque se rattache **toujours** à un ticket ou une action qui existe. Le tout-venant
  se dit ailleurs — sinon l'outil devient une boîte de réception.
- Ce qui remonte en session devient par défaut **un ticket**, pas du code écrit dans l'urgence.

## Ce qu'il n'y a pas, volontairement

Fils de discussion, réponses, auteurs, mentions, réactions, résolu/non-résolu, notifications.
C'est la pente qui mène à Jira ; rien de tout cela ne sert à une personne seule.
`, 'utf8');
}

/**
 * `--ack <ID> "<note>"` — déclare que les remarques d'un ticket sont prises en compte.
 *
 * Volontairement RÉSERVÉ à la ligne de commande : accuser réception est un acte
 * d'analyse (« qu'est-ce que j'en ai fait ? »), pas une case à cocher. La note est
 * obligatoire, faute de quoi l'indicateur finirait par ne signifier que « lu ».
 */
function ack() {
  // Tout ce qui suit `--ack` est sa charge utile : l'identifiant, puis la note. Les options
  // globales se placent AVANT.
  //
  // ⚠️ Le code d'origine filtrait simplement `--ack` hors de la ligne de commande et prenait
  // le premier reste comme identifiant. Avec « --dir backlog --ack EX-001 "…" », l'identifiant
  // devenait « --dir » : l'accusé échouait sur « identifiant inconnu » et la remarque restait
  // en attente. Invisible tant qu'on lançait l'outil depuis la racine du projet, fatal dès
  // qu'on lui passait un dossier.
  const rest = ARGV.slice(ARGV.indexOf('--ack') + 1);
  const [id, ...note] = rest;
  if (!id) { console.error('usage : node backlog.mjs --ack <ID> "ce qui en a été fait"'); process.exit(1); }
  try {
    const n = ackComments(id, note.join(' '));
    console.log(`✓ ${n} remarque${n > 1 ? 's' : ''} de ${id} marquée${n > 1 ? 's' : ''} prise${n > 1 ? 's' : ''} en compte`);
    generate({ quiet: true });
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

/*
 * ── Dispatch ──────────────────────────────────────────────────────────────────
 *
 * ⚠️ Le piège historique : le dispatch se terminait par un `else generate()` nu. Tout
 * drapeau non reconnu — `--help` le premier — tombait donc dans la branche par défaut,
 * RÉÉCRIVAIT les deux fichiers, et affichait « 80 tickets · 22 épiques ». Deux dégâts :
 * une écriture que personne n'a demandée, et surtout un message qui ne ressemble pas à
 * une erreur mais à un résultat. Un lecteur — humain ou agent — le prend pour la réponse,
 * n'apprend rien, et part chercher dans le code source. Un message trompeur coûte plus
 * cher qu'un message absent.
 *
 * Règle : la génération est ce qu'on obtient SANS argument. Jamais par accident.
 */

const USAGE = `TicketoScope — un registre de tickets à coût marginal plat.

  node backlog.mjs                       régénère BACKLOG.md + backlog.html
  node backlog.mjs --serve               http://localhost:${PORT}, rechargement auto
  node backlog.mjs --init                crée un dossier ${basename(DIR)}/ d'exemple
  node backlog.mjs --done <ID> ["…"]     coche l'action en attente (commentaire FACULTATIF)
  node backlog.mjs --undo <ID>           décoche la dernière action cochée et la remet en attente
  node backlog.mjs --comment <ID> "…"    écrit une remarque dans le journal d'un ticket
  node backlog.mjs --ack <ID> "<note>"   marque les remarques d'un ticket prises en compte
  node backlog.mjs --note "<texte>"      dépose une remarque SANS ticket, dans « À trancher »
  node backlog.mjs --triage <ID> "…"     dit ce qu'une remarque de « À trancher » est devenue
  node backlog.mjs --help                cet écran

Options :
  --dir <${basename(DIR)}>   dossier des tickets
  --out <.>         où écrire BACKLOG.md et backlog.html
  --port <4321>     port du mode --serve

Un ticket = un fichier ${basename(DIR)}/<ID>.md. Le contrat de frontmatter est dans
${basename(DIR)}/PROTOCOLE.md (déposé par --init).`;

const KNOWN_FLAGS = new Set(['--init', '--serve', '--ack', '--note', '--triage',
  '--done', '--undo', '--comment', '--help', '-h']);
const VALUE_OPTS = new Set(['--dir', '--out', '--port']);
/**
 * Drapeaux dont TOUT ce qui suit est la charge utile — donc du texte libre, pas des options.
 *
 * `--undo` n'en fait PAS partie : il ne prend qu'un identifiant, rien qui ressemble à du
 * texte libre, donc les options qui le suivent restent validables.
 */
const PAYLOAD_FLAGS = new Set(['--ack', '--note', '--triage', '--done', '--comment']);

/**
 * Premier drapeau non reconnu, ou `null`.
 *
 * S'arrête au premier drapeau à charge utile (`--ack`, `--note`, `--triage`, `--done`,
 * `--comment`) : tout ce qui suit lui appartient, et c'est du texte libre — une note a
 * parfaitement le droit de commencer par deux tirets. La valider reviendrait à refuser
 * une note légitime.
 */
function unknownFlag() {
  for (let i = 0; i < ARGV.length; i++) {
    const a = ARGV[i];
    if (PAYLOAD_FLAGS.has(a)) return null;
    if (VALUE_OPTS.has(a)) { i++; continue; }
    if (a.startsWith('-') && !KNOWN_FLAGS.has(a)) return a;
  }
  return null;
}

/**
 * Le drapeau de commande retenu : le PREMIER rencontré, ou `null` pour la génération.
 *
 * ⚠️ Le dispatch testait `ARGV.includes('--undo')` & co. Ça suffisait tant que les charges
 * utiles étaient des notes ; ça ne suffit plus depuis `--comment`, car le texte libre d'un
 * commentaire parle couramment de l'outil lui-même :
 * `--comment TKS-001 "il faudrait un --undo en ligne de commande"` aurait déclenché `--undo`
 * et écrit dans le fichier au lieu de commenter. Même règle qu'`unknownFlag()` : on s'arrête
 * au premier drapeau à charge utile, tout ce qui suit lui appartient.
 */
function command() {
  for (let i = 0; i < ARGV.length; i++) {
    const a = ARGV[i];
    if (VALUE_OPTS.has(a)) { i++; continue; }
    if (KNOWN_FLAGS.has(a)) return a === '-h' ? '--help' : a;
  }
  return null;
}

/** `--note "<texte>"` — dépose une remarque dans le sas, sans ticket d'accueil. */
function note() {
  const rest = ARGV.slice(ARGV.indexOf('--note') + 1);
  // Rattachement facultatif : s'il est là, c'est le premier mot ET c'est un identifiant
  // connu. Une remarque dont le premier mot est par ailleurs un identifiant existant
  // est indiscernable — cas assez improbable pour préférer la brièveté à un drapeau de plus.
  const ref = rest.length > 1 && knownRefs().all.has(rest[0]) ? rest.shift() : '';
  const text = rest.join(' ');
  try {
    const id = addNote(text, ref);
    console.log(`🧾 ${id} déposée dans « À trancher »`);
    generate({ quiet: true });
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}

/** `--triage <ID> "<note>"` — dit ce qu'une remarque du sas est devenue. */
function triage() {
  const [id, ...note] = ARGV.slice(ARGV.indexOf('--triage') + 1);
  if (!id) { console.error('usage : node backlog.mjs --triage <ID> "ce qui en a été fait"'); process.exit(1); }
  try {
    triageNote(id, note.join(' '));
    console.log(`✓ ${id} tranchée`);
    generate({ quiet: true });
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}

/*
 * ── Les trois gestes que la page web savait déjà faire ────────────────────────
 *
 * `completeAction`, `undoAction` et `commentTicket` n'étaient joignables que par un POST
 * sur 127.0.0.1. L'asymétrie inverse — `--ack` et `--triage` interdits au web — est
 * délibérée et argumentée (trancher est un acte d'analyse, pas un clic). Celle-ci ne
 * l'était pas : rien nulle part ne justifiait qu'il faille un navigateur pour cocher.
 * Voir TKS-015.
 */

/**
 * `--done <ID> ["<note>"]` — coche l'action en attente d'un ticket.
 *
 * La note est FACULTATIVE, contrairement à celle de `--ack` : l'action porte déjà son
 * propre libellé, que le journal recopie tel quel — rien ne se perd si on coche sans
 * commenter. La page web le permet ; deux surfaces ne peuvent pas dire deux règles
 * différentes pour le même geste.
 */
function done() {
  const [id, ...note] = ARGV.slice(ARGV.indexOf('--done') + 1);
  if (!id) { console.error('usage : node backlog.mjs --done <ID> ["ce qu\'on en a appris"]'); process.exit(1); }
  const comment = note.join(' ');
  try {
    const action = completeAction(id, comment);
    console.log(`✅ ${id} — action cochée : ${action}${comment.trim() ? ' (+ commentaire)' : ''}`);
    generate({ quiet: true });
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}

/** `--undo <ID>` — décoche la dernière action cochée et la remet en attente. */
function undo() {
  const [id] = ARGV.slice(ARGV.indexOf('--undo') + 1);
  if (!id) { console.error('usage : node backlog.mjs --undo <ID>'); process.exit(1); }
  try {
    const action = undoAction(id);
    console.log(`↩︎ ${id} — action décochée : ${action}`);
    generate({ quiet: true });
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}

/** `--comment <ID> "<texte>"` — écrit une remarque dans le journal d'un ticket. */
function comment() {
  const [id, ...text] = ARGV.slice(ARGV.indexOf('--comment') + 1);
  if (!id) { console.error('usage : node backlog.mjs --comment <ID> "ce qu\'on a constaté"'); process.exit(1); }
  try {
    // Un commentaire vide est refusé par `commentTicket` — comme une note d'`--ack` vide.
    commentTicket(id, text.join(' '));
    console.log(`💬 remarque écrite sur ${id} — en attente de prise en compte`);
    generate({ quiet: true });
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}

const bad = unknownFlag();
const cmd = command();
if (cmd === '--help') console.log(USAGE);
else if (bad) {
  console.error(`✗ option inconnue : ${bad}\n\n${USAGE}`);
  process.exit(1);
}
else if (cmd === '--init') init();
else if (cmd === '--note') note();
else if (cmd === '--triage') triage();
else if (cmd === '--ack') ack();
else if (cmd === '--done') done();
else if (cmd === '--undo') undo();
else if (cmd === '--comment') comment();
else if (cmd === '--serve') serve();
else generate();
