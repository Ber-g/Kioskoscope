import type { Booth } from "../domain/types";
import type { FleetStore } from "../data/store";
import { el, icon, relativeTime } from "./dom";
import { connectionBadge, healthBadge, heartbeatBadge, sortBooths, type SortKey, type SortState } from "./components";
import { allHealthStatuses, healthMeta } from "../domain/status";
import { t } from "../i18n";

// Vue « Flotte » (CIN-091 c) — LE PARC DE MACHINES. Commune à TOUS les comptes, contenu scopé :
// un opérateur ne voit que les bornes de son organisation, le global_admin voit tout et filtre.
//
// ⚠️ Ne pas confondre avec `organizations.ts` (ex-« Flotte »), qui liste des CLIENTS. Ici : du
// matériel. Cette page répond à « où est la machine X, va-t-elle bien, sur quelle version » —
// un inventaire, pas un tableau de bord.
//
// Division du travail assumée avec la Vue d'ensemble (@design) : l'Overview donne l'état du parc
// EN UN COUP D'ŒIL (tuiles KPI, répartition, carte) ; la Flotte sert à TROUVER une machine
// précise et agir dessus (recherche, filtres, numéro de série, tri). Deux gestes différents —
// c'est pourquoi on ne réplique ici ni les KPI ni la carte. Le chiffre d'affaires reste hors de
// cet inventaire : il vit dans Revenus, qui peut être masqué (CIN-099).
//
// Le scoping N'EST PAS une garantie de sécurité : `visibleBooths()` s'appuie sur la RLS
// (mode supabase) — l'UI ne fait que présenter ce que la base a déjà autorisé.

interface FleetState {
  search: string;
  orgId: string; // "all" | id d'organisation
  health: string; // "all" | statut de santé
  sort: SortState;
}

