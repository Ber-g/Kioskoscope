import type { FleetStore } from "../data/store";
import type { Booth, Media } from "../domain/types";
import { el, formatMoney, relativeTime, icon } from "./dom";
import { healthBadge, connectionBadge, indicatorChips } from "./components";
import { timeSeriesChart } from "./chart";
import { openBoothForm } from "./drawer";
import { openAccessModal, accessStatus, OPERATOR_ROLE_LABELS } from "./settings";
import type { HubTab } from "./router";

// Hub de gestion d'UNE cabine (CIN-045). Réponse au JTBD « tout gérer pour une cabine au
// même endroit » : on garde les vues flotte (globales), et on AJOUTE cette surface par
// cabine. Chaque onglet est scopé à la borne, en réutilisant les données/méthodes du store —
// aucune duplication de la logique métier des vues globales.

// CIN-118 : les clés d'onglet viennent du routeur (un onglet est aussi une adresse). Ré-exportées
// ici pour que les appelants historiques n'aient pas à savoir d'où elles viennent.
export type { HubTab };

/**
 * Menu de gestion d'une cabine — SOURCE UNIQUE (ordre + libellés). Consommé par le hub (onglets)
 * ET par le tiroir (raccourcis deep-link) → cohérence garantie : mêmes libellés à tous les niveaux
 * de profondeur. Chaque icône est un chemin SVG (24×24) passé à `icon()`.
 */
export const HUB_TABS: ReadonlyArray<{ key: HubTab; label: string; icon: string }> = [
  { key: "synthese", label: "Synthèse", icon: "M4 19h16M4 15l4 -4l3 3l5 -6" },
  { key: "medias", label: "Médias", icon: "M4 5h16v14H4zM4 9h16M10 13l3 2l-3 2z" },
  { key: "revenus", label: "Revenus", icon: "M12 3v18M8 7h6a2 2 0 0 1 0 4h-4a2 2 0 0 0 0 4h6" },
  { key: "maj", label: "MAJ", icon: "M12 3a9 9 0 1 0 9 9M12 3v6h6" },
  { key: "acces", label: "Accès", icon: "M8 11V7a4 4 0 0 1 8 0v4M6 11h12v9H6z" },
  { key: "fiche", label: "Fiche & lieu", icon: "M12 21c-4 -4 -6 -7 -6 -10a6 6 0 0 1 12 0c0 3 -2 6 -6 10zM12 11a2 2 0 1 0 0 -4a2 2 0 0 0 0 4z" },
];

const DEPLOY_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "En attente", cls: "bg-secondary-lt" },
  scheduled: { label: "Planifiée", cls: "bg-azure-lt" },
  applying: { label: "En cours", cls: "bg-blue-lt" },
  applied: { label: "Appliquée", cls: "bg-green-lt" },
  failed: { label: "Échec", cls: "bg-red-lt" },
  rolled_back: { label: "Rollback", cls: "bg-red-lt" },
};
const OS_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "Demandée", cls: "bg-azure-lt" },
  running: { label: "En cours", cls: "bg-blue-lt" },
  done: { label: "À jour", cls: "bg-green-lt" },
  failed: { label: "Échec", cls: "bg-red-lt" },
};

/**
 * Page hub d'une cabine. `onBack` revient à la vue d'ensemble ; `onChanged` redemande un
 * rendu au parent après une mutation (édition fiche, statut MAJ…).
 */
