import { GridStack } from "gridstack";
import type { GridStackNode } from "gridstack";
import type { Booth, HealthStatus } from "../domain/types";
import type { FleetStore } from "../data/store";
import { el, icon } from "./dom";
import type { Kpi, SortKey, SortState } from "./components";
import { boothCard, boothTable, computeKpis, kpiTile, sortBooths, statusDistribution } from "./components";
import { openBoothDrawer, openBoothForm } from "./drawer";
import { loginScreen } from "./login";
import { mediaPage } from "./media";
import { revenuePage } from "./revenue";
import { maintenancePage } from "./maintenance";
import { rightsPage } from "./rights";
import { sessionsPage } from "./sessions";
import { settingsPage, setSettingsNav, getSettingsNav } from "./settings";
import { designatedOrgId } from "./settingsNav";
import { fleetPage } from "./fleet";
import { organizationsPage } from "./organizations";
import { boothHubPage, type HubTab } from "./boothHub";
import { mapPage, mountFleetMap } from "./mapView";
import { HOME, formatRoute, parseRoute, sameRoute, type Route, type View } from "./router";
import { t, getLang, setLang, LANGS, onLangChange } from "../i18n";

const THEME_KEY = "kioskoscope.admin.theme.v1";

interface FilterState {
  readonly statuses: readonly HealthStatus[];
  readonly label: string;
  readonly color: string;
}

// Contrôleur du back-office : shell Tabler + vue d'ensemble. Gère rôle, thème,
// mode « édition de la disposition » (Gridstack), FILTRE au clic et TRI du tableau.
export class App {
  private grid: GridStack | undefined;
  private editing = false;
  private filter: FilterState | null = null;
  private sort: SortState = { key: "health", dir: "asc" };
  private view: View = "overview";
  // CIN-091 : org DEMANDÉE par l'adresse (menu « Organisations » → clic sur une org). C'est une
  // GRAINE, pas la vérité : l'org réellement affichée est résolue par l'écran (`getSettingsNav`),
  // et la désignation en est dérivée (`displayedAdminOrgId`). `null` = aucune org demandée.
  private adminOrgId: string | null = null;
  // CIN-045 : hub de gestion d'une cabine (vue dédiée, scopée à une borne).
  private selectedBoothId: string | null = null;
  private boothTab: HubTab = "synthese";
  // CIN-044 : la carte n'est plus un menu — c'est une bascule DANS la vue d'ensemble.
  private overviewMode: "list" | "map" = "list";
  private themePref: "system" | "light" | "dark" = ((): "system" | "light" | "dark" => {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  })();

