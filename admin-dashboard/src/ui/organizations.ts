import { Modal } from "bootstrap";
import type { Booth, HealthStatus } from "../domain/types";
import type { FleetStore } from "../data/store";
import { el, icon } from "./dom";
import { boothLabelEl } from "./components";
import { allHealthStatuses, healthMeta } from "../domain/status";
import { MODULES, SUBSCRIPTION_TYPES } from "../domain/modules";
import { forgetOrgStyleUi } from "./orgStyleSettings";

// Vue « Organisations » (CIN-084, renommée CIN-091) — pilotage PLATEFORME, réservé au
// global_admin. Roster par ORGANISATION (filtrable) + actions par lot : souscription/modules
// et réinitialisation au style maître.
//
// ⚠️ Cette vue s'appelait « Flotte » jusqu'à CIN-091 : elle listait des ORGANISATIONS sous un
// nom qui désigne des MACHINES. Le mot « Flotte » est désormais réservé au parc de bornes
// (`fleet.ts`), commun à tous les comptes et scopé. Ici, on gère des clients, pas du matériel.
//
// Chaque organisation est cliquable → sa page d'administration (le hub `settings.ts` ouvert sur
// cette org) ; les cabines restent cliquables → hub cabine. Toutes les écritures sont imposées
// global_admin-only par la RLS.

type StyleFilter = "all" | "master" | "custom";

interface FleetState {
  search: string;
  subscription: string; // "all" | clé de souscription
  style: StyleFilter;
  selected: Set<string>;
}

/** Libellé lisible d'une souscription (repli = la clé brute). */
function subscriptionLabel(key: string | undefined): string {
  return SUBSCRIPTION_TYPES.find((s) => s.key === key)?.label ?? key ?? "—";
}

/** Résumé compact de l'état des cabines d'une org : un pastille colorée + compte par statut. */
function statusSummary(booths: readonly Booth[]): HTMLElement {
  if (booths.length === 0) return el("span", { class: "text-secondary small" }, ["Aucune cabine"]);
  const counts = new Map<HealthStatus, number>();
  for (const b of booths) counts.set(b.health, (counts.get(b.health) ?? 0) + 1);
  const chips = allHealthStatuses()
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => {
      const m = healthMeta(s);
      return el("span", { class: `badge bg-${m.color}-lt d-inline-flex align-items-center gap-1`, title: m.label }, [
        icon(m.iconPath, 14),
        el("span", {}, [String(counts.get(s) ?? 0)]),
      ]);
    });
  return el("span", { class: "d-inline-flex flex-wrap gap-1" }, chips);
}

/** Badge modules accordés : « Tous » si pas d'entitlement (défaut ouvert), sinon les libellés. */
function modulesCell(store: FleetStore, orgId: string): HTMLElement {
  const ent = store.entitlementFor(orgId);
  if (!ent) return el("span", { class: "badge bg-green-lt" }, ["Tous"]);
  if (ent.enabledModules.length === 0) return el("span", { class: "badge bg-secondary-lt" }, ["Aucun"]);
  const labels = ent.enabledModules.map((k) => MODULES.find((m) => m.key === k)?.label ?? k);
  return el("span", { class: "d-inline-flex flex-wrap gap-1" }, labels.map((l) => el("span", { class: "badge bg-blue-lt" }, [l])));
}

