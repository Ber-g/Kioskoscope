import type { Media } from "../domain/types";
import type { FleetStore } from "../data/store";
import { el, icon, toast } from "./dom";
import { COMMON_LANGS, existingAmbiguities, langLabel, langWarnings } from "./trackLang";
import { judgeVideoCodec, probeMp4, videoPlayabilityHint } from "@kioskoscope/domain";
import { fileByteReader } from "../data/hash";
import { uploadProgressPanel } from "./uploadProgress";

// Tableau des VERSIONS VIDÉO d'un média (CIN-095) — pendant exact du tableau des sous-titres.
//
// Une version = une langue. Ajouter une langue n'écrase jamais les autres ; seul un ré-envoi de
// la MÊME langue remplace, et l'écran le dit avant. C'est la règle qui a manqué et qui rendait
// l'ajout d'une 2ᵉ piste incompréhensible.
//
// ⚠️ UNE SEULE version est servie aux cabines (« primaire ») : la borne lit toujours
// `media.storage_url`, qu'on aligne sur elle. Tant que la cabine ne sait pas choisir une version,
// les autres langues sont stockées mais NON diffusées — l'UI doit le dire sans détour, sinon on
// croit avoir mis un film en anglais en ligne alors que la borne joue toujours le français.

/** Poids lisible. `null` pour les fichiers d'avant le suivi (l'info n'a jamais été capturée). */
function humanSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  const mo = bytes / (1024 * 1024);
  return mo < 1024 ? `${mo.toFixed(mo < 10 ? 1 : 0)} Mo` : `${(mo / 1024).toFixed(2)} Go`;
}

function humanDate(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Panneau « Vidéos » d'un média. `media` doit déjà exister en base (le chemin de stockage dérive
 * de son empreinte). Pour un média non enregistré, l'appelant affiche un repère à la place.
 */
