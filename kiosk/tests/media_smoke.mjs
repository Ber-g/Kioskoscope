// Smoke test du service des médias LOCAUX de la borne (CIN-112 lot 1).
//
// Test de bout en bout, pas de simulacre : on écrit de vrais fichiers dans un dossier temporaire,
// on lève un vrai serveur HTTP, on lit de vraies réponses. Ce qui est prouvé ici ne peut pas
// l'être « à la lecture » : un `Content-Range` faux d'un octet donne une vidéo qui démarre puis
// se fige au premier déplacement — un bug qu'on ne verrait qu'en cabine, avec un client devant.
//
// Lancer : node kiosk/tests/media_smoke.mjs

import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { serveMedia, scanMediaLibrary, resolveMediaFile, parseRange } from "../lib/media.mjs";

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("  ✗ ÉCHEC: " + msg);
    throw new Error("ÉCHEC: " + msg);
  }
  passed += 1;
  console.log("  ✓ " + msg);
}

const HASH = "a".repeat(64); // fichier vidéo complet
const EMPTY = "b".repeat(64); // fichier de 0 octet (téléchargement interrompu)
const HTML = "c".repeat(64); // extension hors liste blanche
const OUTSIDE = "e".repeat(64); // fichier VALIDE, mais posé HORS du dossier média (cible de traversée)
const SIZE = 100_000;

/** Contenu déterministe : l'octet i vaut i % 251. Permet de VÉRIFIER l'offset servi. */
const CONTENT = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

let root;
let parentDir;
let server;
let base;

async function get(path, headers = {}, method = "GET") {
  const res = await fetch(base + path, { method, headers });
  const body = method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}

async function setup() {
  // Deux niveaux : le dossier média, et son parent où l'on pose la cible de traversée.
  parentDir = await mkdtemp(join(tmpdir(), "kioskoscope-media-"));
  root = join(parentDir, "media");
  await mkdir(root);
  await writeFile(join(parentDir, `${OUTSIDE}.mp4`), CONTENT.subarray(0, 64));
  await writeFile(join(root, `${HASH}.mp4`), CONTENT);
  await writeFile(join(root, `${EMPTY}.mp4`), Buffer.alloc(0));
  await writeFile(join(root, `${HTML}.html`), "<script>alert(1)</script>");
  server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname).slice("/media/".length);
    void serveMedia(req, res, name, root);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function testFullRead() {
  console.log("M1. Sans Range : le fichier entier, en annonçant qu'on sait faire du Range");
  const r = await get(`/media/${HASH}`);
  assert(r.status === 200, "200 sur une lecture simple");
  assert(r.headers.get("content-type") === "video/mp4", "type MIME déduit de l'extension");
  assert(r.headers.get("content-length") === String(SIZE), "longueur = taille du fichier");
  assert(r.headers.get("accept-ranges") === "bytes", "accept-ranges annoncé (sans quoi le lecteur ne cherche même pas à se déplacer)");
  assert(r.body.equals(CONTENT), "octets identiques au fichier sur disque");
}

async function testRanges() {
  console.log("M2. Range simple : 206 + Content-Range exact + LES BONS OCTETS");
  {
    const r = await get(`/media/${HASH}`, { range: "bytes=0-99" });
    assert(r.status === 206, "206 sur intervalle");
    assert(r.headers.get("content-range") === `bytes 0-99/${SIZE}`, "content-range exact (bornes INCLUSES)");
    assert(r.headers.get("content-length") === "100", "longueur = 100 octets pour 0-99, pas 99");
    assert(r.body.equals(CONTENT.subarray(0, 100)), "contenu = les 100 premiers octets");
  }

  console.log("M3. Déplacement dans la timeline : un intervalle au milieu renvoie le bon offset");
  {
    const r = await get(`/media/${HASH}`, { range: "bytes=50000-50009" });
    assert(r.status === 206, "206 au milieu du fichier");
    assert(r.body.equals(CONTENT.subarray(50_000, 50_010)), "octets du MILIEU, pas du début (le bug qui fige la vidéo)");
    assert(r.headers.get("content-range") === `bytes 50000-50009/${SIZE}`, "content-range du milieu");
  }

  console.log("M4. Intervalle ouvert `bytes=N-` : jusqu'à la fin");
  {
    const r = await get(`/media/${HASH}`, { range: "bytes=99900-" });
    assert(r.status === 206, "206 sur intervalle ouvert");
    assert(r.body.length === 100, "100 derniers octets");
    assert(r.body.equals(CONTENT.subarray(99_900)), "contenu = la fin du fichier");
  }

  console.log("M5. Forme suffixe `bytes=-N` : les N DERNIERS octets (index MP4 en fin de fichier)");
  {
    const r = await get(`/media/${HASH}`, { range: "bytes=-500" });
    assert(r.status === 206, "206 sur suffixe");
    assert(r.headers.get("content-range") === `bytes 99500-99999/${SIZE}`, "suffixe = fin du fichier, jamais début");
    assert(r.body.equals(CONTENT.subarray(SIZE - 500)), "contenu = les 500 derniers octets");
  }

  console.log("M6. Fin demandée au-delà du fichier : on rabote, on ne refuse pas");
  {
    const r = await get(`/media/${HASH}`, { range: "bytes=99990-999999" });
    assert(r.status === 206, "206 (la demande reste satisfaisable)");
    assert(r.headers.get("content-range") === `bytes 99990-99999/${SIZE}`, "fin ramenée à la dernière position");
  }

  console.log("M7. Début au-delà du fichier : 416, avec la taille réelle pour que le lecteur se recale");
  {
    const r = await get(`/media/${HASH}`, { range: `bytes=${SIZE}-` });
    assert(r.status === 416, "416 sur intervalle hors fichier");
    assert(r.headers.get("content-range") === `bytes */${SIZE}`, "content-range de 416 = taille totale");
  }

  console.log("M8. Range multi-intervalles ou illisible : on répond TOUT, jamais à moitié");
  {
    const multi = await get(`/media/${HASH}`, { range: "bytes=0-9,20-29" });
    assert(multi.status === 200 && multi.body.length === SIZE, "multi-intervalles → fichier entier (autorisé par la RFC)");
    const junk = await get(`/media/${HASH}`, { range: "octets=0-9" });
    assert(junk.status === 200 && junk.body.length === SIZE, "unité inconnue → fichier entier");
  }

  console.log("M9. HEAD : les mêmes en-têtes, zéro octet");
  {
    const r = await get(`/media/${HASH}`, { range: "bytes=0-99" }, "HEAD");
    assert(r.status === 206, "206 sur HEAD avec Range");
    assert(r.headers.get("content-length") === "100", "longueur annoncée sans corps");
  }
}

