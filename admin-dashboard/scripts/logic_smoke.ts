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
import { HOME, VIEWS, formatRoute, parseRoute, sameRoute, type Route, type SettingsTab } from "../src/ui/router";
import { designatedOrgId, resolveSettingsNav, type SettingsNavContext } from "../src/ui/settingsNav";
import { setLang } from "../src/i18n";

// DÉTERMINISME : ce test vérifie des libellés FRANÇAIS (relativeTime, healthMeta…). La langue par
// défaut est DÉTECTÉE (localStorage/navigator) → dépend de l'environnement (mac FR en local, en-US
// sur le runner CI → échecs). On force donc le français, quel que soit l'environnement.
setLang("fr");

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

// ── 7. Routage (CIN-118) ─────────────────────────────────────────────────────
// La grammaire d'URL est exactement le genre de code qui casse SANS BRUIT : une route mal lue
// n'affiche pas d'erreur, elle affiche la mauvaise page. D'où une couverture serrée ici.
{
  const p = (h: string): Route | null => parseRoute(h);
  const view = (h: string): string => p(h)?.view ?? "∅";

  // Accueil et vues simples
  assertEqual(view(""), "overview", "parseRoute('') : accueil (URL nue au premier chargement)");
  assertEqual(view("#/"), "overview", "parseRoute('#/') : accueil");
  assertEqual(view("#"), "overview", "parseRoute('#') : accueil");
  assertEqual(p("#/map")?.overviewMode, "map", "parseRoute('#/map') : vue d'ensemble en carte");
  assertEqual(p("#/")?.overviewMode, "list", "parseRoute('#/') : vue d'ensemble en liste");
  assertEqual(view("#/sessions"), "sessions", "parseRoute('#/sessions')");
  assertEqual(view("#/organizations"), "organizations", "parseRoute('#/organizations') : le roster");

  // Onglets par défaut — implicites dans l'URL, explicites dans la route
  assertEqual(p("#/settings")?.settingsTab, "general", "parseRoute('#/settings') : onglet Général par défaut");
  assertEqual(p("#/settings/styles")?.settingsTab, "styles", "parseRoute('#/settings/styles')");
  assertEqual(p("#/booths/abc")?.boothId, "abc", "parseRoute('#/booths/abc') : identifiant de cabine");
  assertEqual(p("#/booths/abc")?.boothTab, "synthese", "parseRoute('#/booths/abc') : onglet Synthèse par défaut");
  assertEqual(p("#/booths/abc/medias")?.boothTab, "medias", "parseRoute('#/booths/abc/medias') : deep-link CIN-045");

  // Administration d'un client depuis le roster (CIN-091 b)
  assertEqual(view("#/organizations/org-7"), "settings", "parseRoute('#/organizations/org-7') : hub d'administration");
  assertEqual(p("#/organizations/org-7")?.adminOrgId, "org-7", "parseRoute('#/organizations/org-7') : org ciblée");
  assertEqual(p("#/organizations/org-7/members")?.settingsTab, "members", "parseRoute('#/organizations/org-7/members')");
  assertEqual(p("#/settings")?.adminOrgId, null, "parseRoute('#/settings') : aucune org ciblée (la sienne)");

  // Ce qui doit être REFUSÉ. `null` et pas un repli silencieux : l'appelant doit pouvoir
  // remplacer l'entrée d'historique, sinon le bouton Retour retraverse l'URL fautive.
  assertEqual(p("#/nope"), null, "parseRoute : vue inconnue refusée");
  assertEqual(p("#/booths"), null, "parseRoute : cabine sans identifiant refusée");
  assertEqual(p("#/booths/abc/nope"), null, "parseRoute : onglet de cabine inconnu refusé");
  assertEqual(p("#/settings/nope"), null, "parseRoute : onglet d'organisation inconnu refusé");
  assertEqual(p("#/sessions/extra"), null, "parseRoute : segment surnuméraire refusé");
  assertEqual(p("#/booths/a/b/c"), null, "parseRoute : profondeur excessive refusée");
  assertEqual(p("#/map/extra"), null, "parseRoute : '#/map' n'accepte pas de segment");
  // Une URL malformée ne doit pas faire LEVER (`decodeURIComponent` sur un '%' isolé). Elle
  // reste une route BIEN FORMÉE dont l'identifiant ne résoudra simplement aucune cabine : le hub
  // répond « Cabine introuvable », ce qui est la réponse honnête à un lien cassé — bien meilleure
  // qu'une redirection muette vers l'accueil, qui laisserait croire que le lien était bon.
  {
    let threw = false;
    let parsed: Route | null = null;
    try {
      parsed = p("#/booths/%");
    } catch {
      threw = true;
    }
    assert(!threw, "parseRoute : échappement invalide ne fait pas lever");
    assertEqual(parsed?.boothId, "%", "parseRoute : segment indécodable conservé tel quel");
  }

  // Aller-retour : formater puis relire doit redonner la même adresse.
  const roundTrip = (r: Route, expected: string, label: string): void => {
    const href = formatRoute(r);
    assertEqual(href, expected, `formatRoute : ${label}`);
    const back = parseRoute(href);
    assert(back !== null && sameRoute(back, r), `aller-retour : ${label}`);
  };
  roundTrip(HOME, "#/", "accueil");
  roundTrip({ ...HOME, overviewMode: "map" }, "#/map", "carte");
  roundTrip({ ...HOME, view: "sessions" }, "#/sessions", "vue simple");
  roundTrip({ ...HOME, view: "settings" }, "#/settings", "mon organisation");
  roundTrip({ ...HOME, view: "settings", settingsTab: "billing" }, "#/settings/billing", "onglet d'organisation");
  roundTrip({ ...HOME, view: "settings", adminOrgId: "org-7" }, "#/organizations/org-7", "administration d'un client");
  roundTrip({ ...HOME, view: "settings", adminOrgId: "org-7", settingsTab: "roles" }, "#/organizations/org-7/roles", "client + onglet");
  roundTrip({ ...HOME, view: "booth", boothId: "booth-1" }, "#/booths/booth-1", "hub cabine");
  roundTrip({ ...HOME, view: "booth", boothId: "booth-1", boothTab: "revenus" }, "#/booths/booth-1/revenus", "hub cabine + onglet");

  // Identifiants exotiques : un id à barre oblique casserait la grammaire s'il n'était pas échappé.
  {
    const r: Route = { ...HOME, view: "booth", boothId: "a/b c" };
    const back = parseRoute(formatRoute(r));
    assertEqual(back?.boothId, "a/b c", "aller-retour : identifiant échappé (slash + espace)");
  }

  // `formatRoute` n'émet QUE ce qui concerne la vue : un champ résiduel ne doit pas fuiter
  // dans l'URL — c'est ce qui rend `sameRoute` fiable comme garde anti-boucle.
  assertEqual(
    formatRoute({ ...HOME, view: "sessions", boothId: "x", settingsTab: "billing", adminOrgId: "org-7" }),
    "#/sessions",
    "formatRoute : les champs hors-sujet n'apparaissent pas dans l'URL",
  );
  assert(
    sameRoute({ ...HOME, view: "sessions", boothId: "x" }, { ...HOME, view: "sessions", settingsTab: "roles" }),
    "sameRoute : même adresse malgré des champs hors-sujet différents",
  );
  assert(!sameRoute(HOME, { ...HOME, overviewMode: "map" }), "sameRoute : liste ≠ carte");

  // Une vue `booth` sans identifiant n'est pas adressable — repli sur l'accueil plutôt qu'une
  // URL `#/booths/` que personne ne saurait relire.
  assertEqual(formatRoute({ ...HOME, view: "booth" }), "#/", "formatRoute : cabine sans identifiant → accueil");

  // Toute vue déclarée doit produire une adresse relisible : garde-fou pour la prochaine vue
  // ajoutée à `VIEWS` sans segment d'URL correspondant.
  for (const v of VIEWS) {
    const r: Route = { ...HOME, view: v, boothId: v === "booth" ? "booth-1" : null };
    const back = parseRoute(formatRoute(r));
    assertEqual(back?.view, v, `toute vue est adressable : ${v}`);
  }
}