  constructor(
    private readonly root: HTMLElement,
    private readonly store: FleetStore,
  ) {
    this.store.subscribe(() => this.render());
    onLangChange(() => this.render());
    document.documentElement.lang = getLang();
    this.applyTheme();
    // En mode « système », suivre les changements de préférence de l'OS en direct.
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (this.themePref === "system") this.applyTheme();
    });
    // CIN-117 : revenir sur l'onglet remet les données à jour. C'est le moment où l'opérateur
    // REGARDE — donc celui où la fraîcheur compte. Pas de `setInterval` : un onglet laissé
    // ouvert toute la journée n'a aucune raison d'interroger la base dans le vide.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.autoRefresh();
    });
    // CIN-118 : les DEUX événements, délibérément. `popstate` couvre Retour/Suivant ; `hashchange`
    // couvre l'URL modifiée à la main dans la barre d'adresse. Certains navigateurs émettent les
    // deux pour un même geste — `onUrlChange` est idempotent (il ne fait rien si l'adresse
    // demandée est déjà celle affichée), donc le doublon est sans effet.
    window.addEventListener("popstate", () => this.onUrlChange());
    window.addEventListener("hashchange", () => this.onUrlChange());
  }

  // ── Rafraîchissement automatique (CIN-117) ────────────────────────────────────
  private lastRefreshAt = 0;
  /** Deux gestes rapprochés (retour d'onglet puis changement de vue) ne font qu'une requête. */
  private static readonly REFRESH_MIN_INTERVAL_MS = 10_000;

  /**
   * Un rechargement est-il SÛR à cet instant ?
   *
   * ⚠️ Garde héritée de BUG-006 : tout `emit()` du store reconstruit la page. Un formulaire dont
   * l'état vit dans la closure de sa fonction de rendu perd donc sa saisie. Seul
   * `orgStyleSettings` a été immunisé (map `DRAFTS` hors cycle de rendu) — partout ailleurs, un
   * rafraîchissement déclenché pendant une saisie REJOUERAIT le bug, et cette fois au hasard,
   * ce qui est bien pire qu'un bug reproductible.
   *
   * On s'abstient donc dès qu'il y a le moindre signe d'édition en cours. Un rafraîchissement
   * manqué est invisible ; une saisie perdue ne l'est pas.
   */
  private canAutoRefresh(): boolean {
    if (this.store.isBooting || this.store.needsAuth) return false;
    // Modale ou tiroir ouvert = geste en cours (formulaire cabine, média, accès opérateur…).
    if (document.querySelector(".modal.show, .offcanvas.show")) return false;
    // Champ en cours de saisie.
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement
    ) {
      return false;
    }
    // Mode « édition de la disposition » (Gridstack) : re-rendre casserait le glisser-déposer.
    if (this.editing) return false;
    return Date.now() - this.lastRefreshAt >= App.REFRESH_MIN_INTERVAL_MS;
  }

  /** Recharge si c'est sûr. Silencieux par construction : jamais d'erreur à l'écran ici. */
  private autoRefresh(): void {
    if (!this.canAutoRefresh()) return;
    this.lastRefreshAt = Date.now();
    void this.store.refresh().catch((e: unknown) => {
      // Un rafraîchissement d'arrière-plan qui échoue ne doit RIEN changer à l'écran : les
      // données affichées restent les dernières connues. `loadFromSupabase` gère déjà le cas
      // « impossible de vérifier l'identité » sans déconnecter (BUG-010).
      console.error("[dashboard] rafraîchissement automatique échoué —", e);
    });
  }

  // ── Routage (CIN-118) ─────────────────────────────────────────────────────────
  /**
   * Une seule normalisation d'URL au démarrage — les vues sous condition (module, rôle) ne
   * peuvent être arbitrées qu'une fois l'identité connue, donc pas au premier rendu.
   */
  private routeSettled = false;

  /**
   * Org à faire figurer dans l'adresse et dans le surlignage du menu — la DÉSIGNATION.
   *
   * Trois notions distinctes, longtemps confondues sous le seul `adminOrgId` :
   *   • `this.adminOrgId` — l'org DEMANDÉE par l'adresse (graine, transmise à `settingsPage`) ;
   *   • `getSettingsNav().orgId` — l'org AFFICHÉE (résolue par l'écran, toujours visible) ;
   *   • cette méthode — la désignation, dérivée des deux précédentes.
   *
   * Le calcul précédent (`this.adminOrgId ?? …`) GELAIT l'URL sur la première org : arrivé depuis
   * le roster, changer d'org au sélecteur changeait l'écran mais pas l'adresse. Partir de l'org
   * affichée supprime la question.
   */
  private displayedAdminOrgId(): string | null {
    return designatedOrgId(getSettingsNav().orgId, this.store.current?.activeOrganizationId ?? null);
  }

  /** L'état de navigation courant, vu comme une adresse. */
  private currentRoute(): Route {
    return {
      view: this.view,
      overviewMode: this.overviewMode,
      settingsTab: getSettingsNav().tab,
      // L'adresse nomme l'org RÉELLEMENT affichée. Pour un global_admin il n'y a pas d'org
      // « sienne » (`activeOrganizationId` vaut null) : toute org affichée est donc désignée.
      adminOrgId: this.displayedAdminOrgId(),
      boothId: this.selectedBoothId,
      boothTab: this.boothTab,
    };
  }

  /** Adresse → état. N'écrit RIEN dans l'historique et ne rend pas : les appelants s'en chargent. */
  private applyRoute(r: Route): void {
    this.view = r.view;
    this.overviewMode = r.overviewMode;
    this.adminOrgId = r.view === "settings" ? r.adminOrgId : null;
    this.selectedBoothId = r.view === "booth" ? r.boothId : null;
    this.boothTab = r.boothTab;
    // BUG-006 : cet état vit HORS du cycle de rendu, et n'est écrit qu'ici — c'est-à-dire sur une
    // navigation, jamais sur un re-render. C'est la même règle qu'avant, mais elle n'a plus
    // besoin d'être énoncée séparément : l'URL dit l'onglet, donc arriver sur `#/settings` remet
    // « Général » par construction.
    if (r.view === "settings") setSettingsNav(r.settingsTab, r.adminOrgId);
  }

  /**
   * Va à une adresse : écrit l'URL, applique, rend.
   *
   * `replace` empile ou non une entrée d'historique. La règle : **une vue est un lieu, un onglet
   * est une facette du même lieu.** Changer de vue empile (le Retour doit y ramener) ; changer
   * d'onglet dans un hub remplace — sinon sortir d'une fiche cabine demanderait six appuis sur
   * Retour, ce qui détruirait le geste au lieu de le réparer. Dans les deux cas l'URL est à jour,
   * donc un lien vers un onglet précis reste partageable.
   */
  private navigate(r: Route, replace = false): void {
    const href = formatRoute(r);
    if (href !== location.hash) {
      if (replace) history.replaceState(null, "", href);
      else history.pushState(null, "", href);
    }
    this.applyRoute(r);
    this.render();
  }

  /** L'URL a changé sans nous (Retour/Suivant, barre d'adresse). */
  private onUrlChange(): void {
    const r = parseRoute(location.hash);
    if (!r) {
      // URL illisible : on la remplace au lieu de l'empiler. Une entrée d'historique qui redirige
      // à chaque visite rendrait le bouton Retour inutilisable — il faudrait la traverser.
      this.navigate(HOME, true);
      return;
    }
    if (sameRoute(r, this.currentRoute())) return; // déjà là : ne pas re-rendre pour rien
    this.applyRoute(r);
    this.render();
    this.autoRefresh(); // arriver sur une vue est un bon moment pour rafraîchir (CIN-117)
  }

  /** Écrit l'état courant dans l'URL sans toucher à l'historique. Idempotent. */
  private syncUrl(): void {
    const href = formatRoute(this.currentRoute());
    if (href !== location.hash) history.replaceState(null, "", href);
  }

  /**
   * Publie l'état du menu Organisation dans l'URL. **Ne rend jamais** : appelé depuis le rendu de
   * `settingsPage`, un rendu en retour serait une récursion.
   *
   * `push` : changer de CLIENT au sélecteur est un changement de lieu (Retour doit y ramener) ;
   * changer d'onglet reste une facette du même lieu, donc un simple remplacement.
   */
  private publishSettingsUrl(push: boolean): void {
    if (!push) {
      this.syncUrl();
      return;
    }
    const href = formatRoute(this.currentRoute());
    if (href !== location.hash) history.pushState(null, "", href);
  }

  /**
   * Arbitre une fois, à l'ouverture, ce que le premier rendu ne pouvait pas savoir : la vue
   * demandée est-elle seulement accessible à ce compte ?
   *
   * Sans ça, `#/revenue` sur une org sans facturation afficherait la vue d'ensemble avec une URL
   * qui annonce « Revenus » — une adresse qui ment. On remplace donc l'entrée par l'accueil.
   *
   * ⚠️ Cas volontairement NON traité : `#/booths/<id>` vers une cabine inconnue. Le hub affiche
   * « Cabine introuvable », et c'est la bonne réponse — rediriger en silence vers l'accueil
   * laisserait croire que le lien reçu était valide.
   */
  private settleRoute(): void {
    if (this.routeSettled) return;
    this.routeSettled = true;
    const available =
      this.view === "revenue" || this.view === "rights"
        ? this.store.activeHasModule(this.view)
        : this.view === "organizations"
          ? this.store.isGlobalAdmin
          : true;
    if (!available) this.applyRoute(HOME);
    this.syncUrl();
  }

  /** Point d'entrée : lit l'adresse, rend, puis lance le chargement (async). */
  start(): void {
    // L'adresse est lue AVANT le premier rendu : un lien profond partagé ou un F5 doivent ouvrir
    // la page demandée, pas la vue d'ensemble. L'arbitrage des vues sous condition attend
    // `settleRoute()` — l'identité n'est pas encore connue à cet instant.
    this.applyRoute(parseRoute(location.hash) ?? HOME);
    this.render();
    void this.store.init();
  }

  /** Écran d'attente neutre — n'affirme ni « connecté » ni « pas connecté ». */
  private static loadingScreen(): HTMLElement {
    return el("div", { class: "page page-center" }, [el("div", { class: "text-secondary p-5" }, ["Chargement…"])]);
  }

  render(): void {
    // CIN-118 : tant que `getSession()` n'a pas répondu, on ne SAIT PAS si l'utilisateur est
    // connecté. Cette branche doit passer AVANT `needsAuth`, sinon le premier rendu (synchrone,
    // déclenché par `start()` avant que `init()` n'ait pu répondre) affiche l'écran de connexion
    // à quelqu'un dont la session est valide — c'est ce qui renvoyait au login à chaque
    // rechargement, et à chaque appui sur le bouton Retour du navigateur.
    if (this.store.isBooting) {
      this.root.replaceChildren(App.loadingScreen());
      return;
    }
    // Mode Supabase : connexion requise, ou chargement en cours.
    if (this.store.needsAuth) {
      this.root.replaceChildren(loginScreen(this.store));
      return;
    }
    if (!this.store.current) {
      this.root.replaceChildren(App.loadingScreen());
      return;
    }
    // L'identité est connue : c'est ici, et une seule fois, qu'on peut arbitrer si l'adresse
    // demandée est accessible. `settleRoute` ne rend pas — il ajuste l'état avant construction.
    this.settleRoute();
    this.maybeAcceptInvite();
    const page =
      this.view === "media"
        ? mediaPage(this.store, () => this.render())
        : this.view === "revenue"
          ? (this.store.activeHasModule("revenue") ? revenuePage(this.store, (id) => this.openDrawer(id)) : this.overview())
          : this.view === "rights"
            ? (this.store.activeHasModule("rights") ? rightsPage(this.store, () => this.render(), (id) => this.openDrawer(id)) : this.overview())
            : this.view === "sessions"
              ? sessionsPage(this.store, (id) => this.openDrawer(id))
              : this.view === "maintenance"
                ? maintenancePage(this.store, () => this.render(), (id) => this.openDrawer(id))
                : this.view === "settings"
                  ? settingsPage(this.store, () => this.render(), this.adminOrgId, () => this.setView("organizations"), (push) => this.publishSettingsUrl(push === true))
                  : this.view === "fleet"
                    ? fleetPage(this.store, (id) => this.openBoothHub(id))
                    : this.view === "organizations"
                    ? (this.store.isGlobalAdmin ? organizationsPage(this.store, (id) => this.openBoothHub(id), (id) => this.openOrgAdmin(id)) : this.overview())
                    : this.view === "booth" && this.selectedBoothId
                    ? boothHubPage(this.store, this.selectedBoothId, () => this.setView("overview"), () => this.render(), this.boothTab, (tab) => { this.boothTab = tab; this.syncUrl(); }, () => this.setView("media"))
                    : this.overview();
    this.root.replaceChildren(
      this.sidebar(),
      this.topbar(),
      el("div", { class: "page-wrapper" }, [
        el("div", { class: `page-body ${this.view === "overview" && this.filter ? `is-filtered filtered-${this.filter.color}` : ""}` }, [
          el("div", { class: "container-xl" }, [page]),
        ]),
      ]),
    );
    if (this.view === "overview") {
      this.mountGrid();
      if (this.overviewMode === "map") mountFleetMap(this.store, (id) => this.openDrawer(id));
    }
  }

  /**
   * Navigation par le menu. `#/settings` n'emporte aucune cible d'administration : y revenir par
   * le menu rouvre SA propre org, pas la dernière org inspectée en super-admin (CIN-091).
   */
  private setView(v: View): void {
    this.navigate({ ...HOME, view: v });
    // CIN-117 : changer de vue est un bon moment pour rafraîchir (on quitte ce qu'on éditait).
    this.autoRefresh();
  }

  /** Ouvre la page d'administration d'une organisation (CIN-091 b) : le hub `settings` ciblé. */
  private openOrgAdmin(orgId: string): void {
    // Arrivée explicite depuis le roster → onglet « Général », comme avant : c'est ce que dit
    // l'adresse `#/organizations/<id>` sans onglet.
    this.navigate({ ...HOME, view: "settings", adminOrgId: orgId });
  }

  /** Accepte une invitation présente dans l'URL (`?invite=token`), une seule fois. */
  private inviteHandled = false;
  private maybeAcceptInvite(): void {
    if (this.inviteHandled) return;
    this.inviteHandled = true;
    const token = new URLSearchParams(location.search).get("invite");
    if (!token) return;
    void this.store.acceptInvitation(token).then((res) => {
      // `new URL` conserve le hash : retirer le jeton de la query ne détruit pas la route
      // courante (le routeur de CIN-118 vit dans le fragment, jamais dans la query).
      const url = new URL(location.href);
      url.searchParams.delete("invite");
      history.replaceState({}, "", url.toString());
      window.setTimeout(() => {
        if (res.ok) {
          this.setView("settings");
          alert("Invitation acceptée — vous avez rejoint l'organisation.");
        } else {
          alert("Invitation : " + (res.error ?? "échec"));
        }
      }, 50);
    });
  }

  /** Kiosks visibles → filtrées → triées. */
  private currentBooths(): Booth[] {
    let list = this.store.visibleBooths();
    if (this.filter && this.filter.statuses.length > 0) {
      list = list.filter((b) => this.filter!.statuses.includes(b.health));
    }
    return sortBooths(list, this.sort);
  }

  /**
   * Entrée de menu vers une vue simple : libellé, adresse, actif et navigation d'un seul tenant.
   */
  private menuItem(key: string, view: View, iconPath: string): HTMLElement {
    return navItem(t(key), formatRoute({ ...HOME, view }), iconPath, this.highlightedView() === view, () => this.setView(view));
  }

  /**
   * Vue mise en évidence dans le menu — pas toujours `this.view`.
   *
   * Administrer un CLIENT depuis le roster ouvre techniquement la vue `settings`, et le menu
   * surlignait donc « Mon organisation » alors qu'on administre celle de quelqu'un d'autre.
   * Constat de Beranger sur CIN-084 : *« quand on clique sur une org on entre dans le menu "mon
   * org", c'est pas hyper clair »*. Il a raison, et c'est un défaut de vocabulaire, pas de goût :
   * ces deux mots ont été séparés exprès en CIN-091, le menu les reconfondait.
   *
   * L'URL tranchait déjà — `#/organizations/<id>` et non `#/settings` (CIN-118). Le menu s'aligne
   * simplement sur ce que l'adresse dit déjà.
   */
  private highlightedView(): View {
    // Même source que l'adresse (`displayedAdminOrgId`), sans quoi les deux se contredisent en
    // miroir : URL `#/organizations/<id>` d'un côté, menu surlignant « Mon organisation » de l'autre.
    return this.view === "settings" && this.displayedAdminOrgId() ? "organizations" : this.view;
  }

  // ── Barre latérale (responsive : toggler + collapse) ──────────────────────
  private sidebar(): HTMLElement {
    return el("aside", { class: "navbar navbar-vertical navbar-expand-lg", "data-bs-theme": "dark" }, [
      el("div", { class: "container-fluid" }, [
        el("button", { class: "navbar-toggler", type: "button", "data-bs-toggle": "collapse", "data-bs-target": "#sidebar-menu", "aria-label": "Menu" }, [
          el("span", { class: "navbar-toggler-icon" }, []),
        ]),
        el("h1", { class: "navbar-brand fs-2 fw-bold m-0" }, ["KIOSKOSCOPE"]),
        el("div", { class: "collapse navbar-collapse", id: "sidebar-menu" }, [
          el("ul", { class: "navbar-nav pt-lg-2 w-100" }, [
            // Ordre = groupes de sens, du parc vers l'administration (CIN-091) :
            //   PARC (Vue d'ensemble, Flotte) · CONTENU (Médias) · ACTIVITÉ (Revenus, Droits,
            //   Sessions) · TECHNIQUE (Maintenance) · ADMINISTRATION (Mon organisation,
            //   Organisations). « Flotte » suit immédiatement la vue d'ensemble : même objet
            //   — les machines — vues de loin puis de près.
            this.menuItem("nav.overview", "overview", "M4 21v-13l8 -4l8 4v13M9 21v-6h6v6"),
            this.menuItem("nav.fleet", "fleet", "M4 8l0 8M8 4l0 16M12 8l0 8M16 4l0 16M20 8l0 8"),
            this.menuItem("nav.media", "media", "M4 5h16v14H4zM4 9h16M10 13l3 2l-3 2z"),
            // Revenus (CIN-099) : MASQUÉ — pas grisé — si l'org ne facture pas au spectateur
            // (forfaitaire/festival). Un cadenas « Revenus » proposerait d'acheter une fonction
            // structurellement sans objet pour ces orgs : c'est du bruit, pas de l'upsell
            // (@design). Contraste avec « Droits », vrai module optionnel → cadenas conservé.
            ...(this.store.activeHasModule("revenue")
              ? [this.menuItem("nav.revenue", "revenue", "M12 3v18M8 7h6a2 2 0 0 1 0 4h-4a2 2 0 0 0 0 4h6")]
              : []),
            this.store.activeHasModule("rights")
              ? this.menuItem("nav.rights", "rights", "M9 5h6a2 2 0 0 1 2 2v12l-5 -3l-5 3v-12a2 2 0 0 1 2 -2z")
              : navItem(t("nav.rights"), "#", "M9 5h6a2 2 0 0 1 2 2v12l-5 -3l-5 3v-12a2 2 0 0 1 2 -2z", false, undefined, true),
            this.menuItem("nav.sessions", "sessions", "M8 4v16M16 4v16M4 8h16M4 16h16"),
            this.menuItem("nav.maintenance", "maintenance", "M12 3l1.5 3.5l3.5 1.5l-3.5 1.5l-1.5 3.5l-1.5 -3.5l-3.5 -1.5l3.5 -1.5zM6 14l.7 1.8l1.8 .7l-1.8 .7l-.7 1.8l-.7 -1.8l-1.8 -.7l1.8 -.7z"),
            this.menuItem("nav.organization", "settings", "M3 21h18M9 8h1M9 12h1M9 16h1M14 8h1M14 12h1M14 16h1M5 21V5a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16"),
            // Organisations (ex-« Flotte », CIN-084 → renommée CIN-091) : roster des CLIENTS,
            // pilotage plateforme — réservé au global_admin (un client ne voit jamais cette
            // entrée). La RLS refuse en plus toute écriture non-admin (défense en profondeur).
            ...(this.store.isGlobalAdmin
              ? [this.menuItem("nav.organizations", "organizations", "M3 21h18M5 21V7l7 -4l7 4v14M10 12h4M10 16h4M10 8h4")]
              : []),
          ]),
        ]),
      ]),
    ]);
  }

  // ── Barre du haut ─────────────────────────────────────────────────────────
  private topbar(): HTMLElement {
    const identity = this.store.current!;
    const roleLabel = this.store.isGlobalAdmin ? "global_admin" : (identity.role ?? "—");

    const roleBtn = el("button", { class: "btn dropdown-toggle", type: "button", "data-bs-toggle": "dropdown" }, [
      icon("M12 12a4 4 0 1 0 0 -8a4 4 0 0 0 0 8zM6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2", 18),
      el("span", { class: "d-none d-sm-inline" }, [`${identity.user.name || identity.user.email} · ${roleLabel}`]),
    ]);
    // Mode mock : bascule d'identité de démo. Mode supabase : déconnexion.
    const roleMenu =
      this.store.mode === "mock"
        ? el("div", { class: "dropdown-menu dropdown-menu-end" }, [
            identityOption("Admin — global_admin (tout + debug)", "user-admin", identity.user.id, (u) => this.store.switchUser(u)),
            identityOption("Camille — super_user Le Perchoir (sans debug)", "user-camille", identity.user.id, (u) => this.store.switchUser(u)),
          ])
        : el("div", { class: "dropdown-menu dropdown-menu-end" }, [
            (() => {
              const b = el("button", { class: "dropdown-item", type: "button" }, ["Se déconnecter"]);
              b.addEventListener("click", () => void this.store.signOut());
              return b;
            })(),
          ]);

    const themeIcon =
      this.themePref === "system"
        ? "M3 5h18v10H3zM8 21h8M12 17v4" // moniteur
        : this.themePref === "light"
          ? "M12 3a6 6 0 0 0 0 12a6 6 0 0 0 0 -12zM12 3v0M12 21v-3M3 12h3M18 12h3" // soleil
          : "M12 3a9 9 0 1 0 9 9c-4.97 0 -9 -4.03 -9 -9z"; // lune
    const themeLabel = this.themePref === "system" ? "système" : this.themePref === "light" ? "clair" : "sombre";
    const themeBtn = el("button", { class: "btn btn-icon", type: "button", title: `Thème : ${themeLabel} (cliquer pour changer)` }, [icon(themeIcon, 18)]);
    themeBtn.addEventListener("click", () => this.cycleTheme());

    const langBtn = el("button", { class: "btn btn-icon", type: "button", title: "Langue / Language" }, [
      el("span", { class: "fw-bold small" }, [getLang().toUpperCase()]),
    ]);
    langBtn.addEventListener("click", () => setLang(getLang() === LANGS[0] ? LANGS[1] : LANGS[0]));

    const editBtn = el("button", { class: `btn ${this.editing ? "btn-primary" : ""}`, type: "button" }, [
      icon("M4 20h4l10 -10l-4 -4l-10 10v4", 18),
      el("span", { class: "d-none d-md-inline" }, [this.editing ? t("action.editDone") : t("action.edit")]),
    ]);
    editBtn.addEventListener("click", () => this.toggleEditing());

    const addBtn = el("button", { class: "btn btn-primary", type: "button" }, [
      icon("M12 5v14M5 12h14", 18),
      el("span", { class: "d-none d-sm-inline" }, [t("action.add")]),
    ]);
    addBtn.addEventListener("click", () => openBoothForm(this.store, null));

    return el("header", { class: "navbar navbar-expand-md d-print-none" }, [
      el("div", { class: "container-xl" }, [
        el("div", { class: "navbar-nav flex-row order-md-last ms-auto align-items-center gap-2" }, [
          editBtn,
          langBtn,
          themeBtn,
          el("div", { class: "nav-item dropdown" }, [roleBtn, roleMenu]),
          addBtn,
        ]),
      ]),
    ]);
  }

  // ── Vue d'ensemble ────────────────────────────────────────────────────────
  private overview(): HTMLElement {
    const all = this.store.visibleBooths();
    const kpis = computeKpis(all);
    const booths = this.currentBooths();

    // Auto-position : Gridstack place les tuiles dans les colonnes ACTIVES (6 → 3 → 2
    // → 1 selon le breakpoint). Figer gs-x/gs-y sur 6 colonnes cassait la mise en page
    // dès que le responsive tombait à 3 colonnes (tuiles rabattues et empilées).
    const gridItems = kpis.map((k, i) =>
      el("div", { class: "grid-stack-item", "gs-id": `kpi-${i}`, "gs-w": "1", "gs-h": "1", "gs-auto-position": "true" }, [
        el("div", { class: "grid-stack-item-content" }, [
          kpiTile(k, this.isKpiActive(k), k.filter !== undefined && !this.editing, () => this.applyFilter(k)),
        ]),
      ]),
    );

    const cards = booths.map((b) => el("div", { class: "col-12 col-md-6" }, [boothCard(b, (id) => this.openDrawer(id))]));

    // CIN-044 : bascule Liste / Carte (la carte n'a plus de menu dédié).
    const segBtn = (label: string, mode: "list" | "map"): HTMLElement => {
      const b = el("button", { class: `btn ${this.overviewMode === mode ? "btn-primary" : ""}`, type: "button" }, [label]);
      // Liste et carte sont deux LIEUX (on envoie « regarde la carte »), pas deux facettes d'un
      // même écran : la bascule empile donc une entrée, et Retour ramène à l'autre mode.
      b.addEventListener("click", () => this.navigate({ ...HOME, overviewMode: mode }));
      return b;
    };
    const modeToggle = el("div", { class: "btn-group ms-auto", role: "group" }, [segBtn(t("nav.overview"), "list"), segBtn(t("nav.map"), "map")]);

    const body =
      this.overviewMode === "map"
        ? [mapPage(this.store)]
        : [
            el("div", { class: "row row-cards mt-1" }, [
              el("div", { class: "col-12 col-xl-4" }, [statusDistribution(all)]),
              el("div", { class: "col-12 col-xl-8" }, [el("div", { class: "row row-cards" }, cards)]),
            ]),
            el("div", { class: "mt-3" }, [boothTable(booths, this.sort, (k) => this.applySort(k), (id) => this.openDrawer(id))]),
          ];

    return el("div", {}, [
      el("div", { class: "d-flex align-items-center mb-3 gap-2 flex-wrap" }, [
        el("div", {}, [
          el("h2", { class: "page-title m-0" }, [t("overview.title")]),
          el("div", { class: "text-secondary" }, [
            this.store.isGlobalAdmin ? t("overview.subtitleAdmin") : t("overview.subtitle"),
            this.editing ? " · Glissez les tuiles pour réorganiser." : "",
          ]),
        ]),
        modeToggle,
      ]),
      el("div", { class: "grid-stack" }, gridItems),
      this.filterBanner(),
      ...body,
    ]);
  }

  private filterBanner(): HTMLElement {
    if (!this.filter) return el("span", {}, []);
    const clear = el("button", { class: "btn btn-sm ms-auto", type: "button" }, ["Effacer le filtre"]);
    clear.addEventListener("click", () => {
      this.filter = null;
      this.render();
    });
    return el("div", { class: `alert alert-${this.filter.color} d-flex align-items-center mt-3 mb-0` }, [
      el("span", {}, [`Vue filtrée : ${this.filter.label}`]),
      clear,
    ]);
  }

  private isKpiActive(kpi: Kpi): boolean {
    if (!this.filter || !kpi.filter || kpi.filter.length === 0) return false;
    return kpi.filter.length === this.filter.statuses.length && kpi.filter.every((s) => this.filter!.statuses.includes(s));
  }

  private applyFilter(kpi: Kpi): void {
    if (!kpi.filter) return;
    if (kpi.filter.length === 0 || this.isKpiActive(kpi)) {
      this.filter = null; // "Kiosks" ou re-clic sur le filtre actif = tout afficher
    } else {
      this.filter = { statuses: kpi.filter, label: kpi.label, color: kpi.color };
    }
    this.render();
  }

  private applySort(key: SortKey): void {
    this.sort = this.sort.key === key ? { key, dir: this.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
    this.render();
  }

  private openDrawer(id: string): void {
    openBoothDrawer(this.store, id, (b) => openBoothForm(this.store, b), (boothId, tab) => this.openBoothHub(boothId, tab));
  }

  /** Ouvre le hub de gestion d'une cabine (CIN-045), éventuellement sur un onglet précis (deep-link tiroir). */
  private openBoothHub(id: string, tab: HubTab = "synthese"): void {
    this.navigate({ ...HOME, view: "booth", boothId: id, boothTab: tab });
  }

  // ── Gridstack : montage responsive + persistance ──────────────────────────
  private mountGrid(): void {
    // Libère l'ancienne instance (et son listener resize) avant de re-monter sur le
    // nouveau DOM — sinon les instances s'accumulent à chaque navigation.
    this.grid?.destroy(false);
    const gridEl = this.root.querySelector<HTMLElement>(".grid-stack");
    if (!gridEl) {
      this.grid = undefined;
      return;
    }
    this.applySavedLayout(gridEl);
    this.grid = GridStack.init(
      {
        column: 6,
        cellHeight: 104,
        margin: 8,
        staticGrid: !this.editing,
        float: false,
        // columnMax: 6 → au-dessus du plus grand breakpoint, Gridstack plafonne à 6
        // colonnes (sans ça il retombe sur le défaut 12 → tuiles KPI écrasées > 1200px).
        columnOpts: { columnMax: 6, breakpointForWindow: true, breakpoints: [{ w: 576, c: 1 }, { w: 768, c: 2 }, { w: 1200, c: 3 }] },
      },
      gridEl,
    );
    this.grid.on("change", () => this.persistLayout());
  }

  private applySavedLayout(gridEl: HTMLElement): void {
    const saved = this.store.loadLayout();
    if (!Array.isArray(saved)) return;
    const byId = new Map<string, GridStackNode>();
    for (const nd of saved as GridStackNode[]) if (nd.id) byId.set(String(nd.id), nd);
    for (const item of Array.from(gridEl.querySelectorAll<HTMLElement>(".grid-stack-item"))) {
      const id = item.getAttribute("gs-id");
      const nd = id ? byId.get(id) : undefined;
      if (!nd) continue;
      if (nd.x !== undefined) item.setAttribute("gs-x", String(nd.x));
      if (nd.y !== undefined) item.setAttribute("gs-y", String(nd.y));
      if (nd.w !== undefined) item.setAttribute("gs-w", String(nd.w));
      if (nd.h !== undefined) item.setAttribute("gs-h", String(nd.h));
    }
  }

  private persistLayout(): void {
    if (this.grid) this.store.saveLayout(this.grid.save(false));
  }

  private toggleEditing(): void {
    this.editing = !this.editing;
    if (this.editing) this.filter = null; // pas de filtre pendant l'édition
    this.render();
  }

  // ── Thème clair/sombre ────────────────────────────────────────────────────
  /** Applique le thème effectif : « système » résout via la préférence de l'OS. */
  private applyTheme(): void {
    const effective =
      this.themePref === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : this.themePref;
    document.documentElement.setAttribute("data-bs-theme", effective);
  }
  /** Cycle système → clair → sombre → système. */
  private cycleTheme(): void {
    this.themePref = this.themePref === "system" ? "light" : this.themePref === "light" ? "dark" : "system";
    localStorage.setItem(THEME_KEY, this.themePref);
    this.applyTheme();
    this.render(); // met à jour l'icône/le libellé du bouton
  }
}