export function boothHubPage(
  store: FleetStore,
  boothId: string,
  onBack: () => void,
  onChanged: () => void,
  initialTab: HubTab = "synthese",
  onTabChange?: (t: HubTab) => void,
  onOpenMedia?: () => void,
): HTMLElement {
  const booth = store.boothById(boothId);
  if (!booth) {
    return el("div", { class: "text-secondary p-4" }, ["Cabine introuvable.", el("div", {}, [backLink(onBack)])]);
  }
  const canManage = store.canManageOrg(booth.organizationId);
  // L'onglet actif est remonté au parent (`onTabChange`) : il SURVIT aux re-render déclenchés
  // par une mutation (changer la fenêtre de MAJ, déclencher un patch…) qui reconstruit ce hub.
  let tab: HubTab = initialTab;

  const content = el("div", {}, []);
  const renderContent = (): void => {
    const view =
      tab === "maj" ? majTab(store, booth, canManage, onChanged)
      : tab === "acces" ? accesTab(store, booth, canManage)
      : tab === "fiche" ? ficheTab(store, booth, canManage)
      : tab === "medias" ? mediasTab(store, booth, onOpenMedia)
      : tab === "revenus" ? revenusTab(store, booth)
      : syntheseTab(booth);
    content.replaceChildren(view);
  };

  const tabBtn = (key: HubTab, label: string): HTMLElement => {
    const b = el("button", { class: `btn ${tab === key ? "btn-primary" : ""}`, type: "button" }, [label]);
    b.addEventListener("click", () => {
      tab = key;
      onTabChange?.(key);
      tabs.querySelectorAll("button").forEach((x) => x.classList.remove("btn-primary"));
      b.classList.add("btn-primary");
      renderContent();
    });
    return b;
  };
  const tabs = el("div", { class: "btn-group", role: "group" }, HUB_TABS.map((t) => tabBtn(t.key, t.label)));

  renderContent();

  return el("div", {}, [
    el("div", { class: "mb-3" }, [backLink(onBack)]),
    el("div", { class: "d-flex align-items-center flex-wrap gap-2 mb-1" }, [
      el("h2", { class: "page-title m-0 me-2" }, [booth.label]),
      healthBadge(booth.health),
      connectionBadge(booth),
      indicatorChips(booth),
    ]),
    el("div", { class: "text-secondary mb-3" }, [booth.location || "—"]),
    el("div", { class: "mb-3" }, [tabs]),
    content,
  ]);
}

function backLink(onBack: () => void): HTMLElement {
  const a = el("button", { class: "btn btn-link px-0 text-secondary", type: "button" }, [icon("M15 6l-6 6l6 6", 18), el("span", {}, ["Toutes les cabines"])]);
  a.addEventListener("click", onBack);
  return a;
}

// ── Onglet Synthèse : santé, télémétrie, chiffres du jour, tendance 14 j ──────────
function syntheseTab(booth: Booth): HTMLElement {
  const stat = (label: string, value: string): HTMLElement =>
    el("div", { class: "col" }, [el("div", { class: "text-secondary small" }, [label]), el("div", { class: "fw-bold fs-3" }, [value])]);
  const t = booth.telemetry;
  return el("div", { class: "row row-cards" }, [
    el("div", { class: "col-lg-4" }, [
      el("div", { class: "card" }, [el("div", { class: "card-body" }, [
        el("h3", { class: "card-title" }, ["Aujourd'hui"]),
        el("div", { class: "row g-2" }, [stat("Sessions", String(booth.sessionsToday)), stat("Revenu", formatMoney(booth.revenueTodayCents))]),
        el("div", { class: "row g-2 mt-2" }, [
          stat("Version", booth.softwareVersion || "—"),
          stat("Dernier contact", relativeTime(booth.lastHeartbeatAt)),
        ]),
      ])]),
    ]),
    el("div", { class: "col-lg-4" }, [
      el("div", { class: "card" }, [el("div", { class: "card-body" }, [
        el("h3", { class: "card-title" }, ["Télémétrie"]),
        meter("Disponibilité (30 j)", t.uptimePct, " %", t.uptimePct >= 95),
        meter("Stockage libre", t.storageFreePct, " %", t.storageFreePct >= 15),
        meter("Charge CPU", t.cpuLoadPct, " %", t.cpuLoadPct < 80),
        el("div", { class: "text-secondary small mt-2" }, [`Température ${t.temperatureC} °C · Film : ${t.currentFilmTitle ?? "—"}`]),
      ])]),
    ]),
    el("div", { class: "col-lg-4" }, [
      el("div", { class: "card" }, [el("div", { class: "card-body" }, [
        el("h3", { class: "card-title" }, ["Tendance (14 j)"]),
        timeSeriesChart({ title: "Sessions/jour", points: booth.history.map((d) => ({ date: d.date, value: d.sessions })), kind: "area", hue: "var(--tblr-primary)", formatValue: (n) => String(n) }),
      ])]),
    ]),
  ]);
}

function meter(label: string, value: number, unit: string, ok: boolean): HTMLElement {
  return el("div", { class: "mb-2" }, [
    el("div", { class: "d-flex justify-content-between small text-secondary" }, [el("span", {}, [label]), el("span", {}, [`${value}${unit}`])]),
    el("div", { class: "progress progress-sm" }, [el("div", { class: `progress-bar bg-${ok ? "green" : "yellow"}`, style: `width:${Math.max(0, Math.min(100, value))}%` }, [])]),
  ]);
}

