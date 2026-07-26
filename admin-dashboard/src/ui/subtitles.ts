import type { Media } from "../domain/types";
import type { FleetStore, SubtitleRecord } from "../data/store";
import { el, icon, toast } from "./dom";
import { cuesToVtt, parseSubtitles } from "../data/vtt";

// Panneau « pistes de sous-titres » d'un média (CIN-094, 1ʳᵉ tranche).
//
// POURQUOI ICI. Jusqu'ici, attacher un sous-titre passait UNIQUEMENT par l'écran de validation
// (aperçu vidéo + calage). Or déposer un fichier déjà calé par le distributeur n'est pas un acte
// de validation : c'est de la saisie de métadonnées, au même titre que le titre ou la durée.
// Le geste vit donc désormais dans « Modifier un média ». Le calage fin reste dans l'aperçu —
// deux parcours distincts pour deux intentions distinctes.
//
// UNE PISTE = UNE LANGUE. C'est la règle qui lève l'ambiguïté signalée : ajouter une 2ᵉ langue
// n'écrase jamais la 1ʳᵉ ; seul un ré-envoi de la MÊME langue remplace, et l'écran le dit avant.

/** Langues proposées (suggestions, pas une contrainte : le champ accepte tout code ISO). */
const COMMON_LANGS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "fr", label: "Français" },
  { code: "en", label: "Anglais" },
  { code: "es", label: "Espagnol" },
  { code: "de", label: "Allemand" },
  { code: "it", label: "Italien" },
  { code: "pt", label: "Portugais" },
  { code: "nl", label: "Néerlandais" },
];