export function fleetPage(store: FleetStore, onOpenBooth: (id: string) => void): HTMLElement {
  const booths = store.visibleBooths();
  const orgs = store.organizations();
  const orgName = (id: string): string => orgs.find((o) => o.id === id)?.name ?? "—";

  // La colonne « Organisation » n'apparaît que si le compte voit effectivement plusieurs orgs :
  // pour un client mono-org, c'est une colonne constante, donc du bruit (cf. sélecteur d'org du
  // formulaire média, même principe — on n'affiche pas un choix qui n'en est pas un).
  const spannedOrgs = new Set(booths.map((b) => b.organizationId));
  const showOrgColumn = spannedOrgs.size > 1;

  const state: FleetState = { search: "", orgId: "all", health: "all", sort: { key: "health", dir: "asc" } };
  const container = el("div", {}, []);

  const filtered = (): Booth[] => {
    const q = state.search.trim().toLowerCase();
    const list = booths.filter((b) => {
      if (state.orgId !== "all" && b.organizationId !== state.orgId) return false;
      if (state.health !== "all" && b.health !== state.health) return false;
      if (!q) return true;
      // Recherche sur ce qu'on a sous les yeux quand on cherche une machine : son nom, où elle
      // est posée, et le numéro inscrit dessus.
      return (
        b.label.toLowerCase().includes(q) ||
        b.location.toLowerCase().includes(q) ||
        (b.serial ?? "").toLowerCase().includes(q)
      );
    });
    return sortBooths(list, state.sort);
  };

  const render = (): HTMLElement => {
    const list = filtered();

    // ── Filtres ───────────────────────────────────────────────────────────────
    const search = el("input", { class: "form-control", type: "search", placeholder: "Nom, lieu ou n° de série…", value: state.search }) as HTMLInputElement;
    search.addEventListener("input", () => {
      state.search = search.value;
      container.replaceChildren(render());
      // Le re-render recrée l'input : on lui rend le focus et le curseur en fin de saisie,
      // sinon on ne peut pas taper deux caractères d'affilée.
      const next = container.querySelector<HTMLInputElement>('input[type="search"]');
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });

    const orgSelect = el("select", { class: "form-select w-auto" }, [
      el("option", { value: "all" }, ["Toutes organisations"]),
      ...orgs.filter((o) => spannedOrgs.has(o.id)).map((o) => el("option", { value: o.id }, [o.name])),
    ]) as HTMLSelectElement;
    orgSelect.value = state.orgId;
    orgSelect.addEventListener("change", () => {
      state.orgId = orgSelect.value;
      container.replaceChildren(render());
    });

    const healthSelect = el("select", { class: "form-select w-auto" }, [
      el("option", { value: "all" }, ["Tous les états"]),
      ...allHealthStatuses().map((s) => el("option", { value: s }, [healthMeta(s).label])),
    ]) as HTMLSelectElement;
    healthSelect.value = state.health;
    healthSelect.addEventListener("change", () => {
      state.health = healthSelect.value;
      container.replaceChildren(render());
    });

    const toolbar = el("div", { class: "d-flex flex-wrap gap-2 align-items-center mb-3" }, [
      el("div", { class: "flex-grow-1", style: "min-width:220px" }, [search]),
      ...(showOrgColumn ? [orgSelect] : []),
      healthSelect,
    ]);

    // ── Tableau inventaire ────────────────────────────────────────────────────
    const header = (key: SortKey, label: string): HTMLElement => {
      const active = state.sort.key === key;
      const arrow = active ? (state.sort.dir === "asc" ? " ↑" : " ↓") : "";
      const th = el("th", { class: `cursor-pointer user-select-none ${active ? "text-primary" : ""}` }, [`${label}${arrow}`]);
      th.addEventListener("click", () => {
        state.sort = state.sort.key === key ? { key, dir: state.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
        container.replaceChildren(render());
      });
      return th;
    };

    const rows = list.map((b) => {
      const tr = el("tr", { class: "cursor-pointer" }, [
        el("td", {}, [
          el("div", { class: "fw-bold" }, [b.label]),
          el("div", { class: "text-secondary small" }, [b.location]),
        ]),
        ...(showOrgColumn ? [el("td", { class: "text-secondary" }, [orgName(b.organizationId)])] : []),
        el("td", {}, [
          b.serial
            ? el("span", { class: "font-monospace small" }, [b.serial])
            : el("span", { class: "text-secondary small fst-italic" }, ["non renseigné"]),
        ]),
        el("td", {}, [healthBadge(b.health)]),
        el("td", {}, [connectionBadge(b)]),
        el("td", { class: "text-secondary" }, [b.softwareVersion]),
        el("td", {}, [
          el("div", { class: "d-flex align-items-center gap-2" }, [
            heartbeatBadge(b.lastHeartbeatAt),
            el("span", { class: "text-secondary small" }, [relativeTime(b.lastHeartbeatAt)]),
          ]),
        ]),
      ]);
      tr.addEventListener("click", () => onOpenBooth(b.id));
      return tr;
    });

    // Deux vides très différents : « aucune machine » (le compte n'a pas de parc) et « aucun
    // résultat » (les filtres sont trop stricts). Les confondre laisserait croire à une perte
    // de données — le second propose donc de relâcher les filtres.
    const emptyMessage =
      booths.length === 0
        ? "Aucune borne rattachée à votre organisation pour l'instant."
        : "Aucune borne ne correspond à ces filtres.";

    const table =
      list.length === 0
        ? el("div", { class: "card-body text-secondary text-center py-5" }, [emptyMessage])
        : el("div", { class: "table-responsive" }, [
            el("table", { class: "table table-vcenter card-table table-hover" }, [
              el("thead", {}, [
                el("tr", {}, [
                  header("label", t("table.booth")),
                  ...(showOrgColumn ? [el("th", {}, ["Organisation"])] : []),
                  el("th", {}, ["N° de série"]),
                  header("health", t("table.health")),
                  header("connection", t("table.connection")),
                  header("version", t("table.version")),
                  header("heartbeat", t("table.seen")),
                ]),
              ]),
              el("tbody", {}, rows),
            ]),
          ]);

    const counter =
      list.length === booths.length
        ? `${booths.length} borne${booths.length > 1 ? "s" : ""}`
        : `${list.length} borne${list.length > 1 ? "s" : ""} sur ${booths.length}`;

    return el("div", {}, [
      el("div", { class: "mb-3" }, [
        el("h2", { class: "page-title m-0 d-flex align-items-center gap-2" }, [
          icon("M4 8l0 8M8 4l0 16M12 8l0 8M16 4l0 16M20 8l0 8", 22),
          "Flotte",
        ]),
        el("div", { class: "text-secondary" }, [
          store.isGlobalAdmin
            ? `Parc complet, toutes organisations · ${counter}.`
            : `Les bornes de votre organisation · ${counter}.`,
        ]),
      ]),
      toolbar,
      el("div", { class: "card" }, [table]),
    ]);
  };

  container.replaceChildren(render());
  return container;
}