export function organizationsPage(
  store: FleetStore,
  onOpenBooth: (id: string) => void,
  onOpenOrg: (id: string) => void,
): HTMLElement {
  // Garde-fou de défense en profondeur : la vue n'existe que pour le global_admin (la nav la cache
  // déjà, la RLS refuse déjà les écritures — c'est la 3ᵉ ligne, jamais la seule).
  if (!store.isGlobalAdmin) {
    return el("div", { class: "alert alert-danger" }, ["Réservé à l'administration plateforme."]);
  }

  const orgs = store.organizations();
  const booths = store.visibleBooths();
  const boothsByOrg = new Map<string, Booth[]>();
  for (const b of booths) {
    const list = boothsByOrg.get(b.organizationId) ?? [];
    list.push(b);
    boothsByOrg.set(b.organizationId, list);
  }

  const state: FleetState = { search: "", subscription: "all", style: "all", selected: new Set() };
  const container = el("div", {}, []);

  const isCustom = (orgId: string): boolean => store.orgStyleFor(orgId) !== null;

  const filtered = (): typeof orgs => {
    const q = state.search.trim().toLowerCase();
    return orgs.filter((o) => {
      if (q && !o.name.toLowerCase().includes(q)) return false;
      if (state.subscription !== "all" && (store.entitlementFor(o.id)?.subscriptionType ?? "demo") !== state.subscription) return false;
      if (state.style === "master" && isCustom(o.id)) return false;
      if (state.style === "custom" && !isCustom(o.id)) return false;
      return true;
    });
  };

  const render = (): HTMLElement => {
    const list = filtered();
    // La sélection ne porte que sur les orgs visibles (filtrées).
    const visibleIds = new Set(list.map((o) => o.id));
    for (const id of [...state.selected]) if (!visibleIds.has(id)) state.selected.delete(id);

    // ── Barre de filtres ──────────────────────────────────────────────────────
    const search = el("input", { class: "form-control", type: "search", placeholder: "Rechercher une organisation…", value: state.search }) as HTMLInputElement;
    search.addEventListener("input", () => {
      state.search = search.value;
      container.replaceChildren(render());
      // Rendre le focus après re-render (la saisie recrée l'input).
      const next = container.querySelector<HTMLInputElement>('input[type="search"]');
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
    });

    const subSelect = el("select", { class: "form-select w-auto" }, [
      el("option", { value: "all" }, ["Toutes souscriptions"]),
      ...SUBSCRIPTION_TYPES.map((s) => el("option", { value: s.key }, [s.label])),
    ]) as HTMLSelectElement;
    subSelect.value = state.subscription;
    subSelect.addEventListener("change", () => { state.subscription = subSelect.value; container.replaceChildren(render()); });

    const styleSelect = el("select", { class: "form-select w-auto" }, [
      el("option", { value: "all" }, ["Tous styles"]),
      el("option", { value: "master" }, ["Style maître"]),
      el("option", { value: "custom" }, ["Personnalisé"]),
    ]) as HTMLSelectElement;
    styleSelect.value = state.style;
    styleSelect.addEventListener("change", () => { state.style = styleSelect.value as StyleFilter; container.replaceChildren(render()); });

    const toolbar = el("div", { class: "d-flex flex-wrap gap-2 align-items-center mb-3" }, [
      el("div", { class: "flex-grow-1", style: "min-width:220px" }, [search]),
      subSelect,
      styleSelect,
    ]);

    // ── Barre d'actions par lot (si sélection) ────────────────────────────────
    const selectedOrgs = list.filter((o) => state.selected.has(o.id));
    const batchBar =
      selectedOrgs.length === 0
        ? el("span", {}, [])
        : (() => {
            const subBtn = el("button", { class: "btn btn-primary", type: "button" }, [icon("M9 5h6a2 2 0 0 1 2 2v12l-5 -3l-5 3v-12a2 2 0 0 1 2 -2z", 18), "Souscription & modules"]);
            subBtn.addEventListener("click", () => openSubscriptionModal(store, selectedOrgs.map((o) => o.id), selectedOrgs.map((o) => o.name)));
            const resetBtn = el("button", { class: "btn btn-outline-danger", type: "button" }, [icon("M20 11a8.1 8.1 0 0 0 -15.5 -2M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4", 18), "Réinitialiser au style maître"]);
            resetBtn.addEventListener("click", () => runReset(store, selectedOrgs.map((o) => o.id), selectedOrgs.map((o) => o.name)));
            const clear = el("button", { class: "btn btn-link", type: "button" }, ["Tout désélectionner"]);
            clear.addEventListener("click", () => { state.selected.clear(); container.replaceChildren(render()); });
            return el("div", { class: "card bg-primary-lt mb-3" }, [
              el("div", { class: "card-body d-flex flex-wrap align-items-center gap-2 py-2" }, [
                el("strong", {}, [`${selectedOrgs.length} organisation${selectedOrgs.length > 1 ? "s" : ""} sélectionnée${selectedOrgs.length > 1 ? "s" : ""}`]),
                el("div", { class: "ms-auto d-flex flex-wrap gap-2" }, [subBtn, resetBtn, clear]),
              ]),
            ]);
          })();

    // ── Tableau roster ────────────────────────────────────────────────────────
    const selectAll = el("input", { class: "form-check-input m-0", type: "checkbox", "aria-label": "Tout sélectionner" }) as HTMLInputElement;
    selectAll.checked = list.length > 0 && list.every((o) => state.selected.has(o.id));
    selectAll.addEventListener("change", () => {
      if (selectAll.checked) for (const o of list) state.selected.add(o.id);
      else for (const o of list) state.selected.delete(o.id);
      container.replaceChildren(render());
    });

    const rows = list.map((o) => {
      const orgBooths = boothsByOrg.get(o.id) ?? [];
      const check = el("input", { class: "form-check-input m-0", type: "checkbox", "aria-label": `Sélectionner ${o.name}` }) as HTMLInputElement;
      check.checked = state.selected.has(o.id);
      check.addEventListener("change", () => {
        if (check.checked) state.selected.add(o.id);
        else state.selected.delete(o.id);
        container.replaceChildren(render());
      });
      const boothChips = orgBooths.length
        ? el("div", { class: "d-inline-flex flex-wrap gap-2" }, orgBooths.map((b) => boothLabelEl(b.label, () => onOpenBooth(b.id))))
        : el("span", { class: "text-secondary small" }, ["—"]);
      const styleBadge = isCustom(o.id)
        ? el("span", { class: "badge bg-azure-lt" }, ["Personnalisé"])
        : el("span", { class: "badge bg-secondary-lt" }, ["Maître"]);
      // Le nom ouvre la page d'administration de l'org (CIN-091 b). Un <button> plutôt qu'un
      // <a href="#"> : c'est une action applicative, pas une navigation documentaire — donc
      // focusable et activable au clavier sans piéger l'historique.
      const nameBtn = el("button", { class: "btn btn-link p-0 fw-bold text-start", type: "button", title: `Administrer ${o.name}` }, [o.name]);
      nameBtn.addEventListener("click", () => onOpenOrg(o.id));
      return el("tr", {}, [
        el("td", {}, [check]),
        el("td", {}, [
          nameBtn,
          el("div", { class: "text-secondary small" }, [o.type]),
        ]),
        el("td", {}, [el("span", { class: "badge bg-purple-lt" }, [subscriptionLabel(store.entitlementFor(o.id)?.subscriptionType)])]),
        el("td", {}, [modulesCell(store, o.id)]),
        el("td", {}, [styleBadge]),
        el("td", {}, [
          el("div", { class: "d-flex flex-column gap-1" }, [statusSummary(orgBooths), boothChips]),
        ]),
      ]);
    });

    const table =
      list.length === 0
        ? el("div", { class: "card-body text-secondary text-center py-5" }, ["Aucune organisation ne correspond aux filtres."])
        : el("div", { class: "table-responsive" }, [
            el("table", { class: "table table-vcenter card-table" }, [
              el("thead", {}, [
                el("tr", {}, [
                  el("th", { class: "w-1" }, [selectAll]),
                  el("th", {}, ["Organisation"]),
                  el("th", {}, ["Souscription"]),
                  el("th", {}, ["Modules"]),
                  el("th", {}, ["Style"]),
                  el("th", {}, ["Cabines"]),
                ]),
              ]),
              el("tbody", {}, rows),
            ]),
          ]);

    return el("div", {}, [
      el("div", { class: "mb-3" }, [
        el("h2", { class: "page-title m-0" }, ["Organisations"]),
        el("div", { class: "text-secondary" }, [`Pilotage multi-organisations (super-admin) · ${orgs.length} organisation${orgs.length > 1 ? "s" : ""}, ${booths.length} cabine${booths.length > 1 ? "s" : ""}. Cliquez une organisation pour l'administrer.`]),
      ]),
      toolbar,
      batchBar,
      el("div", { class: "card" }, [table]),
    ]);
  };

  container.replaceChildren(render());
  return container;
}