// ── Onglet MAJ : version, fenêtre, dernier déploiement, MAJ OS ───────────────────
function majTab(store: FleetStore, booth: Booth, canManage: boolean, onChanged: () => void): HTMLElement {
  const row = store.updatesReport().rows.find((r) => r.boothId === booth.id);
  const os = store.osUpdateFor(booth.id);
  const wrap = el("div", { class: "row row-cards" }, []);
  const reload = (): void => onChanged();

  // Version + fenêtre de MAJ.
  const hourSel = el("select", { class: "form-select w-auto d-inline-block" }, Array.from({ length: 24 }, (_, h) =>
    el("option", { value: String(h), ...(h === (row?.maintenanceHour ?? 3) ? { selected: "selected" } : {}) }, [`${String(h).padStart(2, "0")}:00`]))) as HTMLSelectElement;
  hourSel.addEventListener("change", () => void store.setMaintenanceHour(booth.id, Number(hourSel.value)).then((r) => (r.ok ? reload() : alert(r.error ?? "Échec."))));

  const versionCard = el("div", { class: "col-lg-6" }, [el("div", { class: "card" }, [el("div", { class: "card-body" }, [
    el("h3", { class: "card-title" }, ["Version logicielle"]),
    el("div", { class: "mb-2" }, [el("span", { class: "badge bg-blue-lt me-2" }, [booth.softwareVersion || "—"]), el("span", { class: "text-secondary small" }, [`contact ${relativeTime(booth.lastHeartbeatAt)}`])]),
    el("div", { class: "form-label" }, ["Fenêtre de mise à jour (heure locale)"]),
    hourSel,
    el("div", { class: "form-hint" }, ["Les MAJ non urgentes s'appliquent dans cette fenêtre."]),
  ])])]);

  // Dernier déploiement.
  const latest = row?.latest;
  const depActions: HTMLElement[] = [];
  if (canManage && latest && ["scheduled", "pending", "applying", "failed"].includes(latest.status)) {
    const b = el("button", { class: "btn btn-sm", type: "button" }, ["Marquer appliquée"]);
    b.addEventListener("click", () => void store.setUpdateStatus(latest.updateId, "applied").then((r) => (r.ok ? reload() : alert(r.error ?? "Échec."))));
    depActions.push(b);
  }
  if (canManage && latest && latest.status === "applied") {
    const b = el("button", { class: "btn btn-sm btn-outline-danger", type: "button" }, ["Rollback"]);
    b.addEventListener("click", () => void store.setUpdateStatus(latest.updateId, "rolled_back").then((r) => (r.ok ? reload() : alert(r.error ?? "Échec."))));
    depActions.push(b);
  }
  const deployCard = el("div", { class: "col-lg-6" }, [el("div", { class: "card" }, [el("div", { class: "card-body" }, [
    el("h3", { class: "card-title" }, ["Dernier déploiement"]),
    latest
      ? el("div", { class: "d-flex align-items-center gap-2 mb-2" }, [el("span", { class: "text-secondary" }, [latest.version]), el("span", { class: `badge ${DEPLOY_STATUS[latest.status]?.cls ?? "bg-secondary-lt"}` }, [DEPLOY_STATUS[latest.status]?.label ?? latest.status])])
      : el("div", { class: "text-secondary" }, ["Aucun déploiement. Déployez une version depuis Maintenance."]),
    el("div", { class: "btn-list" }, depActions),
  ])])]);

  // MAJ OS.
  const osBusy = os?.status === "pending" || os?.status === "running";
  const osActions: HTMLElement[] = [];
  if (store.isGlobalAdmin && !osBusy) {
    const b = el("button", { class: "btn btn-sm", type: "button", title: "Demander une MAJ système (apt) à cette borne" }, ["Mettre à jour l'OS"]);
    b.addEventListener("click", () => void store.requestOsUpdate([booth.id]).then((r) => (r.ok ? reload() : alert(r.error ?? "Échec."))));
    osActions.push(b);
  }
  const osCard = el("div", { class: "col-12" }, [el("div", { class: "card" }, [el("div", { class: "card-body" }, [
    el("h3", { class: "card-title" }, ["Système d'exploitation"]),
    os
      ? el("div", { class: "d-flex align-items-center gap-2 mb-2" }, [
          el("span", { class: `badge ${OS_STATUS[os.status]?.cls ?? "bg-secondary-lt"}`, ...(os.error ? { title: os.error } : {}) }, [OS_STATUS[os.status]?.label ?? os.status]),
          os.packagesPending ? el("span", { class: "text-secondary small" }, [`${os.packagesPending} paquet(s) en attente`]) : el("span", {}, []),
        ])
      : el("div", { class: "text-secondary mb-2" }, ["Aucune commande de MAJ OS."]),
    store.isGlobalAdmin
      ? el("div", { class: "btn-list" }, osActions.length ? osActions : [el("span", { class: "text-secondary small" }, ["MAJ OS en cours…"])])
      : el("div", { class: "text-secondary small" }, ["Les MAJ système sont pilotées par Kioskoscope."]),
  ])])]);

  wrap.replaceChildren(versionCard, deployCard, osCard);
  return wrap;
}

