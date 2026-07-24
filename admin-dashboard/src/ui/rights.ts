import { Modal } from "bootstrap";
import type { FleetStore, RightsReport, RightsRow, RoyaltyModel } from "../data/store";
import { el, formatMoney, icon } from "./dom";
import { boothLabelEl } from "./components";
import { t } from "../i18n";

// Menu Droits & redevances (F9) : journal de vision (`plays`) confronté aux licences.
// Par film : distributeur, séances utilisées / plafond (org-wide ou par Kiosk), redevance
// estimée, statut. Édition de licence (dont plafond PAR MACHINE). CRUD distributeurs.
// L'application du plafond côté borne est différée (booth non connecté) — ici c'est le suivi.

const MODEL_LABELS: Record<RoyaltyModel, string> = {
  free: "Gratuit",
  per_screening: "Par séance",
  revenue_share: "% des revenus",
  flat: "Forfait",
};

const STATUS: Record<RightsRow["status"], { label: string; cls: string }> = {
  ok: { label: "Dans les droits", cls: "bg-green-lt" },
  no_license: { label: "Sans licence", cls: "bg-secondary-lt" },
  expired: { label: "Expiré", cls: "bg-red-lt" },
  over_cap: { label: "Au plafond", cls: "bg-red-lt" },
};

function kpiTile(label: string, value: string, hue: string, iconPath: string): HTMLElement {
  return el("div", { class: "col-sm-6 col-xl-4" }, [
    el("div", { class: "card card-sm" }, [
      el("div", { class: "card-body" }, [
        el("div", { class: "row align-items-center" }, [
          el("div", { class: "col-auto" }, [el("span", { class: `bg-${hue}-lt text-${hue} avatar` }, [icon(iconPath, 22)])]),
          el("div", { class: "col" }, [el("div", { class: "fs-2 fw-bold lh-1" }, [value]), el("div", { class: "text-secondary" }, [label])]),
        ]),
      ]),
    ]),
  ]);
}

export function rightsPage(store: FleetStore, onChanged: () => void, onOpenBooth?: (id: string) => void): HTMLElement {
  const container = el("div", {}, [el("div", { class: "text-secondary p-3" }, ["Chargement des droits…"])]);
  const reload = (): void => void store.rightsReport().then((rep) => container.replaceChildren(render(store, rep, () => { reload(); onChanged(); }, onOpenBooth)));
  reload();
  return container;
}

