#!/usr/bin/env node
/**
 * TicketoScope — un registre de tickets à coût marginal plat.
 *
 * Un ticket = un fichier Markdown avec frontmatter. Le générateur en tire :
 *   - BACKLOG.md   : une ligne par ticket (la surface de scan, volontairement compacte)
 *   - backlog.html : trois vues (kanban, fils par épique, graphe des blocages)
 *
 * Zéro dépendance : Node natif uniquement.
 *
 *   node backlog.mjs                → régénère BACKLOG.md + backlog.html
 *   node backlog.mjs --serve        → http://localhost:4321, auto-reload sur modification
 *   node backlog.mjs --init         → crée un dossier backlog/ d'exemple
 *
 * Options : --dir <backlog> --out <.> --port <4321>
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, watch } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createServer } from 'node:http';

// ─────────────────────────────────────────────────────────── configuration

const ARGV = process.argv.slice(2);
const flag = (name) => ARGV.includes(name);
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
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()) {
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

  // Intégrité référentielle : une référence pendante est une erreur de saisie, pas un détail.
  const known = new Set(tickets.map((t) => t.id));
  const knownEpics = new Set(epics.map((e) => e.id));
  for (const t of tickets) {
    for (const ref of [...t.blocks, ...t.blocked_by, ...(t.follows ? [t.follows] : [])]) {
      if (!known.has(ref)) warnings.push(`${t.id} : référence inconnue « ${ref} »`);
    }
    if (t.epic && !knownEpics.has(t.epic)) warnings.push(`${t.id} : épique « ${t.epic} » sans fichier epics/${t.epic}.md`);
  }
  return { tickets, epics, warnings };
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

/** Nombre de tickets encore vivants bloqués en aval — l'urgence n'est jamais saisie à la main. */
function impacts(tickets) {
  const E = edges(tickets);
  const alive = new Set(tickets.filter((t) => t.status !== 'done' && t.status !== 'dropped').map((t) => t.id));
  const out = {};
  const down = (id, seen) => {
    let n = 0;
    for (const e of E) {
      if (e.from !== id || seen.has(e.to)) continue;
      seen.add(e.to);
      if (alive.has(e.to)) n++;
      n += down(e.to, seen);
    }
    return n;
  };
  for (const t of tickets) out[t.id] = down(t.id, new Set([t.id]));
  return out;
}

/** Les actions ouvertes, regroupées par outil : on ouvre Supabase une fois, on enchaîne. */
function actions(tickets) {
  const imp = impacts(tickets);
  return tickets.filter((t) => t.action).map((t) => {
    const i = t.action.indexOf('—');
    return {
      id: t.id, icon: t.icon, priority: t.priority, epic: t.epic,
      tool: i < 0 ? 'divers' : t.action.slice(0, i).trim(),
      text: i < 0 ? t.action.trim() : t.action.slice(i + 1).trim(),
      unblocks: imp[t.id] || 0,
    };
  }).sort((a, b) => b.unblocks - a.unblocks || a.priority.localeCompare(b.priority) || a.id.localeCompare(b.id));
}