// ── Onglet Accès : PINs opérateur scopés à cette cabine (+ portée « toutes ») ─────
function accesTab(store: FleetStore, booth: Booth, canManage: boolean): HTMLElement {
  const org = store.organizations().find((o) => o.id === booth.organizationId) ?? null;
  const wrap = el("div", {}, [el("div", { class: "card" }, [el("div", { class: "card-body text-secondary" }, ["Chargement des accès…"])])]);
  if (!org) return wrap;

  const orgBooths = store.visibleBooths().filter((b) => b.organizationId === org.id);

  const load = (): void => {
    void store.listOperatorAccess(org.id).then((all) => {
      // Accès qui s'appliquent à CETTE cabine : ceux scopés dessus + ceux « toutes les Kiosks ».
      const list = all.filter((a) => a.boothId === booth.id || a.boothId === null);
      const rows = list.map((a) => {
        const st = accessStatus(a);
        const actions: HTMLElement[] = [];
        if (canManage) {
          const toggle = el("button", { class: `btn btn-sm ${a.revoked ? "btn-outline-success" : "btn-outline-danger"}`, type: "button" }, [a.revoked ? "Réactiver" : "Révoquer"]);
          toggle.addEventListener("click", () => void store.setOperatorAccessRevoked(a.id, !a.revoked).then((r) => (r.ok ? load() : alert(r.error ?? "Échec."))));
          actions.push(toggle);
        }
        return el("tr", {}, [
          el("td", {}, [el("div", { class: "fw-bold" }, [a.identifier]), a.label ? el("div", { class: "text-secondary small" }, [a.label]) : el("span", {}, [])]),
          el("td", {}, [el("span", { class: "badge bg-secondary-lt" }, [OPERATOR_ROLE_LABELS[a.role]])]),
          el("td", {}, [a.boothId === null ? el("span", { class: "badge bg-azure-lt" }, ["Toutes les cabines"]) : el("span", { class: "text-secondary small" }, ["Cette cabine"])]),
          el("td", {}, [el("span", { class: `badge ${st.cls}` }, [st.label])]),
          el("td", { class: "text-end" }, actions),
        ]);
      });

      const children: HTMLElement[] = [];
      if (canManage) {
        const add = el("button", { class: "btn btn-primary mb-3", type: "button" }, ["Créer un accès pour cette cabine"]);
        add.addEventListener("click", () => openAccessModal(store, org, orgBooths, all.map((a) => a.identifier), load, booth.id));
        children.push(add);
      }
      children.push(el("div", { class: "card" }, [el("div", { class: "table-responsive" }, [
        el("table", { class: "table table-vcenter card-table" }, [
          el("thead", {}, [el("tr", {}, [el("th", {}, ["Identifiant"]), el("th", {}, ["Rôle"]), el("th", {}, ["Portée"]), el("th", {}, ["Statut"]), el("th", {}, [])])]),
          el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: "5", class: "text-secondary text-center py-4" }, ["Aucun accès pour cette cabine."])])]),
        ]),
      ])]));
      wrap.replaceChildren(...children);
    });
  };
  load();
  return wrap;
}