export function videoVersionsPanel(store: FleetStore, media: Media, onChanged: () => void): HTMLElement {
  const container = el("div", {}, []);
  let addOpen = false;

  const render = (): void => {
    const versions = store.videosFor(media.id);

    const rows = versions.map((v) => {
      const actions = el("div", { class: "d-flex gap-1 justify-content-end" }, []);

      if (!v.isPrimary) {
        const promote = el("button", { class: "btn btn-sm", type: "button", title: "Servir cette version aux cabines" }, ["Servir"]);
        promote.addEventListener("click", () => {
          if (!confirm(`Servir la version « ${langLabel(v.lang)} » sur toutes les cabines ?\n\nElle remplacera « ${langLabel(versions.find((x) => x.isPrimary)?.lang ?? "—")} » dès la prochaine synchronisation.`)) return;
          promote.setAttribute("disabled", "true");
          void store.setPrimaryMediaVideo(v).then((res) => {
            if (res.ok) {
              toast(`Version ${langLabel(v.lang)} servie aux cabines ✓`);
              render();
              onChanged();
            } else {
              promote.removeAttribute("disabled");
              toast(res.error ?? "Échec.", "error");
            }
          });
        });
        actions.append(promote);

        const del = el("button", { class: "btn btn-sm btn-outline-danger", type: "button", title: `Supprimer la version ${langLabel(v.lang)}` }, [
          icon("M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12M9 7V4h6v3", 16),
        ]);
        del.addEventListener("click", () => {
          if (!confirm(`Supprimer la version « ${langLabel(v.lang)} » ? Les autres langues sont conservées. Action définitive.`)) return;
          del.setAttribute("disabled", "true");
          void store.deleteMediaVideo(v).then((res) => {
            if (res.ok) {
              toast(`Version ${langLabel(v.lang)} supprimée ✓`);
              render();
              onChanged();
            } else {
              del.removeAttribute("disabled");
              toast(res.error ?? "Échec.", "error");
            }
          });
        });
        actions.append(del);
      }

      return el("tr", {}, [
        el("td", {}, [
          el("span", { class: "fw-bold" }, [langLabel(v.lang)]),
          el("span", { class: "text-secondary small ms-2 font-monospace" }, [v.lang]),
        ]),
        el("td", {}, [
          v.isPrimary
            ? el("span", { class: "badge bg-green-lt", title: "Version lue par les cabines" }, ["Servie aux cabines"])
            : el("span", { class: "badge bg-secondary-lt", title: "Stockée mais non diffusée" }, ["En réserve"]),
        ]),
        // CIN-104 : ce que le back-office ne savait pas dire. « inconnu » explicite plutôt qu'un
        // blanc, qui laisserait croire à une donnée perdue.
        el("td", {}, [
          v.originalFilename
            ? el("span", { class: "font-monospace small" }, [v.originalFilename])
            : el("span", { class: "text-secondary small fst-italic" }, ["inconnu (envoyé avant le suivi)"]),
        ]),
        el("td", { class: "text-secondary small text-nowrap" }, [humanSize(v.sizeBytes)]),
        el("td", { class: "text-secondary small text-nowrap" }, [humanDate(v.createdAt)]),
        el("td", { class: "text-end" }, [actions]),
      ]);
    });

    const table =
      versions.length === 0
        ? el("div", { class: "text-secondary small fst-italic py-2" }, [
            "Aucun fichier vidéo. Ce média ne se lira pas en cabine.",
          ])
        : el("div", { class: "table-responsive" }, [
            el("table", { class: "table table-sm table-vcenter mb-0" }, [
              el("thead", {}, [
                el("tr", {}, [
                  el("th", {}, ["Langue"]),
                  el("th", {}, ["Diffusion"]),
                  el("th", {}, ["Fichier d'origine"]),
                  el("th", {}, ["Poids"]),
                  el("th", {}, ["Envoyé le"]),
                  el("th", {}, []),
                ]),
              ]),
              el("tbody", {}, rows),
            ]),
          ]);

    // ── Ajout d'une version, révélé par le « + » ──────────────────────────────
    const addBtn = el("button", { class: "btn btn-sm mt-2 d-inline-flex align-items-center gap-1", type: "button" }, [
      icon("M12 5v14M5 12h14", 16),
      "Ajouter une version",
    ]);
    addBtn.addEventListener("click", () => {
      addOpen = !addOpen;
      render();
    });

    const form = el("div", { class: "mt-2" }, []);
    if (addOpen) {
      const listId = `vid-langs-${media.id}`;
      const datalist = el("datalist", { id: listId }, COMMON_LANGS.map((l) => el("option", { value: l.code }, [l.label])));
      const langInput = el("input", { class: "form-control", type: "text", list: listId, placeholder: "en", maxlength: "5", spellcheck: "false", autocomplete: "off", style: "max-width:7rem" }) as HTMLInputElement;
      const fileInput = el("input", { class: "form-control", type: "file", accept: "video/*" }) as HTMLInputElement;
      const hint = el("div", { class: "form-hint mt-1" }, []);
      const submit = el("button", { class: "btn btn-primary", type: "button" }, ["Envoyer"]);

      // Verdict de codec établi en LISANT le fichier (CIN-103). Nul tant que la lecture n'a pas
      // répondu : on affiche alors l'heuristique par extension, jamais rien.
      let probedWarning: string | null = null;

      const refreshHint = (): void => {
        const lang = langInput.value.trim().toLowerCase();
        const warnings = langWarnings(lang, versions);
        const file = fileInput.files?.[0];
        // Le garde-fou codec (CIN-022) s'applique ici comme à l'upload principal : prévenir avant
        // l'envoi, pas après avoir découvert un écran noir en cabine.
        if (file) {
          if (probedWarning !== null) {
            warnings.push(probedWarning);
          } else {
            const codec = videoPlayabilityHint(file.name);
            if (codec.verdict !== "playable") warnings.push(codec.message);
          }
        }
        if (warnings.length === 0) {
          hint.className = "form-hint mt-1";
          hint.replaceChildren("Une version par langue ; ajouter une langue n'efface pas les autres. La première envoyée est servie aux cabines.");
          return;
        }
        hint.className = "form-hint mt-1 text-yellow";
        hint.replaceChildren(...warnings.map((w) => el("div", {}, [w])));
      };
      langInput.addEventListener("input", refreshHint);
      fileInput.addEventListener("change", () => {
        const chosen = fileInput.files?.[0] ?? null;
        probedWarning = null;
        refreshHint();
        if (!chosen) return;
        void probeMp4(fileByteReader(chosen)).then((probe) => {
          // Fichier changé entre-temps : le verdict ne décrit plus ce qui est à l'écran.
          if (fileInput.files?.[0] !== chosen || !probe) return;
          const judged = judgeVideoCodec(probe.videoCodec);
          probedWarning = judged.verdict === "playable" ? null : judged.message;
          refreshHint();
        });
      });
      refreshHint();

      // Envoi reprenable avec progression (CIN-101). Le drapeau d'annulation est lu par le
      // moteur d'envoi entre deux tranches : l'arrêt est donc effectif en quelques secondes,
      // et il annonce les octets que le serveur a réellement confirmés.
      let cancelFlag = { aborted: false };
      const progress = uploadProgressPanel(() => {
        cancelFlag.aborted = true;
      });

      submit.addEventListener("click", () => {
        const lang = langInput.value.trim().toLowerCase();
        const file = fileInput.files?.[0];
        if (!lang) return toast("Indiquez la langue de la version (ex. en).", "error");
        if (!file) return toast("Choisissez un fichier vidéo.", "error");
        // Le formulaire est verrouillé pendant l'envoi : changer de langue ou de fichier en
        // cours de route enverrait le nouveau fichier sous l'ancien nom.
        submit.setAttribute("disabled", "true");
        fileInput.setAttribute("disabled", "true");
        langInput.setAttribute("disabled", "true");
        submit.textContent = "Envoi en cours…";
        cancelFlag = { aborted: false };
        progress.reset();

        const unlock = (): void => {
          submit.removeAttribute("disabled");
          fileInput.removeAttribute("disabled");
          langInput.removeAttribute("disabled");
          submit.textContent = "Envoyer";
        };

        void store
          .saveMediaVideo(media, lang, file, { onProgress: progress.update, signal: cancelFlag })
          .then((res) => {
            if (res.ok) {
              toast(`Version ${langLabel(lang)} envoyée ✓`);
              addOpen = false;
              render();
              onChanged();
            } else {
              unlock();
              // Le message reste SOUS la barre, à côté du chiffre qu'il commente : un toast
              // disparaît, et avec lui l'information qui dit s'il faut tout recommencer.
              progress.fail(res.error ?? "Échec de l'envoi.");
              toast(res.error ?? "Échec de l'envoi.", "error");
            }
          });
      });

      form.replaceChildren(
        el("div", { class: "d-flex flex-wrap align-items-start gap-2" }, [
          datalist,
          el("div", {}, [el("label", { class: "form-label small" }, ["Langue"]), langInput]),
          el("div", { class: "flex-grow-1", style: "min-width:14rem" }, [el("label", { class: "form-label small" }, ["Fichier vidéo"]), fileInput]),
          el("div", { class: "align-self-end" }, [submit]),
        ]),
        hint,
        progress.node,
      );
    }

    const ambiguities = existingAmbiguities(versions);
    const banner =
      ambiguities.length === 0
        ? el("span", {}, [])
        : el("div", { class: "alert alert-warning py-2 mb-2" }, [
            el("div", {}, [el("div", { class: "fw-bold mb-1" }, ["Versions ambiguës"]), ...ambiguities.map((a) => el("div", { class: "small" }, [a]))]),
          ]);

    // Dit franchement ce que la borne fait aujourd'hui : une seule version diffusée.
    const diffusionNote =
      versions.length > 1
        ? el("div", { class: "text-secondary small mt-2" }, [
            "Les cabines ne lisent qu'une version à la fois — celle marquée « servie ». Les autres sont stockées en réserve.",
          ])
        : el("span", {}, []);

    container.replaceChildren(
      el("div", { class: "card" }, [
        el("div", { class: "card-body" }, [banner, table, addBtn, form, diffusionNote]),
      ]),
    );
  };

  render();
  return container;
}
