// Kioskoscope — état persistant de la borne : le catalogue de secours (CIN-112 lot 2, F22).
//
// Pourquoi l'agent et pas `localStorage` : un vidage de cache Chromium — que la maintenance
// déclenche pour toutes sortes de raisons — emporterait le catalogue, et la borne redeviendrait
// muette hors ligne sans que personne comprenne pourquoi. Le disque de la machine survit à
// Chromium ; c'est le seul endroit honnête pour un état dont dépend l'exploitation.
//
// ─ Surface d'ÉCRITURE (@qa) ─────────────────────────────────────────────────────────────────
// C'est la première fois que la page web peut faire ÉCRIRE l'agent sur le disque. Elle porte le
// jeton Bearer, donc une web-app compromise peut écrire ici. On borne le dégât :
//   1. Schéma strict, tailles bornées, nombre d'entrées borné → pas de disque rempli, pas de
//      structure absurde relue plus tard.
//   2. **L'horodatage est posé par l'AGENT, jamais par le client.** Sinon une page compromise
//      daterait son instantané dans le futur et s'offrirait une fenêtre hors-ligne illimitée —
//      exactement la garde que le lot 2 met en place.
//   3. Le fichier ne contient QUE du catalogue. Aucun identifiant, aucun jeton, aucun secret :
//      s'il fuite, il ne donne rien de plus que ce qu'un visiteur voit déjà à l'écran.
//   4. L'`orgId` écrit ici n'autorise rien — il sert au client à REFUSER un instantané qui n'est
//      pas le sien (borne réaffectée). L'autorité sur l'org reste `device.json`, côté serveur local.
// Ce que ça ne protège pas : quelqu'un avec un accès root/physique à la machine. C'est le
// résiduel connu de la borne (BIOS/GRUB, CIN-072), pas une régression de ce lot.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

/** Un catalogue plus gros que ça n'est pas un catalogue de cabine, c'est une anomalie. */
const MAX_FILMS = 300;
/** Borne dure sur l'écrit disque, après re-sérialisation par NOUS (pas la taille annoncée). */
const MAX_BYTES = 512 * 1024;
const HASH = /^[0-9a-f]{64}$/;

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 64;

/**
 * Valide un instantané de catalogue reçu de la page web. PURE (testée isolément).
 * Renvoie `{ ok: true, snapshot }` (horodaté par l'appelant) ou `{ ok: false, error }`.
 *
 * Les films sans `contentHash` sont ÉCARTÉS et non refusés : sans empreinte, un film ne peut
 * jamais être rapproché du disque, donc il ne sera jamais jouable hors ligne. L'écarter ici évite
 * de faire grossir un fichier avec des entrées qui ne serviront à rien.
 */
export function validateCatalogSnapshot(raw, now) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "objet attendu" };
  if (raw.version !== 1) return { ok: false, error: "version inconnue" };
  if (!isId(raw.orgId)) return { ok: false, error: "orgId invalide" };
  if (!isId(raw.boothId)) return { ok: false, error: "boothId invalide" };
  if (!Array.isArray(raw.films)) return { ok: false, error: "films: tableau attendu" };
  if (raw.films.length > MAX_FILMS) return { ok: false, error: `films: ${MAX_FILMS} maximum` };

  const films = raw.films.filter(
    (f) => f && typeof f === "object" && isId(f.id) && typeof f.contentHash === "string" && HASH.test(f.contentHash),
  );
  const snapshot = {
    version: 1,
    orgId: raw.orgId,
    boothId: raw.boothId,
    // Horloge de l'AGENT, jamais celle annoncée par le client (cf. en-tête).
    savedAt: new Date(now).toISOString(),
    films,
  };
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > MAX_BYTES) return { ok: false, error: "instantané trop volumineux" };
  return { ok: true, snapshot, dropped: raw.films.length - films.length };
}

const file = (dir) => join(dir, "catalog.json");

/**
 * Écrit l'instantané de façon ATOMIQUE (fichier temporaire + `rename`). Une coupure de courant
 * pendant l'écriture — sur une borne, c'est un scénario courant, pas une hypothèse d'école —
 * doit laisser l'ANCIEN catalogue intact, jamais un JSON tronqué qui rendrait la borne muette.
 */
export async function writeCatalogSnapshot(dir, snapshot) {
  await mkdir(dir, { recursive: true }).catch(() => {});
  const target = file(dir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(tmp, target);
  return { films: snapshot.films.length };
}

/**
 * Relit l'instantané. `null` couvre TOUS les cas d'absence (jamais écrit, illisible, JSON
 * corrompu) : la borne doit alors se comporter comme une borne sans catalogue — vide et honnête.
 * Un catalogue corrompu ne doit surtout pas faire tomber le démarrage de l'agent.
 */
export async function readCatalogSnapshot(dir) {
  let raw;
  try {
    raw = await readFile(file(dir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    // On revalide À LA LECTURE : le fichier a pu être écrit par une version antérieure, ou
    // touché sur le disque. On ne fait pas confiance à ce qu'on relit juste parce qu'on l'a écrit.
    if (parsed?.version !== 1 || !isId(parsed.orgId) || !Array.isArray(parsed.films)) return null;
    if (typeof parsed.savedAt !== "string" || Number.isNaN(Date.parse(parsed.savedAt))) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const CATALOG_LIMITS = { MAX_FILMS, MAX_BYTES, dirOf: dirname };