// ── 8. Navigation du menu Organisation ───────────────────────────────────────
// Le repli d'org et le repli d'onglet étaient séparés par le rendu : l'URL était publiée entre
// les deux, donc elle pouvait annoncer un onglet que l'écran n'affichait pas. Ces assertions
// tiennent la règle qui les réunit — et la COUTURE avec le routeur, qui est le vrai gain :
// c'est l'accord entre l'adresse et l'écran qui casse en silence, jamais chacun pris à part.
{
  const ctx = (over: Partial<SettingsNavContext> = {}): SettingsNavContext => ({
    orgIds: ["org-a", "org-b"],
    accountOrgId: "org-a",
    targetOrgId: null,
    isGlobalAdmin: false,
    ...over,
  });
  const nav = (tab: SettingsTab, orgId: string | null): { tab: SettingsTab; orgId: string | null } => ({ tab, orgId });

  assertEqual(resolveSettingsNav(nav("general", "org-b"), ctx()).orgId, "org-b", "resolveSettingsNav : org valide conservée");
  assertEqual(
    resolveSettingsNav(nav("general", "org-disparue"), ctx({ targetOrgId: "org-b" })).orgId,
    "org-b",
    "resolveSettingsNav : org supprimée → repli sur la cible",
  );
  assertEqual(resolveSettingsNav(nav("general", null), ctx()).orgId, "org-a", "resolveSettingsNav : ni requête ni cible → org du compte");
  assertEqual(
    resolveSettingsNav(nav("general", null), ctx({ accountOrgId: null, isGlobalAdmin: true })).orgId,
    "org-a",
    "resolveSettingsNav : global_admin sans org de compte → première org visible",
  );
  assertEqual(
    resolveSettingsNav(nav("general", null), ctx({ orgIds: [], accountOrgId: null, isGlobalAdmin: true })).orgId,
    null,
    "resolveSettingsNav : aucune org visible → null (sans lever)",
  );
  assertEqual(
    resolveSettingsNav(nav("subscription", "org-a"), ctx({ accountOrgId: null, isGlobalAdmin: true })).tab,
    "subscription",
    "resolveSettingsNav : onglet plateforme conservé pour un global_admin",
  );
  {
    const r = resolveSettingsNav(nav("subscription", "org-a"), ctx());
    assertEqual(r.tab, "general", "resolveSettingsNav : onglet plateforme masqué → repli sur Général");
    assert(r.changed, "resolveSettingsNav : le repli d'onglet est signalé (changed) — sinon l'URL garde l'ancien onglet");
  }
  assert(!resolveSettingsNav(nav("members", "org-a"), ctx()).changed, "resolveSettingsNav : état déjà résolu → changed faux");
  {
    // Idempotence : re-résoudre un état résolu ne doit RIEN bouger, sinon la boucle
    // rendu → publication d'URL → rendu ne se stabiliserait jamais.
    const c = ctx({ targetOrgId: "org-b" });
    const once = resolveSettingsNav(nav("subscription", "org-disparue"), c);
    const twice = resolveSettingsNav(nav(once.tab, once.orgId), c);
    assertEqual(twice.tab, once.tab, "resolveSettingsNav : idempotent (onglet)");
    assertEqual(twice.orgId, once.orgId, "resolveSettingsNav : idempotent (org)");
    assert(!twice.changed, "resolveSettingsNav : idempotent (rien à republier au second passage)");
  }
  assertEqual(
    resolveSettingsNav(nav("members", "org-b"), ctx({ accountOrgId: null, isGlobalAdmin: true })).tab,
    "members",
    "resolveSettingsNav : changer d'org ne change pas l'onglet",
  );

  assertEqual(designatedOrgId("org-b", null), "org-b", "designatedOrgId : global_admin → toute org affichée est désignée");
  assertEqual(designatedOrgId("org-a", "org-a"), null, "designatedOrgId : super_user sur SON org → pas de désignation");
  assertEqual(designatedOrgId("org-b", "org-a"), "org-b", "designatedOrgId : super_user sur une AUTRE org → désignée");
  assertEqual(designatedOrgId(null, "org-a"), null, "designatedOrgId : aucune org affichée → null");

  // Couture avec le routeur : l'adresse est dérivée de la résolution, jamais saisie à part.
  const settingsHref = (tab: SettingsTab, orgId: string | null, c: SettingsNavContext): string => {
    const r = resolveSettingsNav(nav(tab, orgId), c);
    return formatRoute({ ...HOME, view: "settings", settingsTab: r.tab, adminOrgId: designatedOrgId(r.orgId, c.accountOrgId) });
  };
  assertEqual(
    settingsHref("general", null, ctx({ accountOrgId: null, isGlobalAdmin: true })),
    "#/organizations/org-a",
    "couture : un global_admin sur « Mon organisation » obtient l'adresse d'un CLIENT",
  );
  assertEqual(settingsHref("general", null, ctx()), "#/settings", "couture : un super_user sur son org reste sur #/settings");
  {
    // Bout en bout : une adresse d'onglet plateforme lue par un non-admin ne peut pas survivre.
    const parsed = parseRoute("#/settings/subscription");
    assert(parsed?.settingsTab === "subscription", "couture : #/settings/subscription est bien lu");
    const r = resolveSettingsNav(nav(parsed!.settingsTab, null), ctx());
    assertEqual(r.tab, "general", "couture : onglet plateforme refusé à un non-admin");
    assertEqual(
      formatRoute({ ...HOME, view: "settings", settingsTab: r.tab, adminOrgId: designatedOrgId(r.orgId, "org-a") }),
      "#/settings",
      "couture : l'URL ne peut plus annoncer un onglet non affiché",
    );
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\nlogic_smoke : ${passed}/${total} assertions OK` + (failed ? `, ${failed} ÉCHEC(S)` : ""));
if (failed > 0) process.exit(1);
