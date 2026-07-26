import { Modal } from "bootstrap";
import { CANONICAL_MOODS, videoPlayabilityHint } from "@kioskoscope/domain";
import type { Media } from "../domain/types";
import type { FleetStore } from "../data/store";
import { sha256Hex } from "../data/hash";
import { openPreview } from "./preview";
import { subtitleTracksPanel } from "./subtitles";
import { el } from "./dom";
import { t } from "../i18n";

// Page de gestion des médias (F8) + modale d'ajout/édition. CRUD sur Supabase,
// hachage SHA-256 côté client, anti-doublons imposé par la base, filtrage par
// tags d'audience, dashboard de lecture (top 10), et envoi batch vers plusieurs
// Kiosks en une action (crée des `media_instances`).

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m > 0 ? `${m} min` : `${seconds}s`;
}

/** Durée cumulée lisible : "3 h 12 min", "45 min", "0 min". */
function formatPlaytime(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** Signal sous-titres : un badge par langue (vert = calé/vérifié, ambre = à retravailler). */
function subtitleCell(store: FleetStore, m: Media): HTMLElement {
  const subs = store.subtitlesFor(m.id);
  if (subs.length === 0) return el("span", { class: "text-secondary" }, ["—"]);
  return el(
    "span",
    { class: "d-inline-flex flex-wrap gap-1" },
    subs.map((s) => {
      const verified = s.workflowStatus === "verified";
      return el(
        "span",
        { class: `badge ${verified ? "bg-green-lt" : "bg-yellow-lt"}`, title: verified ? "Sous-titres présents et calés (vérifiés)" : "Sous-titres à retravailler" },
        [`${s.lang.toUpperCase()}${verified ? " ✓" : ""}`],
      );
    }),
  );
}

/** Signal protection : DRM / chiffré / aucun. (La clé DRM vit sur la borne signée.) */
function protectionCell(m: Media): HTMLElement {
  const p = m.protection ?? "none";
  if (p === "drm") return el("span", { class: "badge bg-purple-lt", title: `Protégé DRM${m.drmScheme ? " · " + m.drmScheme : ""}` }, [`🔒 DRM${m.drmScheme ? " " + m.drmScheme : ""}`]);
  if (p === "encrypted") return el("span", { class: "badge bg-blue-lt", title: "Fichier chiffré" }, ["🔒 Chiffré"]);
  return el("span", { class: "text-secondary" }, ["—"]);
}

/** Signal vidéo : validée par l'opérateur / à valider / pas de fichier. */
function videoStatusCell(m: Media): HTMLElement {
  if (!m.storageUrl) return el("span", { class: "badge bg-secondary-lt", title: "Aucun fichier vidéo" }, ["—"]);
  if (m.reviewedAt) {
    return el("span", { class: "badge bg-green-lt", title: `Validée le ${new Date(m.reviewedAt).toLocaleDateString("fr-FR")}` }, ["✓ Validée"]);
  }
  return el("span", { class: "badge bg-yellow-lt", title: "À valider par l'opérateur (via l'aperçu)" }, ["À valider"]);
}

export function mediaPage(store: FleetStore, onChanged: () => void): HTMLElement {
  const all = store.mediaList();

  // Filtre par tag d'audience + sélection multiple (pour l'envoi batch).
  const tagSet = new Set<string>();
  for (const m of all) for (const t of m.audienceTags) tagSet.add(t);
  const state = { tag: null as string | null, selected: new Set<string>() };

  const container = el("div", {}, []);

  const render = (): HTMLElement => {
    const list = state.tag ? all.filter((m) => m.audienceTags.includes(state.tag!)) : all;
    // La sélection ne porte que sur les médias visibles (filtrés).
    const visibleIds = new Set(list.map((m) => m.id));
    for (const id of [...state.selected]) if (!visibleIds.has(id)) state.selected.delete(id);

    const chips = [...tagSet].sort().map((t) => {
      const b = el("button", { class: `chip ${state.tag === t ? "chip--on" : ""}`, type: "button" }, [t]);
      b.addEventListener("click", () => {
        state.tag = state.tag === t ? null : t;
        container.replaceChildren(render());
      });
      return b;
    });

    const selectAll = el("input", { class: "form-check-input m-0", type: "checkbox", "aria-label": "Tout sélectionner" }) as HTMLInputElement;
    selectAll.checked = list.length > 0 && list.every((m) => state.selected.has(m.id));
    selectAll.addEventListener("change", () => {
      if (selectAll.checked) for (const m of list) state.selected.add(m.id);
      else state.selected.clear();
      container.replaceChildren(render());
    });

    const rows = list.map((m) => {
      const check = el("input", { class: "form-check-input m-0", type: "checkbox", "aria-label": `Sélectionner ${m.title}` }) as HTMLInputElement;
      check.checked = state.selected.has(m.id);
      check.addEventListener("change", () => {
        if (check.checked) state.selected.add(m.id);
        else state.selected.delete(m.id);
        container.replaceChildren(render());
      });
      const boothCount = store.boothIdsForMedia(m.id).size;
      const coverage =
        boothCount > 0
          ? el("span", { class: "badge bg-green-lt" }, [`${boothCount} Kiosk${boothCount > 1 ? "s" : ""}`])
          : el("span", { class: "badge bg-secondary-lt", title: "Présent sur aucun Kiosk" }, ["—"]);

      return el("tr", {}, [
        el("td", {}, [check]),
        el("td", {}, [el("div", { class: "fw-bold" }, [m.title]), el("div", { class: "text-secondary small" }, [`${m.director || "—"} · ${m.year || "—"}`])]),
        el("td", { class: "text-secondary" }, [formatDuration(m.durationSeconds)]),
        el("td", { class: "text-secondary" }, [m.language.toUpperCase()]),
        el("td", {}, [el("span", { class: "d-inline-flex flex-wrap gap-1" }, m.audienceTags.map((t) => el("span", { class: "badge bg-secondary-lt" }, [t])))]),
        el("td", {}, [subtitleCell(store, m)]),
        el("td", {}, [videoStatusCell(m)]),
        el("td", {}, [protectionCell(m)]),
        el("td", {}, [coverage]),
        el("td", { class: "text-secondary text-nowrap" }, [m.contentHash ? m.contentHash.slice(0, 10) + "…" : "—"]),
        el("td", { class: "text-end" }, [rowActions(store, m, onChanged)]),
      ]);
    });

    const add = el("button", { class: "btn btn-primary", type: "button" }, ["Ajouter un média"]);
    add.addEventListener("click", () => openMediaForm(store, null, onChanged));

    const selCount = state.selected.size;
    const send = el(
      "button",
      { class: "btn btn-outline-primary", type: "button", ...(selCount === 0 ? { disabled: "true" } : {}) },
      [selCount === 0 ? "Envoyer vers des Kiosks" : `Envoyer ${selCount} média${selCount > 1 ? "s" : ""} →`],
    );
    send.addEventListener("click", () => {
      if (selCount > 0) openBatchModal(store, [...state.selected], onChanged);
    });

    return el("div", {}, [
      el("div", { class: "d-flex align-items-center justify-content-between mb-3 gap-2 flex-wrap" }, [
        el("div", {}, [el("h2", { class: "page-title m-0" }, [t("page.media")]), el("div", { class: "text-secondary" }, [`${all.length} média(s)`])]),
        el("div", { class: "btn-list" }, [send, add]),
      ]),
      statsPanel(store),
      tagSet.size > 0 ? el("div", { class: "chips mb-3" }, chips) : el("span", {}, []),
      list.length === 0
        ? el("div", { class: "card" }, [el("div", { class: "card-body text-secondary text-center py-5" }, ["Aucun média. Cliquez sur « Ajouter un média »."])])
        : el("div", { class: "card" }, [
            el("div", { class: "table-responsive" }, [
              el("table", { class: "table table-vcenter card-table" }, [
                el("thead", {}, [
                  el("tr", {}, [
                    el("th", { class: "w-1" }, [selectAll]),
                    el("th", {}, ["Titre"]),
                    el("th", {}, ["Durée"]),
                    el("th", {}, ["Langue"]),
                    el("th", {}, ["Tags d'audience"]),
                    el("th", {}, ["Sous-titres"]),
                    el("th", {}, ["Vidéo"]),
                    el("th", {}, ["Protection"]),
                    el("th", {}, ["Kiosks"]),
                    el("th", {}, ["Empreinte"]),
                    el("th", {}, []),
                  ]),
                ]),
                el("tbody", {}, rows),
              ]),
            ]),
          ]),
    ]);
  };

  container.replaceChildren(render());
  return container;
}

// ── Panneau statistiques de lecture (top 10) ─────────────────────────────────
function statsPanel(store: FleetStore): HTMLElement {
  const tile = (label: string, value: string): HTMLElement =>
    el("div", { class: "col-6 col-md-3" }, [
      el("div", { class: "card card-sm" }, [
        el("div", { class: "card-body" }, [
          el("div", { class: "text-secondary small text-uppercase" }, [label]),
          el("div", { class: "h2 m-0" }, [value]),
        ]),
      ]),
    ]);

  const kpis = el("div", { class: "row g-2 mb-2" }, [tile("Lectures totales", "…"), tile("Durée de lecture", "…")]);
  const topWrap = el("div", { class: "card mb-3" }, [
    el("div", { class: "card-body text-secondary" }, ["Chargement des statistiques de lecture…"]),
  ]);

  void store.mediaStats().then((s) => {
    kpis.replaceChildren(tile("Lectures totales", String(s.totalPlays)), tile("Durée de lecture", formatPlaytime(s.totalSeconds)));
    if (s.top.length === 0) {
      topWrap.replaceChildren(
        el("div", { class: "card-body text-secondary" }, ["Aucune lecture enregistrée pour l'instant (les Kiosks n'ont pas encore remonté de sessions)."]),
      );
      return;
    }
    const maxPlays = s.top[0]?.plays ?? 1;
    const rows = s.top.map((t, i) =>
      el("tr", {}, [
        el("td", { class: "text-secondary" }, [String(i + 1)]),
        el("td", { class: "fw-bold" }, [t.title]),
        el("td", { class: "text-end" }, [String(t.plays)]),
        el("td", { class: "text-end text-secondary" }, [formatPlaytime(t.playSeconds)]),
        el("td", { class: "w-50" }, [
          el("div", { class: "progress progress-sm" }, [
            el("div", { class: "progress-bar", style: `width:${Math.round((t.plays / maxPlays) * 100)}%`, role: "progressbar" }, []),
          ]),
        ]),
      ]),
    );
    topWrap.replaceChildren(
      el("div", { class: "card-header" }, [el("h3", { class: "card-title m-0" }, ["Top 10 des médias les plus lus"])]),
      el("div", { class: "table-responsive" }, [
        el("table", { class: "table table-vcenter card-table" }, [
          el("thead", {}, [el("tr", {}, [el("th", { class: "w-1" }, ["#"]), el("th", {}, ["Titre"]), el("th", { class: "text-end" }, ["Lectures"]), el("th", { class: "text-end" }, ["Durée"]), el("th", {}, [])])]),
          el("tbody", {}, rows),
        ]),
      ]),
    );
  });

  return el("div", {}, [kpis, topWrap]);
}

function rowActions(store: FleetStore, m: Media, onChanged: () => void): HTMLElement {
  const preview = el("button", { class: "btn btn-sm", type: "button" }, ["Aperçu"]);
  preview.addEventListener("click", () => openPreview(store, m, onChanged));
  const edit = el("button", { class: "btn btn-sm ms-1", type: "button" }, ["Modifier"]);
  edit.addEventListener("click", () => openMediaForm(store, m, onChanged));
  const del = el("button", { class: "btn btn-sm btn-outline-danger ms-1", type: "button" }, ["Suppr."]);
  del.addEventListener("click", () => {
    if (confirm(`Supprimer « ${m.title} » ?`)) void store.deleteMedia(m.id).then(onChanged);
  });
  return el("span", { class: "btn-list justify-content-end" }, [preview, edit, del]);
}

// ── Modale d'envoi batch vers des Kiosks ────────────────────────────────────
function openBatchModal(store: FleetStore, mediaIds: string[], onChanged: () => void): void {
  const titles = mediaIds
    .map((id) => store.mediaList().find((m) => m.id === id)?.title ?? "—")
    .slice(0, 5);
  const summary = mediaIds.length > 5 ? `${titles.join(", ")}… (+${mediaIds.length - 5})` : titles.join(", ");

  // Cibles possibles = Kiosks de l'organisation des médias sélectionnés (la RLS
  // garantit déjà qu'on ne voit que les siennes).
  const orgIds = new Set(mediaIds.map((id) => store.mediaList().find((m) => m.id === id)?.organizationId));
  const booths = store.visibleBooths().filter((b) => orgIds.has(b.organizationId));

  const checks = new Map<string, HTMLInputElement>();
  const boothRows = booths.map((b) => {
    const cb = el("input", { class: "form-check-input", type: "checkbox", id: `booth-${b.id}` }) as HTMLInputElement;
    checks.set(b.id, cb);
    return el("label", { class: "list-group-item d-flex align-items-center gap-2", for: `booth-${b.id}` }, [
      cb,
      el("span", { class: "flex-fill" }, [el("div", { class: "fw-bold" }, [b.label]), el("div", { class: "text-secondary small" }, [b.location || b.address || "—"])]),
    ]);
  });

  const error = el("div", { class: "alert alert-danger d-none" }, []);
  const feedback = el("div", { class: "text-secondary small" }, [`${mediaIds.length} média(s) : ${summary}`]);
  const confirm = el("button", { class: "btn btn-primary ms-auto", type: "button" }, ["Envoyer"]);

  const bodyContent =
    booths.length === 0
      ? el("div", { class: "text-secondary text-center py-4" }, ["Aucun Kiosk disponible pour cette organisation."])
      : el("div", { class: "list-group list-group-flush" }, boothRows);

  const modalEl = el("div", { class: "modal modal-blur fade", tabindex: "-1" }, [
    el("div", { class: "modal-dialog modal-dialog-centered" }, [
      el("div", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [
          el("h3", { class: "modal-title" }, ["Envoyer vers des Kiosks"]),
          el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" }, []),
        ]),
        el("div", { class: "modal-body" }, [feedback, error, bodyContent]),
        el("div", { class: "modal-footer" }, [el("button", { class: "btn", type: "button", "data-bs-dismiss": "modal" }, ["Annuler"]), confirm]),
      ]),
    ]),
  ]);
  document.body.append(modalEl);
  const modal = new Modal(modalEl);

  confirm.addEventListener("click", () => {
    error.classList.add("d-none");
    const boothIds = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
    if (boothIds.length === 0) {
      error.textContent = "Sélectionnez au moins un Kiosk.";
      error.classList.remove("d-none");
      return;
    }
    confirm.setAttribute("disabled", "true");
    confirm.textContent = "Envoi…";
    void store.sendMediaToBooths(mediaIds, boothIds).then((res) => {
      if (!res.ok) {
        error.textContent = res.error ?? "Échec de l'envoi.";
        error.classList.remove("d-none");
        confirm.removeAttribute("disabled");
        confirm.textContent = "Envoyer";
        return;
      }
      modal.hide();
      const parts = [`${res.created} présence(s) créée(s)`];
      if (res.skipped > 0) parts.push(`${res.skipped} déjà présente(s)`);
      if (res.boothsWithoutStorage > 0) parts.push(`${res.boothsWithoutStorage} Kiosk(s) sans support connu`);
      console.info("[media] envoi batch :", parts.join(" · "));
      onChanged();
    });
  });

  modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
  modal.show();
}

