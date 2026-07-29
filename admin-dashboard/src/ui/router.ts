// Routage du back-office (CIN-118) — traduction entre l'URL et l'état de navigation.
//
// ── Pourquoi le HASH et pas `pushState` avec de vraies URL ───────────────────────────────────
// Le dashboard est un bundle statique servi par Cloudflare Pages. Une URL comme `/booths/xyz`
// exigerait une réécriture serveur vers `index.html` : sans elle, un accès DIRECT (lien partagé,
// favori, F5) renvoie un 404 — c'est-à-dire précisément le cas d'usage qui motive ce ticket. Le
// hash n'est jamais envoyé au serveur : il marche tel quel, partout, sans configuration.
//
// ── Pourquoi ce module ne touche PAS au DOM ─────────────────────────────────────────────────
// `parseRoute` / `formatRoute` sont des fonctions pures : elles se testent sans navigateur
// (`scripts/logic_smoke.ts`). Toute la partie `history` vit dans `App`. C'est la couture qui
// permet de vérifier la grammaire d'URL — la partie qui casse en silence — dans le harnais
// existant plutôt qu'à la main dans un onglet.

// ── Vocabulaire d'URL ───────────────────────────────────────────────────────────────────────
// Ce module n'importe RIEN des écrans, et c'est délibéré : ce sont les écrans qui importent leurs
// clés d'onglet d'ici. Le sens de la dépendance est ce qui garde le routeur sans DOM (donc
// testable dans `logic_smoke`) — `settings.ts` tire `bootstrap`, qui n'existe pas sous Node.
// Effet de bord utile : ajouter un onglet sans lui donner de segment d'URL ne compile pas.

/** Onglets du menu « Mon organisation » — aussi des segments d'URL. */
export const SETTINGS_TAB_KEYS = [
  "general",
  "members",
  "invites",
  "roles",
  "booths",
  "styles",
  "access",
  "billing",
  "subscription",
] as const;
export type SettingsTab = (typeof SETTINGS_TAB_KEYS)[number];

/** Onglets du hub d'une cabine (CIN-045) — aussi des segments d'URL. */
export const HUB_TAB_KEYS = ["synthese", "maj", "acces", "fiche", "medias", "revenus"] as const;
export type HubTab = (typeof HUB_TAB_KEYS)[number];

// Vues du back-office. « fleet » = le PARC DE MACHINES (tous les comptes, scopé) ;
// « organizations » = le roster de CLIENTS (super-admin). Ces deux mots ont été confondus
// jusqu'à CIN-091 — les garder distincts ici est ce qui empêche la confusion de revenir.
// Ils servent aussi de vocabulaire d'URL : une seule source, pas de table de traduction à
// maintenir en parallèle (donc rien qui puisse dériver).
export const VIEWS = [
  "overview",
  "media",
  "revenue",
  "rights",
  "sessions",
  "maintenance",
  "settings",
  "fleet",
  "organizations",
  "booth",
] as const;

export type View = (typeof VIEWS)[number];

/** Vues qui s'écrivent `#/<vue>` et n'ont aucun paramètre. */
const PLAIN_VIEWS = ["media", "revenue", "rights", "sessions", "maintenance", "fleet", "organizations"] as const;

/**
 * État de navigation adressable.
 *
 * Volontairement PLAT plutôt qu'union discriminée : il reflète champ pour champ l'état de `App`,
 * ce qui rend l'application d'une route triviale et sans conversion. La discipline est portée par
 * `formatRoute`, qui n'émet que les segments pertinents pour la vue courante.
 *
 * Ce qui n'est PAS dans l'URL, et pourquoi : le filtre par statut et le tri du tableau. Ce sont
 * des aides de lecture transitoires — les mettre dans l'historique remplirait le bouton Retour de
 * douzaines d'étapes qui ne sont pas des lieux, et rendrait le geste inutilisable pour ce à quoi
 * il sert vraiment : revenir d'où l'on vient.
 */
export interface Route {
  readonly view: View;
  /** `overview` uniquement — CIN-044 : la carte est une bascule DANS la vue d'ensemble. */
  readonly overviewMode: "list" | "map";
  /** `settings` uniquement. */
  readonly settingsTab: SettingsTab;
  /** `settings` uniquement — org administrée depuis le roster (CIN-091 b). `null` = la sienne. */
  readonly adminOrgId: string | null;
  /** `booth` uniquement. */
  readonly boothId: string | null;
  /** `booth` uniquement. */
  readonly boothTab: HubTab;
}

const DEFAULT_SETTINGS_TAB: SettingsTab = "general";
const DEFAULT_HUB_TAB: HubTab = "synthese";

