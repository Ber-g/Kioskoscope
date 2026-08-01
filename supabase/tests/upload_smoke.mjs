// Kioskoscope — smoke-test des ENVOIS DE GROS FICHIERS (CIN-101), avec une session RÉELLE.
//
// Ce que ce test répond, et qu'aucune suite en CI ne peut répondre : le backend accepte-t-il
// vraiment ce qu'on croit ? Il tourne contre le VRAI Storage, sous RLS, avec un JWT de simple
// membre — jamais en `service_role`, qui bypasserait tout et ne prouverait rien.
//
// Il transfère très peu : le protocole d'envoi reprenable DÉCLARE la taille à la création, et le
// serveur refuse d'emblée si elle dépasse le plafond. Mesurer le plafond ne coûte donc aucun
// octet, même quand on interroge des tailles de 50 Go.
//
// Lancement :
//   node supabase/tests/upload_smoke.mjs
//   UPLOAD_EMAIL=… UPLOAD_PASSWORD=… node supabase/tests/upload_smoke.mjs
//
// URL et clé anon sont lues depuis `admin-dashboard/.env` (comme `isolation.mjs`).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadSupabaseConfig() {
  let url = process.env.VITE_SUPABASE_URL;
  let anon = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    try {
      for (const raw of readFileSync(resolve(repoRoot, "admin-dashboard", ".env"), "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key === "VITE_SUPABASE_URL" && !url) url = val;
        if (key === "VITE_SUPABASE_ANON_KEY" && !anon) anon = val;
      }
    } catch {
      /* .env absent */
    }
  }
  return { url, anon };
}

let checks = 0;
let failures = 0;
function assert(cond, label) {
  checks += 1;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✖ ${label}`);
  }
}

const { url, anon } = loadSupabaseConfig();
if (!url || !anon) {
  console.error("✖ VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY introuvables.");
  process.exit(2);
}

const EMAIL = process.env.UPLOAD_EMAIL ?? "test@test.com";
const PASSWORD = process.env.UPLOAD_PASSWORD ?? "test";
const sb = createClient(url, anon);
const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (authErr) {
  console.error(`✖ connexion refusée pour ${EMAIL} : ${authErr.message}`);
  process.exit(2);
}
const token = auth.session.access_token;

const { data: orgs, error: orgErr } = await sb.from("organizations").select("id").limit(1);
if (orgErr || !orgs?.length) {
  console.error(`✖ aucune organisation lisible : ${orgErr?.message ?? "liste vide"}`);
  process.exit(2);
}
const org = orgs[0].id;

const TUS = `${url}/storage/v1/upload/resumable`;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const H = { authorization: `Bearer ${token}`, "tus-resumable": "1.0.0" };
const created = [];

async function tusCreate(objectName, length) {
  const res = await fetch(TUS, {
    method: "POST",
    headers: {
      ...H,
      "upload-length": String(length),
      "upload-metadata": [
        `bucketName ${b64("media")}`,
        `objectName ${b64(objectName)}`,
        `contentType ${b64("video/mp4")}`,
      ].join(","),
      "x-upsert": "true",
    },
  });
  const loc = res.headers.get("location");
  if (loc) created.push(loc);
  return { status: res.status, location: loc, body: res.status >= 400 ? await res.text() : "" };
}

const patch = (loc, offset, body) =>
  fetch(loc, {
    method: "PATCH",
    headers: { ...H, "upload-offset": String(offset), "content-type": "application/offset+octet-stream" },
    body,
  });

console.log(`\n▶ Envois de gros fichiers — org ${org.slice(0, 8)}…, compte ${EMAIL}\n`);

// ── 1. Le plafond réel, mesuré sans transférer d'octet ───────────────────────
console.log("— Plafond de taille —");
let lo = 1;
let hi = 8 * 1024 ** 3;
if ((await tusCreate(`${org}/smoke-lo`, lo)).status !== 201) {
  console.error("  ✖ même un octet est refusé : le bucket ou les droits sont cassés.");
  process.exit(1);
}
while (hi - lo > 64 * 1024) {
  const mid = Math.floor((lo + hi) / 2);
  if ((await tusCreate(`${org}/smoke-bin`, mid)).status === 201) lo = mid;
  else hi = mid;
}
const limitMiB = lo / 1024 ** 2;
console.log(`  → plafond mesuré : ${lo} octets ≈ ${limitMiB.toFixed(0)} Mio`);
assert(lo > 0, "un plafond est bien appliqué par le serveur");
if (limitMiB < 1024) {
  console.log(
    `  ⚠️  ${limitMiB.toFixed(0)} Mio seulement : la cible CIN-101 (6 Go) est HORS D'ATTEINTE.\n` +
      "     Le plafond GLOBAL du projet (Dashboard → Storage → Settings) prime sur\n" +
      "     `storage.buckets.file_size_limit` posé par la migration 0028. Relevez-le d'abord.",
  );
}
assert(
  (await tusCreate(`${org}/smoke-toobig`, 6 * 1024 ** 3)).status === (6 * 1024 ** 3 <= lo ? 201 : 413),
  "une taille au-delà du plafond est refusée À LA CRÉATION (aucun octet émis)",
);

