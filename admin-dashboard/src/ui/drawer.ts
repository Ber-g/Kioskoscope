import { Offcanvas, Modal } from "bootstrap";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Booth, HealthStatus } from "../domain/types";
import { allHealthStatuses, healthMeta } from "../domain/status";
import type { FleetStore } from "../data/store";
import { el, formatClockTime, formatMoney, icon } from "./dom";
import { connectionBadge, healthBadge, indicatorChips } from "./components";
import { timeSeriesChart } from "./chart";
import { HUB_TABS, type HubTab } from "./boothHub";

// Détail d'une Kiosk (offcanvas) + formulaire add/edit (modal). Les OUTILS DE
// DEBUG (journaux, redémarrage, push, suppression) ne sont rendus que pour
// l'opérateur — un gérant de bar ne les voit pas.

function meter(label: string, value: number, unit: string, ok: boolean): HTMLElement {
  const color = ok ? "green" : "yellow";
  return el("div", { class: "mb-2" }, [
    el("div", { class: "d-flex justify-content-between small text-secondary" }, [
      el("span", {}, [label]),
      el("span", {}, [`${value}${unit}`]),
    ]),
    el("div", { class: "progress progress-sm" }, [
      el("div", { class: `progress-bar bg-${color}`, style: `width: ${Math.max(0, Math.min(100, value))}%` }, []),
    ]),
  ]);
}