async function testRefusals() {
  console.log("M10. Ce qui NE doit jamais être servi");
  {
    const unknown = await get(`/media/${"d".repeat(64)}`);
    assert(unknown.status === 404, "empreinte inconnue → 404");

    const empty = await get(`/media/${EMPTY}`);
    assert(empty.status === 404, "fichier de 0 octet → 404 (jamais proposé comme jouable)");

    const html = await get(`/media/${HTML}`);
    assert(html.status === 404, "extension hors liste blanche → 404, même avec une empreinte valide");

    for (const evil of ["../../etc/passwd", "..%2f..%2fetc%2fpasswd", HASH.toUpperCase(), ""]) {
      const r = await get(`/media/${evil}`);
      assert(r.status === 404, `chemin refusé : ${evil.slice(0, 28) || "(vide)"}`);
    }
  }

  console.log("M10b. Traversée de dossier — avec CONTRÔLE POSITIF (sinon on ne prouve rien)");
  {
    // Les 404 ci-dessus ne prouvent pas grand-chose : `fetch` normalise `..` avant l'envoi, donc
    // la requête n'atteint peut-être jamais le garde-fou. On appelle donc `resolveMediaFile` en
    // DIRECT, et surtout on vérifie d'abord que le fichier visé EXISTE et EST servable quand on
    // l'adresse légitimement — sans quoi « introuvable » ne dirait rien d'autre que « absent ».
    const found = await resolveMediaFile(parentDir, OUTSIDE);
    assert(found !== null && found.size > 0, "contrôle positif : le fichier hors dossier existe et EST servable si on l'adresse normalement");

    for (const evil of [`../${OUTSIDE}`, `..${sep}..${sep}${OUTSIDE}`, `${HASH}/../${OUTSIDE}`, `./${OUTSIDE}`]) {
      assert((await resolveMediaFile(root, evil)) === null, `traversée refusée depuis le dossier média : ${evil}`);
    }
    // Et l'octet près : la même empreinte, servie depuis le bon dossier, ne l'atteint pas non plus.
    assert((await resolveMediaFile(root, OUTSIDE)) === null, "empreinte valide mais fichier absent du dossier média → introuvable");
  }
}

async function testLibrary() {
  console.log("M11. Inventaire : présence réelle, et rien d'autre");
  {
    const media = await scanMediaLibrary(root);
    assert(media.length === 1, "un seul média inventorié (le vide et le .html sont écartés)");
    assert(media[0].hash === HASH && media[0].bytes === SIZE, "empreinte et taille remontées telles quelles");
    assert(media[0].ext === ".mp4", "extension conservée (le serveur la retrouvera)");
    const absent = await scanMediaLibrary(join(root, "dossier-inexistant"));
    assert(Array.isArray(absent) && absent.length === 0, "dossier absent → inventaire VIDE, jamais une exception");
  }
}

function testParseRangeEdges() {
  console.log("M12. Bornes de parseRange que le réseau ne permet pas de provoquer");
  {
    assert(parseRange(undefined, 10).kind === "full", "en-tête absent → fichier entier");
    assert(parseRange("bytes=-0", 10).kind === "unsatisfiable", "suffixe de 0 octet → 416");
    assert(parseRange("bytes=5-3", 10).kind === "unsatisfiable", "fin avant début → 416");
    assert(parseRange("bytes=0-", 0).kind === "unsatisfiable", "fichier vide → aucun intervalle satisfaisable");
    assert(parseRange("bytes=-", 10).kind === "full", "`bytes=-` sans chiffre → fichier entier");
    const p = parseRange("  bytes=2-4  ", 10);
    assert(p.kind === "partial" && p.start === 2 && p.end === 4, "espaces autour de l'en-tête tolérés");
  }
}

async function main() {
  await setup();
  try {
    console.log("=== MÉDIA LOCAL : lecture complète ===");
    await testFullRead();
    console.log("\n=== MÉDIA LOCAL : HTTP Range ===");
    await testRanges();
    console.log("\n=== MÉDIA LOCAL : refus ===");
    await testRefusals();
    console.log("\n=== MÉDIA LOCAL : inventaire ===");
    await testLibrary();
    console.log("\n=== MÉDIA LOCAL : parseRange ===");
    testParseRangeEdges();
  } finally {
    server?.close();
    if (parentDir) await rm(parentDir, { recursive: true, force: true });
  }
  console.log(`\n✅ media_smoke : ${passed} assertions vérifiées (lecture + Range + refus + inventaire)`);
}

main().catch((err) => {
  console.error("\n❌ media_smoke a échoué :", err instanceof Error ? err.message : err);
  process.exit(1);
});
