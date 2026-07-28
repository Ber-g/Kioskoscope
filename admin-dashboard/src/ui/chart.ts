import { el } from "./dom";

// Graphe temporel SVG minimal, sans dépendance. Une seule série, une seule
// échelle (jamais de double axe — règle n°1 dataviz). Traits fins, grille
// discrète, survol crosshair + infobulle, couleurs via variables Tabler
// (fonctionne en clair comme en sombre).

export interface ChartPoint {
  readonly date: string; // "YYYY-MM-DD"
  readonly value: number;
}

export interface ChartOptions {
  readonly title: string;
  readonly points: readonly ChartPoint[];
  readonly kind: "area" | "line";
  /** Couleur de la série (ex. "var(--tblr-primary)"). */
  readonly hue: string;
  /** Formatage de la valeur pour l'infobulle. */
  readonly formatValue: (n: number) => string;
}

/**
 * Largeur de repli, utilisée au tout premier rendu — avant que l'élément soit attaché au DOM,
 * sa largeur réelle est inconnue (0). Le `ResizeObserver` corrige dès l'attachement.
 */
const W_FALLBACK = 640;
const H = 180;
// `left` = gouttière du label d'axe Y. Il est posé à `left - 6` avec `text-anchor:"end"`, donc il
// s'étend vers la GAUCHE : trop étroite, la gouttière fait sortir les valeurs à 4+ chiffres du
// `viewBox`, où elles sont rognées (BUG-012). 48 laisse la place à « 12 345 » à 10 px.
const PAD = { top: 16, right: 12, bottom: 24, left: 48 };
/** En deçà, la zone de tracé n'a plus de sens ; on garde un plancher plutôt qu'un dessin inversé. */
const PLOT_W_MIN = 40;

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

export function timeSeriesChart(opts: ChartOptions): HTMLElement {
  const pts = opts.points;
  const n = pts.length;
  // Sans point (borne neuve, aucun historique), les libellés d'axe lisent pts[0].date →
  // crash. On rend un état vide propre au lieu de planter le tiroir / le hub cabine.
  if (n === 0) {
    return el("div", { class: "text-secondary small text-center py-4" }, [opts.title ? `${opts.title} — pas encore de données` : "Pas encore de données"]);
  }
  const maxV = Math.max(1, ...pts.map((p) => p.value));

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", String(H));
  svg.classList.add("ts-chart");

  const mk = (tag: string, attrs: Record<string, string>): SVGElement => {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  const tooltip = el("div", { class: "ts-tooltip" }, []);
  const wrap = el("div", { class: "ts-wrap" }, [
    el("div", { class: "ts-title" }, [opts.title]),
    svg,
    tooltip,
  ]);

  /*
   * BUG-012 — pourquoi le graphe se redessine au lieu d'être mis à l'échelle.
   *
   * Avant : `viewBox="0 0 640 180"` + `width="100%"` sans hauteur. Le SVG entier était donc
   * étiré par `largeurConteneur / 640` — y compris la typographie des axes, qui est en unités
   * utilisateur. Dans une carte de ~1100 px le facteur valait ≈1,7 : des libellés de 10 px
   * s'affichaient à ~17 px, et le libellé d'axe Y sortait du `viewBox` où il était rogné.
   * Figer la hauteur supprimait l'agrandissement, mais laissait du vide sous la courbe dans
   * les cartes étroites (tiroir, hub cabine) et n'y rendait pas les libellés plus lisibles.
   *
   * Maintenant : le `viewBox` épouse la largeur RÉELLE du conteneur, donc **1 unité utilisateur
   * = 1 pixel CSS**, à toute largeur. Plus aucune mise à l'échelle : la typo fait exactement la
   * taille demandée par la CSS (`.ts-axis`, 10 px), le graphe remplit sa carte, et le tracé se
   * redessine sur redimensionnement (fenêtre, ouverture du tiroir, bascule de colonnes).
   */
  let w = W_FALLBACK;
  const plotH = H - PAD.top - PAD.bottom;
  let plotW = Math.max(PLOT_W_MIN, w - PAD.left - PAD.right);
  const x = (i: number): number => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number): number => PAD.top + plotH - (v / maxV) * plotH;

  // Recréés à chaque tracé : les gestionnaires de survol doivent viser les noeuds COURANTS.
  let cross = mk("line", {});
  let dot = mk("circle", {});

  const draw = (): void => {
    plotW = Math.max(PLOT_W_MIN, w - PAD.left - PAD.right);
    svg.setAttribute("viewBox", `0 0 ${w} ${H}`);
    svg.replaceChildren();

    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const area = `${line} L${x(n - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;

    const label = (attrs: Record<string, string>, text: string): void => {
      const t = mk("text", attrs);
      t.textContent = text;
      svg.append(t);
    };
    // Grille horizontale discrète (0, mid, max) + libellés Y.
    for (const frac of [0, 0.5, 1]) {
      const gy = PAD.top + plotH - frac * plotH;
      svg.append(mk("line", { x1: String(PAD.left), y1: String(gy), x2: String(w - PAD.right), y2: String(gy), class: "ts-grid" }));
      label({ x: String(PAD.left - 6), y: String(gy + 4), class: "ts-axis", "text-anchor": "end" }, opts.formatValue(Math.round(frac * maxV)));
    }
    // Libellés X : premier, milieu, dernier.
    for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
      label({ x: String(x(i)), y: String(H - 6), class: "ts-axis", "text-anchor": "middle" }, shortDate(pts[i]!.date));
    }

    if (opts.kind === "area") {
      svg.append(mk("path", { d: area, class: "ts-area", style: `fill:${opts.hue}` }));
    }
    svg.append(mk("path", { d: line, class: "ts-line", style: `stroke:${opts.hue}` }));

    // Couche de survol : crosshair + point + infobulle.
    cross = mk("line", { class: "ts-cross", y1: String(PAD.top), y2: String(PAD.top + plotH), style: "display:none" });
    dot = mk("circle", { class: "ts-dot", r: "4", style: `fill:${opts.hue};display:none` });
    svg.append(cross, dot);
  };

  draw();

  // Le graphe suit la largeur de sa carte. `ResizeObserver` plutôt qu'un écouteur `resize` de
  // fenêtre : la carte change aussi de largeur SANS que la fenêtre bouge (ouverture du tiroir,
  // bascule de colonnes, repli de la barre latérale).
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      // Le seuil d'1 px évite une boucle de redessin sur des largeurs fractionnaires.
      if (next > 0 && Math.abs(next - w) >= 1) {
        w = next;
        draw();
      }
    });
    ro.observe(wrap);
  }

  const onMove = (evt: PointerEvent): void => {
    const rect = svg.getBoundingClientRect();
    const ratio = (evt.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
    const px = x(i);
    const py = y(pts[i]!.value);
    cross.setAttribute("x1", String(px));
    cross.setAttribute("x2", String(px));
    cross.setAttribute("style", "");
    dot.setAttribute("cx", String(px));
    dot.setAttribute("cy", String(py));
    dot.setAttribute("style", `fill:${opts.hue}`);
    tooltip.textContent = `${shortDate(pts[i]!.date)} · ${opts.formatValue(pts[i]!.value)}`;
    tooltip.style.left = `${(px / w) * 100}%`;
    tooltip.classList.add("is-visible");
  };
  const onLeave = (): void => {
    cross.setAttribute("style", "display:none");
    dot.setAttribute("style", "display:none");
    tooltip.classList.remove("is-visible");
  };
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);

  return wrap;
}
