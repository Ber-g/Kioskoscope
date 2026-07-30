// Catalogue de secours hors ligne (CIN-112 lot 2, F22) — la décision, isolée et pure.
//
// Au démarrage sans réseau, la borne n'a que deux choses : un instantané du dernier catalogue
// valide (écrit par l'agent sur le disque) et la liste des médias réellement présents. Ce module
// décide ce qu'on en fait. Il ne touche ni au réseau, ni au DOM, ni à l'horloge : tout lui est
// passé — c'est ce qui permet de le tester exhaustivement, y compris les cas d'horloge tordue.
//
// ─ La règle, et pourquoi ─────────────────────────────────────────────────────────────────────
// Le catalogue en ligne est filtré par les DROITS (`blocked_media_for_booth`, CIN-010) : licence
// expirée, borne non autorisée, plafond de séances atteint. Hors ligne, la borne ne peut rien
// réévaluer : elle ne lit ni les licences, ni les compteurs (surface minimale, CIN-002). Elle sait
// seulement qu'à l'instant `savedAt`, ces films-là étaient autorisés POUR ELLE.
//
// Cette connaissance se périme de deux façons, et il faut les nommer séparément :
//   • par le TEMPS — une licence peut expirer pendant la fenêtre hors ligne ;
//   • par le COMPTE — la borne joue, un plafond de séances peut être franchi sans qu'elle le voie.
//
// Face à ça, on choisit la prudence, pas l'optimisme : **dans le doute, le film sort du
// catalogue.** Une séance de moins est un manque à gagner ; une séance jouée hors droits est une
// redevance impayée à un ayant droit, c'est-à-dire un problème contractuel. Les deux ne pèsent pas
// pareil. La fenêtre `maxAgeMs` borne l'exposition des DEUX dérives à la fois.

import type { Film } from "./types";
import { localMediaUrl } from "./catalog";

/**
 * Fenêtre pendant laquelle un catalogue hors ligne reste digne de confiance. 7 jours : assez pour
 * couvrir un week-end de festival ou une panne de box, assez court pour qu'une licence expirée ne
 * traîne pas des semaines. ⚠️ C'est un arbitrage PRODUIT (@cpo) autant que technique — le jour où
 * un lieu réel reste hors ligne plus longtemps, c'est cette valeur qu'on rediscute, pas la règle.
 */
export const OFFLINE_CATALOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * Tolérance de dérive d'horloge. Une borne sans réseau n'a pas de NTP : son horloge dérive, et un
 * redémarrage peut la ramener en arrière. En deçà, on ne s'en émeut pas ; au-delà, l'horloge n'est
 * plus une source de vérité et on refuse de s'en servir pour juger des droits.
 */
export const CLOCK_DRIFT_TOLERANCE_MS = 60 * 60 * 1000;

/** Pourquoi le catalogue hors ligne est ce qu'il est. Sert au diagnostic à l'écran ET aux tests. */
export type OfflineCatalogReason =
  | "restored" // catalogue restauré (éventuellement partiel)
  | "no-snapshot" // jamais connecté, ou instantané illisible
  | "other-org" // instantané d'une autre organisation (borne réaffectée)
  | "too-old" // fenêtre de confiance dépassée
  | "clock-behind" // l'horloge locale est AVANT l'instantané : elle a reculé
  | "empty-snapshot" // instantané valide mais vide
  | "no-local-media"; // rien de l'instantané n'est présent sur le disque

/**
 * Forme ATTENDUE de l'instantané — jamais garantie. Il vient d'un fichier sur disque : version
 * antérieure, écriture interrompue, fichier touché à la main. On le reçoit donc en `unknown` et
 * on le rétrécit champ par champ, sans jamais présumer d'une forme.
 */
interface RawSnapshot {
  readonly version?: unknown;
  readonly orgId?: unknown;
  readonly savedAt?: unknown;
  readonly films?: unknown;
}

export interface OfflineCatalogResult {
  /** Films jouables hors ligne : autorisés à `savedAt` ET présents sur le disque MAINTENANT. */
  readonly films: readonly Film[];
  readonly reason: OfflineCatalogReason;
  /** Âge de l'instantané en ms (null si inexploitable). Pour le diagnostic sur place. */
  readonly ageMs: number | null;
  /** Films de l'instantané écartés faute de fichier local — la mesure de l'écart à combler. */
  readonly missingLocally: number;
}