// ── Action par lot : souscription & modules (modal) ──────────────────────────
function openSubscriptionModal(store: FleetStore, orgIds: readonly string[], orgNames: readonly string[]): void {
  const subSelect = el("select", { class: "form-select" }, SUBSCRIPTION_TYPES.map((s) => el("option", { value: s.key }, [s.label]))) as HTMLSelectElement;
  subSelect.value = SUBSCRIPTION_TYPES[0]?.key ?? "demo";

  // Une case par module (toutes cochées par défaut = tout accordé).
  const moduleChecks = MODULES.map((m) => {
    const input = el("input", { class: "form-check-input", type: "checkbox" }) as HTMLInputElement;
    input.checked = true;
    const label = el("label", { class: "form-check" }, [input, el("span", { class: "form-check-label" }, [m.label])]);
    return { key: m.key, input, label };
  });

  const error = el("div", { class: "alert alert-danger d-none" }, []);
  const result = el("div", { class: "d-none" }, []);
  const apply = el("button", { class: "btn btn-primary ms-auto", type: "button" }, [`Appliquer à ${orgIds.length} organisation${orgIds.length > 1 ? "s" : ""}`]);

  apply.addEventListener("click", () => {
    error.classList.add("d-none");
    apply.setAttribute("disabled", "true");
    const enabledModules = moduleChecks.filter((c) => c.input.checked).map((c) => c.key);
    void store.saveEntitlementsBatch(orgIds, { subscriptionType: subSelect.value, enabledModules }).then((res) => {
      apply.removeAttribute("disabled");
      if (!res.ok) {
        error.textContent = res.error ?? "Échec de l'application.";
        error.classList.remove("d-none");
        return;
      }
      result.replaceChildren(el("div", { class: "alert alert-success mb-0" }, [`✓ ${res.updated} organisation${res.updated > 1 ? "s" : ""} mise${res.updated > 1 ? "s" : ""} à jour.`]));
      result.classList.remove("d-none");
      apply.classList.add("d-none");
    });
  });

  const modalEl = el("div", { class: "modal modal-blur fade", tabindex: "-1" }, [
    el("div", { class: "modal-dialog modal-dialog-centered" }, [
      el("div", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [el("h3", { class: "modal-title" }, ["Souscription & modules"]), el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" }, [])]),
        el("div", { class: "modal-body" }, [
          error,
          el("p", { class: "text-secondary" }, [`Ces réglages REMPLACENT la souscription et les modules de : ${orgNames.join(", ")}.`]),
          el("div", { class: "mb-3" }, [el("label", { class: "form-label" }, ["Souscription"]), subSelect]),
          el("div", { class: "mb-2" }, [el("label", { class: "form-label" }, ["Modules accordés"]), ...moduleChecks.map((c) => c.label)]),
          result,
        ]),
        el("div", { class: "modal-footer" }, [el("button", { class: "btn", type: "button", "data-bs-dismiss": "modal" }, ["Fermer"]), apply]),
      ]),
    ]),
  ]);
  document.body.append(modalEl);
  const modal = new Modal(modalEl);
  modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
  modal.show();
}

