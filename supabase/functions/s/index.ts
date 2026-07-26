// Kioskoscope — Edge Function de partage de séance (CIN-020, F5).
//
// Route publique /s/{token} (le QR de fin de séance). Rend une page HTML récap des
// films vus + un export CSV importable dans Letterboxd. Tourne en service_role mais
// ne lit QUE la projection sûre `session_recap(token)` (aucun booth/org/montant/PII).
//
// Sécurité : token = secret de capacité 128 bits (non énumérable) ; réponse générique
// si inconnu (pas de signal d'énumération) ; en-têtes noindex + CSP stricte (page
// auto-suffisante, zéro ressource externe) ; throttle best-effort par IP.
//
// Déploiement : `supabase functions deploy s --no-verify-jwt`
// (--no-verify-jwt car la route est PUBLIQUE : pas de header Authorization attendu).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

interface RecapRow {
  started_at: string;
  position: number;
  title: string;
  year: number;
  director: string;
  source: "user_choice" | "recommendation";
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// Token base64url de 16 octets = ~22 caractères. On borne large pour tolérer d'éventuels
// formats futurs, mais on rejette tout de suite ce qui ne peut pas être un token (anti-abus).
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Throttle best-effort par IP (par isolate — un vrai rate-limit distribué = plus tard).
const HITS = new Map<string, { n: number; reset: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 40;

function throttled(ip: string): boolean {
  const now = Date.now();
  const cur = HITS.get(ip);
  if (!cur || now > cur.reset) {
    HITS.set(ip, { n: 1, reset: now + WINDOW_MS });
    return false;
  }
  cur.n += 1;
  return cur.n > MAX_PER_WINDOW;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
};

// La page récap est servie par un hébergeur statique (Cloudflare Pages) qui consomme
// cette fonction en JSON cross-origin. Données publiques par token, non-PII → origine *.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoDate(ts: string): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function htmlPage(rows: RecapRow[], token: string): string {
  const date = rows.length ? isoDate(rows[0].started_at) : "";
  const items = rows
    .map((r) => {
      const year = r.year > 0 ? ` <span class="y">(${r.year})</span>` : "";
      const dir = r.director ? `<div class="dir">de ${esc(r.director)}</div>` : "";
      const tag = r.source === "recommendation" ? `<span class="tag">suggéré</span>` : "";
      return `<li><div class="ttl">${esc(r.title)}${year}${tag}</div>${dir}</li>`;
    })
    .join("");
  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Votre séance Kioskoscope</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0e0f13; color: #f2f3f5; padding: 24px 18px 48px; }
  main { max-width: 560px; margin: 0 auto; }
  .brand { font-size: 13px; letter-spacing: .16em; text-transform: uppercase; color: #8a8f9a; }
  h1 { font-size: 24px; margin: 4px 0 2px; }
  .date { color: #8a8f9a; margin-bottom: 22px; }
  ol { list-style: none; padding: 0; margin: 0 0 28px; counter-reset: n; }
  li { counter-increment: n; padding: 14px 0 14px 42px; position: relative; border-top: 1px solid #23262e; }
  li::before { content: counter(n); position: absolute; left: 0; top: 14px; width: 28px; height: 28px;
    border-radius: 50%; background: #1b1e25; color: #b7bcc6; font-size: 13px; display: grid; place-items: center; }
  .ttl { font-weight: 600; }
  .y { color: #8a8f9a; font-weight: 400; }
  .dir { color: #9aa0ab; font-size: 14px; }
  .tag { display: inline-block; margin-left: 8px; font-size: 11px; padding: 2px 8px; border-radius: 999px;
    background: #1f2a44; color: #9db4e6; vertical-align: middle; }
  .cta { display: inline-block; background: #f2f3f5; color: #0e0f13; text-decoration: none; font-weight: 600;
    padding: 12px 20px; border-radius: 10px; }
  .foot { margin-top: 34px; color: #6b7079; font-size: 12px; }
</style></head><body><main>
  <div class="brand">Kioskoscope</div>
  <h1>Votre séance</h1>
  <div class="date">${date}</div>
  <ol>${items}</ol>
  <a class="cta" href="./${esc(token)}.csv" download="kioskoscope-seance.csv">Exporter vers Letterboxd (CSV)</a>
  <div class="foot">Lien privé, non indexé. Aucune donnée personnelle n'est stockée sur cette page.</div>
</main></body></html>`;
}

function jsonDoc(rows: RecapRow[]): string {
  return JSON.stringify({
    date: rows.length ? isoDate(rows[0].started_at) : null,
    films: rows.map((r) => ({
      position: r.position,
      title: r.title,
      year: r.year > 0 ? r.year : null,
      director: r.director || null,
      source: r.source,
    })),
  });
}

function csvDoc(rows: RecapRow[]): string {
  const header = "Title,Year,Directors,WatchedDate";
  const lines = rows.map((r) =>
    [csvField(r.title), r.year > 0 ? String(r.year) : "", csvField(r.director), isoDate(r.started_at)].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

function notFound(wantJson: boolean): Response {
  if (wantJson) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { ...SECURITY_HEADERS, ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const body = `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Séance introuvable</title>
<body style="font:16px system-ui;background:#0e0f13;color:#f2f3f5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="letter-spacing:.16em;text-transform:uppercase;color:#8a8f9a;font-size:13px">Kioskoscope</div>
<p>Ce lien de séance n'existe pas ou a expiré.</p></div>`;
  return new Response(body, { status: 404, headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Préflight CORS (la page statique CF Pages consomme l'API en JSON cross-origin).
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...CORS_HEADERS } });
  }
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { ...SECURITY_HEADERS, ...CORS_HEADERS } });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (throttled(ip)) {
    return new Response("Too Many Requests", { status: 429, headers: { ...SECURITY_HEADERS, ...CORS_HEADERS, "Retry-After": "60" } });
  }

  // Dernier segment du chemin = token, avec suffixe .csv/.json optionnel (ou ?format=).
  const url = new URL(req.url);
  const fmt = url.searchParams.get("format");
  let seg = url.pathname.split("/").filter(Boolean).pop() ?? "";
  let wantCsv = fmt === "csv";
  let wantJson = fmt === "json";
  if (seg.endsWith(".csv")) { wantCsv = true; seg = seg.slice(0, -4); }
  else if (seg.endsWith(".json")) { wantJson = true; seg = seg.slice(0, -5); }
  const token = decodeURIComponent(seg);
  if (!TOKEN_RE.test(token)) return notFound(wantJson);

  const { data, error } = await admin.rpc("session_recap", { p_token: token });
  if (error) {
    console.error("[share] rpc error", error.message);
    const h = { ...SECURITY_HEADERS, ...CORS_HEADERS };
    return new Response(wantJson ? JSON.stringify({ error: "server_error" }) : "Server Error", { status: 500, headers: h });
  }
  const rows = (data ?? []) as RecapRow[];
  if (rows.length === 0) return notFound(wantJson);

  // Comptage des ouvertures de la page de partage (F21 / CIN-106). Journalisé APRÈS avoir établi
  // que le token existe — un token inconnu ne doit rien créer, sinon on offrirait un compteur
  // d'énumération. ⚠️ ZÉRO donnée personnelle : ni IP, ni user-agent, ni cookie ; on n'enregistre
  // que « telle séance a vu sa page ouverte à tel instant ».
  //
  // Volontairement NON attendu (`void`) et jamais bloquant : une statistique ne doit pas pouvoir
  // empêcher un visiteur de voir sa page. Un échec se journalise et s'oublie.
  void admin
    .rpc("record_share_open", { p_token: token })
    .then(({ error: openErr }: { error: { message: string } | null }) => {
      if (openErr) console.error("[share] record_share_open", openErr.message);
    });

  if (wantJson) {
    return new Response(jsonDoc(rows), {
      headers: { ...SECURITY_HEADERS, ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  }
  if (wantCsv) {
    return new Response(csvDoc(rows), {
      headers: {
        ...SECURITY_HEADERS,
        ...CORS_HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="kioskoscope-seance.csv"',
      },
    });
  }
  return new Response(htmlPage(rows, token), {
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, max-age=300" },
  });
});