function byTool(list) {
  const g = {};
  for (const a of list) (g[a.tool] ||= []).push(a);
  return Object.entries(g).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
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

function renderIndex({ tickets, epics }) {
  const titles = Object.fromEntries(epics.map((e) => [e.id, e.title]));
  const line = (t) => `- ${t.icon} [${t.id}] ${t.priority} · ${t.status} · ${t.hook}${t.epic ? ` — ${t.epic}` : ''}`;
  const active = tickets.filter((t) => t.status === 'todo' || t.status === 'doing').sort(byEpicPrioId);
  const closed = tickets.filter((t) => t.status === 'done' || t.status === 'dropped').sort(byEpicPrioId);
  const counts = STATUSES.map((s) => `${tickets.filter((t) => t.status === s).length} ${s}`).join(' · ');

  const acts = actions(tickets);
  const head = [];
  if (acts.length) {
    head.push(`## ⏳ Actions à faire — humaines (${acts.length})`, '');
    for (const [tool, list] of byTool(acts)) {
      head.push(`### ${tool} (${list.length})`);
      for (const a of list) head.push(`- [${a.id}] ${a.priority} · débloque ${a.unblocks} · ${a.text}`);
      head.push('');
    }
  }

  return [
    '# BACKLOG — index généré',
    `_${tickets.length} tickets : ${counts}. Généré le ${new Date().toISOString().slice(0, 10)} par TicketoScope._`,
    '',
    '> ⚠️ **Ne jamais éditer ce fichier à la main** — il est écrasé à chaque génération.',
    `> Un ticket = un fichier : \`${basename(DIR)}/<ID>.md\`. Le détail ne se lit que si l'on travaille dessus.`,
    `> Épiques : ${epics.map((e) => `${e.id} (${titles[e.id]})`).join(' · ') || '—'}`,
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
.act{display:flex;gap:10px;align-items:flex-start;padding:9px 4px;border-top:1px solid var(--line);cursor:pointer}
.act:first-of-type{border-top:0}
.act input{margin:2px 0 0;width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex:none}
.act .at{font-size:13px}
.act .am{font-size:11.5px;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.act.gone{opacity:.35;text-decoration:line-through}
.tool{display:flex;align-items:baseline;gap:9px;margin:0 0 4px}
.tool b{font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.tool span{color:var(--muted);font-size:11.5px}
.hot{color:var(--p1);font-weight:600}
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
@media (max-width:900px){.board{grid-template-columns:1fr 1fr}}
@media (max-width:560px){.board{grid-template-columns:1fr}main{padding:14px}}
`;

const CLIENT = `
const D = JSON.parse(document.getElementById('data').textContent);
const T = D.tickets, E = D.epics, EDGES = D.edges;
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

function renderActions(root) {
  const acts = hiddenA.has('todo') ? [] : D.actions.filter(a => !DONE.has(a.id));
  if (!hiddenA.has('done')) doneList(root);
  if (hiddenA.has('todo')) return;
  if (!acts.length) { root.appendChild(el('div','empty','Rien ne t\\'attend. Le goulot, ce n\\'est pas toi.')); return; }
  const groups = {};
  for (const a of acts) (groups[a.tool] ||= []).push(a);
  const keys = Object.keys(groups).sort((x, y) => groups[y].length - groups[x].length || x.localeCompare(y));

  if (!D.live) root.appendChild(el('div', 'empty',
    'Page statique : les cases ne peuvent pas s\\'enregistrer. Lance « node scripts/backlog.mjs --serve » pour cocher.'));

  for (const k of keys) {
    const box = el('div', 'thread');
    const t = el('div', 'tool');
    t.innerHTML = '<b>' + escape(k) + '</b><span>' + groups[k].length + ' action' +
      (groups[k].length > 1 ? 's' : '') + ' — à faire d\\'un seul tenant</span>';
    box.appendChild(t);
    for (const a of groups[k]) {
      const row = el('label', 'act');
      row.innerHTML = '<input type="checkbox"' + (D.live ? '' : ' disabled') + '>' +
        '<span><span class="at">' + fmt(a.text) + '</span><span class="am">' +
        '<span class="id">' + a.icon + ' ' + a.id + '</span><span>' + a.priority + '</span>' +
        (a.epic ? '<span>' + a.epic + '</span>' : '') +
        (a.unblocks ? '<span class="hot">débloque ' + a.unblocks + ' ticket' + (a.unblocks > 1 ? 's' : '') + '</span>'
                    : '<span>ne débloque rien d\\'autre</span>') + '</span></span>';
      row.querySelector('input').onchange = ev => { ev.stopPropagation(); done(a, row); };
      row.querySelector('.id').onclick = ev => { ev.preventDefault(); ev.stopPropagation(); openTicket(a.id); };
      box.appendChild(row);
    }
    root.appendChild(box);
  }
}

function doneList(root) {
  const list = D.doneActions || [];
  if (!list.length) { root.appendChild(el('div', 'empty', 'Rien de coché pour le moment.')); return; }
  const box = el('div', 'thread');
  box.appendChild(el('div', 'tool', '<b>Fait</b><span>' + list.length + ' action' +
    (list.length > 1 ? 's' : '') + ' cochées — journalisées dans leur ticket</span>'));
  for (const a of list) {
    const row = el('div', 'act');
    row.innerHTML = '<input type="checkbox" checked disabled>' +
      '<span><span class="at">' + fmt(a.text) + '</span><span class="am">' +
      '<span class="id">' + a.icon + ' ' + a.id + '</span><span>' + a.date + '</span>' +
      '<span>' + escape(a.tool) + '</span></span></span>';
    row.style.opacity = '.6';
    row.querySelector('.id').onclick = () => openTicket(a.id);
    box.appendChild(row);
  }
  root.appendChild(box);
}

const DONE = new Set();
async function done(a, row) {
  row.classList.add('gone');
  try {
    const r = await fetch('/api/action/done', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: a.id }),
    });
    if (!r.ok) throw new Error(await r.text());
    DONE.add(a.id);                       // le fs.watch régénère et la page se rechargera d'elle-même
    badge();
  } catch (e) {
    row.classList.remove('gone');
    row.querySelector('input').checked = false;
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
  document.querySelector('.filters').hidden = view === 'actions' || view === 'roadmap';
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
  else if (view === 'roadmap') renderRoadmap(root);
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

function renderHtml({ tickets, epics }, { live }) {
  const data = {
    tickets: tickets.map(({ body, ...rest }) => rest),
    epics: epics.map(({ body, ...rest }) => rest),
    edges: edges(tickets),
    labels: STATUS_LABEL,
    actions: actions(tickets),
    doneActions: tickets.flatMap((t) => [...t.body.matchAll(/^- ✅ (\d{4}-\d{2}-\d{2}) — (.+)$/gm)].map((m) => {
      const i = m[2].indexOf('—');
      return { id: t.id, icon: t.icon, date: m[1],
        tool: i < 0 ? 'divers' : m[2].slice(0, i).trim(),
        text: i < 0 ? m[2].trim() : m[2].slice(i + 1).trim() };
    })).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)),
    live,
    bodies: Object.fromEntries(tickets.map((t) => [t.id, md(t.body)])),
    epicBodies: Object.fromEntries(epics.map((e) => [e.id, md(e.body)])),
  };
  const counts = STATUSES.map((s) => `${tickets.filter((t) => t.status === s).length} ${STATUS_LABEL[s].toLowerCase()}`).join(' · ');
  const nAct = data.actions.length;
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
    <span class="spacer"></span>
    <input id="q" type="search" placeholder="Filtrer  ( / )" aria-label="Filtrer les tickets">
    <button id="theme" class="ghost" title="Clair / sombre">◐</button>
  </div>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" data-view="kanban">Kanban</button>
    <button class="tab" role="tab" data-view="threads">Fils par épique</button>
    <button class="tab" role="tab" data-view="graph">Graphe des blocages</button>
    <button class="tab" role="tab" data-view="roadmap">Roadmap</button>
    <button class="tab" role="tab" data-view="actions">Mes actions${nAct ? ` <b class="pill">${nAct}</b>` : ''}</button>
  </div>
</header>
<main>
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
    console.log(`${data.tickets.length} tickets · ${data.epics.length} épiques → BACKLOG.md + backlog.html`);
    for (const w of data.warnings) console.warn(`  ⚠ ${w}`);
  }
  return data;
}

/** Coche une action : retire la ligne `action:` et journalise dans le corps du ticket. */
function completeAction(id) {
  const safe = readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md'));
  if (!safe.includes(id)) throw new Error('identifiant inconnu');   // jamais de chemin construit depuis l'entrée
  const file = join(DIR, `${id}.md`);
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^action: (.*)$/m);
  if (!m) throw new Error('aucune action en attente sur ce ticket');
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let out = raw.replace(/^action: .*\n/m, '');
  out = out.trimEnd() + (out.includes('\n## Journal') ? '' : '\n\n## Journal') +
    `\n\n- ✅ ${today} — ${m[1].trim()}\n`;
  writeFileSync(file, out, 'utf8');
  return m[1].trim();
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
    if (req.method === 'POST' && req.url === '/api/action/done') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const done = completeAction(JSON.parse(body).id);
          console.log(`  ✅ action cochée — ${done}`);
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
  console.log(`Squelette créé dans ${DIR}. Lance « node backlog.mjs --serve ».`);
}

if (flag('--init')) init();
else if (flag('--serve')) serve();
else generate();