export function openBoothDrawer(store: FleetStore, boothId: string, onEdit: (b: Booth) => void, onManage?: (boothId: string, tab?: HubTab) => void): void {
  const booth = store.boothById(boothId);
  if (!booth) return;
  // Outils de debug/shell = global_admin UNIQUEMENT (exigence sécurité V2/F7).
  const canDebug = store.isGlobalAdmin;

  // CIN-045 : accès au hub de gestion complet de la cabine (médias/MAJ/accès/fiche).
  const manageBtn = el("button", { class: "btn btn-primary w-100 mb-2", type: "button" }, [
    icon("M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0", 18),
    el("span", {}, ["Gérer cette cabine"]),
  ]);

  // Menu des 6 domaines de gestion — MÊMES libellés que le hub (source unique HUB_TABS) → chaque
  // raccourci deep-linke le hub sur son onglet. Le tiroir = niveau 1 (aperçu + accès rapide), le hub
  // = niveau 2 (détail complet). Rendu seulement si la gestion est atteignable (onManage fourni).
  const manageMenu = onManage
    ? el("div", { class: "list-group list-group-flush mb-3" },
        HUB_TABS.map((tabDef) => {
          const item = el("button", { class: "list-group-item list-group-item-action d-flex align-items-center gap-2 py-2", type: "button" }, [
            icon(tabDef.icon, 18),
            el("span", { class: "flex-fill text-start" }, [tabDef.label]),
            icon("M9 6l6 6l-6 6", 16),
          ]);
          item.addEventListener("click", () => { oc.hide(); onManage(booth.id, tabDef.key); });
          return item;
        }),
      )
    : el("span", {}, []);

  const body: HTMLElement[] = [
    onManage ? manageBtn : el("span", {}, []),
    manageMenu,
    el("div", { class: "d-flex align-items-center flex-wrap gap-2 mb-2" }, [
      healthBadge(booth.health),
      indicatorChips(booth),
      connectionBadge(booth),
    ]),
    el("div", { class: "text-secondary mb-3" }, [booth.location]),

    // Graphes d'utilisation : sessions/jour (aire) + bande passante/jour (ligne).
    el("h4", {}, ["Statistiques (14 jours)"]),
    timeSeriesChart({
      title: "Visionnages par jour",
      points: booth.history.map((d) => ({ date: d.date, value: d.sessions })),
      kind: "area",
      hue: "var(--tblr-primary)",
      formatValue: (n) => String(n),
    }),
    timeSeriesChart({
      title: "Bande passante par jour",
      points: booth.history.map((d) => ({ date: d.date, value: d.bandwidthMb })),
      kind: "line",
      hue: "var(--tblr-teal)",
      formatValue: (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} Go` : `${n} Mo`),
    }),

    // Télémétrie (visible par tous).
    el("h4", { class: "mt-3" }, ["Télémétrie"]),
    meter("Disponibilité (30 j)", booth.telemetry.uptimePct, " %", booth.telemetry.uptimePct >= 95),
    meter("Stockage libre", booth.telemetry.storageFreePct, " %", booth.telemetry.storageFreePct >= 15),
    meter("Charge CPU", booth.telemetry.cpuLoadPct, " %", booth.telemetry.cpuLoadPct < 80),
    el("div", { class: "row g-2 mt-1 mb-3" }, [
      el("div", { class: "col" }, [
        el("div", { class: "text-secondary small" }, ["Température"]),
        el("div", { class: "fw-bold" }, [`${booth.telemetry.temperatureC} °C`]),
      ]),
      el("div", { class: "col" }, [
        el("div", { class: "text-secondary small" }, ["Film en cours"]),
        el("div", { class: "fw-bold" }, [booth.telemetry.currentFilmTitle ?? "—"]),
      ]),
    ]),

    // Chiffres du jour.
    el("div", { class: "row g-2 mb-3" }, [
      el("div", { class: "col" }, [
        el("div", { class: "text-secondary small" }, ["Sessions aujourd'hui"]),
        el("div", { class: "fw-bold fs-3" }, [String(booth.sessionsToday)]),
      ]),
      el("div", { class: "col" }, [
        el("div", { class: "text-secondary small" }, ["Revenu aujourd'hui"]),
        el("div", { class: "fw-bold fs-3" }, [formatMoney(booth.revenueTodayCents)]),
      ]),
    ]),

    booth.notes ? el("div", { class: "alert alert-secondary" }, [booth.notes]) : el("span", {}, []),
  ];

  // Section DEBUG — global_admin uniquement (jamais un client, même super_user).
  if (canDebug) {
    const actionsRow = el("div", { class: "btn-list mb-3" }, [
      actionButton("Redémarrer", "M12 3a9 9 0 1 0 9 9M12 3v6h6", () => remoteAction(store, booth, "Redémarrage demandé (watchdog)")),
      actionButton("Pousser le contenu", "M12 3v12M8 11l4 4l4 -4M4 21h16", () => remoteAction(store, booth, "Push contenu/metadata déclenché")),
      actionButton("Modifier", "M4 20h4l10 -10l-4 -4l-10 10v4", () => onEdit(booth)),
    ]);

    const logRows = booth.logs
      .slice()
      .sort((a, b) => b.at - a.at)
      .map((l) =>
        el("tr", {}, [
          el("td", { class: "text-secondary text-nowrap" }, [formatClockTime(l.at)]),
          el("td", {}, [logLevelBadge(l.level)]),
          el("td", {}, [l.message]),
        ]),
      );

    body.push(
      el("div", { class: "hr-text" }, ["Outils global admin"]),
      actionsRow,
      el("h4", {}, ["Journaux"]),
      el("div", { class: "table-responsive mb-3" }, [
        el("table", { class: "table table-sm table-vcenter" }, [el("tbody", {}, logRows)]),
      ]),
      el("button", { class: "btn btn-outline-danger w-100", type: "button", "data-action": "delete" }, ["Supprimer ce Kiosk"]),
    );
  } else {
    body.push(el("div", { class: "text-secondary small" }, ["Les outils techniques (journaux, redémarrage, push) sont réservés au global admin."]));
  }

  const offEl = el("div", { class: "offcanvas offcanvas-end", tabindex: "-1" }, [
    el("div", { class: "offcanvas-header" }, [
      el("h2", { class: "offcanvas-title" }, [booth.label]),
      el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "offcanvas", "aria-label": "Fermer" }, []),
    ]),
    el("div", { class: "offcanvas-body" }, body),
  ]);
  document.body.append(offEl);

  const delBtn = offEl.querySelector('[data-action="delete"]');
  const oc = new Offcanvas(offEl);
  manageBtn.addEventListener("click", () => {
    oc.hide();
    onManage?.(booth.id);
  });
  delBtn?.addEventListener("click", () => {
    if (confirm(`Supprimer « ${booth.label} » ? Cette action est définitive.`)) {
      store.deleteBooth(booth.id);
      oc.hide();
    }
  });
  offEl.addEventListener("hidden.bs.offcanvas", () => offEl.remove(), { once: true });
  oc.show();
}

function actionButton(label: string, path: string, onClick: () => void): HTMLElement {
  const b = el("button", { class: "btn", type: "button" }, [icon(path, 18), el("span", {}, [label])]);
  b.addEventListener("click", onClick);
  return b;
}

function logLevelBadge(level: "info" | "warn" | "error"): HTMLElement {
  const map = { info: "secondary", warn: "yellow", error: "red" } as const;
  return el("span", { class: `badge bg-${map[level]}-lt` }, [level]);
}

function remoteAction(store: FleetStore, booth: Booth, message: string): void {
  const updated: Booth = {
    ...booth,
    logs: [{ at: Date.now(), level: "info", message }, ...booth.logs],
  };
  store.upsertBooth(updated);
  // Feedback simple ; un vrai toast Tabler pourra remplacer ça.
  alert(`${booth.label} : ${message}`);
}

// ── Formulaire add/edit (modal) ──────────────────────────────────────────────
export function openBoothForm(store: FleetStore, existing: Booth | null): void {
  const isNew = existing === null;
  const b: Booth =
    existing ??
    ({
      id: crypto.randomUUID(), // vrai UUID (la colonne booths.id est uuid côté Supabase)
      label: "",
      location: "",
      health: "operational",
      indicators: [],
      lastHeartbeatAt: Date.now(),
      softwareVersion: "", // inconnue jusqu'au 1er heartbeat de la borne (CIN-016)
      sessionsToday: 0,
      revenueTodayCents: 0,
      telemetry: { uptimePct: 100, temperatureC: 38, storageFreePct: 80, cpuLoadPct: 20, currentFilmTitle: null, connection: "wifi", signalPct: 70 },
      logs: [],
      history: [],
      // Nouvelle Kiosk rattachée à l'org active (global_admin → org par défaut).
      organizationId: store.current?.activeOrganizationId ?? "org-perchoir",
      address: "",
      gpsLat: null,
      gpsLng: null,
      venueType: null,
      serial: null,
      notes: "",
    } satisfies Booth);

  // Catégorie du LIEU où est posée la Kiosk (propre à la Kiosk, ≠ type d'organisation).
  const VENUE_TYPES = ["Bar", "Restaurant", "Café", "Hôtel", "Musée", "Cinéma", "Festival", "Événement", "Tiers-lieu", "Espace public", "Autre"];

  const field = (labelText: string, input: HTMLElement): HTMLElement =>
    el("div", { class: "mb-3" }, [el("label", { class: "form-label" }, [labelText]), input]);

  const labelInput = el("input", { class: "form-control", type: "text", value: b.label, placeholder: "Kioskoscope — Nom du lieu" });
  const locationInput = el("input", { class: "form-control", type: "text", value: b.location, placeholder: "Ville · Lieu" });
  // Adresse postale : repli quand le GPS est absent/erroné (F11).
  const addressInput = el("input", { class: "form-control", type: "text", value: b.address, placeholder: "N°, rue, code postal, ville" }) as HTMLInputElement;
  // Localisation précise (F11) : on DROP UNE PIN sur la carte → coordonnées exactes.
  // L'adresse postale + les notes restent le repli si le GPS/la carte ne suffit pas.
  let pickedLat: number | null = b.gpsLat;
  let pickedLng: number | null = b.gpsLng;
  const mapDiv = el("div", { style: "height: 260px; border-radius: 8px; overflow: hidden; z-index: 0;" });
  const coordReadout = el("div", { class: "form-hint small mt-1 d-flex align-items-center gap-2" }, []);
  const clearPin = el("button", { class: "btn btn-sm btn-ghost-secondary py-0 px-1", type: "button" }, ["retirer la pin"]);
  const venueSelect = el("select", { class: "form-select" }, [
    el("option", { value: "", ...(b.venueType ? {} : { selected: "selected" }) }, ["—"]),
    ...VENUE_TYPES.map((v) => el("option", { value: v, ...(v === b.venueType ? { selected: "selected" } : {}) }, [v])),
  ]) as HTMLSelectElement;
  const healthSelect = el(
    "select",
    { class: "form-select" },
    allHealthStatuses().map((s) =>
      el("option", { value: s, ...(s === b.health ? { selected: "selected" } : {}) }, [healthMeta(s).label]),
    ),
  ) as HTMLSelectElement;
  // CIN-016 : la version = réalité remontée par la borne (heartbeat), jamais saisie à la main.
  const versionInput = el("input", { class: "form-control", type: "text", value: b.softwareVersion, readonly: "true", placeholder: "en attente du premier contact" });
  // 2ᵉ id : numéro physique ÉDITABLE — mais réservé au global_admin (attribution de flotte).
  const serialInput = el("input", { class: "form-control", type: "text", value: b.serial ?? "", placeholder: "ex. KIO-0007", ...(store.isGlobalAdmin ? {} : { readonly: "true" }) }) as HTMLInputElement;
  const notesInput = el("textarea", { class: "form-control", rows: "2" }, [b.notes]) as HTMLTextAreaElement;

  const form = el("form", {}, [
    field("Nom du Kiosk", labelInput),
    field("Emplacement (ville · lieu)", locationInput),
    field("Adresse postale", addressInput),
    field("Catégorie de lieu", venueSelect),
    field("Localisation précise — cliquez sur la carte pour poser la pin", el("div", {}, [
      mapDiv,
      el("div", { class: "d-flex align-items-center justify-content-between mt-1" }, [coordReadout, clearPin]),
    ])),
    field("Statut de santé", healthSelect),
    field("Version logicielle (remontée par la borne — lecture seule)", el("div", {}, [
      versionInput,
      el("div", { class: "form-hint" }, ["Renseignée automatiquement par la Kiosk à chaque contact ; non modifiable ici."]),
    ])),
    field("Numéro physique de la borne", el("div", {}, [
      serialInput,
      el("div", { class: "form-hint" }, [store.isGlobalAdmin ? "Identifiant matériel éditable (distinct de l'identité interne, qui reste stable)." : "Attribué par Kioskoscope."]),
    ])),
    field("Notes d'accès (où exactement, comment brancher, contact sur place…)", notesInput),
  ]);

  const save = el("button", { class: "btn btn-primary ms-auto", type: "button" }, [isNew ? "Créer le Kiosk" : "Enregistrer"]);

  const modalEl = el("div", { class: "modal modal-blur fade", tabindex: "-1" }, [
    el("div", { class: "modal-dialog modal-dialog-centered" }, [
      el("div", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [
          el("h3", { class: "modal-title" }, [isNew ? "Nouveau Kiosk" : "Modifier le Kiosk"]),
          el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" }, []),
        ]),
        el("div", { class: "modal-body" }, [form]),
        el("div", { class: "modal-footer" }, [
          el("button", { class: "btn", type: "button", "data-bs-dismiss": "modal" }, ["Annuler"]),
          save,
        ]),
      ]),
    ]),
  ]);
  document.body.append(modalEl);
  const modal = new Modal(modalEl);

  // ── Carte : drop d'une pin pour la localisation précise (F11) ──────────────
  const DEFAULT_CENTER: [number, number] = [46.6, 2.5]; // France, si aucune coordonnée
  const pinIcon = L.divIcon({ className: "kioskoscope-pin", html: '<div style="font-size:26px;line-height:1">📍</div>', iconSize: [26, 26], iconAnchor: [13, 24] });
  let map: L.Map | null = null;
  let marker: L.Marker | null = null;
  const updateReadout = (): void => {
    coordReadout.textContent = pickedLat != null && pickedLng != null ? `📍 ${pickedLat.toFixed(5)}, ${pickedLng.toFixed(5)}` : "Aucune pin — cliquez sur la carte pour placer le Kiosk.";
    clearPin.style.display = pickedLat != null ? "" : "none";
  };
  const setPin = (lat: number, lng: number): void => {
    pickedLat = lat;
    pickedLng = lng;
    if (map) {
      if (marker) marker.setLatLng([lat, lng]);
      else {
        marker = L.marker([lat, lng], { draggable: true, icon: pinIcon }).addTo(map);
        marker.on("dragend", () => {
          const p = marker!.getLatLng();
          pickedLat = p.lat;
          pickedLng = p.lng;
          updateReadout();
        });
      }
    }
    updateReadout();
  };
  clearPin.addEventListener("click", () => {
    pickedLat = null;
    pickedLng = null;
    if (marker && map) { map.removeLayer(marker); marker = null; }
    updateReadout();
  });
  updateReadout();
  // Leaflet a besoin d'un conteneur VISIBLE et dimensionné → init à l'ouverture du modal.
  modalEl.addEventListener("shown.bs.modal", () => {
    if (map) return;
    const center: [number, number] = pickedLat != null && pickedLng != null ? [pickedLat, pickedLng] : DEFAULT_CENTER;
    map = L.map(mapDiv).setView(center, pickedLat != null ? 15 : 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19 }).addTo(map);
    if (pickedLat != null && pickedLng != null) setPin(pickedLat, pickedLng);
    map.on("click", (e: L.LeafletMouseEvent) => setPin(e.latlng.lat, e.latlng.lng));
    map.invalidateSize();
  });

  save.addEventListener("click", () => {
    if (!labelInput.value.trim()) {
      labelInput.classList.add("is-invalid");
      return;
    }
    const updated: Booth = {
      ...b,
      label: labelInput.value.trim(),
      location: locationInput.value.trim(),
      address: addressInput.value.trim(),
      health: healthSelect.value as HealthStatus,
      softwareVersion: b.softwareVersion, // réalité borne (heartbeat), jamais éditée ici (CIN-016)
      notes: notesInput.value.trim(),
      gpsLat: pickedLat,
      gpsLng: pickedLng,
      venueType: venueSelect.value || null,
      serial: serialInput.value.trim() || null, // readonly si non global_admin → valeur inchangée
    };
    store.upsertBooth(updated);
    modal.hide();
  });
  modalEl.addEventListener("hidden.bs.modal", () => {
    if (map) { map.remove(); map = null; }
    modalEl.remove();
  }, { once: true });
  modal.show();
}