function render(store: FleetStore, rep: RightsReport, reload: () => void, onOpenBooth?: (id: string) => void): HTMLElement {
  const cur = rep.currency;
  const filmRows = rep.rows.map((r) => {
    const st = STATUS[r.status];
    const capText = r.maxScreenings != null ? `${r.screeningsUsed} / ${r.maxScreenings}` : r.capScope === "per_booth" ? `${r.screeningsUsed} (par Kiosk)` : `${r.screeningsUsed} / ∞`;
    const gauge = r.maxScreenings != null
      ? el("div", { class: "progress progress-sm mt-1" }, [el("div", { class: `progress-bar ${r.status === "over_cap" ? "bg-red" : ""}`, style: `width:${Math.min(100, Math.round((r.screeningsUsed / Math.max(1, r.maxScreenings)) * 100))}%`, role: "progressbar" }, [])])
      : el("span", {}, []);
    // Détail par Kiosk (si scope par machine ou plusieurs Kiosks).
    const perBooth = r.perBooth.length > 0 && (r.capScope === "per_booth" || r.perBooth.length > 1)
      ? el("div", { class: "text-secondary small mt-1" }, r.perBooth.map((pb) => el("div", {}, [
          boothLabelEl(pb.boothLabel, onOpenBooth ? () => onOpenBooth(pb.boothId) : undefined),
          ` : ${pb.used}${pb.cap != null ? ` / ${pb.cap}` : ""}`,
        ])))
      : el("span", {}, []);

    const editBtn = el("button", { class: "btn btn-sm", type: "button" }, ["Licence"]);
    editBtn.addEventListener("click", () => openLicenseModal(store, r.mediaId, r.title, reload));

    return el("tr", {}, [
      el("td", { class: "fw-bold" }, [r.title]),
      el("td", { class: "text-secondary" }, [r.distributorName ?? "—"]),
      el("td", {}, [r.royaltyModel ? el("span", { class: "badge bg-secondary-lt" }, [MODEL_LABELS[r.royaltyModel]]) : el("span", { class: "text-secondary" }, ["—"])]),
      el("td", { style: "min-width:160px" }, [el("div", {}, [capText]), gauge, perBooth]),
      el("td", { class: "text-end text-nowrap" }, [formatMoney(r.royaltyOwedCents, cur)]),
      el("td", {}, [el("span", { class: `badge ${st.cls}` }, [st.label])]),
      el("td", { class: "text-end" }, [editBtn]),
    ]);
  });

  return el("div", {}, [
    el("div", { class: "mb-3" }, [
      el("h2", { class: "page-title m-0" }, [t("page.rights")]),
      el("div", { class: "text-secondary" }, ["Journal de vision (séances) confronté aux licences. L'application du plafond côté borne viendra quand les Kiosks seront connectés."]),
    ]),
    el("div", { class: "row row-cards g-2 mb-3" }, [
      kpiTile("Redevances estimées", formatMoney(rep.totalOwedCents, cur), "teal", "M12 3v18M8 7h6a2 2 0 0 1 0 4h-4a2 2 0 0 0 0 4h6"),
      kpiTile("Films au plafond", String(rep.overCapCount), "red", "M12 9v4M12 16v.01M12 3l9 16H3z"),
      kpiTile("Films sans licence", String(rep.noLicenseCount), "yellow", "M12 9v4M12 16v.01M12 3l9 16H3z"),
    ]),
    distributorsCard(store, reload),
    el("div", { class: "card" }, [
      el("div", { class: "card-header" }, [el("h3", { class: "card-title m-0" }, ["Droits par film"])]),
      el("div", { class: "table-responsive" }, [
        el("table", { class: "table table-vcenter card-table" }, [
          el("thead", {}, [el("tr", {}, [el("th", {}, ["Film"]), el("th", {}, ["Distributeur"]), el("th", {}, ["Modèle"]), el("th", {}, ["Séances / plafond"]), el("th", { class: "text-end" }, ["Redevance est."]), el("th", {}, ["Statut"]), el("th", {}, [])])]),
          el("tbody", {}, filmRows.length ? filmRows : [el("tr", {}, [el("td", { colspan: "7", class: "text-secondary text-center py-4" }, ["Aucun média."])])]),
        ]),
      ]),
    ]),
  ]);
}

// ── Distributeurs (CRUD compact) ──────────────────────────────────────────────
function distributorsCard(store: FleetStore, reload: () => void): HTMLElement {
  const orgId = store.current?.activeOrganizationId ?? store.organizations()[0]?.id ?? "";
  const dists = store.distributorsList();
  const rows = dists.map((d) => {
    const edit = el("button", { class: "btn btn-sm", type: "button" }, ["Modifier"]);
    edit.addEventListener("click", () => openDistributorModal(store, orgId, d, reload));
    const del = el("button", { class: "btn btn-sm btn-outline-danger ms-1", type: "button" }, ["Suppr."]);
    del.addEventListener("click", () => {
      if (!confirm(`Supprimer le distributeur « ${d.name} » ?`)) return;
      void store.deleteDistributor(d.id).then((res) => (res.ok ? reload() : alert(res.error ?? "Échec.")));
    });
    return el("tr", {}, [el("td", { class: "fw-bold" }, [d.name]), el("td", { class: "text-secondary" }, [d.territory || "—"]), el("td", { class: "text-secondary" }, [d.contactEmail || "—"]), el("td", { class: "text-end" }, [edit, del])]);
  });
  const add = el("button", { class: "btn", type: "button" }, ["Ajouter un distributeur"]);
  add.addEventListener("click", () => openDistributorModal(store, orgId, null, reload));
  return el("div", { class: "card mb-3" }, [
    el("div", { class: "card-header d-flex align-items-center" }, [el("h3", { class: "card-title m-0" }, ["Distributeurs"]), el("div", { class: "ms-auto" }, [add])]),
    el("div", { class: "table-responsive" }, [
      el("table", { class: "table table-vcenter card-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", {}, ["Nom"]), el("th", {}, ["Territoire"]), el("th", {}, ["Contact"]), el("th", {}, [])])]),
        el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: "4", class: "text-secondary text-center py-3" }, ["Aucun distributeur."])])]),
      ]),
    ]),
  ]);
}

