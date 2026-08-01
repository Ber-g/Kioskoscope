// Lecture de l'ENTÊTE d'un fichier MP4/QuickTime — codec réel et durée réelle (CIN-103, CIN-114a).
//
// POURQUOI CE MODULE EXISTE. `videoPlayabilityHint` juge le CONTENEUR par son extension. Un `.mp4`
// en H.265 passe donc pour lisible et **reste noir en cabine** : le conteneur n'est pas le codec.
// Ici on ouvre le fichier et on lit ce qu'il contient vraiment.
//
// ⚠️ POURQUOI PAS `<video>` NI `MediaSource.isTypeSupported`. Ces deux-là répondent « MON
// navigateur sait-il lire ce fichier ? ». Or celui qui téléverse est sur un Mac (Safari/Chrome
// décodent le HEVC en matériel) et le film sera joué par **Chromium sur Debian**, qui ne le décode
// pas. Un verdict rendu par le navigateur de l'exploitant serait donc rassurant ET faux. On lit
// le fourcc du flux vidéo et on juge sur une table explicite : le verdict ne dépend plus de la
// machine qui pose la question.
//
// COÛT DE LECTURE. Un film fait plusieurs gigaoctets ; on n'en lit que quelques kilo-octets. Le
// parcours saute de boîte en boîte par 16 octets d'entête, donc **sans jamais toucher `mdat`**
// (les données vidéo), puis lit la seule boîte `moov`. Fonctionne aussi sur les fichiers non
// « faststart », où `moov` est à la fin.

/** Accès en lecture par plage d'octets. Implémenté par `File.slice()` côté navigateur. */
export interface ByteRangeReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface Mp4Probe {
  /** fourcc du premier flux vidéo trouvé : `avc1`, `hvc1`, `av01`… `null` si aucun. */
  readonly videoCodec: string | null;
  /** Durée du film en secondes (depuis `mvhd`), `null` si absente ou incohérente. */
  readonly durationSeconds: number | null;
}

/** Au-delà, on refuse de charger `moov` en mémoire : un entête sain ne pèse jamais ça. */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/** Sécurité de terminaison : un fichier malformé ne doit pas faire tourner la boucle sans fin. */
const MAX_TOP_LEVEL_BOXES = 4096;

const VIDEO_SAMPLE_ENTRIES = new Set([
  "avc1", "avc3", "hvc1", "hev1", "av01", "vp08", "vp09", "mp4v", "s263", "dvh1", "dvhe", "dva1", "dvav", "jpeg", "mjpa",
]);

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}

function u64(b: Uint8Array, o: number): number {
  // Les durées de films tiennent très largement dans un double : pas de BigInt à traîner.
  return u32(b, o) * 0x100000000 + u32(b, o + 4);
}

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}

/**
 * Localise la boîte `moov` en sautant de boîte en boîte au niveau racine.
 * Renvoie `null` si le fichier n'est pas un conteneur ISOBMFF ou si `moov` est introuvable.
 */
async function findMoov(reader: ByteRangeReader): Promise<{ offset: number; size: number } | null> {
  let offset = 0;
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && offset + 8 <= reader.size; i++) {
    const head = await reader.read(offset, 16);
    if (head.length < 8) return null;
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    let headerLength = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = u64(head, 8);
      headerLength = 16;
    } else if (size === 0) {
      // « jusqu'à la fin du fichier » — légal, et forcément la dernière boîte.
      size = reader.size - offset;
    }
    // Une taille inférieure à son propre entête ne décrit rien : le fichier n'est pas un ISOBMFF
    // (ou il est corrompu). On s'arrête plutôt que d'avancer d'un pas arbitraire.
    if (size < headerLength) return null;
    if (type === "moov") return { offset: offset + headerLength, size: size - headerLength };
    offset += size;
  }
  return null;
}

/** Parcourt les boîtes ENFANTS contenues dans `buf[start, end)`. */
function* children(buf: Uint8Array, start: number, end: number): Generator<{ type: string; from: number; to: number }> {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(buf, o);
    const type = fourcc(buf, o + 4);
    let headerLength = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = u64(buf, o + 8);
      headerLength = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < headerLength || o + size > end) return;
    yield { type, from: o + headerLength, to: o + size };
    o += size;
  }
}

/** Première boîte enfant d'un type donné, ou `null`. */
function child(buf: Uint8Array, from: number, to: number, type: string): { from: number; to: number } | null {
  for (const c of children(buf, from, to)) if (c.type === type) return { from: c.from, to: c.to };
  return null;
}

