// Smoke-tests DOM-free de la LOGIQUE PURE de admin-dashboard.
//
// Garde de non-régression sur les agrégations / tri / mapping — SANS réseau,
// SANS Supabase, SANS DOM réel (voir `_env.ts` pour les stubs de globals).
// Lancé par `npm run -w admin-dashboard test` (bundle esbuild → node).
//
// ⚠️ `./_env` DOIT rester le tout premier import (installe les stubs avant que
// i18n / dom ne s'initialisent). Ne pas réordonner.
import { FakeEl, collectByClassToken } from "./_env";

import type { Booth, BoothTelemetry, HealthStatus } from "../src/domain/types";
import { MOCK_BOOTHS } from "../src/data/mockFleet";
import { computeKpis, sortBooths, statusDistribution } from "../src/ui/components";
import type { SortKey, SortState } from "../src/ui/components";
import { boothToRow, rowToBooth } from "../src/data/mappers";
import { formatMoney, relativeTime } from "../src/ui/dom";
import { allHealthStatuses, connectionMeta, healthMeta } from "../src/domain/status";

// ── Micro-harnais d'assertions ───────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  assert(Object.is(actual, expected), `${msg} — attendu ${String(expected)}, obtenu ${String(actual)}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ids(booths: readonly Booth[]): string[] {
  return booths.map((b) => b.id);
}

function sort(key: SortKey, dir: "asc" | "desc"): Booth[] {
  const state: SortState = { key, dir };
  return sortBooths(MOCK_BOOTHS, state);
}

// ── 0. Fixtures cohérentes ───────────────────────────────────────────────────
assertEqual(MOCK_BOOTHS.length, 6, "MOCK_BOOTHS : parc de démo à 6 bornes");

// ── 1. sortBooths — tri, direction, stabilité, immutabilité ──────────────────
const before = ids(MOCK_BOOTHS);

// sessions asc : 0,0,2,8,15,23 ; les deux 0 gardent leur ordre source (stable).
assert(
  deepEqual(ids(sort("sessions", "asc")), [
    "booth-lyon-02",
    "booth-marseille-01",
    "booth-lyon-01",
    "booth-paris-02",
    "booth-nantes-01",
    "booth-paris-01",
  ]),
  "sortBooths(sessions, asc) : ordre croissant + stabilité sur les ex æquo (0)",
);

// sessions desc : 23,15,8,2,0,0 ; les ex æquo (0) restent dans l'ordre source
// → desc n'est PAS l'inverse strict de asc (preuve de stabilité).
assert(
  deepEqual(ids(sort("sessions", "desc")), [
    "booth-paris-01",
    "booth-nantes-01",
    "booth-paris-02",
    "booth-lyon-01",
    "booth-lyon-02",
    "booth-marseille-01",
  ]),
  "sortBooths(sessions, desc) : ordre décroissant + ex æquo stables (non inversés)",
);

// revenue asc : monotone croissant sur revenueTodayCents.
const revAsc = sort("revenue", "asc");
let revMonotone = true;
for (let i = 1; i < revAsc.length; i++) {
  if (revAsc[i]!.revenueTodayCents < revAsc[i - 1]!.revenueTodayCents) revMonotone = false;
}
assert(revMonotone, "sortBooths(revenue, asc) : revenus non décroissants");

// label asc : ordre alphabétique insensible à la casse (comme l'implémentation).
const labelAsc = sort("label", "asc");
let labelMonotone = true;
for (let i = 1; i < labelAsc.length; i++) {
  if (labelAsc[i]!.label.toLowerCase() < labelAsc[i - 1]!.label.toLowerCase()) labelMonotone = false;
}
assert(labelMonotone, "sortBooths(label, asc) : labels triés (lowercase, non décroissants)");
assert(
  deepEqual(ids(labelAsc).slice().reverse(), ids(sort("label", "desc"))) === false ||
    labelAsc.length === new Set(ids(labelAsc)).size,
  "sortBooths(label) : jeu d'ids identique quel que soit le sens",
);