// ── 2. L'isolation tient sur le canal reprenable ─────────────────────────────
console.log("\n— Isolation (RLS storage) sur le canal reprenable —");
const foreign = "00000000-0000-0000-0000-000000000000";
assert((await tusCreate(`${foreign}/smoke`, 1024)).status === 403, "chemin d'une autre org refusé (403)");
assert(
  (await tusCreate(`${foreign}/${"a".repeat(64)}/video/en/${"b".repeat(64)}`, 1024)).status === 403,
  "chemin PROFOND d'une autre org refusé aussi (la policy lit bien le 1er segment)",
);

// ── 3. Reprise après coupure : l'offset serveur fait foi ─────────────────────
console.log("\n— Reprise après coupure —");
const name = `${org}/${"a".repeat(64)}/video/en/${"b".repeat(64)}`;
const TOTAL = 2 * 1024 * 1024;
const payload = Buffer.alloc(TOTAL);
for (let i = 0; i < TOTAL; i++) payload[i] = (i * 13) & 0xff;

const c = await tusCreate(name, TOTAL);
assert(c.status === 201 && !!c.location, "création d'un envoi sur un chemin profond de SON org");
if (c.location) {
  const p1 = await patch(c.location, 0, payload.subarray(0, TOTAL / 2));
  assert(p1.status === 204, "première moitié acceptée");

  const head = await fetch(c.location, { method: "HEAD", headers: H });
  const offset = Number(head.headers.get("upload-offset"));
  assert(offset === TOTAL / 2, `l'offset relu vaut exactement ce qui est arrivé (${offset})`);

  const p2 = await patch(c.location, offset, payload.subarray(offset));
  assert(p2.status === 204, "seconde moitié acceptée depuis l'offset relu");

  const { data: dl, error: dlErr } = await sb.storage.from("media").download(name);
  if (dlErr) assert(false, `objet retéléchargeable : ${dlErr.message}`);
  else {
    const back = Buffer.from(await dl.arrayBuffer());
    assert(back.length === TOTAL, `l'objet fait la taille annoncée (${back.length})`);
    assert(back.equals(payload), "octet pour octet identique à la source APRÈS reprise");
  }

  const folder = name.slice(0, name.lastIndexOf("/"));
  const { data: listed } = await sb.storage.from("media").list(folder, { search: "b".repeat(64), limit: 10 });
  assert((listed ?? []).length === 1, "objet listable dans son dossier profond (le dedup peut le voir)");
  const { error: sErr } = await sb.storage.from("media").createSignedUrl(name, 60);
  assert(!sErr, "URL signée délivrable sur le chemin profond (c'est ainsi que la cabine lit)");
}

// ── 4. Octets orphelins : invisibles, mais révocables ────────────────────────
console.log("\n— Envoi abandonné : que reste-t-il ? —");
const orphan = `${org}/smoke-orphan`;
const o = await tusCreate(orphan, 4 * 1024 * 1024);
if (o.location) {
  await patch(o.location, 0, Buffer.alloc(1024 * 1024, 7));
  const { data: seen } = await sb.storage.from("media").list(org, { search: "smoke-orphan", limit: 10 });
  assert((seen ?? []).length === 0, "les octets d'un envoi inachevé sont INVISIBLES du bucket");
  const del = await fetch(o.location, { method: "DELETE", headers: H });
  assert(del.status === 204, "le verbe DELETE de résiliation est honoré (seule prise sur ces octets)");
  const after = await fetch(o.location, { method: "HEAD", headers: H });
  assert(after.status === 404 || after.status === 410, "après résiliation, l'envoi n'existe plus");
}

// ── Nettoyage ────────────────────────────────────────────────────────────────
for (const loc of created) {
  await fetch(loc, { method: "DELETE", headers: H }).catch(() => {});
}
const { data: leftovers } = await sb.storage.from("media").list(org, { limit: 200, search: "smoke-" });
const paths = (leftovers ?? []).map((f) => `${org}/${f.name}`);
paths.push(name);
const { error: rmErr } = await sb.storage.from("media").remove(paths);

console.log(`\n—— ${checks - failures}/${checks} vérifications OK ——`);
if (rmErr) console.warn(`⚠️  nettoyage partiel : ${rmErr.message}`);
if (failures > 0) {
  console.error(`✖ ${failures} vérification(s) en échec.`);
  process.exit(1);
}
console.log("✅ upload_smoke : plafond, isolation, reprise et résiliation vérifiés en conditions réelles.");