/** Route d'accueil — aussi le repli de toute URL qu'on ne sait pas lire. */
export const HOME: Route = {
  view: "overview",
  overviewMode: "list",
  settingsTab: DEFAULT_SETTINGS_TAB,
  adminOrgId: null,
  boothId: null,
  boothTab: DEFAULT_HUB_TAB,
};

function isSettingsTab(s: string): s is SettingsTab {
  return (SETTINGS_TAB_KEYS as readonly string[]).includes(s);
}

function isHubTab(s: string): s is HubTab {
  return (HUB_TAB_KEYS as readonly string[]).includes(s);
}

/**
 * URL → route, ou `null` si la grammaire n'est pas reconnue.
 *
 * `null` et non « repli silencieux sur l'accueil » : c'est à l'appelant de décider quoi faire
 * d'une URL illisible, et il doit le faire par un `replaceState` — laisser une entrée d'historique
 * qui redirige à chaque visite transforme le bouton Retour en piège.
 *
 * Grammaire :
 *   `#/`                                → vue d'ensemble (liste)
 *   `#/map`                             → vue d'ensemble (carte)
 *   `#/media` `#/sessions` …            → vue simple
 *   `#/settings` `#/settings/<onglet>`  → mon organisation
 *   `#/organizations`                   → roster des clients
 *   `#/organizations/<id>[/<onglet>]`   → administration d'un client (CIN-091 b)
 *   `#/booths/<id>[/<onglet>]`          → hub d'une cabine (CIN-045)
 */
export function parseRoute(hash: string): Route | null {
  const raw = String(hash ?? "").replace(/^#/, "");
  const segments = raw
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        // Un `%` isolé fait lever `decodeURIComponent`. Une URL malformée n'est pas une raison
        // de faire tomber l'application : on garde le segment brut, il ne matchera rien.
        return s;
      }
    });

  if (segments.length === 0) return HOME;

  const [head, second, third] = segments;

  if (head === "map" && segments.length === 1) return { ...HOME, overviewMode: "map" };

  if ((PLAIN_VIEWS as readonly string[]).includes(head)) {
    // `#/organizations/<id>` est une route distincte, traitée plus bas.
    if (head === "organizations" && segments.length > 1) {
      if (segments.length > 3) return null;
      const tab = third ?? DEFAULT_SETTINGS_TAB;
      if (!isSettingsTab(tab)) return null;
      return { ...HOME, view: "settings", adminOrgId: second!, settingsTab: tab };
    }
    if (segments.length !== 1) return null;
    return { ...HOME, view: head as View };
  }

  if (head === "settings") {
    if (segments.length > 2) return null;
    const tab = second ?? DEFAULT_SETTINGS_TAB;
    if (!isSettingsTab(tab)) return null;
    return { ...HOME, view: "settings", settingsTab: tab };
  }

  if (head === "booths") {
    if (segments.length < 2 || segments.length > 3) return null;
    const tab = third ?? DEFAULT_HUB_TAB;
    if (!isHubTab(tab)) return null;
    return { ...HOME, view: "booth", boothId: second!, boothTab: tab };
  }

  return null;
}

/**
 * Route → URL. N'émet que ce qui distingue la route de son défaut.
 *
 * Omettre l'onglet par défaut n'est pas de la cosmétique : l'URL est une partie de l'interface,
 * c'est ce qu'on colle dans un message. `#/booths/abc` se lit ; `#/booths/abc/synthese` fait
 * croire qu'il existe un état plus précis qu'il n'y en a.
 */
export function formatRoute(r: Route): string {
  const seg = (s: string): string => encodeURIComponent(s);

  switch (r.view) {
    case "overview":
      return r.overviewMode === "map" ? "#/map" : "#/";
    case "settings": {
      const tab = r.settingsTab === DEFAULT_SETTINGS_TAB ? "" : `/${seg(r.settingsTab)}`;
      // Administrer un CLIENT depuis le roster est une route du roster, pas de « mon
      // organisation » : la hiérarchie de l'URL dit de qui on parle.
      return r.adminOrgId ? `#/organizations/${seg(r.adminOrgId)}${tab}` : `#/settings${tab}`;
    }
    case "booth": {
      if (!r.boothId) return "#/";
      const tab = r.boothTab === DEFAULT_HUB_TAB ? "" : `/${seg(r.boothTab)}`;
      return `#/booths/${seg(r.boothId)}${tab}`;
    }
    default:
      return `#/${r.view}`;
  }
}

/**
 * Deux routes désignent-elles la même adresse ?
 *
 * Comparaison par l'URL rendue, et non champ à champ : deux routes qui ne diffèrent que par un
 * champ hors-sujet pour leur vue (un `settingsTab` traînant sur une route `booth`) sont bien la
 * même adresse. C'est ce qui rend l'écriture d'URL idempotente et empêche les boucles
 * `render → pushState → hashchange → render`.
 */
export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