function openDistributorModal(store: FleetStore, orgId: string, existing: ReturnType<FleetStore["distributorsList"]>[number] | null, onDone: () => void): void {
  const name = el("input", { class: "form-control", type: "text", value: existing?.name ?? "" }) as HTMLInputElement;
  const territory = el("input", { class: "form-control", type: "text", value: existing?.territory ?? "", placeholder: "France, Benelux…" }) as HTMLInputElement;
  const contact = el("input", { class: "form-control", type: "email", value: existing?.contactEmail ?? "" }) as HTMLInputElement;
  const error = el("div", { class: "alert alert-danger d-none" }, []);
  const save = el("button", { class: "btn btn-primary ms-auto", type: "button" }, ["Enregistrer"]);
  save.addEventListener("click", () => {
    if (!name.value.trim()) return;
    save.setAttribute("disabled", "true");
    void store.saveDistributor(orgId, { ...(existing ? { id: existing.id } : {}), name: name.value.trim(), territory: territory.value.trim(), contactEmail: contact.value.trim() }).then((res) => {
      if (res.ok) { modal.hide(); onDone(); }
      else { save.removeAttribute("disabled"); error.textContent = res.error ?? "Échec."; error.classList.remove("d-none"); }
    });
  });
  const field = (l: string, i: HTMLElement): HTMLElement => el("div", { class: "mb-3" }, [el("label", { class: "form-label" }, [l]), i]);
  const modal = buildModal("Distributeur", [error, field("Nom", name), field("Territoire", territory), field("E-mail de contact", contact)], save);
}