// ── Action par lot : réinitialiser au style maître (destructive) ─────────────
function runReset(store: FleetStore, orgIds: readonly string[], orgNames: readonly string[]): void {
  const n = orgIds.length;
  if (!confirm(`Réinitialiser ${n} organisation${n > 1 ? "s" : ""} au style maître Kioskoscope ?\n\n${orgNames.join(", ")}\n\nLeurs couleurs, fontes, titres et logos personnalisés seront supprimés — leurs cabines reviendront au visuel par défaut. Action irréversible.`)) return;
  // AVANT l'appel, et non après : un brouillon laissé sur une org réinitialisée par lot
  // ressusciterait à la réouverture de son onglet « Mes styles » et ré-appliquerait les couleurs
  // que ce geste vient d'effacer — même bug que la réinitialisation unitaire, autre porte.
  forgetOrgStyleUi(orgIds);
  void store.resetOrgStylesBatch(orgIds).then((res) => {
    // Le store a déjà rechargé + réémis (la page s'est reconstruite, badges → « Maître »).
    // On confirme donc via une alerte, indépendante du DOM détaché.
    if (!res.ok) alert("Échec de la réinitialisation : " + (res.error ?? "erreur inconnue"));
    else alert(`${n} organisation${n > 1 ? "s" : ""} réinitialisée${n > 1 ? "s" : ""} au style maître.`);
  });
}
