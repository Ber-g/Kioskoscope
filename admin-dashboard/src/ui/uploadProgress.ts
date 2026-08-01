// PANNEAU D'AVANCEMENT D'UN TÉLÉVERSEMENT (CIN-101).
//
// L'irritant constaté sur le terrain le 2026-07-28 n'était pas « c'est lent », c'était « on
// attend sans savoir où on en est ». Une barre qui bouge ne suffit donc pas : il faut dire
// QUELLE phase tourne, à quel DÉBIT, et — c'est le point qu'on oublie toujours — ce qui est
// réellement acquis quand ça s'arrête.
//
// TROIS RÈGLES D'AFFICHAGE, chacune contre un mensonge courant :
//  1. Le hachage et l'émission sont DEUX phases distinctes, jamais fondues dans une barre unique.
//     Le hachage ne consomme pas de réseau : le confondre avec l'envoi ferait passer une minute
//     de calcul local pour un envoi bloqué, et l'exploitant couperait au pire moment.
//  2. Le débit et le temps restant sont LISSÉS sur une fenêtre glissante. Un débit instantané
//     saute d'un facteur dix entre deux tranches et rend l'estimation absurde.
//  3. Une interruption annonce les octets que le SERVEUR a confirmés, jamais ceux qu'on croit
//     avoir poussés — et elle dit que la reprise repartira de là.

import { el } from "./dom";
import type { MediaUploadProgress } from "../data/store";

/** Fenêtre de lissage du débit : assez longue pour être stable, assez courte pour réagir à une
 *  vraie chute de réseau plutôt que de rester sur une moyenne flatteuse. */
const SPEED_WINDOW_MS = 5000;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
  return `${(n / 1024 ** 3).toFixed(2)} Go`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

export interface UploadProgressPanel {
  /** Le nœud à insérer dans le formulaire. */
  readonly node: HTMLElement;
  readonly update: (p: MediaUploadProgress) => void;
  /** Termine l'affichage sur un message d'échec — en gardant la dernière progression visible. */
  readonly fail: (message: string) => void;
  readonly reset: () => void;
}

/**
 * Construit le panneau. `onCancel` est appelé quand l'exploitant demande l'arrêt ; si aucun
 * gestionnaire n'est fourni, le bouton n'apparaît pas — un bouton d'annulation qui n'annule
 * rien serait pire que pas de bouton.
 */
export function uploadProgressPanel(onCancel?: () => void): UploadProgressPanel {
  const label = el("div", { class: "d-flex justify-content-between align-items-baseline gap-2" }, []);
  const phaseText = el("span", { class: "small fw-medium" }, [""]);
  const rateText = el("span", { class: "small text-secondary" }, [""]);
  label.append(phaseText, rateText);

  const bar = el("div", { class: "progress-bar", style: "width:0%" }, []);
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  const track = el("div", { class: "progress progress-sm mt-1" }, [bar]);

  const detail = el("div", { class: "form-hint mt-1" }, [""]);
  const cancel = el("button", { class: "btn btn-sm btn-link text-secondary p-0 mt-1", type: "button" }, ["Annuler l'envoi"]);
  if (onCancel) cancel.addEventListener("click", onCancel);

  const node = el("div", { class: "mt-2 d-none" }, onCancel ? [label, track, detail, cancel] : [label, track, detail]);
  // L'avancement est annoncé aux lecteurs d'écran sans voler le focus, et sans bavarder à
  // chaque tranche : `polite` laisse la synthèse finir sa phrase en cours.
  node.setAttribute("aria-live", "polite");

  let samples: Array<{ t: number; bytes: number }> = [];
  let lastPhase: MediaUploadProgress["phase"] | null = null;

  const update = (p: MediaUploadProgress): void => {
    node.classList.remove("d-none");
    if (p.phase !== lastPhase) {
      // Changer de phase remet la mesure de débit à zéro : le débit du hachage (processeur) et
      // celui de l'émission (réseau) n'ont rien à voir, les moyenner n'aurait aucun sens.
      samples = [];
      lastPhase = p.phase;
      bar.className = p.phase === "hash" ? "progress-bar bg-secondary" : "progress-bar";
    }

    const now = Date.now();
    samples.push({ t: now, bytes: p.doneBytes });
    samples = samples.filter((s) => now - s.t <= SPEED_WINDOW_MS);

    const pct = p.totalBytes > 0 ? Math.min(100, (p.doneBytes / p.totalBytes) * 100) : 0;
    bar.style.width = `${pct.toFixed(1)}%`;
    bar.setAttribute("aria-valuenow", pct.toFixed(0));

    const first = samples[0];
    const span = first ? (now - first.t) / 1000 : 0;
    const moved = first ? p.doneBytes - first.bytes : 0;
    const rate = span > 0.5 && moved > 0 ? moved / span : 0;

    phaseText.textContent =
      p.phase === "hash"
        ? `Empreinte du fichier… ${pct.toFixed(0)} %`
        : `Envoi… ${pct.toFixed(0)} %`;
    rateText.textContent = rate > 0
      ? `${formatBytes(rate)}/s · ${formatDuration((p.totalBytes - p.doneBytes) / rate)} restantes`
      : "";
    detail.className = "form-hint mt-1";
    detail.textContent =
      p.phase === "hash"
        ? `${formatBytes(p.doneBytes)} sur ${formatBytes(p.totalBytes)} — calcul local, le réseau n'est pas encore sollicité.`
        : `${formatBytes(p.doneBytes)} sur ${formatBytes(p.totalBytes)} confirmés par le serveur.`;
  };

  const fail = (message: string): void => {
    node.classList.remove("d-none");
    bar.className = "progress-bar bg-danger";
    phaseText.textContent = "Envoi interrompu";
    rateText.textContent = "";
    detail.className = "form-hint mt-1 text-yellow";
    detail.textContent = message;
    cancel.classList.add("d-none");
  };

  const reset = (): void => {
    node.classList.add("d-none");
    bar.className = "progress-bar";
    bar.style.width = "0%";
    phaseText.textContent = "";
    rateText.textContent = "";
    detail.textContent = "";
    cancel.classList.remove("d-none");
    samples = [];
    lastPhase = null;
  };

  return { node, update, fail, reset };
}
