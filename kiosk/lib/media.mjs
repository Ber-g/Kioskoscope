// Kioskoscope — médias LOCAUX de la borne : inventaire + service (CIN-112 lot 1, F22).
//
// Partagé par les DEUX processus Node de la borne, et c'est le but : l'agent inventorie
// (`scanMediaLibrary`), le serveur local sert (`serveMedia`), et les deux lisent la même liste
// blanche d'extensions. Séparées, elles dériveraient — l'agent annoncerait un format que le
// serveur refuse, et le catalogue proposerait un film qui ne se lit pas. C'est exactement la
// classe de bug que ce ticket répare ; on ne va pas la réintroduire d'un étage.
//
// Le fait structurant du hors-ligne : Chromium n'a aucun accès au disque, les deux processus
// Node de la borne l'ont. Ce module donne au lecteur une source de lecture qui ne dépend ni du
// réseau, ni d'une URL signée à durée de vie limitée : `http://127.0.0.1:<port>/media/<sha256>`.
//
// ─ Deux exigences NON négociables (cf. cadrage du ticket) ──────────────────────────────────
// 1. **Streaming.** `createReadStream`, jamais `readFile` : un média fait plusieurs Go, le lire
//    en mémoire tuerait la borne (et une borne qui meurt pendant une séance payée, c'est un
//    remboursement).
// 2. **HTTP Range.** Sans réponses 206, `<video>` ne peut pas se déplacer dans la timeline —
//    et selon le conteneur, ne peut même pas démarrer. Le déplacement est le test qui prouve
//    que ce module est correct, pas la simple lecture depuis le début.
//
// ─ Surface d'entrée (@qa) ──────────────────────────────────────────────────────────────────
// L'URL est fabriquée par la page web, qui est la surface la moins fiable de la borne. La
// défense n'est PAS un filtre anti-`../` mais une LISTE BLANCHE de forme : seuls 64 caractères
// hexadécimaux minuscules sont acceptés comme nom, et l'extension est choisie par le serveur
// dans une liste fermée. Aucune donnée venue de la requête n'atteint le système de fichiers
// autrement que par cette empreinte validée — il n'existe donc pas de chemin à traverser.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Nom de fichier = empreinte sha256 minuscule. Toute autre forme est refusée d'emblée. */
const HASH = /^[0-9a-f]{64}$/;

/**
 * Extensions servies, avec leur type MIME. Liste FERMÉE : le fichier part vers Chromium depuis
 * `127.0.0.1`, en même origine que l'app — servir un `.html` ou un `.js` déposé sur une clé USB
 * y exécuterait du code dans le contexte de la borne. Les sous-titres locaux viendront avec le
 * lot qui les fait entrer dans le modèle de présence.
 */
const MEDIA_TYPES = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * Inventaire du dossier média : ce qui est RÉELLEMENT sur le disque de la borne.
 *
 * ⚠️ Ce que cet inventaire affirme, et ce qu'il n'affirme PAS. Il affirme une PRÉSENCE : « un
 * fichier portant ce nom, non vide, est là ». Il ne VÉRIFIE PAS l'empreinte — re-hacher 6 Go à
 * chaque appel mettrait la borne à genoux, et il est appelé à chaque retour à l'écran d'attente.
 * L'intégrité se prouve UNE FOIS, à l'ingestion (lots 3a/3b) ; ici on fait confiance au nom parce
 * que seul le provisionnement (root) écrit dans ce dossier. Ce n'est pas un contrôle de sécurité,
 * c'est un inventaire.
 *
 * Dossier absent = borne sans média local (cas normal avant tout approvisionnement), pas une
 * panne : bibliothèque vide, la borne repassera par les URLs signées.
 */
export async function scanMediaLibrary(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  const media = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = Object.keys(MEDIA_TYPES).find((x) => entry.name.endsWith(x));
    if (!ext) continue;
    const hash = entry.name.slice(0, -ext.length);
    if (!HASH.test(hash)) continue;
    const info = await stat(join(root, entry.name)).catch(() => null);
    // 0 octet = fichier créé mais pas (encore) rempli : un téléchargement interrompu ne doit
    // jamais entrer au catalogue comme s'il était jouable.
    if (!info || info.size === 0) continue;
    media.push({ hash, ext, bytes: info.size, mtime: Math.round(info.mtimeMs) });
  }
  return media;
}