// ── Helpers de navigation ────────────────────────────────────────────────────
/**
 * Entrée de menu.
 *
 * `href` porte la VRAIE adresse (CIN-118) et non plus `#` : un clic milieu ou ⌘-clic ouvre
 * l'écran dans un nouvel onglet, et « Copier l'adresse du lien » donne quelque chose d'utile.
 * Le clic simple reste piloté à la main pour passer par `navigate()` — un seul chemin d'écriture
 * de l'historique — mais les clics modifiés sont laissés au navigateur, sans quoi on lui
 * reprendrait un comportement qu'il fait mieux que nous.
 */
function navItem(label: string, href: string, path: string, active: boolean, onClick?: () => void, locked?: boolean): HTMLElement {
  // Module non accordé (CIN-080) : item visible mais GRISÉ + cadenas (upsell), non cliquable.
  if (locked) {
    const lockPath = "M6 11V7a4 4 0 0 1 8 0v4M5 11h10a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1H5a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z";
    const link = el("a", { class: "nav-link disabled text-secondary opacity-75", href: "#", "aria-disabled": "true", title: t("nav.locked") }, [
      el("span", { class: "nav-link-icon" }, [icon(path, 20)]),
      el("span", { class: "nav-link-title" }, [label]),
      el("span", { class: "nav-link-icon ms-auto" }, [icon(lockPath, 16)]),
    ]);
    link.addEventListener("click", (e) => e.preventDefault());
    return el("li", { class: "nav-item" }, [link]);
  }
  const link = el("a", { class: `nav-link ${active ? "active" : ""}`, href }, [
    el("span", { class: "nav-link-icon" }, [icon(path, 20)]),
    el("span", { class: "nav-link-title" }, [label]),
  ]);
  if (onClick) {
    link.addEventListener("click", (e) => {
      // ⌘/Ctrl-clic, clic milieu, Maj-clic : laisser le navigateur ouvrir onglet ou fenêtre.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      onClick();
    });
  }
  return el("li", { class: "nav-item" }, [link]);
}

function identityOption(label: string, userId: string, currentUserId: string, onPick: (u: string) => void): HTMLElement {
  const a = el("button", { class: `dropdown-item ${userId === currentUserId ? "active" : ""}`, type: "button" }, [label]);
  a.addEventListener("click", () => onPick(userId));
  return a;
}