/** Durée en secondes depuis `mvhd` (timescale + duration). `null` si absente ou nulle. */
function readDuration(buf: Uint8Array, from: number, to: number): number | null {
  const mvhd = child(buf, from, to, "mvhd");
  if (!mvhd || mvhd.to - mvhd.from < 20) return null;
  const version = buf[mvhd.from]!;
  const o = mvhd.from + 4; // version (1) + flags (3)
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (mvhd.to - mvhd.from < 32) return null;
    timescale = u32(buf, o + 16);
    duration = u64(buf, o + 20);
  } else {
    timescale = u32(buf, o + 8);
    duration = u32(buf, o + 12);
  }
  if (timescale <= 0 || duration <= 0) return null;
  // `0xffffffff` = « durée inconnue » dans la spec : ne JAMAIS le rendre comme une durée.
  if (version === 0 && duration === 0xffffffff) return null;
  return duration / timescale;
}

/** fourcc du premier flux VIDÉO trouvé dans les `trak` — les pistes audio sont ignorées. */
function readVideoCodec(buf: Uint8Array, from: number, to: number): string | null {
  for (const trak of children(buf, from, to)) {
    if (trak.type !== "trak") continue;
    const mdia = child(buf, trak.from, trak.to, "mdia");
    if (!mdia) continue;
    const minf = child(buf, mdia.from, mdia.to, "minf");
    if (!minf) continue;
    const stbl = child(buf, minf.from, minf.to, "stbl");
    if (!stbl) continue;
    const stsd = child(buf, stbl.from, stbl.to, "stsd");
    if (!stsd) continue;
    // stsd : version/flags (4) + entry_count (4), puis les entrées (taille (4) + format (4)).
    for (const entry of children(buf, stsd.from + 8, stsd.to)) {
      if (VIDEO_SAMPLE_ENTRIES.has(entry.type)) return entry.type;
    }
  }
  return null;
}

/**
 * Lit l'entête d'un MP4/MOV. `null` = ce n'est pas un ISOBMFF lisible ici (WebM, AVI, fichier
 * tronqué…) — dans ce cas l'appelant retombe sur l'heuristique par extension, jamais sur un
 * verdict inventé.
 */
export async function probeMp4(reader: ByteRangeReader): Promise<Mp4Probe | null> {
  if (reader.size < 16) return null;
  let moov: { offset: number; size: number } | null;
  try {
    moov = await findMoov(reader);
  } catch {
    return null; // lecture impossible (fichier retiré, permission) : on ne prétend rien
  }
  if (!moov || moov.size <= 0 || moov.size > MAX_MOOV_BYTES) return null;
  let buf: Uint8Array;
  try {
    buf = await reader.read(moov.offset, moov.size);
  } catch {
    return null;
  }
  if (buf.length < 8) return null;
  return {
    videoCodec: readVideoCodec(buf, 0, buf.length),
    durationSeconds: readDuration(buf, 0, buf.length),
  };
}

export type CodecVerdict = "playable" | "transcode" | "risky" | "unknown";

export interface CodecJudgement {
  readonly verdict: CodecVerdict;
  readonly codec: string;
  readonly message: string;
}

/**
 * Juge un fourcc pour LA BORNE (Chromium sur Debian), jamais pour le navigateur qui téléverse.
 *
 * ⚠️ Le HEVC est le cœur du ticket : macOS le décode en matériel, donc l'exploitant le voit
 * parfaitement chez lui et découvre l'écran noir en cabine. Le verdict doit contredire ce que
 * son propre navigateur lui montre.
 */
export function judgeVideoCodec(codec: string | null): CodecJudgement {
  const c = (codec ?? "").toLowerCase();
  switch (c) {
    case "avc1":
    case "avc3":
      return { verdict: "playable", codec: c, message: "Vidéo H.264 — le format le plus sûr pour les bornes." };
    case "vp08":
    case "vp09":
      return { verdict: "playable", codec: c, message: `Vidéo ${c === "vp09" ? "VP9" : "VP8"} — lisible sur les bornes.` };
    case "hvc1":
    case "hev1":
      return {
        verdict: "transcode",
        codec: c,
        message:
          "Vidéo H.265 (HEVC) : elle se lit peut-être sur votre ordinateur, mais la borne ne la décodera PAS — le film resterait noir. Reconvertissez le fichier en H.264 avant de l'envoyer.",
      };
    case "dvh1":
    case "dvhe":
    case "dva1":
    case "dvav":
      return {
        verdict: "transcode",
        codec: c,
        message: "Vidéo Dolby Vision : non décodée par les bornes. Exportez une version H.264 standard.",
      };
    case "mp4v":
    case "s263":
    case "jpeg":
    case "mjpa":
      return { verdict: "transcode", codec: c, message: "Codec vidéo ancien, non décodé par les bornes. Reconvertissez le fichier en H.264." };
    case "av01":
      return {
        verdict: "risky",
        codec: c,
        message:
          "Vidéo AV1 : décodée en logiciel sur une borne, ce qui peut saccader sur un long métrage. Préférez du H.264 si vous le pouvez.",
      };
    case "":
      return { verdict: "unknown", codec: "", message: "Aucun flux vidéo trouvé dans le fichier." };
    default:
      return { verdict: "unknown", codec: c, message: `Codec vidéo inhabituel (${c}) : vérifiez le film dans l'aperçu avant de l'envoyer sur une borne.` };
  }
}
