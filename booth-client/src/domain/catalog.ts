import type { Film } from "./types";

// ⚠️ CATALOGUE FACTICE — données de démonstration structurées à l'identique du
// vrai catalogue. Aucun de ces films n'existe : titres/tmdbId/durées inventés.
// Remplacer intégralement dès que le catalogue réel + métadonnées sont fournis.
// `storageUrl: null` => lecture simulée (aucun fichier requis pour tester le parcours).

// Champs « Media V2 » (organizationId, contentHash…) ajoutés par map ci-dessous —
// évite de répéter des valeurs identiques sur chaque littéral factice.
type SeedFilm = Omit<Film, "organizationId" | "contentHash" | "language" | "audienceTags" | "subtitles" | "reviewedAt" | "reviewedBy">;

/** Empreinte factice déterministe (remplacée par un vrai SHA-256 à l'upload). */
function mockHash(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

const SEED_FILMS: readonly SeedFilm[] = [
  {
    id: "f-aurora",
    title: "Aurora",
    year: 2021,
    durationSeconds: 480, // 8 min
    storageUrl: null,
    version: 1,
    active: true,
    tmdbId: 900001,
    genres: ["drame", "contemplatif"],
    moods: ["apaisant", "mélancolique"],
    tags: ["nuit", "nature", "lent"],
    director: "Camille Roy",
    synopsis:
      "Une veilleuse de nuit traverse une ville endormie et croise, à l'aube, les fantômes de ses insomnies. Un poème visuel sur le passage du temps.",
    stills: [],
    learnMoreUrl: null,
  },
  {
    id: "f-court-circuit",
    title: "Court-Circuit",
    year: 2019,
    durationSeconds: 300, // 5 min
    storageUrl: null,
    version: 1,
    active: true,
    tmdbId: 900002,
    genres: ["comédie", "absurde"],
    moods: ["énergique", "léger"],
    tags: ["urbain", "rythmé", "dialogue"],
    director: "Nadia Belkacem",
    synopsis:
      "Cinq minutes, une panne d'ascenseur, deux inconnus et un quiproquo qui dérape. Une comédie électrique où chaque seconde compte.",
    stills: [],
    learnMoreUrl: null,
  },
  {
    id: "f-derniere-station",
    title: "Dernière Station",
    year: 2022,
    durationSeconds: 720, // 12 min
    storageUrl: null,
    version: 1,
    active: true,
    tmdbId: 900003,
    genres: ["thriller", "drame"],
    moods: ["tendu", "sombre"],
    tags: ["huis-clos", "nuit", "intense"],
    director: "Yohan Prévost",
    synopsis:
      "Dernier train, dernier quai. Un contrôleur et une voyageuse sans billet se livrent un duel psychologique jusqu'au terminus.",
    stills: [],
    learnMoreUrl: null,
  },
  {
    id: "f-papier",
    title: "Papier",
    year: 2020,
    durationSeconds: 240, // 4 min
    storageUrl: null,
    version: 1,
    active: true,
    tmdbId: 900004,
    genres: ["animation", "poétique"],
    moods: ["apaisant", "léger"],
    tags: ["sans-dialogue", "artisanal", "doux"],
    director: "Lior Amrani",
    synopsis:
      "Un origami prend vie et part à la recherche de la main qui l'a plié. Animation papier découpé, entièrement faite main, sans un mot.",
    stills: [],
    learnMoreUrl: null,
  },
  {
    id: "f-plein-soleil",
    title: "Plein Soleil",
    year: 2023,
    durationSeconds: 540, // 9 min
    storageUrl: null,
    version: 1,
    active: true,
    tmdbId: 900005,
    genres: ["comédie", "romance"],
    moods: ["énergique", "joyeux"],
    tags: ["été", "lumineux", "dialogue"],
    director: "Inès Fontaine",
    synopsis:
      "Une terrasse, un mois d'août, un serveur maladroit et une cliente qui revient chaque jour à la même heure. La romance d'un été, en neuf minutes.",
    stills: [],
    learnMoreUrl: null,
  },
  {
    id: "f-sous-la-cendre",
    title: "Sous la Cendre",
    year: 2018,
    durationSeconds: 660, // 11 min
    storageUrl: null,
    version: 1,
    active: true,
    tmdbId: 900006,
    genres: ["drame", "historique"],
    moods: ["mélancolique", "sombre"],
    tags: ["mémoire", "lent", "intense"],
    director: "Théo Marchand",
    synopsis:
      "Dans une maison vidée après un deuil, une femme retrouve des lettres brûlées à moitié. Ce qui reste de la cendre suffit-il à se souvenir ?",
    stills: [],
    learnMoreUrl: null,
  },
  {
    id: "f-vertige",
    title: "Vertige",
    year: 2022,
    durationSeconds: 180, // 3 min
    storageUrl: null,
    version: 1,
    active: true,
    tmdbId: 900007,
    genres: ["expérimental", "thriller"],
    moods: ["tendu", "énergique"],
    tags: ["court", "rythmé", "sans-dialogue"],
    director: "Sacha Novak",
    synopsis:
      "Trois minutes en apnée au bord du vide. Un montage vertigineux, sans dialogue, où l'image elle-même semble sur le point de tomber.",
    stills: [],
    learnMoreUrl: null,
  },
];

// Catalogue factice complet : SEED + champs Media V2 (mono-org pour le prototype).
export const FACTICE_CATALOG: readonly Film[] = SEED_FILMS.map((f) => ({
  ...f,
  organizationId: "org-perchoir",
  contentHash: mockHash(f.id),
  language: "fr",
  audienceTags: ["bar"],
  subtitles: [],
  reviewedAt: null,
  reviewedBy: null,
}));

// Catalogue d'EXÉCUTION : part du catalogue factice, mais peut recevoir des films
// importés (mode setup / clé USB). C'est la source de vérité du parcours.
const runtimeCatalog: Film[] = FACTICE_CATALOG.map((f) => ({ ...f }));

/** Ajoute un film au catalogue d'exécution (import USB/fichier). */
export function addFilm(film: Film): void {
  runtimeCatalog.push(film);
}

/** Remplace le catalogue d'exécution (ex. catalogue réel chargé depuis Supabase). */
export function setCatalog(films: readonly Film[]): void {
  runtimeCatalog.length = 0;
  runtimeCatalog.push(...films);
}

/** Tous les films du catalogue d'exécution. */
export function allFilms(): readonly Film[] {
  return runtimeCatalog;
}

/** Films actifs uniquement — jamais recommander/jouer un film désactivé. */
export function activeCatalog(catalog: readonly Film[] = runtimeCatalog): readonly Film[] {
  return catalog.filter((f) => f.active);
}

/** Ensemble des humeurs présentes dans le catalogue actif (pour l'écran de choix). */
export function availableMoods(catalog: readonly Film[] = runtimeCatalog): readonly string[] {
  const set = new Set<string>();
  for (const f of activeCatalog(catalog)) for (const m of f.moods) set.add(m);
  return [...set].sort();
}

export function filmById(id: string, catalog: readonly Film[] = runtimeCatalog): Film | undefined {
  return catalog.find((f) => f.id === id);
}

// ── Jouabilité : un film sans fichier n'est PAS un film (BUG-017) ────────────
// Un média dont l'URL de lecture est nulle passait quand même dans le catalogue, était recommandé,
// et « se jouait » via la lecture SIMULÉE de l'écran lecteur (barre de progression, aucune image,
// aucun son). Un visiteur pouvait donc payer pour un fichier qui n'existe pas. Règle : on ne
// propose que ce qu'on peut réellement projeter.

/**
 * Source de lecture LOCALE d'un média (CIN-112 lot 1), servie par le serveur local de la borne
 * en streaming Range. `null` = ce média n'est pas sur le disque → il faudra une URL signée, donc
 * du réseau. La forme de l'empreinte est re-vérifiée ici parce qu'elle vient de la base et finit
 * dans une URL : une empreinte mal formée ne produit pas une URL douteuse, elle ne produit RIEN.
 *
 * Chemin relatif (même origine que l'app) : le lecteur n'a donc pas à connaître le port local, et
 * la requête n'est pas soumise au CORS.
 */
export function localMediaUrl(contentHash: string, localMedia: ReadonlySet<string>): string | null {
  if (!/^[0-9a-f]{64}$/.test(contentHash) || !localMedia.has(contentHash)) return null;
  return `/media/${contentHash}`;
}

/** Un média du catalogue réel, avec le chemin de fichier DÉCLARÉ en base (avant résolution). */
export interface CatalogEntry {
  /** Le film tel qu'il sera servi au parcours (`storageUrl` = URL résolue, ou null si échec). */
  readonly film: Film;
  /** Chemin storage déclaré en base (`media.storage_url`). null = aucun fichier rattaché. */
  readonly declaredPath: string | null;
}

/**
 * Tri du catalogue réel en trois tas. La distinction entre les deux tas d'exclusion est
 * intentionnelle : ils n'appellent pas la même réaction.
 *  - `withoutFile` : la fiche existe, aucun fichier n'a jamais été rattaché → DONNÉE INCOMPLÈTE,
 *    c'est au back-office de la compléter. Normal sur un catalogue en cours de constitution.
 *  - `unresolved`  : un fichier est déclaré mais son URL n'a pas pu être résolue (signature
 *    refusée, objet absent du bucket, droits) → INCIDENT. Le média existe et devrait être jouable :
 *    quelque chose est cassé côté stockage ou policies, et ça mérite une alerte, pas un haussement
 *    d'épaules.
 * Dans les deux cas le média SORT du catalogue : mieux vaut aucune séance qu'un faux film payant
 * (règle posée par BUG-011, ici étendue au média sans fichier).
 */
export function auditCatalog(entries: readonly CatalogEntry[]): {
  readonly playable: readonly Film[];
  readonly withoutFile: readonly Film[];
  readonly unresolved: readonly Film[];
} {
  const playable: Film[] = [];
  const withoutFile: Film[] = [];
  const unresolved: Film[] = [];
  for (const { film, declaredPath } of entries) {
    const declared = typeof declaredPath === "string" && declaredPath.trim() !== "";
    const resolved = typeof film.storageUrl === "string" && film.storageUrl.trim() !== "";
    if (!declared) withoutFile.push(film);
    else if (!resolved) unresolved.push(film);
    else playable.push(film);
  }
  return { playable, withoutFile, unresolved };
}
