// Smoke test de l'état persistant de la borne (CIN-112 lot 2) : le catalogue de secours.
//
// C'est la PREMIÈRE écriture disque que la page web peut déclencher. Ce test porte donc autant
// sur ce qui est refusé que sur ce qui est écrit — et sur l'atomicité, parce qu'une borne perd
// le courant sans prévenir et qu'un JSON tronqué la rendrait muette au démarrage suivant.
//
// Lancer : node kiosk/tests/state_smoke.mjs

import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCatalogSnapshot, writeCatalogSnapshot, readCatalogSnapshot, CATALOG_LIMITS } from "../lib/state.mjs";

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("  ✗ ÉCHEC: " + msg);
    throw new Error("ÉCHEC: " + msg);
  }
  passed += 1;
  console.log("  ✓ " + msg);
}

const HASH = "a".repeat(64);
const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const film = (over = {}) => ({ id: "m1", contentHash: HASH, title: "Le Perchoir", ...over });
const payload = (over = {}) => ({ version: 1, orgId: "org-a", boothId: "booth-1", films: [film()], ...over });

let dir;

function testValidation() {
  console.log("S1. Un instantané bien formé est accepté, et daté par NOUS");
  {
    const r = validateCatalogSnapshot(payload({ savedAt: "2099-01-01T00:00:00.000Z" }), NOW);
    assert(r.ok, "instantané valide accepté");
    // Le point qui compte : une page compromise qui se daterait dans le futur s'offrirait une
    // fenêtre hors-ligne illimitée. L'horodatage client est donc IGNORÉ, pas corrigé.
    assert(r.snapshot.savedAt === new Date(NOW).toISOString(), "horodatage posé par l'agent, celui du client ignoré");
    assert(r.snapshot.films.length === 1, "le film est conservé");
  }

  console.log("S2. Ce qui est refusé en bloc");
  {
    const bad = (p, why) => assert(validateCatalogSnapshot(p, NOW).ok === false, why);
    bad(null, "null refusé");
    bad("bonjour", "chaîne refusée");
    bad(payload({ version: 2 }), "version inconnue refusée");
    bad(payload({ orgId: "" }), "orgId vide refusé");
    bad(payload({ orgId: "x".repeat(65) }), "orgId hors borne refusé");
    bad(payload({ boothId: undefined }), "boothId absent refusé");
    bad(payload({ films: "beaucoup" }), "films non-tableau refusé");
    bad(payload({ films: Array.from({ length: CATALOG_LIMITS.MAX_FILMS + 1 }, () => film()) }), "au-delà du plafond de films, refusé");
  }

  console.log("S3. Un film sans empreinte est ÉCARTÉ, pas refusé");
  {
    // Sans empreinte, un film ne pourra jamais être rapproché du disque : le garder ferait
    // grossir le fichier avec des entrées inutilisables. Mais il ne doit pas faire tomber le reste.
    const r = validateCatalogSnapshot(payload({ films: [film(), { id: "m2" }, { id: "m3", contentHash: "PAS-UN-HASH" }, film({ id: "m4" })] }), NOW);
    assert(r.ok && r.snapshot.films.length === 2, "seuls les films rapprochables du disque sont gardés");
    assert(r.dropped === 2, "les écartés sont comptés (pour le dire dans le journal)");
  }

  console.log("S4. Un instantané trop volumineux est refusé (disque de la borne = ressource rare)");
  {
    const gros = payload({ films: [film({ synopsis: "x".repeat(600 * 1024) })] });
    assert(validateCatalogSnapshot(gros, NOW).ok === false, "au-delà de la borne d'octets, refusé");
  }
}

async function testRoundTrip() {
  console.log("S5. Écrit puis relu : ce qui sort est ce qui est entré");
  {
    const r = validateCatalogSnapshot(payload(), NOW);
    await writeCatalogSnapshot(dir, r.snapshot);
    const back = await readCatalogSnapshot(dir);
    assert(back !== null && back.films.length === 1, "instantané relu");
    assert(back.orgId === "org-a" && back.savedAt === r.snapshot.savedAt, "org et horodatage conservés");
    assert(back.films[0].contentHash === HASH, "empreinte conservée — c'est elle qui rapproche du disque");
  }

  console.log("S6. Écriture ATOMIQUE : pas de fichier temporaire laissé derrière");
  {
    const names = await readdir(dir);
    assert(names.includes("catalog.json"), "le fichier final existe");
    assert(!names.some((n) => n.endsWith(".tmp")), "aucun .tmp résiduel (écriture + rename)");
  }

  console.log("S7. Une seconde écriture remplace la première, sans état intermédiaire");
  {
    const r2 = validateCatalogSnapshot(payload({ films: [film({ id: "z1" }), film({ id: "z2" })] }), NOW + 1000);
    await writeCatalogSnapshot(dir, r2.snapshot);
    const back = await readCatalogSnapshot(dir);
    assert(back.films.length === 2, "le nouvel instantané a remplacé l'ancien");
  }
}

async function testCorruption() {
  console.log("S8. Un fichier corrompu vaut une absence — jamais un démarrage cassé");
  {
    const target = join(dir, "catalog.json");
    await writeFile(target, "{ ceci n'est pas du JSON");
    assert((await readCatalogSnapshot(dir)) === null, "JSON tronqué (coupure de courant) → null");

    await writeFile(target, JSON.stringify({ version: 9, orgId: "org-a", savedAt: new Date().toISOString(), films: [] }));
    assert((await readCatalogSnapshot(dir)) === null, "version inconnue relue → null (on ne fait pas confiance à ce qu'on relit)");

    await writeFile(target, JSON.stringify({ version: 1, orgId: "org-a", savedAt: "hier", films: [] }));
    assert((await readCatalogSnapshot(dir)) === null, "date illisible → null");

    await writeFile(target, JSON.stringify({ version: 1, orgId: "org-a", savedAt: new Date().toISOString(), films: {} }));
    assert((await readCatalogSnapshot(dir)) === null, "films non-tableau → null");

    assert((await readCatalogSnapshot(join(dir, "nulle-part"))) === null, "dossier absent → null, jamais une exception");
  }

  console.log("S9. Contrôle positif : après corruption, une écriture saine répare tout");
  {
    // Sans ce contrôle, les null ci-dessus prouveraient seulement que la fonction sait dire null.
    const r = validateCatalogSnapshot(payload(), NOW);
    await writeCatalogSnapshot(dir, r.snapshot);
    const back = await readCatalogSnapshot(dir);
    assert(back !== null && back.films.length === 1, "la borne se relève d'un catalogue corrompu dès la prochaine connexion");
    const onDisk = JSON.parse(await readFile(join(dir, "catalog.json"), "utf8"));
    assert(!JSON.stringify(onDisk).includes("devicePassword"), "aucun secret n'a fuité dans le fichier d'état");
  }
}

async function main() {
  dir = await mkdtemp(join(tmpdir(), "kioskoscope-state-"));
  try {
    console.log("=== ÉTAT PERSISTANT : validation ===");
    testValidation();
    console.log("\n=== ÉTAT PERSISTANT : écriture/lecture ===");
    await testRoundTrip();
    console.log("\n=== ÉTAT PERSISTANT : corruption ===");
    await testCorruption();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`\n✅ state_smoke : ${passed} assertions vérifiées (validation + atomicité + corruption)`);
}

main().catch((err) => {
  console.error("\n❌ state_smoke a échoué :", err instanceof Error ? err.message : err);
  process.exit(1);
});
