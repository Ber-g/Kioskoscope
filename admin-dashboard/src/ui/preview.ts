import { Modal } from "bootstrap";
import type { Media } from "../domain/types";
import type { FleetStore } from "../data/store";
import { el } from "./dom";
import { cuesToVtt, parseSubtitles, shiftCues, type Cue } from "../data/vtt";

// Aperçu média (F8) + calage global des sous-titres (amorce F12). Lit la vidéo via
// URL signée (bucket privé), superpose une piste de sous-titres et permet de la
// décaler (offset ±s) en direct, puis d'enregistrer la piste calée (offset baké
// dans le VTT). Le calage ligne-par-ligne reste hors périmètre (éditeur F12).

const OFFSET_RANGE = 30; // ± secondes couverts par le slider

export function openPreview(store: FleetStore, media: Media, onChanged: () => void): void {
  let cues: Cue[] = [];
  let offset = 0;
  let track: TextTrack | null = null;

  // ── Lecteur vidéo ──────────────────────────────────────────────────────────
  const video = el("video", { class: "w-100 rounded bg-dark", controls: "true", preload: "metadata", style: "max-height:52vh" }) as HTMLVideoElement;
  const videoWrap = el("div", { class: "mb-3" }, [el("div", { class: "text-secondary text-center py-5" }, ["Chargement de la vidéo…"])]);

  const protection = media.protection ?? "none";
  if (protection !== "none") {
    videoWrap.replaceChildren(
      el("div", { class: "alert alert-warning mb-0" }, [
        `Contenu protégé (${protection === "drm" ? "DRM" + (media.drmScheme ? " · " + media.drmScheme : "") : "chiffré"}) — aperçu indisponible ici. La lecture se fera sur une borne signée (pipeline DRM à venir).`,
      ]),
    );
  } else void store.signedUrl(media.storageUrl).then((url) => {
    if (url) {
      video.src = url;
      videoWrap.replaceChildren(video);
    } else {
      videoWrap.replaceChildren(
        el("div", { class: "alert alert-warning mb-0" }, [
          media.storageUrl ? "Impossible de générer un lien de lecture." : "Aucun fichier vidéo pour ce média — ajoutez-en un via « Modifier » pour l'aperçu.",
        ]),
      );
    }
  });

  // ── Validation opérateur de la vidéo ────────────────────────────────────────
  const reviewed = { at: media.reviewedAt };
  const validateWrap = el("div", { class: "d-flex align-items-center gap-2 mb-3 flex-wrap" }, []);
  const renderValidate = (): void => {
    validateWrap.replaceChildren();
    if (!media.storageUrl) return; // rien à valider sans fichier
    if (reviewed.at) {
      const when = new Date(reviewed.at).toLocaleDateString("fr-FR");
      const undo = el("button", { class: "btn btn-sm", type: "button" }, ["Retirer la validation"]);
      undo.addEventListener("click", () => toggleReview(false));
      validateWrap.append(el("span", { class: "badge bg-green-lt" }, [`✓ Vidéo validée le ${when}`]), undo);
    } else {
      const btn = el("button", { class: "btn btn-success", type: "button" }, ["✓ Valider la vidéo"]);
      btn.addEventListener("click", () => toggleReview(true));
      validateWrap.append(btn, el("span", { class: "text-secondary small" }, ["Confirme que la vidéo est correcte (visionnée par l'opérateur)."]));
    }
  };
  const toggleReview = (v: boolean): void => {
    validateWrap.replaceChildren(el("span", { class: "text-secondary small" }, ["Enregistrement…"]));
    void store.setMediaReviewed(media, v).then((res) => {
      if (res.ok) {
        reviewed.at = v ? Date.now() : null;
        renderValidate();
        onChanged();
      } else {
        renderValidate();
        validateWrap.append(el("span", { class: "text-danger small" }, [res.error ?? "Échec."]));
      }
    });
  };
  renderValidate();

  // ── Piste de sous-titres (rendu natif via TextTrack, mis à jour en direct) ───
  const applyCues = (): void => {
    if (!track) track = video.addTextTrack("subtitles", "Sous-titres", langInput.value || "fr");
    while (track.cues && track.cues.length > 0) track.removeCue(track.cues[0]!);
    for (const c of cues) {
      const s = Math.max(0, c.start + offset);
      const e = Math.max(0, c.end + offset);
      if (e > s) track.addCue(new VTTCue(s, e, c.text));
    }
    track.mode = "showing";
  };

  // ── Contrôles de calage (cachés tant qu'aucune piste n'est chargée) ──────────
  const langInput = el("input", { class: "form-control", type: "text", value: media.language || "fr", maxlength: "5", style: "max-width:6rem" }) as HTMLInputElement;

  const offsetRange = el("input", { class: "form-range", type: "range", min: String(-OFFSET_RANGE), max: String(OFFSET_RANGE), step: "0.1", value: "0" }) as HTMLInputElement;
  const offsetLabel = el("span", { class: "badge bg-blue-lt", style: "min-width:5rem" }, ["+0.0 s"]);
  const setOffset = (v: number): void => {
    offset = Math.round(v * 10) / 10;
    offsetRange.value = String(offset);
    offsetLabel.textContent = `${offset >= 0 ? "+" : ""}${offset.toFixed(1)} s`;
    applyCues();
  };
  offsetRange.addEventListener("input", () => setOffset(Number(offsetRange.value)));
  const reset = el("button", { class: "btn btn-sm", type: "button" }, ["Réinitialiser"]);
  reset.addEventListener("click", () => setOffset(0));

  const cueCount = el("div", { class: "text-secondary small" }, []);
  const status = el("div", { class: "small" }, []);
  const save = el("button", { class: "btn btn-primary", type: "button" }, ["Enregistrer la piste calée"]);
  save.addEventListener("click", () => {
    status.textContent = "";
    status.className = "small text-secondary";
    if (cues.length === 0) return;
    save.setAttribute("disabled", "true");
    save.textContent = "Enregistrement…";
    const vtt = cuesToVtt(cues, offset);
    void store.saveSubtitle(media, langInput.value, vtt).then((res) => {
      save.removeAttribute("disabled");
      save.textContent = "Enregistrer la piste calée";
      if (res.ok) {
        // L'offset est désormais dans le fichier : on l'intègre aux cues et on remet à 0.
        cues = shiftCues(cues, offset);
        setOffset(0);
        status.className = "small text-green";
        status.textContent = "Piste enregistrée ✓";
        onChanged();
      } else {
        status.className = "small text-danger";
        status.textContent = res.error ?? "Échec de l'enregistrement.";
      }
    });
  });

  const controls = el("div", { class: "card d-none" }, [
    el("div", { class: "card-body" }, [
      el("div", { class: "d-flex align-items-center gap-2 mb-2 flex-wrap" }, [
        el("label", { class: "form-label m-0 me-1" }, ["Langue"]),
        langInput,
        cueCount,
      ]),
      el("label", { class: "form-label" }, ["Décalage des sous-titres"]),
      el("div", { class: "d-flex align-items-center gap-3" }, [offsetRange, offsetLabel, reset]),
      el("div", { class: "d-flex align-items-center gap-3 mt-3" }, [save, status]),
    ]),
  ]);

  const loadCues = (parsed: Cue[], lang?: string): void => {
    if (parsed.length === 0) {
      status.className = "small text-danger";
      status.textContent = "Aucune réplique détectée dans ce fichier.";
      controls.classList.remove("d-none");
      cueCount.textContent = "";
      return;
    }
    cues = parsed;
    if (lang) langInput.value = lang;
    setOffset(0);
    cueCount.textContent = `${parsed.length} réplique${parsed.length > 1 ? "s" : ""}`;
    status.textContent = "";
    controls.classList.remove("d-none");
  };

  // Réinitialise l'éditeur (après suppression de la piste en cours d'édition).
  const resetEditor = (): void => {
    cues = [];
    if (track) {
      while (track.cues && track.cues.length > 0) track.removeCue(track.cues[0]!);
      track.mode = "hidden";
    }
    controls.classList.add("d-none");
    cueCount.textContent = "";
    status.textContent = "";
  };

  // ── Sources de sous-titres : pistes existantes (charger / supprimer) + import ─
  const existing = store.subtitlesFor(media.id);
  const placeholder = el("span", { class: "text-secondary small" }, ["aucune piste enregistrée"]);
  const pillsWrap = el("span", { class: "d-inline-flex align-items-center gap-2 flex-wrap" }, []);

  const makePill = (s: (typeof existing)[number]): HTMLElement => {
    const load = el("button", { class: "btn btn-sm", type: "button" }, [`Charger « ${s.lang} »`]);
    load.addEventListener("click", () => {
      status.className = "small text-secondary";
      status.textContent = "Chargement de la piste…";
      controls.classList.remove("d-none");
      void store.fetchSubtitleText(s.url).then((text) => {
        if (text === null) {
          status.className = "small text-danger";
          status.textContent = "Impossible de charger cette piste.";
          return;
        }
        loadCues(parseSubtitles(text), s.lang);
      });
    });
    const del = el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: `Supprimer la piste « ${s.lang} »` }, ["✕"]);
    const group = el("span", { class: "btn-group" }, [load, del]);
    del.addEventListener("click", () => {
      if (!confirm(`Supprimer la piste de sous-titres « ${s.lang} » ? Cette action est définitive.`)) return;
      del.setAttribute("disabled", "true");
      void store.deleteSubtitle(s).then((res) => {
        if (res.ok) {
          group.remove();
          if (langInput.value.trim().toLowerCase() === s.lang) resetEditor();
          if (pillsWrap.querySelector(".btn-group") === null) pillsWrap.append(placeholder);
          onChanged();
        } else {
          del.removeAttribute("disabled");
          status.className = "small text-danger";
          status.textContent = res.error ?? "Suppression échouée.";
        }
      });
    });
    return group;
  };

  if (existing.length > 0) for (const s of existing) pillsWrap.append(makePill(s));
  else pillsWrap.append(placeholder);

  const fileInput = el("input", { class: "form-control", type: "file", accept: ".vtt,.srt,text/vtt,application/x-subrip", style: "max-width:20rem" }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.text().then((text) => loadCues(parseSubtitles(text)));
  });

  const subsSection = el("div", {}, [
    el("div", { class: "d-flex align-items-center gap-2 mb-2 flex-wrap" }, [
      el("span", { class: "text-secondary" }, ["Sous-titres :"]),
      pillsWrap,
    ]),
    el("div", { class: "d-flex align-items-center gap-2 mb-3 flex-wrap" }, [
      el("span", { class: "text-secondary small" }, ["Importer .srt / .vtt :"]),
      fileInput,
    ]),
    controls,
  ]);

  // ── Modale ───────────────────────────────────────────────────────────────────
  const modalEl = el("div", { class: "modal modal-blur fade", tabindex: "-1" }, [
    el("div", { class: "modal-dialog modal-xl modal-dialog-centered" }, [
      el("div", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [
          el("h3", { class: "modal-title" }, [`Validation — ${media.title}`]),
          el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" }, []),
        ]),
        el("div", { class: "modal-body" }, [videoWrap, validateWrap, subsSection]),
        el("div", { class: "modal-footer" }, [el("button", { class: "btn", type: "button", "data-bs-dismiss": "modal" }, ["Fermer"])]),
      ]),
    ]),
  ]);
  document.body.append(modalEl);
  const modal = new Modal(modalEl);
  modalEl.addEventListener("hidden.bs.modal", () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
    modalEl.remove();
  }, { once: true });
  modal.show();
}