// ── Licence d'un film (dont plafond par machine) ──────────────────────────────
function openLicenseModal(store: FleetStore, mediaId: string, title: string, onDone: () => void): void {
  const orgId = store.current?.activeOrganizationId ?? store.organizations()[0]?.id ?? "";
  const existing = store.mediaLicenseFor(mediaId);
  const currentLb = existing ? store.licenseBoothsFor(existing.id) : [];
  const dists = store.distributorsList();
  const booths = store.visibleBooths();

  const distSel = el("select", { class: "form-select" }, [el("option", { value: "" }, ["— aucun —"]), ...dists.map((d) => el("option", { value: d.id, ...(existing?.distributorId === d.id ? { selected: "selected" } : {}) }, [d.name]))]) as HTMLSelectElement;
  const model = el("select", { class: "form-select" }, (["free", "per_screening", "revenue_share", "flat"] as RoyaltyModel[]).map((m) => el("option", { value: m, ...(existing?.royaltyModel === m ? { selected: "selected" } : {}) }, [MODEL_LABELS[m]]))) as HTMLSelectElement;
  const royalty = el("input", { class: "form-control", type: "number", min: "0", value: String((existing?.royaltyCents ?? 0) / 100), placeholder: "€ / séance" }) as HTMLInputElement;
  const sharePct = el("input", { class: "form-control", type: "number", min: "0", max: "100", value: String(existing?.revenueSharePct ?? 0) }) as HTMLInputElement;
  const mg = el("input", { class: "form-control", type: "number", min: "0", value: existing?.minimumGuaranteeCents != null ? String(existing.minimumGuaranteeCents / 100) : "" }) as HTMLInputElement;
  const maxScr = el("input", { class: "form-control", type: "number", min: "0", value: existing?.maxScreenings != null ? String(existing.maxScreenings) : "", placeholder: "illimité si vide" }) as HTMLInputElement;
  const from = el("input", { class: "form-control", type: "date", value: existing?.validFrom ?? "" }) as HTMLInputElement;
  const to = el("input", { class: "form-control", type: "date", value: existing?.validTo ?? "" }) as HTMLInputElement;

  // Plafond par machine (optionnel) : cocher une Kiosk + cap facultatif.
  const perBoothToggle = el("input", { class: "form-check-input", type: "checkbox", ...(currentLb.length > 0 ? { checked: "checked" } : {}) }) as HTMLInputElement;
  const boothInputs = new Map<string, { on: HTMLInputElement; cap: HTMLInputElement }>();
  const boothList = el("div", { class: `list-group ${currentLb.length > 0 ? "" : "d-none"}` }, booths.map((b) => {
    const lb = currentLb.find((x) => x.boothId === b.id);
    const on = el("input", { class: "form-check-input", type: "checkbox", ...(lb ? { checked: "checked" } : {}) }) as HTMLInputElement;
    const cap = el("input", { class: "form-control form-control-sm w-auto ms-auto", type: "number", min: "0", value: lb?.maxScreenings != null ? String(lb.maxScreenings) : "", placeholder: "cap" }) as HTMLInputElement;
    boothInputs.set(b.id, { on, cap });
    return el("label", { class: "list-group-item d-flex align-items-center gap-2" }, [on, el("span", {}, [b.label]), cap]);
  }));
  perBoothToggle.addEventListener("change", () => boothList.classList.toggle("d-none", !perBoothToggle.checked));

  const error = el("div", { class: "alert alert-danger d-none" }, []);
  const save = el("button", { class: "btn btn-primary ms-auto", type: "button" }, ["Enregistrer la licence"]);
  save.addEventListener("click", () => {
    save.setAttribute("disabled", "true");
    const lic = {
      ...(existing ? { id: existing.id } : {}), mediaId, distributorId: distSel.value || null, royaltyModel: model.value as RoyaltyModel,
      royaltyCents: Math.round(Number(royalty.value || 0) * 100), revenueSharePct: Number(sharePct.value || 0),
      minimumGuaranteeCents: mg.value ? Math.round(Number(mg.value) * 100) : null,
      maxScreenings: maxScr.value ? Math.round(Number(maxScr.value)) : null,
      validFrom: from.value || null, validTo: to.value || null, notes: "",
    };
    void store.saveMediaLicense(orgId, lic).then((res) => {
      if (!res.ok) { save.removeAttribute("disabled"); error.textContent = res.error ?? "Échec."; error.classList.remove("d-none"); return; }
      const licId = store.mediaLicenseFor(mediaId)?.id;
      const entries = perBoothToggle.checked && licId
        ? [...boothInputs.entries()].filter(([, i]) => i.on.checked).map(([boothId, i]) => ({ boothId, maxScreenings: i.cap.value ? Math.round(Number(i.cap.value)) : null }))
        : [];
      const finish = (): void => { modal.hide(); onDone(); };
      if (licId) void store.setLicenseBooths(orgId, licId, entries).then(finish);
      else finish();
    });
  });

  const field = (l: string, i: HTMLElement): HTMLElement => el("div", { class: "col-md-6 mb-3" }, [el("label", { class: "form-label" }, [l]), i]);
  const body = el("div", {}, [
    error,
    el("div", { class: "row" }, [
      field("Distributeur", distSel),
      field("Modèle de redevance", model),
      field("€ par séance (per_screening)", royalty),
      field("% des revenus (revenue_share)", sharePct),
      field("Forfait / minimum garanti €", mg),
      field("Plafond de séances (org-wide)", maxScr),
      field("Valide du", from),
      field("Valide au", to),
    ]),
    el("label", { class: "form-check form-switch mb-2" }, [perBoothToggle, el("span", { class: "form-check-label" }, [" Plafond par machine (au lieu d'org-wide)"])]),
    boothList,
  ]);
  const modal = buildModal(`Licence — ${title}`, [body], save, "modal-lg");
}

// ── Petit constructeur de modale ──────────────────────────────────────────────
function buildModal(titleText: string, bodyChildren: Node[], footerBtn: HTMLElement, size = ""): Modal {
  const modalEl = el("div", { class: "modal modal-blur fade", tabindex: "-1" }, [
    el("div", { class: `modal-dialog modal-dialog-centered ${size}` }, [
      el("div", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [el("h3", { class: "modal-title" }, [titleText]), el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" }, [])]),
        el("div", { class: "modal-body" }, bodyChildren),
        el("div", { class: "modal-footer" }, [el("button", { class: "btn", type: "button", "data-bs-dismiss": "modal" }, ["Annuler"]), footerBtn]),
      ]),
    ]),
  ]);
  document.body.append(modalEl);
  const modal = new Modal(modalEl);
  modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
  modal.show();
  return modal;
}