/**
 * Analyse un en-tête `Range` pour un fichier de `size` octets. PURE (testée isolément).
 *
 * Renvoie `full` (répondre 200 avec tout le fichier), `partial` (206 + `Content-Range`), ou
 * `unsatisfiable` (416). Une requête multi-intervalles (`bytes=0-9,20-29`) retombe volontairement
 * sur `full` : la RFC 9110 autorise un serveur à ignorer un `Range` qu'il ne sait pas honorer, et
 * répondre juste est toujours préférable à répondre à moitié.
 */
export function parseRange(header, size) {
  if (typeof header !== "string" || header.trim() === "") return { kind: "full" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: "full" };
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return { kind: "full" };
  // Un fichier vide n'a aucun octet à satisfaire — et ne devrait jamais arriver ici (l'agent
  // exclut les 0 octet de sa bibliothèque). Ceinture et bretelles.
  if (size === 0) return { kind: "unsatisfiable" };

  if (rawStart === "") {
    // Forme suffixe : `bytes=-500` = les 500 DERNIERS octets. Chromium s'en sert pour lire l'index
    // d'un MP4 dont le `moov` est en fin de fichier — sans ça, la vidéo ne démarre pas du tout.
    const wanted = Number(rawEnd);
    if (wanted === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - wanted), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}

/**
 * Retrouve le fichier d'une empreinte. Le client ne connaît QUE l'empreinte : c'est le serveur qui
 * essaie les extensions de la liste blanche. `null` = empreinte mal formée ou absente du disque —
 * les deux cas donnent un 404, sans dire lequel (on n'aide personne à sonder le disque).
 */
export async function resolveMediaFile(root, name) {
  if (!HASH.test(name)) return null;
  for (const [ext, type] of Object.entries(MEDIA_TYPES)) {
    const file = join(root, name + ext);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.size > 0) return { file, size: info.size, type };
  }
  return null;
}

/** Réponse d'erreur nue : le lecteur ne lit pas le corps, et un message n'apprendrait rien d'utile. */
function fail(res, code, headers = {}) {
  res.writeHead(code, headers);
  res.end();
}

/**
 * Sert `GET|HEAD /media/<sha256>` depuis `root`. Répond 404 (inconnu), 416 (intervalle hors
 * fichier), 206 (intervalle) ou 200 (fichier entier).
 */
export async function serveMedia(req, res, name, root) {
  const found = await resolveMediaFile(root, name);
  if (!found) return fail(res, 404);

  const range = parseRange(req.headers.range, found.size);
  if (range.kind === "unsatisfiable") {
    return fail(res, 416, { "content-range": `bytes */${found.size}`, "accept-ranges": "bytes" });
  }
  const start = range.kind === "partial" ? range.start : 0;
  const end = range.kind === "partial" ? range.end : found.size - 1;

  const headers = {
    "content-type": found.type,
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
    // Pas de cache navigateur : le fichier est DÉJÀ sur ce disque. Le laisser recopier dans le
    // cache de Chromium doublerait plusieurs Go sur une borne dont l'espace est la ressource
    // rare — et rendrait « libérer de la place » incompréhensible pour l'exploitant.
    "cache-control": "no-store",
    ...(range.kind === "partial" ? { "content-range": `bytes ${start}-${end}/${found.size}` } : {}),
  };
  // HEAD : Chromium sonde parfois la taille avant de lire. Mêmes en-têtes, aucun octet.
  if (req.method === "HEAD") {
    res.writeHead(range.kind === "partial" ? 206 : 200, headers);
    return res.end();
  }

  res.writeHead(range.kind === "partial" ? 206 : 200, headers);
  const stream = createReadStream(found.file, { start, end });
  // Le lecteur ANNULE en permanence (chaque déplacement dans la timeline abandonne la requête en
  // cours). Sans ce `destroy`, chaque saut laisserait un descripteur de fichier ouvert : au bout
  // d'une soirée la borne n'a plus de descripteurs et ne lit plus rien.
  res.on("close", () => stream.destroy());
  stream.on("error", () => {
    // Fichier disparu/illisible EN COURS de lecture (clé USB retirée, purge). Les en-têtes sont
    // déjà partis : on ne peut plus changer le code de statut, on coupe net — le lecteur voit une
    // lecture interrompue, ce qui est la vérité.
    res.destroy();
  });
  stream.pipe(res);
}
