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
import { settingsPage } from "./settings";
import { boothHubPage, type HubTab } from "./boothHub";
import { mapPage, mountFleetMap } from "./mapView";
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
  private view: "overview" | "media" | "revenue" | "rights" | "sessions" | "maintenance" | "settings" | "booth" = "overview";
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
  }

  /** Point d'entrée : lance le chargement (async) puis rend. */
  start(): void {
    this.render();
    void this.store.init();
  }

  render(): void {
    // Mode Supabase : connexion requise, ou chargement en cours.
    if (this.store.needsAuth) {
      this.root.replaceChildren(loginScreen(this.store));
      return;
    }
    if (!this.store.current) {
      this.root.replaceChildren(el("div", { class: "page page-center" }, [el("div", { class: "text-secondary p-5" }, ["Chargement…"])]));
      return;
    }
    this.maybeAcceptInvite();
    const page =
      this.view === "media"
        ? mediaPage(this.store, () => this.render())
        : this.view === "revenue"
          ? revenuePage(this.store, (id) => this.openDrawer(id))
          : this.view === "rights"
            ? (this.store.activeHasModule("rights") ? rightsPage(this.store, () => this.render(), (id) => this.openDrawer(id)) : this.overview())
            : this.view === "sessions"
              ? sessionsPage(this.store, (id) => this.openDrawer(id))
              : this.view === "maintenance"
                ? maintenancePage(this.store, () => this.render(), (id) => this.openDrawer(id))
                : this.view === "settings"
                  ? settingsPage(this.store, () => this.render())
                  : this.view === "booth" && this.selectedBoothId
                    ? boothHubPage(this.store, this.selectedBoothId, () => this.setView("overview"), () => this.render(), this.boothTab, (tab) => { this.boothTab = tab; }, () => this.setView("media"))
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

  private setView(v: "overview" | "media" | "revenue" | "rights" | "sessions" | "maintenance" | "settings"): void {
    this.view = v;
    this.render();
  }

  /** Accepte une invitation présente dans l'URL (`?invite=token`), une seule fois. */
  private inviteHandled = false;
  private maybeAcceptInvite(): void {
    if (this.inviteHandled) return;
    this.inviteHandled = true;
    const token = new URLSearchParams(location.search).get("invite");
    if (!token) return;
    void this.store.acceptInvitation(token).then((res) => {
      const url = new URL(location.href);
      url.searchParams.delete("invite");
      history.replaceState({}, "", url.toString());
      window.setTimeout(() => {
        if (res.ok) {
          this.view = "settings";
          this.render();
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
            navItem(t("nav.overview"), "M4 21v-13l8 -4l8 4v13M9 21v-6h6v6", this.view === "overview", () => this.setView("overview")),
            navItem(t("nav.media"), "M4 5h16v14H4zM4 9h16M10 13l3 2l-3 2z", this.view === "media", () => this.setView("media")),
            navItem(t("nav.revenue"), "M12 3v18M8 7h6a2 2 0 0 1 0 4h-4a2 2 0 0 0 0 4h6", this.view === "revenue", () => this.setView("revenue")),
            this.store.activeHasModule("rights")
              ? navItem(t("nav.rights"), "M9 5h6a2 2 0 0 1 2 2v12l-5 -3l-5 3v-12a2 2 0 0 1 2 -2z", this.view === "rights", () => this.setView("rights"))
              : navItem(t("nav.rights"), "M9 5h6a2 2 0 0 1 2 2v12l-5 -3l-5 3v-12a2 2 0 0 1 2 -2z", false, undefined, true),
            navItem(t("nav.sessions"), "M8 4v16M16 4v16M4 8h16M4 16h16", this.view === "sessions", () => this.setView("sessions")),
            navItem(t("nav.maintenance"), "M12 3l1.5 3.5l3.5 1.5l-3.5 1.5l-1.5 3.5l-1.5 -3.5l-3.5 -1.5l3.5 -1.5zM6 14l.7 1.8l1.8 .7l-1.8 .7l-.7 1.8l-.7 -1.8l-1.8 -.7l1.8 -.7z", this.view === "maintenance", () => this.setView("maintenance")),
            navItem(t("nav.organization"), "M3 21h18M9 8h1M9 12h1M9 16h1M14 8h1M14 12h1M14 16h1M5 21V5a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16", this.view === "settings", () => this.setView("settings")),
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
      b.addEventListener("click", () => {
        this.overviewMode = mode;
        this.render();
      });
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
    this.selectedBoothId = id;
    this.boothTab = tab;
    this.view = "booth";
    this.render();
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
function navItem(label: string, path: string, active: boolean, onClick?: () => void, locked?: boolean): HTMLElement {
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
  const link = el("a", { class: `nav-link ${active ? "active" : ""}`, href: "#" }, [
    el("span", { class: "nav-link-icon" }, [icon(path, 20)]),
    el("span", { class: "nav-link-title" }, [label]),
  ]);
  if (onClick) {
    link.addEventListener("click", (e) => {
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