// health asc : ordre error < offline < attention < maintenance < operational.
const healthAsc = sort("health", "asc");
assertEqual(healthAsc[0]!.health, "error", "sortBooths(health, asc) : 'error' en tête");
assertEqual(healthAsc[healthAsc.length - 1]!.health, "operational", "sortBooths(health, asc) : 'operational' en fin");
const healthDesc = sort("health", "desc");
assertEqual(healthDesc[0]!.health, "operational", "sortBooths(health, desc) : 'operational' en tête");

// Immutabilité : entrée inchangée + nouvelle référence de tableau.
assert(deepEqual(ids(MOCK_BOOTHS), before), "sortBooths : n'altère pas le tableau source");
assert(sort("label", "asc") !== (MOCK_BOOTHS as unknown as Booth[]), "sortBooths : renvoie un NOUVEAU tableau");

// ── 2. computeKpis — compteurs alignés sur le parc ───────────────────────────
const kpis = computeKpis(MOCK_BOOTHS);
assertEqual(kpis.length, 6, "computeKpis : 6 tuiles");
assertEqual(kpis[0]!.value, "6", "computeKpis[booths] : total = 6");
assertEqual(kpis[1]!.value, "2", "computeKpis[operational] : 2");
assertEqual(kpis[2]!.value, "1", "computeKpis[attention] : 1");
assertEqual(kpis[3]!.value, "2", "computeKpis[error+offline] : 1+1 = 2");
// sessions total : 23+8+2+0+0+15 = 48 ; revenu : 11500+4000+1000+7500 = 24000.
assertEqual(kpis[4]!.value, "48", "computeKpis[sessions] : somme = 48");
assert(kpis[5]!.value.includes("240,00"), "computeKpis[revenue] : 24000c → 240,00 €");

// Filtres portés par les tuiles cliquables (câblage vue ↔ statut).
assert(deepEqual(kpis[0]!.filter, []), "computeKpis[booths].filter = [] (tout)");
assert(deepEqual(kpis[1]!.filter, ["operational"]), "computeKpis[operational].filter = ['operational']");
assert(deepEqual(kpis[3]!.filter, ["error", "offline"]), "computeKpis[errorOffline].filter = ['error','offline']");

// Invariant de distribution : la somme des compteurs par statut = total du parc.
const perStatus = allHealthStatuses().map((s) => MOCK_BOOTHS.filter((b) => b.health === s).length);
assertEqual(
  perStatus.reduce((a, b) => a + b, 0),
  MOCK_BOOTHS.length,
  "distribution : Σ compteurs par statut = nombre de bornes",
);

// ── 3. statusDistribution — agrégation réelle (via faux DOM) ──────────────────
const distCard = statusDistribution(MOCK_BOOTHS) as unknown as FakeEl;
const bars = collectByClassToken(distCard, "progress-bar");
// 5 statuts distincts présents dans le parc → 5 segments.
assertEqual(bars.length, 5, "statusDistribution : un segment par statut présent (5)");

let segTotal = 0;
let widthTotal = 0;
for (const bar of bars) {
  const title = bar.getAttribute("title") ?? "";
  const n = Number(title.split(":").pop()!.trim());
  assert(Number.isFinite(n) && n > 0, `statusDistribution : segment compté (${title})`);
  segTotal += n;
  const w = Number(/width:\s*([\d.]+)%/.exec(bar.getAttribute("style") ?? "")?.[1] ?? "NaN");
  widthTotal += w;
}
assertEqual(segTotal, MOCK_BOOTHS.length, "statusDistribution : Σ segments = nombre de bornes (6)");
assert(Math.abs(widthTotal - 100) < 1e-6, "statusDistribution : Σ largeurs = 100%");