function langLabel(code: string): string {
  return COMMON_LANGS.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

// ── Détection d'ambiguïté de code langue ─────────────────────────────────────
// Deux pistes « de la même langue » sous deux codes différents (`fr` et `fr-FR`, `fr` et `fra`)
// se retrouvent côte à côte à l'écran de lecture sans que rien ne les distingue : le spectateur
// choisit au hasard. Un code hors norme (`français`, `FRA`) pose le même problème un cran plus
// tôt — la cabine ne saura pas l'étiqueter. On ne BLOQUE pas (un cas légitime existe : `pt` et
// `pt-BR`), on rend le risque visible avant l'envoi.

/** Forme attendue : ISO 639-1, éventuellement suffixé d'une région (`fr`, `pt-BR`). */
const WELL_FORMED_LANG = /^[a-z]{2}(-[a-z]{2})?$/;

/** Racine linguistique d'un code : `pt-BR` → `pt`. Sert à repérer les doublons déguisés. */
function baseLang(code: string): string {
  return code.split(/[-_]/)[0] ?? code;
}

/**
 * Avertissements pour un code saisi, au regard des pistes déjà présentes.
 * Renvoie une liste (vide = rien à signaler) — jamais une erreur bloquante.
 */
function langWarnings(lang: string, tracks: readonly SubtitleRecord[]): string[] {
  const out: string[] = [];
  if (!lang) return out;

  if (!WELL_FORMED_LANG.test(lang)) {
    out.push(
      lang.length === 3
        ? `« ${lang} » ressemble à un code ISO 639-2. La cabine attend un code à 2 lettres (ISO 639-1) : « ${lang.slice(0, 2)} » par exemple.`
        : `Code langue inhabituel : « ${lang} ». Utilisez un code à 2 lettres (fr, en, es…), éventuellement régionalisé (pt-BR).`,
    );
  }

  const exact = tracks.some((s) => s.lang === lang);
  if (exact) {
    out.push(`Une piste « ${langLabel(lang)} » existe déjà : elle sera REMPLACÉE. Les autres langues ne bougent pas.`);
  } else {
    // Même racine, code différent → deux entrées indiscernables à l'écran de lecture.
    const cousins = tracks.filter((s) => baseLang(s.lang) === baseLang(lang)).map((s) => s.lang);
    if (cousins.length > 0) {
      out.push(
        `⚠️ Deux pistes de la même langue : « ${cousins.join(" », « ")} » et « ${lang} ». En cabine, elles s'afficheront côte à côte sans distinction — préférez un seul code, ou régionalisez les DEUX (ex. fr-FR et fr-CA).`,
      );
    }
  }
  return out;
}

/** Ambiguïtés DÉJÀ enregistrées (pistes existantes), à signaler en permanence. */
function existingAmbiguities(tracks: readonly SubtitleRecord[]): string[] {
  const byBase = new Map<string, string[]>();
  for (const s of tracks) {
    const b = baseLang(s.lang);
    byBase.set(b, [...(byBase.get(b) ?? []), s.lang]);
  }
  const out: string[] = [];
  for (const [base, codes] of byBase) {
    if (codes.length > 1) out.push(`⚠️ ${codes.length} pistes « ${base} » (${codes.join(", ")}) — indistinguables pour le spectateur.`);
  }
  for (const s of tracks) {
    if (!WELL_FORMED_LANG.test(s.lang)) out.push(`⚠️ Code langue non standard : « ${s.lang} » — la cabine risque de mal l'étiqueter.`);
  }
  return out;
}

/** Libellé lisible du statut de workflow d'une piste. */
function statusBadge(s: SubtitleRecord): HTMLElement {
  const verified = s.workflowStatus === "verified";
  return el("span", { class: `badge ${verified ? "bg-green-lt" : "bg-yellow-lt"}` }, [
    verified ? "Vérifié" : String(s.workflowStatus ?? "à vérifier"),
  ]);
}

/**
 * Tableau des pistes + ajout d'une piste. `media` DOIT déjà exister en base : le chemin de
 * stockage dérive de son empreinte et la ligne `subtitles` porte une clé étrangère vers lui.
 * Pour un média non encore enregistré, l'appelant affiche un repère à la place (cf. `media.ts`).
 */
export function subtitleTracksPanel(store: FleetStore, media: Media, onChanged: () => void): HTMLElement {
  const container = el("div", {}, []);

  const render = (): void => {
    const tracks = store.subtitlesFor(media.id);

    const rows = tracks.map((s) => {
      const del = el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: `Supprimer la piste ${langLabel(s.lang)}` }, [
        icon("M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12M9 7V4h6v3", 16),
      ]);
      del.addEventListener("click", () => {
        if (!confirm(`Supprimer la piste « ${langLabel(s.lang)} » ? Les autres langues sont conservées. Action définitive.`)) return;
        del.setAttribute("disabled", "true");
        void store.deleteSubtitle(s).then((res) => {
          if (res.ok) {
            toast(`Piste ${langLabel(s.lang)} supprimée ✓`);
            render();
            onChanged();
          } else {
            del.removeAttribute("disabled");
            toast(res.error ?? "Suppression échouée.", "error");
          }
        });
      });
      return el("tr", {}, [
        el("td", {}, [
          el("span", { class: "fw-bold" }, [langLabel(s.lang)]),
          el("span", { class: "text-secondary small ms-2 font-monospace" }, [s.lang]),
        ]),
        el("td", { class: "text-secondary text-uppercase small" }, [s.format]),
        el("td", {}, [statusBadge(s)]),
        el("td", { class: "text-end" }, [del]),
      ]);
    });

    const table =
      tracks.length === 0
        ? el("div", { class: "text-secondary small fst-italic py-2" }, [
            "Aucune piste. Sans sous-titres, la cabine ne proposera que « Sans » à l'écran de lecture.",
          ])
        : el("div", { class: "table-responsive" }, [
            el("table", { class: "table table-sm table-vcenter mb-0" }, [
              el("thead", {}, [
                el("tr", {}, [el("th", {}, ["Langue"]), el("th", {}, ["Format"]), el("th", {}, ["Statut"]), el("th", {}, [])]),
              ]),
              el("tbody", {}, rows),
            ]),
          ]);

    // ── Ajout d'une piste ─────────────────────────────────────────────────────
    const listId = `langs-${media.id}`;
    const datalist = el("datalist", { id: listId }, COMMON_LANGS.map((l) => el("option", { value: l.code }, [l.label])));
    const langInput = el("input", {
      class: "form-control",
      type: "text",
      list: listId,
      placeholder: "fr",
      maxlength: "5",
      spellcheck: "false",
      autocomplete: "off",
      style: "max-width:7rem",
    }) as HTMLInputElement;

    const fileInput = el("input", {
      class: "form-control",
      type: "file",
      accept: ".vtt,.srt,text/vtt,application/x-subrip",
    }) as HTMLInputElement;

    const hint = el("div", { class: "form-hint mt-1" }, []);
    const addBtn = el("button", { class: "btn btn-primary", type: "button" }, ["Ajouter la piste"]);

    // Prévient AVANT l'envoi qu'une langue déjà présente sera remplacée : c'est exactement le
    // point où l'on croyait « ajouter » et où l'on écrasait.
    const refreshHint = (): void => {
      const lang = langInput.value.trim().toLowerCase();
      const warnings = langWarnings(lang, tracks);
      if (warnings.length === 0) {
        hint.className = "form-hint mt-1";
        hint.replaceChildren("Fichier .srt ou .vtt déjà calé. Une piste par langue ; ajouter une langue n'efface pas les autres.");
        return;
      }
      hint.className = "form-hint mt-1 text-yellow";
      hint.replaceChildren(...warnings.map((w) => el("div", {}, [w])));
    };
    langInput.addEventListener("input", refreshHint);
    refreshHint();

    addBtn.addEventListener("click", () => {
      const lang = langInput.value.trim().toLowerCase();
      const file = fileInput.files?.[0];
      if (!lang) {
        toast("Indiquez la langue de la piste (ex. fr).", "error");
        return;
      }
      if (!file) {
        toast("Choisissez un fichier .srt ou .vtt.", "error");
        return;
      }
      addBtn.setAttribute("disabled", "true");
      void file
        .text()
        .then((text) => {
          const cues = parseSubtitles(text);
          if (cues.length === 0) {
            // Un fichier illisible produit 0 cue : l'envoyer créerait une piste vide que la
            // cabine proposerait sans rien afficher — pire qu'une absence de piste.
            throw new Error("Fichier illisible ou vide : aucun sous-titre détecté.");
          }
          // Normalisation en VTT sans décalage : le fichier est réputé déjà calé (le calage
          // fin, lui, vit dans l'écran d'aperçu).
          return store.saveSubtitle(media, lang, cuesToVtt(cues, 0));
        })
        .then((res) => {
          if (!res.ok) throw new Error(res.error ?? "Échec de l'enregistrement.");
          toast(`Piste ${langLabel(lang)} enregistrée ✓`);
          langInput.value = "";
          fileInput.value = "";
          render();
          onChanged();
        })
        .catch((e: unknown) => {
          addBtn.removeAttribute("disabled");
          toast(e instanceof Error ? e.message : "Échec de l'ajout de la piste.", "error");
        });
    });

    // Ambiguïtés déjà en base : signalées en permanence, pas seulement au moment d'ajouter —
    // sinon on ne les découvre qu'en rouvrant par hasard le bon écran.
    const ambiguities = existingAmbiguities(tracks);
    const ambiguityBanner =
      ambiguities.length === 0
        ? el("span", {}, [])
        : el("div", { class: "alert alert-warning py-2 mb-2" }, [
            el("div", {}, [
              el("div", { class: "fw-bold mb-1" }, ["Pistes ambiguës"]),
              ...ambiguities.map((a) => el("div", { class: "small" }, [a])),
            ]),
          ]);

    container.replaceChildren(
      el("div", { class: "card" }, [
        el("div", { class: "card-body" }, [
          ambiguityBanner,
          table,
          el("hr", {}, []),
          el("div", { class: "d-flex flex-wrap align-items-start gap-2" }, [
            datalist,
            el("div", {}, [el("label", { class: "form-label small" }, ["Langue"]), langInput]),
            el("div", { class: "flex-grow-1", style: "min-width:14rem" }, [
              el("label", { class: "form-label small" }, ["Fichier de sous-titres"]),
              fileInput,
            ]),
            el("div", { class: "align-self-end" }, [addBtn]),
          ]),
          hint,
        ]),
      ]),
    );
  };

  render();
  return container;
}
