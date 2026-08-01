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
  Sha256Stream,
  sha256HexOfRanges,
  resumableUpload,
  base64Utf8,
  type UploadTransport,
  type UploadResponse,
  type UploadTarget,
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

  // ── 3. SHA-256 incrémental (CIN-101 verrou n°1) ────────────────────────────
  // Le point à prouver n'est pas « l'empreinte est juste » (elle l'est ou le fichier est perdu),
  // c'est « elle est juste SANS jamais tenir le fichier en mémoire ». Les deux se testent :
  // l'exactitude contre les vecteurs FIPS et contre WebCrypto, la frugalité en comptant ce que
  // le lecteur s'est vu réclamer.
  {
    const hexOf = (s: string): string => {
      const h = new Sha256Stream();
      h.update(new TextEncoder().encode(s));
      return h.digestHex();
    };

    // Vecteurs publiés (FIPS 180-4 / NIST) — la référence qui ne dépend d'aucune implémentation.
    assert(
      hexOf("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "SHA-256 : vecteur NIST, message vide",
    );
    assert(
      hexOf("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "SHA-256 : vecteur NIST, « abc »",
    );
    assert(
      hexOf("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ===
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
      "SHA-256 : vecteur NIST, 448 bits (deux blocs)",
    );
    {
      const h = new Sha256Stream();
      const chunk = new TextEncoder().encode("a".repeat(1000));
      for (let i = 0; i < 1000; i++) h.update(chunk);
      assert(
        h.digestHex() === "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
        "SHA-256 : vecteur NIST, un million de « a » servi en 1000 tranches",
      );
    }

    // Confrontation à WebCrypto sur les tailles qui encadrent le rembourrage (55/56/57 et 63/64/65
    // sont exactement là où une implémentation fausse se trahit).
    let boundaryOk = true;
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
      const ref = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const h = new Sha256Stream();
      h.update(bytes);
      if (h.digestHex() !== ref) boundaryOk = false;
    }
    assert(boundaryOk, "SHA-256 : identique à WebCrypto sur 13 tailles autour des bornes de bloc");

    // Le découpage ne doit RIEN changer : c'est la propriété qui autorise le calcul par tranches.
    {
      const bytes = new Uint8Array(5000);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) & 0xff;
      const oneShot = new Sha256Stream();
      oneShot.update(bytes);
      const expected = oneShot.digestHex();
      let allSplitsOk = true;
      for (const step of [1, 7, 63, 64, 65, 100, 4096]) {
        const h = new Sha256Stream();
        for (let o = 0; o < bytes.length; o += step) h.update(bytes.subarray(o, Math.min(o + step, bytes.length)));
        if (h.digestHex() !== expected) allSplitsOk = false;
      }
      assert(allSplitsOk, "SHA-256 : 7 découpages différents donnent la même empreinte qu'un seul bloc");
    }

    // LA propriété de CIN-101 : hacher un « fichier » sans jamais en tenir plus d'une tranche.
    {
      const SIZE = 3_000_000;
      let maxRequested = 0;
      let totalRequested = 0;
      const reader = {
        size: SIZE,
        async read(offset: number, length: number): Promise<Uint8Array> {
          maxRequested = Math.max(maxRequested, length);
          totalRequested += length;
          const out = new Uint8Array(length);
          for (let i = 0; i < length; i++) out[i] = (offset + i) & 0xff;
          return out;
        },
      };
      const whole = new Uint8Array(SIZE);
      for (let i = 0; i < SIZE; i++) whole[i] = i & 0xff;
      const ref = [...new Uint8Array(await crypto.subtle.digest("SHA-256", whole))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const progress: number[] = [];
      const got = await sha256HexOfRanges(reader, {
        chunkBytes: 64 * 1024,
        onProgress: (p) => progress.push(p.hashedBytes),
      });
      assert(got === ref, "sha256HexOfRanges : empreinte d'un fichier de 3 Mo lu par plages = WebCrypto");
      assert(maxRequested <= 64 * 1024, `sha256HexOfRanges : jamais plus de 64 Ko réclamés d'un coup (max ${maxRequested})`);
      assert(totalRequested === SIZE, "sha256HexOfRanges : chaque octet lu une seule fois, aucun relu");
      assert(
        progress[progress.length - 1] === SIZE && progress.every((v, i) => i === 0 || v >= progress[i - 1]!),
        "sha256HexOfRanges : progression monotone et terminée à 100 %",
      );
    }

    // Une empreinte à moitié calculée ne doit jamais sortir comme si elle était valide.
    {
      const reader = {
        size: 1_000_000,
        async read(_o: number, l: number): Promise<Uint8Array> {
          return new Uint8Array(l);
        },
      };
      const signal = { aborted: false };
      const p = sha256HexOfRanges(reader, { chunkBytes: 1024, signal });
      signal.aborted = true;
      let name = "";
      await p.catch((e: Error) => {
        name = e.name;
      });
      assert(name === "AbortError", "sha256HexOfRanges : annulation → rejet AbortError, pas une empreinte partielle");
    }

    // Un lecteur qui rend 0 octet avant la fin ment sur la taille : refuser plutôt que boucler.
    {
      const reader = { size: 100, async read(): Promise<Uint8Array> { return new Uint8Array(0); } };
      let threw = false;
      await sha256HexOfRanges(reader).catch(() => { threw = true; });
      assert(threw, "sha256HexOfRanges : lecture vide avant la fin → erreur, jamais une boucle sans fin");
    }

    // L'objet est scellé après lecture : réutiliser un état déjà digéré donnerait une empreinte fausse.
    {
      const h = new Sha256Stream();
      h.update(new Uint8Array([1]));
      h.digestHex();
      let sealed = false;
      try { h.update(new Uint8Array([2])); } catch { sealed = true; }
      assert(sealed, "Sha256Stream : update() après digestHex() est refusé");
    }
  }

  // ── 4. Envoi reprenable TUS (CIN-101 verrou n°2) ───────────────────────────
  // Un serveur TUS de simulation : il tient l'objet en cours et l'offset, exactement comme le
  // vrai. Il permet de provoquer ce qu'on ne peut pas provoquer à la demande en vrai — la coupure
  // au mauvais moment, la réponse perdue, l'URL expirée.
  {
    interface FakeServer {
      readonly stored: Map<string, Uint8Array>;
      readonly transport: UploadTransport;
      failNextPatches: number;
      /** Simule une réponse PERDUE : le serveur écrit puis la réponse n'arrive pas. */
      swallowNextResponse: boolean;
      patchCount: number;
      createCount: number;
      sizeLimit: number;
      expireAfterCreate: boolean;
      seenTokens: string[];
    }

    const makeServer = (): FakeServer => {
      const uploads = new Map<string, { data: Uint8Array; length: number; name: string }>();
      let nextId = 1;
      const srv: FakeServer = {
        stored: new Map(),
        failNextPatches: 0,
        swallowNextResponse: false,
        patchCount: 0,
        createCount: 0,
        sizeLimit: Number.MAX_SAFE_INTEGER,
        expireAfterCreate: false,
        seenTokens: [],
        transport: async (req): Promise<UploadResponse> => {
          const token = (req.headers["authorization"] ?? "").replace("Bearer ", "");
          srv.seenTokens.push(token);
          const none = { status: 0, headers: {}, body: "" };
          if (req.method === "POST") {
            srv.createCount += 1;
            const meta = req.headers["upload-metadata"] ?? "";
            const nameB64 = /objectName ([^,]+)/.exec(meta)?.[1] ?? "";
            const name = new TextDecoder().decode(
              Uint8Array.from(Buffer.from(nameB64, "base64")),
            );
            const length = Number(req.headers["upload-length"]);
            if (length > srv.sizeLimit) return { status: 413, headers: {}, body: "Maximum size exceeded" };
            if (name.startsWith("00000000")) return { status: 403, headers: {}, body: "row-level security" };
            const id = `https://fake/upload/${nextId++}`;
            uploads.set(id, { data: new Uint8Array(0), length, name });
            return { status: 201, headers: { location: id }, body: "" };
          }
          const up = uploads.get(req.url);
          if (!up || srv.expireAfterCreate) return { status: 404, headers: {}, body: "not found" };
          if (req.method === "HEAD") {
            return { status: 200, headers: { "upload-offset": String(up.data.length) }, body: "" };
          }
          if (req.method === "PATCH") {
            srv.patchCount += 1;
            if (srv.failNextPatches > 0) {
              srv.failNextPatches -= 1;
              throw new Error("réseau coupé");
            }
            const at = Number(req.headers["upload-offset"]);
            if (at !== up.data.length) return { status: 409, headers: {}, body: "offset mismatch" };
            const merged = new Uint8Array(up.data.length + (req.body?.length ?? 0));
            merged.set(up.data, 0);
            if (req.body) merged.set(req.body, up.data.length);
            up.data = merged;
            if (up.data.length >= up.length) srv.stored.set(up.name, up.data);
            if (srv.swallowNextResponse) {
              srv.swallowNextResponse = false;
              throw new Error("réponse perdue en route");
            }
            return { status: 204, headers: { "upload-offset": String(up.data.length) }, body: "" };
          }
          return none;
        },
      };
      return srv;
    };

    const SIZE = 500_000;
    const payload = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) payload[i] = (i * 13) & 0xff;
    const reader = {
      size: SIZE,
      async read(offset: number, length: number): Promise<Uint8Array> {
        return payload.subarray(offset, offset + length);
      },
    };
    const target = (name = "org-a/film"): UploadTarget => ({
      createUrl: "https://fake/upload/resumable",
      bucket: "media",
      objectName: name,
      contentType: "video/mp4",
      authToken: () => "jeton-1",
      upsert: false,
    });
    const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
      a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);
    const noSleep = async (): Promise<void> => {};

    // Cas nominal : l'objet arrive entier, octet pour octet.
    {
      const srv = makeServer();
      const seen: number[] = [];
      const out = await resumableUpload(reader, target(), srv.transport, {
        chunkBytes: 64_000,
        onProgress: (p) => seen.push(p.sentBytes),
        sleep: noSleep,
      });
      assert(out.ok && out.sentBytes === SIZE, "envoi TUS : cas nominal terminé");
      assert(sameBytes(srv.stored.get("org-a/film"), payload), "envoi TUS : l'objet stocké est identique à la source");
      assert(seen[seen.length - 1] === SIZE, "envoi TUS : la progression finit à 100 %");
    }

    // Le Wi-Fi tombe : trois PATCH échouent, puis ça repart. Aucun octet dupliqué ni perdu.
    {
      const srv = makeServer();
      srv.failNextPatches = 3;
      const out = await resumableUpload(reader, target(), srv.transport, { chunkBytes: 64_000, sleep: noSleep });
      assert(out.ok, "envoi TUS : 3 coupures réseau consécutives sont absorbées");
      assert(sameBytes(srv.stored.get("org-a/film"), payload), "envoi TUS : après coupure, l'objet reste exact");
    }

    // LE piège : le serveur a ÉCRIT la tranche mais la réponse s'est perdue. Reprendre à l'offset
    // qu'on croit avoir dupliquerait des octets au milieu du fichier. On relit donc l'offret serveur.
    {
      const srv = makeServer();
      srv.swallowNextResponse = true;
      const out = await resumableUpload(reader, target(), srv.transport, { chunkBytes: 64_000, sleep: noSleep });
      assert(out.ok, "envoi TUS : une réponse perdue n'empêche pas la fin de l'envoi");
      assert(
        sameBytes(srv.stored.get("org-a/film"), payload),
        "envoi TUS : réponse perdue → l'offset est relu au serveur, AUCUN octet dupliqué",
      );
    }

    // Onglet fermé à 80 % : on garde l'URL, on relance plus tard, ça reprend où le serveur en est.
    {
      const srv = makeServer();
      let url: string | null = null;
      const signal = { aborted: false };
      let sent = 0;
      const first = await resumableUpload(reader, target(), srv.transport, {
        chunkBytes: 50_000,
        sleep: noSleep,
        signal,
        onUploadUrl: (u) => { url = u; },
        onProgress: (p) => {
          sent = p.sentBytes;
          if (p.sentBytes >= 300_000) signal.aborted = true; // l'onglet se ferme
        },
      });
      assert(!first.ok && first.reason === "aborted", "envoi TUS : fermeture à mi-course → `aborted`");
      assert(!first.ok && first.confirmedBytes === sent && sent > 0, "envoi TUS : l'interruption annonce les octets RÉELLEMENT reçus");
      assert(url !== null, "envoi TUS : l'URL de reprise a été signalée dès la création");

      const createsBefore = srv.createCount;
      const second = await resumableUpload(reader, target(), srv.transport, {
        chunkBytes: 50_000,
        sleep: noSleep,
        resumeUrl: url,
      });
      assert(second.ok && second.resumed, "envoi TUS : la reprise repart de l'envoi existant");
      assert(srv.createCount === createsBefore, "envoi TUS : reprendre ne recrée PAS un envoi (rien n'est réémis depuis zéro)");
      assert(sameBytes(srv.stored.get("org-a/film"), payload), "envoi TUS : après reprise, l'objet est complet et exact");
    }

    // Une reprise dont l'URL a expiré doit le DIRE, pas repartir de zéro en silence.
    {
      const srv = makeServer();
      srv.expireAfterCreate = true;
      const out = await resumableUpload(reader, target(), srv.transport, {
        chunkBytes: 64_000,
        sleep: noSleep,
        resumeUrl: "https://fake/upload/disparu",
      });
      assert(!out.ok && out.reason === "expired", "envoi TUS : URL de reprise périmée → `expired`, jamais un redémarrage muet");
    }

    // Le plafond de taille est refusé À LA CRÉATION : aucun octet ne part inutilement.
    {
      const srv = makeServer();
      srv.sizeLimit = 52_428_800; // le plafond réellement mesuré sur le projet
      const bigReader = { size: 6 * 1024 ** 3, async read(): Promise<Uint8Array> { return new Uint8Array(1); } };
      const out = await resumableUpload(bigReader, target(), srv.transport, { sleep: noSleep });
      assert(!out.ok && out.reason === "too-large", "envoi TUS : 6 Go contre un plafond de 50 Mio → `too-large`");
      assert(srv.patchCount === 0, "envoi TUS : refus de taille → PAS un seul octet émis");
    }

    // L'isolation : un chemin d'une autre org est refusé, et l'échec est nommé pour ce qu'il est.
    {
      const srv = makeServer();
      const out = await resumableUpload(reader, target("00000000-0000-0000-0000-000000000000/film"), srv.transport, { sleep: noSleep });
      assert(!out.ok && out.reason === "forbidden", "envoi TUS : chemin d'une autre org → `forbidden` (RLS storage)");
    }

    // Le fichier bouge sur le disque pendant l'envoi : on ne prétend pas avoir envoyé un film.
    {
      const srv = makeServer();
      let reads = 0;
      const flaky = {
        size: SIZE,
        async read(offset: number, length: number): Promise<Uint8Array> {
          if (++reads > 2) throw new DOMException?.("file changed", "NotReadableError") ?? new Error("file changed");
          return payload.subarray(offset, offset + length);
        },
      };
      const out = await resumableUpload(flaky, target(), srv.transport, { chunkBytes: 64_000, sleep: noSleep });
      assert(!out.ok && out.reason === "source-changed", "envoi TUS : fichier modifié en cours → `source-changed`");
      assert(!out.ok && out.confirmedBytes < SIZE, "envoi TUS : fichier modifié → on n'annonce pas un envoi complet");
    }

    // Le réseau ne revient jamais : on rend la main en disant ce que le serveur détient.
    {
      const srv = makeServer();
      srv.failNextPatches = 99;
      const out = await resumableUpload(reader, target(), srv.transport, {
        chunkBytes: 64_000,
        sleep: noSleep,
        retryDelaysMs: [1, 1],
      });
      assert(!out.ok && out.reason === "network", "envoi TUS : réseau définitivement absent → `network` après les tentatives");
      assert(!out.ok && out.uploadUrl !== null, "envoi TUS : l'URL de reprise est rendue même en échec (l'envoi reste reprenable)");
    }

    // Le jeton est relu à chaque requête : un envoi long survit à une rotation de session.
    {
      const srv = makeServer();
      let n = 0;
      const rotating: UploadTarget = { ...target(), authToken: () => `jeton-${++n}` };
      await resumableUpload(reader, rotating, srv.transport, { chunkBytes: 100_000, sleep: noSleep });
      assert(new Set(srv.seenTokens).size > 1, "envoi TUS : le jeton est relu à chaque requête, pas figé à la création");
    }

    assert(base64Utf8("média/été") === "bcOpZGlhL8OpdMOp", "base64Utf8 : les accents passent (btoa échouerait)");
    assert(base64Utf8("a") === "YQ==" && base64Utf8("ab") === "YWI=", "base64Utf8 : rembourrage correct");
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