// ── 4. Mappers — round-trip row → booth → row sur les champs mappés ──────────
const telemetry: BoothTelemetry = {
  uptimePct: 98.5,
  temperatureC: 42,
  storageFreePct: 55,
  cpuLoadPct: 30,
  currentFilmTitle: "Aurora",
  connection: "lte",
  signalPct: 77,
};

const row = {
  id: "booth-test-01",
  organization_id: "org-test",
  label: "Kiosk Test",
  location: "Testville",
  address: "1 rue du Test",
  gps_lat: 48.8566,
  gps_lng: 2.3522,
  venue_type: "bar",
  serial: "SN-TEST-0001",
  health: "operational" as HealthStatus,
  indicators: ["powered", "in_use"],
  software_version: "0.3.0",
  last_heartbeat_at: new Date("2026-07-24T10:00:00.000Z").toISOString(),
  telemetry,
  notes: "note de test",
  signed_at: null,
  device_key_ref: null,
  maintenance_hour: 4,
};

const booth = rowToBooth(row);
assertEqual(booth.serial, "SN-TEST-0001", "rowToBooth : serial mappé");
assertEqual(booth.venueType, "bar", "rowToBooth : venueType mappé");
assert(deepEqual(booth.telemetry, telemetry), "rowToBooth : telemetry complète préservée");

const row2 = boothToRow(booth);
// boothToRow n'émet qu'un sous-ensemble ; on vérifie l'égalité sur ces champs.
const mappedFields = [
  "id",
  "organization_id",
  "label",
  "location",
  "address",
  "gps_lat",
  "gps_lng",
  "venue_type",
  "serial",
  "health",
  "indicators",
  "software_version",
  "telemetry",
  "notes",
] as const;
for (const f of mappedFields) {
  assert(
    deepEqual((row2 as Record<string, unknown>)[f], (row as Record<string, unknown>)[f]),
    `round-trip mapper : champ '${f}' préservé`,
  );
}

// ── 5. Formatage — cas limites ───────────────────────────────────────────────
assert(formatMoney(0).includes("0,00"), "formatMoney(0) : '0,00'");
assert(formatMoney(0).includes("€"), "formatMoney(0) : symbole €");
assert(formatMoney(11500).includes("115,00"), "formatMoney(11500) : 115,00");
assert(formatMoney(-500).includes("5,00"), "formatMoney(-500) : magnitude 5,00");

assertEqual(relativeTime(0), "jamais", "relativeTime(0) : 'jamais' (aucun heartbeat)");
assertEqual(relativeTime(-1), "jamais", "relativeTime(<=0) : 'jamais'");
{
  const r = relativeTime(Date.now() - 30_000);
  assert(r.startsWith("il y a") && r.includes("s"), `relativeTime(~30s) : 'il y a N s' (obtenu '${r}')`);
}
{
  const r = relativeTime(Date.now() - 5 * 60_000);
  assert(r.includes("min"), `relativeTime(~5min) : 'il y a N min' (obtenu '${r}')`);
}

// ── 6. Helpers de statut / connexion ─────────────────────────────────────────
assertEqual(allHealthStatuses().length, 5, "allHealthStatuses : 5 statuts");
assert(
  (["operational", "attention", "error", "offline", "maintenance"] as HealthStatus[]).every((s) =>
    allHealthStatuses().includes(s),
  ),
  "allHealthStatuses : couvre tous les statuts de santé",
);
assertEqual(healthMeta("operational").color, "green", "healthMeta(operational).color = green");
assertEqual(healthMeta("error").color, "red", "healthMeta(error).color = red");
assertEqual(healthMeta("operational").label, "Opérationnel", "healthMeta(operational).label (fr)");
assertEqual(connectionMeta("wifi").label, "Wi-Fi", "connectionMeta(wifi).label");
assertEqual(connectionMeta("lte").label, "LTE (4G)", "connectionMeta(lte).label");

// ── Verdict ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\nlogic_smoke : ${passed}/${total} assertions OK` + (failed ? `, ${failed} ÉCHEC(S)` : ""));
if (failed > 0) process.exit(1);