// ── Onglet Fiche & lieu : infos d'implantation + édition complète ────────────────
// L'édition passe par `openBoothForm` → `store.upsertBooth` émet → le parent re-render.
function ficheTab(store: FleetStore, booth: Booth, canManage: boolean): HTMLElement {
  const line = (label: string, value: string): HTMLElement =>
    el("div", { class: "mb-2" }, [el("div", { class: "text-secondary small" }, [label]), el("div", {}, [value || "—"])]);
  const gps = booth.gpsLat != null && booth.gpsLng != null ? `${booth.gpsLat.toFixed(5)}, ${booth.gpsLng.toFixed(5)}` : "";

  const editBtn = el("button", { class: "btn btn-primary", type: "button" }, [icon("M4 20h4l10 -10l-4 -4l-10 10v4", 18), el("span", {}, ["Modifier la fiche"])]);
  editBtn.addEventListener("click", () => openBoothForm(store, booth));

  return el("div", { class: "card" }, [el("div", { class: "card-body" }, [
    el("div", { class: "d-flex align-items-center mb-3" }, [el("h3", { class: "card-title m-0" }, ["Implantation"]), canManage ? el("div", { class: "ms-auto" }, [editBtn]) : el("span", {}, [])]),
    line("Emplacement", booth.location),
    line("Adresse postale", booth.address),
    line("Catégorie de lieu", booth.venueType ?? ""),
    line("Coordonnées GPS", gps),
    line("Notes d'accès", booth.notes),
    canManage ? el("span", {}, []) : el("div", { class: "text-secondary small mt-2" }, ["Modification réservée aux administrateurs de l'organisation."]),
  ])]);
}

// ── Onglet Médias : films physiquement présents sur CETTE borne ──────────────────
// Lecture seule : la présence se pilote depuis la vue Médias globale (envoi batch).
// On dérive du store (`mediaForBooth`) → aucune requête ad hoc, tout est scopé RLS.
function mediaDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m > 0 ? `${m} min` : `${seconds}s`;
}

/** Badges sous-titres d'un média (vert = vérifié/calé, ambre = à retravailler). */
function subtitleBadges(store: FleetStore, m: Media): HTMLElement {
  const subs = store.subtitlesFor(m.id);
  if (subs.length === 0) return el("span", { class: "text-secondary" }, ["—"]);
  return el("span", { class: "d-inline-flex flex-wrap gap-1" }, subs.map((s) => {
    const verified = s.workflowStatus === "verified";
    return el("span", { class: `badge ${verified ? "bg-green-lt" : "bg-yellow-lt"}`, title: verified ? "Sous-titres présents et calés" : "Sous-titres à retravailler" }, [`${s.lang.toUpperCase()}${verified ? " ✓" : ""}`]);
  }));
}

/** Badge état vidéo : validée par l'opérateur / à valider / pas de fichier. */
function videoBadge(m: Media): HTMLElement {
  if (!m.storageUrl) return el("span", { class: "badge bg-secondary-lt", title: "Aucun fichier vidéo" }, ["—"]);
  if (m.reviewedAt) return el("span", { class: "badge bg-green-lt", title: `Validée le ${new Date(m.reviewedAt).toLocaleDateString("fr-FR")}` }, ["✓ Validée"]);
  return el("span", { class: "badge bg-yellow-lt", title: "À valider par l'opérateur (via l'aperçu)" }, ["À valider"]);
}

function mediasTab(store: FleetStore, booth: Booth, onOpenMedia?: () => void): HTMLElement {
  const media = store.mediaForBooth(booth.id);
  const nowPlaying = booth.telemetry.currentFilmTitle;

  // Renvoi vers la gestion globale (l'envoi/retrait de médias se fait là-bas).
  const manageBtn = el("button", { class: "btn btn-outline-primary", type: "button" }, [icon("M4 5h16v14H4zM4 9h16M10 13l3 2l-3 2z", 18), el("span", {}, ["Gérer les médias"])]);
  if (onOpenMedia) manageBtn.addEventListener("click", onOpenMedia);

  const header = el("div", { class: "d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3" }, [
    el("div", {}, [
      el("h3", { class: "m-0" }, [`Médias sur cette cabine (${media.length})`]),
      nowPlaying ? el("div", { class: "text-secondary small" }, [`En cours de lecture : ${nowPlaying}`]) : el("span", {}, []),
    ]),
    onOpenMedia ? manageBtn : el("span", {}, []),
  ]);

  // Empty state explicite : on n'affiche jamais un tableau vide muet.
  if (media.length === 0) {
    return el("div", {}, [header, el("div", { class: "card" }, [el("div", { class: "card-body text-secondary text-center py-5" }, [
      el("div", { class: "mb-2" }, ["Aucun média n'est présent sur cette cabine pour l'instant."]),
      el("div", { class: "small" }, ["Envoyez des films depuis la vue Médias pour qu'ils apparaissent ici."]),
    ])])]);
  }

  const rows = media.map((m) => el("tr", {}, [
    el("td", {}, [el("div", { class: "fw-bold" }, [m.title]), el("div", { class: "text-secondary small" }, [`${m.director || "—"} · ${m.year || "—"}`])]),
    el("td", { class: "text-secondary" }, [mediaDuration(m.durationSeconds)]),
    el("td", { class: "text-secondary" }, [m.language.toUpperCase()]),
    el("td", {}, [subtitleBadges(store, m)]),
    el("td", {}, [videoBadge(m)]),
  ]));

  return el("div", {}, [
    header,
    el("div", { class: "card" }, [el("div", { class: "table-responsive" }, [
      el("table", { class: "table table-vcenter card-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", {}, ["Titre"]), el("th", {}, ["Durée"]), el("th", {}, ["Langue"]), el("th", {}, ["Sous-titres"]), el("th", {}, ["Vidéo"])])]),
        el("tbody", {}, rows),
      ]),
    ])]),
  ]);
}

