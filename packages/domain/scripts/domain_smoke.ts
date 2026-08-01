// Suite de tests DOM-free du domaine — logique PURE et CRITIQUE, sans réseau ni WebCrypto externe
// (crypto.subtle est natif Node 20+). Deux volets :
//   1. Contraste WCAG (F19) : parseHexColor / relativeLuminance / contrastRatio / readableInk.
//   2. Auth opérateur (CIN-073) : verifyOperator (PBKDF2) — bons/mauvais PIN, révoqué, expiré,
//      normalisation d'identifiant, ANTI-ÉNUMÉRATION (l'état n'est révélé qu'après un PIN correct).
// Lancé par `npm run -w @kioskoscope/domain test` et en CI. Sortie non nulle si un invariant casse.

import {
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  readableInk,
  hashPin,
  verifyOperator,
  normalizeIdentifier,
  PBKDF2_ITERATIONS,
  fileExtension,
  isBrowserPlayableVideo,
  videoPlayabilityHint,
  probeMp4,
  judgeVideoCodec,
  type ByteRangeReader,
  watchRatio,
  emptyDeciles,
  PLAY_DECILES,
  type AccessEntry,
  type AccessTable,
} from "../src/index";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;

async function main(): Promise<void> {
  // ── 1. Contraste WCAG ────────────────────────────────────────────────────────
  console.log("1. Contraste (WCAG)");
  assert(JSON.stringify(parseHexColor("#ffffff")) === JSON.stringify([255, 255, 255]), "parseHexColor #ffffff");
  assert(JSON.stringify(parseHexColor("#000")) === JSON.stringify([0, 0, 0]), "parseHexColor #000 (court)");
  assert(JSON.stringify(parseHexColor("abc")) === JSON.stringify([170, 187, 204]), "parseHexColor abc (sans #, court)");
  assert(parseHexColor("xyz") === null, "parseHexColor invalide (xyz) → null");
  assert(parseHexColor("#12") === null, "parseHexColor invalide (#12) → null");

  assert(near(relativeLuminance("#000000"), 0, 0.001), "luminance noir ≈ 0");
  assert(near(relativeLuminance("#ffffff"), 1, 0.001), "luminance blanc ≈ 1");
  assert(relativeLuminance("#000000") < relativeLuminance("#808080"), "noir < gris moyen");

  assert(near(contrastRatio("#000000", "#ffffff"), 21, 0.1), "contraste noir/blanc ≈ 21");
  assert(near(contrastRatio("#123456", "#123456"), 1, 0.001), "contraste couleur identique = 1");
  assert(contrastRatio("#000000", "#ffffff") >= 4.5, "noir/blanc passe AA (≥ 4.5)");
  assert(contrastRatio("#777777", "#888888") < 4.5, "gris proches échouent AA");

  assert(readableInk("#0a0a0c") === "#f4f2ee", "encre sur fond sombre = claire");
  assert(readableInk("#ffffff") === "#1a1206", "encre sur fond clair = foncée");
  assert(readableInk("#000000", "#111", "#eee") === "#eee", "readableInk respecte les encres fournies");

  // ── 2. Auth opérateur (PBKDF2) ───────────────────────────────────────────────
  console.log("2. Auth opérateur (verifyOperator / PBKDF2)");
  const salt = "00112233445566778899aabbccddeeff";
  const PIN = "246810";
  const goodHash = await hashPin(PIN, salt, PBKDF2_ITERATIONS);
  const mk = (over: Partial<AccessEntry>): AccessEntry => ({
    identifier: "PERCHOIR-CAB001-OP",
    pinHash: goodHash,
    salt,
    iterations: PBKDF2_ITERATIONS,
    role: "operator",
    expiresAt: null,
    revoked: false,
    ...over,
  });
  const table: AccessTable = {
    orgId: "org-a",
    boothId: "booth-1",
    updatedAt: new Date().toISOString(),
    entries: [
      mk({}),
      mk({ identifier: "PERCHOIR-CAB001-REV", revoked: true }),
      mk({ identifier: "PERCHOIR-CAB001-EXP", expiresAt: "2000-01-01T00:00:00.000Z" }),
    ],
  };

  const ok = await verifyOperator(table, "PERCHOIR-CAB001-OP", PIN);
  assert(ok.ok === true && ok.role === "operator" && ok.identifier === "PERCHOIR-CAB001-OP", "PIN correct → ok + rôle");

  const wrong = await verifyOperator(table, "PERCHOIR-CAB001-OP", "000000");
  assert(wrong.ok === false && wrong.reason === "invalid", "PIN faux → invalid");

  const unknown = await verifyOperator(table, "INCONNU", PIN);
  assert(unknown.ok === false && unknown.reason === "invalid", "identifiant inconnu → invalid");

  const revoked = await verifyOperator(table, "PERCHOIR-CAB001-REV", PIN);
  assert(revoked.ok === false && revoked.reason === "revoked", "révoqué + PIN correct → revoked");

  const expired = await verifyOperator(table, "PERCHOIR-CAB001-EXP", PIN);
  assert(expired.ok === false && expired.reason === "expired", "expiré + PIN correct → expired");

  const normalized = await verifyOperator(table, "  perchoir-cab001-op  ", PIN);
  assert(normalized.ok === true, "identifiant normalisé (espaces + minuscules) → match");
  assert(normalizeIdentifier("  x-y  ") === "X-Y", "normalizeIdentifier trim + majuscules");

  // ANTI-ÉNUMÉRATION : sur un compte RÉVOQUÉ avec un PIN FAUX, on ne révèle PAS « revoked »
  // (l'état n'est divulgué qu'après un PIN correct) → doit répondre « invalid ».
  const revokedWrongPin = await verifyOperator(table, "PERCHOIR-CAB001-REV", "000000");
  assert(revokedWrongPin.ok === false && revokedWrongPin.reason === "invalid", "révoqué + PIN faux → invalid (anti-énumération)");

  // ── Codecs vidéo lisibles navigateur (fondation CIN-022) ──
  assert(fileExtension("demo.MP4") === "mp4", "fileExtension : minuscules");
  assert(fileExtension("no-ext") === "", "fileExtension : absente → \"\"");
  assert(fileExtension("a/b/clip.webm") === "webm", "fileExtension : ignore le chemin");
  assert(isBrowserPlayableVideo("film.mp4") === true, "mp4 → lisible navigateur");
  assert(isBrowserPlayableVideo("film.webm") === true, "webm → lisible navigateur");
  assert(isBrowserPlayableVideo("film.mkv") === false, "mkv → à transcoder");
  assert(isBrowserPlayableVideo("film.xyz") === null, "extension inconnue → indéterminé");
  // `.mov` contient presque toujours du H.264 lisible : le déclarer « à transcoder » produisait un
  // faux positif sur un format de production courant → indéterminé (on vérifie, on n'alarme pas).
  assert(isBrowserPlayableVideo("film.mov") === null, "mov → indéterminé (dépend du codec embarqué)");
  // Theora retiré de Chrome 123 (2024), jamais supporté par Safari → ne plus rassurer.
  assert(isBrowserPlayableVideo("film.ogv") === false, "ogv → à transcoder (Theora abandonné)");
  assert(videoPlayabilityHint("film.mp4").verdict === "playable", "hint : mp4 → playable");
  assert(videoPlayabilityHint("film.mkv").verdict === "transcode", "hint : mkv → transcode");
  assert(videoPlayabilityHint("film.mov").verdict === "unknown", "hint : mov → unknown");
  assert(videoPlayabilityHint("sans-extension").verdict === "unknown", "hint : sans extension → unknown");
  assert(videoPlayabilityHint("film.mkv").message.includes("mp4"), "hint : le message dit QUOI faire (convertir en mp4)");
  assert(videoPlayabilityHint("FILM.MKV").extension === "mkv", "hint : extension normalisée en minuscules");

  // ── Taux d'écoute (F21 / CIN-105) ──
  // Ce ratio part dans des rapports d'ayants droit : il ne doit jamais dépasser 100 %, ni être
  // calculé sur une durée absente (un pourcentage faux est pire que pas de pourcentage).
  assert(watchRatio(50, 100) === 0.5, "watchRatio : 50/100 → 0.5");
  assert(watchRatio(100, 100) === 1, "watchRatio : lecture complète → 1");
  assert(watchRatio(150, 100) === 1, "watchRatio : borné à 1 (jamais > 100 %)");
  assert(watchRatio(10, 0) === null, "watchRatio : durée nulle → null (on n'invente pas)");
  assert(watchRatio(10, Number.NaN) === null, "watchRatio : durée non finie → null");
  assert(watchRatio(-1, 100) === null, "watchRatio : durée vue négative → null");
  assert(emptyDeciles().length === PLAY_DECILES, "emptyDeciles : longueur = PLAY_DECILES");
  assert(emptyDeciles().every((d) => d === false), "emptyDeciles : tout à false");

  // ── Probe de codec RÉEL, sur des entêtes MP4 fabriqués (CIN-103 / CIN-114a) ──
  // On construit de VRAIES boîtes ISOBMFF plutôt que de simuler le parseur : c'est la seule
  // façon de prouver qu'on sait lire un fichier qu'on n'a pas écrit soi-même. Le cas qui
  // compte est `hvc1` — le fichier qui se lit chez l'exploitant et reste noir en cabine.
  {
    const enc = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
    const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    /** Boîte ISOBMFF : taille (4) + type (4) + charge utile. */
    const box = (type: string, payload: number[]): number[] => [...be32(payload.length + 8), ...enc(type), ...payload];
    const mvhd = (timescale: number, duration: number): number[] =>
      box("mvhd", [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(timescale), ...be32(duration), ...new Array(80).fill(0)]);
    const sampleEntry = (fourcc: string): number[] => box(fourcc, new Array(78).fill(0));
    const videoTrak = (fourcc: string): number[] =>
      box("trak", box("mdia", box("minf", box("stbl", box("stsd", [0, 0, 0, 0, ...be32(1), ...sampleEntry(fourcc)])))));
    const audioTrak = (): number[] => box("trak", box("mdia", box("minf", box("stbl", box("stsd", [0, 0, 0, 0, ...be32(1), ...sampleEntry("mp4a")])))));

    const file = (moovPayload: number[], moovLast: boolean): Uint8Array => {
      const ftyp = box("ftyp", enc("isom") .concat(be32(512), enc("isomiso2avc1mp41")));
      // `mdat` GÉANT et vide : c'est tout l'enjeu du parcours par sauts — si le probe le lisait,
      // il chargerait le film entier en mémoire. Ici il ne doit lire que 16 octets d'entête.
      const mdat = box("mdat", new Array(200_000).fill(0));
      const moov = box("moov", moovPayload);
      return new Uint8Array(moovLast ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat]);
    };

    let bytesRead = 0;
    const reader = (bytes: Uint8Array): ByteRangeReader => ({
      size: bytes.length,
      async read(offset, length) {
        bytesRead += length;
        return bytes.subarray(offset, offset + length);
      },
    });

    // H.264, faststart (moov avant mdat) : cas nominal.
    const avc = await probeMp4(reader(file([...mvhd(1000, 90_000), ...videoTrak("avc1")], false)));
    assert(avc?.videoCodec === "avc1", "probeMp4 : flux H.264 identifié");
    assert(avc?.durationSeconds === 90, "probeMp4 : durée lue dans mvhd (90 000 / 1000 = 90 s)");

    // LE cas du ticket : un .mp4 qui contient du H.265.
    const hevcBytes = file([...mvhd(600, 720_000), ...audioTrak(), ...videoTrak("hvc1")], true);
    bytesRead = 0;
    const hevc = await probeMp4(reader(hevcBytes));
    assert(hevc?.videoCodec === "hvc1", "probeMp4 : H.265 démasqué, moov EN FIN de fichier");
    assert(hevc?.durationSeconds === 1200, "probeMp4 : durée correcte malgré un autre timescale");
    assert(bytesRead < 10_000, `probeMp4 : le mdat de 200 Ko n'est jamais lu (${bytesRead} octets lus)`);
    assert(judgeVideoCodec(hevc!.videoCodec).verdict === "transcode", "H.265 : verdict `transcode`, contre l'avis du navigateur de l'exploitant");

    // Piste audio d'abord : elle ne doit pas être prise pour la vidéo.
    const mixed = await probeMp4(reader(file([...mvhd(1000, 1000), ...audioTrak(), ...videoTrak("av01")], false)));
    assert(mixed?.videoCodec === "av01", "probeMp4 : la piste audio n'est pas confondue avec la vidéo");
    assert(judgeVideoCodec("av01").verdict === "risky", "AV1 : ni rassurant ni interdit — décodage logiciel sur borne");

    // Durée inconnue (0xffffffff) : ne JAMAIS la rendre comme une durée.
    const unknownDur = await probeMp4(reader(file([...mvhd(1000, 0xffffffff), ...videoTrak("avc1")], false)));
    assert(unknownDur?.durationSeconds === null, "probeMp4 : durée `inconnue` (0xffffffff) rendue null, pas 4 294 967 s");

    // Ce qui n'est pas un MP4 : aucun verdict inventé.
    assert((await probeMp4(reader(new Uint8Array([1, 2, 3])))) === null, "probeMp4 : fichier minuscule → null");
    assert((await probeMp4(reader(new Uint8Array(64)))) === null, "probeMp4 : octets nuls (taille de boîte 0) → null");
    const webmish = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(200).fill(1)]);
    assert((await probeMp4(reader(webmish))) === null, "probeMp4 : WebM → null (repli sur l'extension, pas de verdict faux)");
    const noVideo = await probeMp4(reader(file([...mvhd(1000, 5000), ...audioTrak()], false)));
    assert(noVideo?.videoCodec === null, "probeMp4 : fichier sans piste vidéo → codec null");
    assert(judgeVideoCodec(null).verdict === "unknown", "codec absent → `unknown`, jamais `playable`");

    assert(judgeVideoCodec("avc1").verdict === "playable", "H.264 : verdict `playable`");
    assert(judgeVideoCodec("vp09").verdict === "playable", "VP9 : verdict `playable`");
    assert(judgeVideoCodec("dvhe").verdict === "transcode", "Dolby Vision : verdict `transcode`");
    assert(judgeVideoCodec("zzzz").verdict === "unknown", "fourcc inconnu : `unknown`, on n'invente pas");
  }

  console.log(`\n—— ${passed}/${passed + failed} assertions OK ——`);
  if (failed > 0) {
    console.error(`✗ ${failed} test(s) du domaine en échec.`);
    process.exit(1);
  }
  console.log("✅ domain_smoke : contraste WCAG + auth opérateur vérifiés.");
}

main().catch((e) => {
  console.error("✗ Erreur inattendue :", e);
  process.exit(2);
});