/**
 * Reconstruit le catalogue jouable hors ligne.
 *
 * `localMedia` est l'inventaire du disque (lot 1). L'intersection est le cœur : un film de
 * l'instantané dont le fichier n'est PAS là ne doit jamais apparaître — c'est la règle BUG-011,
 * un film proposé doit être un film projetable, sinon on encaisse pour du vide.
 */
export function restoreOfflineCatalog(args: {
  readonly snapshot: unknown;
  readonly localMedia: ReadonlySet<string>;
  readonly orgId: string;
  readonly now: number;
  readonly maxAgeMs?: number;
}): OfflineCatalogResult {
  const { localMedia, orgId, now } = args;
  const snapshot = args.snapshot as RawSnapshot | null;
  const maxAgeMs = args.maxAgeMs ?? OFFLINE_CATALOG_MAX_AGE_MS;
  const nothing = (reason: OfflineCatalogReason, ageMs: number | null = null): OfflineCatalogResult => ({
    films: [],
    reason,
    ageMs,
    missingLocally: 0,
  });

  if (!snapshot || typeof snapshot !== "object") return nothing("no-snapshot");
  if (snapshot.version !== 1 || !Array.isArray(snapshot.films)) return nothing("no-snapshot");

  const savedAt = typeof snapshot.savedAt === "string" ? Date.parse(snapshot.savedAt) : NaN;
  if (Number.isNaN(savedAt)) return nothing("no-snapshot");

  // L'org vient du provisionnement local (`device.json`), jamais de l'instantané : un fichier
  // d'une autre org — borne réaffectée, disque déplacé — ne doit rien pouvoir proposer ici.
  if (typeof snapshot.orgId !== "string" || snapshot.orgId !== orgId) return nothing("other-org");

  const ageMs = now - savedAt;
  // Horloge revenue AVANT l'écriture de l'instantané. Soit elle a reculé (pile RTC morte, reboot),
  // soit on la manipule pour rouvrir une fenêtre fermée. Dans les deux cas elle ne peut plus servir
  // à juger si une licence court encore : on refuse, plutôt que de faire semblant de savoir.
  if (ageMs < -CLOCK_DRIFT_TOLERANCE_MS) return nothing("clock-behind", ageMs);
  if (ageMs > maxAgeMs) return nothing("too-old", ageMs);
  if (snapshot.films.length === 0) return nothing("empty-snapshot", ageMs);

  const films: Film[] = [];
  let missingLocally = 0;
  for (const raw of snapshot.films as unknown[]) {
    const film = raw as Film | null;
    if (!film || typeof film !== "object" || typeof film.contentHash !== "string") continue;
    const url = localMediaUrl(film.contentHash, localMedia);
    if (!url) {
      missingLocally += 1;
      continue;
    }
    // L'URL est TOUJOURS recalculée à partir du disque : on ne rejoue jamais une URL signée
    // conservée dans l'instantané — elle serait expirée, et injouable hors ligne par définition.
    films.push({ ...film, storageUrl: url });
  }

  if (films.length === 0) return { films: [], reason: "no-local-media", ageMs, missingLocally };
  return { films, reason: "restored", ageMs, missingLocally };
}

/** Formule le diagnostic destiné à la personne présente devant la borne (jamais au visiteur). */
export function describeOfflineCatalog(r: OfflineCatalogResult): string {
  const days = r.ageMs === null ? null : Math.floor(Math.abs(r.ageMs) / 86_400_000);
  switch (r.reason) {
    case "restored":
      return `catalogue hors ligne restauré : ${r.films.length} film(s)` + (r.missingLocally > 0 ? `, ${r.missingLocally} absent(s) du disque` : "");
    case "no-snapshot":
      return "aucun catalogue enregistré — cette borne ne s'est jamais connectée depuis son installation";
    case "other-org":
      return "le catalogue enregistré appartient à une autre organisation — il est ignoré";
    case "too-old":
      return `catalogue enregistré trop ancien (${days} jour(s)) : les droits ne peuvent plus être garantis hors ligne`;
    case "clock-behind":
      return "l'horloge de la borne est antérieure au dernier catalogue enregistré — elle n'est plus fiable pour juger des droits";
    case "empty-snapshot":
      return "le dernier catalogue enregistré était vide";
    default:
      return `aucun des ${r.missingLocally} film(s) enregistré(s) n'est présent sur le disque de la borne`;
  }
}