// ── Modale d'ajout / édition ─────────────────────────────────────────────────
export function openMediaForm(store: FleetStore, existing: Media | null, onChanged: () => void): void {
  const isNew = existing === null;
  const orgs = store.organizations();
  const identity = store.current;
  const defaultOrg = identity?.activeOrganizationId ?? orgs[0]?.id ?? "";

  const base: Media =
    existing ??
    ({
      id: crypto.randomUUID(),
      organizationId: defaultOrg,
      contentHash: "",
      title: "",
      year: new Date().getFullYear(),
      durationSeconds: 0,
      storageUrl: null,
      version: 1,
      active: true,
      tmdbId: null,
      genres: [],
      moods: [],
      tags: [],
      audienceTags: [],
      language: "fr",
      subtitles: [],
      director: "",
      synopsis: "",
      stills: [],
      learnMoreUrl: null,
      reviewedAt: null,
      reviewedBy: null,
    } satisfies Media);

  let file: File | null = null;
  let computedHash = base.contentHash;

  const field = (label: string, input: HTMLElement): HTMLElement =>
    el("div", { class: "col-md-6 mb-3" }, [el("label", { class: "form-label" }, [label]), input]);

  const title = el("input", { class: "form-control", type: "text", value: base.title }) as HTMLInputElement;
  const director = el("input", { class: "form-control", type: "text", value: base.director }) as HTMLInputElement;
  const year = el("input", { class: "form-control", type: "number", value: String(base.year) }) as HTMLInputElement;
  const duration = el("input", { class: "form-control", type: "number", value: String(base.durationSeconds), placeholder: "secondes" }) as HTMLInputElement;
  const language = el("input", { class: "form-control", type: "text", value: base.language, maxlength: "5" }) as HTMLInputElement;
  const audienceTags = el("input", { class: "form-control", type: "text", value: base.audienceTags.join(", "), placeholder: "18+, bar, enfant…" }) as HTMLInputElement;
  const genres = el("input", { class: "form-control", type: "text", value: base.genres.join(", "), placeholder: "drame, expérimental, animation…" }) as HTMLInputElement;
  const tags = el("input", { class: "form-control", type: "text", value: base.tags.join(", "), placeholder: "nuit, lent, contemplatif…" }) as HTMLInputElement;
  const tmdbId = el("input", { class: "form-control", type: "number", value: base.tmdbId === null ? "" : String(base.tmdbId), placeholder: "id TMDB (optionnel)" }) as HTMLInputElement;

  // Humeurs = vocabulaire CONTRÔLÉ (source unique CANONICAL_MOODS) : une case par
  // humeur canonique → garantit le match reco + palette Kiosk (pas de texte libre).
  const moodChecks = CANONICAL_MOODS.map((m) => {
    const input = el("input", { class: "form-check-input", type: "checkbox", value: m.key, ...(base.moods.includes(m.key) ? { checked: "checked" } : {}) }) as HTMLInputElement;
    const label = el("label", { class: "form-check form-check-inline" }, [input, el("span", { class: "form-check-label" }, [m.label])]);
    return { key: m.key, input, label };
  });
  const moods = el("div", { class: "d-flex flex-wrap gap-1" }, moodChecks.map((c) => c.label));
  const protection = el("select", { class: "form-select" }, (["none", "encrypted", "drm"] as const).map((p) => el("option", { value: p, ...((base.protection ?? "none") === p ? { selected: "selected" } : {}) }, [p === "none" ? "Aucune" : p === "encrypted" ? "Chiffré" : "DRM"]))) as HTMLSelectElement;
  const drmScheme = el("input", { class: "form-control", type: "text", value: base.drmScheme ?? "", placeholder: "widevine, playready… (si DRM)" }) as HTMLInputElement;
  const synopsis = el("textarea", { class: "form-control", rows: "2" }, [base.synopsis]) as HTMLTextAreaElement;

  // Le sélecteur d'organisation n'a de sens que s'il y a VRAIMENT un choix à faire : un
  // global_admin n'a pas d'org active (`activeOrganizationId: null`) et doit donc désigner la
  // destination du média. Un opérateur mono-org, lui, est déjà DANS son organisation : lui
  // présenter une liste à une seule entrée transforme un contexte acquis en décision à prendre
  // (retour de session de test, 2026-07-26). L'élément reste construit — `orgSelect.value` alimente
  // l'enregistrement — mais il n'est monté dans le formulaire que s'il arbitre quelque chose.
  const orgSelect = el(
    "select",
    { class: "form-select" },
    orgs.map((o) => el("option", { value: o.id, ...(o.id === base.organizationId ? { selected: "selected" } : {}) }, [o.name])),
  ) as HTMLSelectElement;
  const needsOrgChoice = orgs.length > 1;

  const fileInput = el("input", { class: "form-control", type: "file", accept: "video/*" }) as HTMLInputElement;
  const hashInfo = el("div", { class: "form-hint" }, [isNew ? "Choisissez un fichier : son empreinte SHA-256 est calculée pour détecter les doublons." : "Empreinte existante conservée."]);
  // Garde-fou codec (CIN-022) : on avertit DÈS la sélection du fichier, avant tout téléversement —
  // découvrir en cabine qu'un film reste noir coûte infiniment plus cher qu'un avertissement ici.
  // Volontairement NON bloquant : l'heuristique porte sur le conteneur, pas sur le codec réel
  // (cf. `videoPlayabilityHint`), donc elle n'a pas autorité pour refuser un fichier.
  const codecInfo = el("div", { class: "mt-1" }, []);
  const showCodecHint = (name: string): void => {
    const hint = videoPlayabilityHint(name);
    if (hint.verdict === "playable") {
      codecInfo.className = "form-hint mt-1 text-green";
      codecInfo.textContent = hint.message;
      return;
    }
    codecInfo.className = hint.verdict === "transcode" ? "alert alert-warning py-2 mt-1 mb-0" : "form-hint mt-1 text-yellow";
    codecInfo.textContent = hint.message;
  };
  fileInput.addEventListener("change", () => {
    file = fileInput.files?.[0] ?? null;
    if (!file) {
      codecInfo.replaceChildren();
      return;
    }
    showCodecHint(file.name);
    hashInfo.textContent = "Calcul de l'empreinte…";
    void sha256Hex(file).then((h) => {
      computedHash = h;
      if (!title.value) title.value = file!.name.replace(/\.[^.]+$/, "");
      hashInfo.textContent = `Empreinte : ${h.slice(0, 24)}…`;
    });
  });

  const error = el("div", { class: "alert alert-danger d-none" }, []);
  const save = el("button", { class: "btn btn-primary ms-auto", type: "button" }, [isNew ? "Ajouter" : "Enregistrer"]);

  const body = el("div", {}, [
    error,
    el("div", { class: "row" }, [
      ...(needsOrgChoice ? [field("Organisation", orgSelect)] : []),
      field("Fichier vidéo", el("div", {}, [fileInput, hashInfo, codecInfo])),
      field("Titre", title),
      field("Réalisateur", director),
      field("Année", year),
      field("Durée (secondes)", duration),
      field("Langue (ISO)", language),
      field("Tags d'audience", audienceTags),
      field("Protection", protection),
      field("Schéma DRM", drmScheme),
    ]),
    el("div", { class: "mb-2" }, [el("label", { class: "form-label" }, ["Synopsis"]), synopsis]),
    el("div", { class: "hr-text" }, ["Métadonnées éditoriales (reco)"]),
    el("div", { class: "row" }, [
      el("div", { class: "col-12 mb-3" }, [el("label", { class: "form-label" }, ["Humeurs"]), moods, el("div", { class: "form-hint" }, ["Détermine la reco par humeur et le thème couleur en Kiosk."])]),
      field("Genres", genres),
      field("Tags éditoriaux", tags),
      field("TMDB id", tmdbId),
    ]),
    el("div", { class: "hr-text" }, ["Sous-titres"]),
    // CIN-094 : les pistes se gèrent ici (métadonnée du média), plus seulement dans l'écran de
    // validation. Un média non encore enregistré n'a ni ligne en base ni empreinte figée : la
    // clé étrangère et le chemin de stockage n'existent pas, on ne peut donc rien y rattacher.
    isNew
      ? el("div", { class: "text-secondary small fst-italic" }, [
          "Enregistrez d'abord le média : les pistes de sous-titres se rattachent à une fiche existante.",
        ])
      : subtitleTracksPanel(store, base, onChanged),
  ]);

  const modalEl = el("div", { class: "modal modal-blur fade", tabindex: "-1" }, [
    el("div", { class: "modal-dialog modal-lg modal-dialog-centered" }, [
      el("div", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [
          el("h3", { class: "modal-title" }, [isNew ? "Nouveau média" : "Modifier le média"]),
          el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" }, []),
        ]),
        el("div", { class: "modal-body" }, [body]),
        el("div", { class: "modal-footer" }, [el("button", { class: "btn", type: "button", "data-bs-dismiss": "modal" }, ["Annuler"]), save]),
      ]),
    ]),
  ]);
  document.body.append(modalEl);
  const modal = new Modal(modalEl);

  save.addEventListener("click", () => {
    error.classList.add("d-none");
    if (!title.value.trim()) {
      title.classList.add("is-invalid");
      return;
    }
    if (isNew && !file) {
      error.textContent = "Un fichier vidéo est requis (pour calculer l'empreinte).";
      error.classList.remove("d-none");
      return;
    }
    const parseTags = (s: string): string[] => s.split(",").map((t) => t.trim()).filter(Boolean);
    const media: Media = {
      ...base,
      organizationId: orgSelect.value,
      contentHash: computedHash,
      title: title.value.trim(),
      director: director.value.trim(),
      year: Number(year.value) || 0,
      durationSeconds: Number(duration.value) || 0,
      language: language.value.trim() || "fr",
      audienceTags: parseTags(audienceTags.value),
      genres: parseTags(genres.value),
      tags: parseTags(tags.value),
      moods: moodChecks.filter((c) => c.input.checked).map((c) => c.key),
      tmdbId: Number(tmdbId.value) || null,
      synopsis: synopsis.value.trim(),
      protection: protection.value as "none" | "encrypted" | "drm",
      drmScheme: drmScheme.value.trim() || null,
    };

    save.setAttribute("disabled", "true");
    save.textContent = "Enregistrement…";
    const done = (res: { ok: boolean; error?: string }): void => {
      if (res.ok) {
        modal.hide();
        onChanged();
      } else {
        error.textContent = res.error ?? "Erreur.";
        error.classList.remove("d-none");
        save.removeAttribute("disabled");
        save.textContent = isNew ? "Ajouter" : "Enregistrer";
      }
    };
    if (isNew) void store.addMedia(media, file).then(done);
    else void store.updateMedia(media).then(() => done({ ok: true }));
  });

  modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
  modal.show();
}