// ── Onglet Revenus : chiffre d'affaires de CETTE borne (scopé boothId) ───────────
// Réutilise la logique de la vue Revenus globale (revenue.ts) restreinte à la borne.
function revenusTab(store: FleetStore, booth: Booth): HTMLElement {
  const tx = store.transactionsForBooth(booth.id);
  const currency = store.orgCurrency(booth.organizationId);

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const dayOf = (createdAt: number): string => new Date(createdAt).toISOString().slice(0, 10);
  const sum = (list: typeof tx): number => list.reduce((n, t) => n + t.amountCents, 0);

  // Fenêtre 30 jours (bornes incluses) : sert au KPI et au graphe (mêmes points).
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const window30 = new Set(days);
  const todayCents = sum(tx.filter((t) => dayOf(t.createdAt) === todayStr));
  const cents30 = sum(tx.filter((t) => window30.has(dayOf(t.createdAt))));

  const byDay = new Map<string, number>();
  for (const t of tx) byDay.set(dayOf(t.createdAt), (byDay.get(dayOf(t.createdAt)) ?? 0) + t.amountCents);
  const points = days.map((d) => ({ date: d, value: byDay.get(d) ?? 0 }));

  const kpi = (label: string, value: string): HTMLElement =>
    el("div", { class: "col-sm-4" }, [el("div", { class: "card card-sm" }, [el("div", { class: "card-body" }, [
      el("div", { class: "fs-2 fw-bold lh-1" }, [value]),
      el("div", { class: "text-secondary" }, [label]),
    ])])]);

  const kpis = el("div", { class: "row row-cards g-2 mb-3" }, [
    kpi("Aujourd'hui", formatMoney(todayCents, currency)),
    kpi("30 derniers jours", formatMoney(cents30, currency)),
    kpi("Transactions", String(tx.length)),
  ]);

  const chart = el("div", { class: "card mb-3" }, [el("div", { class: "card-body" }, [
    timeSeriesChart({ title: "Revenu — 30 derniers jours", points, kind: "area", hue: "var(--tblr-teal)", formatValue: (n) => formatMoney(n, currency) }),
  ])]);

  // Dernières transactions (50 max). Pas de colonne « Kiosk » : tout est cette borne.
  const recent = tx.slice(0, 50);
  const txCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, [el("h3", { class: "card-title m-0" }, ["Dernières transactions"])]),
    recent.length === 0
      ? el("div", { class: "card-body text-secondary text-center py-5" }, ["Aucune transaction pour cette cabine sur la période."])
      : el("div", { class: "table-responsive" }, [el("table", { class: "table table-vcenter card-table" }, [
          el("thead", {}, [el("tr", {}, [el("th", {}, ["Date"]), el("th", { class: "text-end" }, ["Montant"]), el("th", {}, ["Fournisseur"])])]),
          el("tbody", {}, recent.map((t) => el("tr", {}, [
            el("td", { class: "text-secondary text-nowrap" }, [new Date(t.createdAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })]),
            el("td", { class: "text-end fw-bold text-nowrap" }, [formatMoney(t.amountCents, t.currency)]),
            el("td", {}, [el("span", { class: "badge bg-secondary-lt" }, [t.provider])]),
          ]))),
        ])]),
  ]);

  // Cabine sans aucune transaction : empty state global (pas de graphe vide trompeur).
  if (tx.length === 0) {
    return el("div", {}, [
      el("div", { class: "card" }, [el("div", { class: "card-body text-secondary text-center py-5" }, [
        el("div", { class: "mb-2" }, ["Aucun revenu enregistré pour cette cabine."]),
        el("div", { class: "small" }, ["Les paiements encaissés sur cette borne apparaîtront ici."]),
      ])]),
    ]);
  }

  return el("div", {}, [kpis, chart, txCard]);
}
