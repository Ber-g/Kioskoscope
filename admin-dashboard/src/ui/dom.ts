// Helpers DOM — vanilla, typés. Partagés par tous les composants du dashboard.
import { t } from "../i18n";

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(typeof child === "string" ? document.createTextNode(child) : child);
  return node;
}

/** Icône SVG style Tabler (stroke, 24x24). `path` = attribut d de un ou plusieurs tracés. */
export function icon(path: string, size = 24): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("icon");
  // Un tracé unique suffit pour nos icônes (les sous-tracés sont séparés par M).
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

/**
 * Confirmation brève, ancrée sur `document.body` — donc SURVIVANTE au re-render de l'App.
 *
 * Les écritures du store rechargent puis réémettent (`emit()`), ce qui reconstruit la page :
 * un message de succès posé dans le formulaire est détaché avant d'avoir été lu (l'opérateur
 * ne sait plus si son enregistrement a abouti — cf. BUG-006). Le toast vit hors de cet arbre.
 * Non bloquant, contrairement à `alert()` : il n'interrompt pas le geste suivant.
 *
 * `aria-live="polite"` + `role="status"` : annoncé par le lecteur d'écran sans voler le focus.
 */
export function toast(message: string, kind: "success" | "error" = "success"): void {
  const bg = kind === "success" ? "var(--tblr-green)" : "var(--tblr-red)";
  const node = el("div", {
    role: "status",
    "aria-live": "polite",
    style:
      `position:fixed;right:1rem;bottom:1rem;z-index:1090;max-width:min(24rem,calc(100vw - 2rem));` +
      `padding:.6rem .9rem;border-radius:.5rem;color:#fff;background:${bg};` +
      `box-shadow:0 .5rem 1.5rem rgba(0,0,0,.25);font-size:.875rem;opacity:0;transition:opacity .15s`,
  }, [message]);
  document.body.append(node);
  requestAnimationFrame(() => { node.style.opacity = "1"; });
  window.setTimeout(() => {
    node.style.opacity = "0";
    window.setTimeout(() => node.remove(), 200);
  }, kind === "error" ? 6000 : 3000);
}

export function formatMoney(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(cents / 100);
}

export function relativeTime(epochMs: number): string {
  // 0 / valeur absente = aucun heartbeat reçu (pas « il y a 56 ans »).
  if (!epochMs || epochMs <= 0) return t("time.never");
  const s = Math.round((Date.now() - epochMs) / 1000);
  if (s < 60) return t("time.secondsAgo", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t("time.minutesAgo", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  return t("time.daysAgo", { n: Math.round(h / 24) });
}

export function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
