import type { FilmPlayRow } from "../data/store";
import { el, icon } from "./dom";
import { timeSeriesChart } from "./chart";

// Comptabilisation PAR FILM (CIN-099) — « ce film a été lu N fois ».
//
// L'ENJEU. Le back-office savait compter les séances et le chiffre d'affaires, mais pas
// répondre à « combien de fois le film A a-t-il été joué ? ». C'est pourtant l'unité qui
// compte : c'est elle qu'on déclare aux ayants droit, elle qui dit si un film fonctionne, et
// elle qui subsiste quand la séance est gratuite. D'où un écran dédié, JAMAIS gaté par un
// module de facturation : une org forfaitaire tire 0 € de ses séances et doit malgré tout
// pouvoir compter ses lectures.
//
// Deux niveaux, dans cet ordre : le classement de tous les films, puis le détail d'UN film
// (courbe + journal de ses lectures). On ne mélange pas les deux — @design.

const DETAIL_DAYS = 30;

/** Agrégat par film, calculé à la volée depuis les lectures brutes. */
interface FilmTotals {
  readonly mediaId: string;
  readonly title: string;
  readonly plays: number;
  readonly completed: number;
  readonly booths: number;
  readonly lastAt: number;
}

function aggregate(rows: readonly FilmPlayRow[]): FilmTotals[] {
  const byMedia = new Map<string, { title: string; plays: number; completed: number; booths: Set<string>; lastAt: number }>();
  for (const r of rows) {
    let acc = byMedia.get(r.mediaId);
    if (!acc) {
      acc = { title: r.title, plays: 0, completed: 0, booths: new Set(), lastAt: 0 };
      byMedia.set(r.mediaId, acc);
    }
    acc.plays += 1;
    if (r.completed) acc.completed += 1;
    acc.booths.add(r.boothLabel);
    if (r.at > acc.lastAt) acc.lastAt = r.at;
  }
  return [...byMedia.entries()]
    .map(([mediaId, a]) => ({ mediaId, title: a.title, plays: a.plays, completed: a.completed, booths: a.booths.size, lastAt: a.lastAt }))
    .sort((a, b) => b.plays - a.plays);
}

/** Série quotidienne des lectures d'un film sur les N derniers jours (jours vides inclus). */
function dailySeries(rows: readonly FilmPlayRow[], days: number): Array<{ date: string; value: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = new Date(r.at).toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // On matérialise TOUS les jours, y compris à zéro : sans cela, une courbe reliant deux
  // lectures distantes de trois semaines laisserait croire à une activité continue.
  const out: Array<{ date: string; value: number }> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: counts.get(key) ?? 0 });
  }
  return out;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function statTile(label: string, value: string, hue: string): HTMLElement {
  return el("div", { class: "col-6 col-lg-3" }, [
    el("div", { class: "card card-sm" }, [
      el("div", { class: "card-body py-2" }, [
        el("div", { class: `fs-2 fw-bold lh-1 text-${hue}` }, [value]),
        el("div", { class: "text-secondary small" }, [label]),
      ]),
    ]),
  ]);
}

/**
 * Vue « par film ». `rows` = toutes les lectures visibles (déjà scopées par la RLS).
 * L'état de sélection vit dans la closure : sélectionner un film ne recharge rien.
 */
export function filmPlaysView(rows: readonly FilmPlayRow[]): HTMLElement {
  const totals = aggregate(rows);
  let selected: string | null = null;
  const container = el("div", {}, []);

  const render = (): void => {
    const detail = selected ? renderDetail(rows, totals, selected, () => { selected = null; render(); }) : null;
    container.replaceChildren(detail ?? renderRanking(totals, (id) => { selected = id; render(); }));
  };

  render();
  return container;
}

// ── Niveau 1 : classement de tous les films ──────────────────────────────────
function renderRanking(totals: readonly FilmTotals[], onPick: (mediaId: string) => void): HTMLElement {
  if (totals.length === 0) {
    return el("div", { class: "card" }, [
      el("div", { class: "card-body text-secondary text-center py-5" }, [
        "Aucune lecture enregistrée. Dès qu'une cabine joue un film, il apparaît ici — même si la séance est gratuite.",
      ]),
    ]);
  }

  const rows = totals.map((f) => {
    const rate = f.plays > 0 ? Math.round((f.completed / f.plays) * 100) : 0;
    const open = el("button", { class: "btn btn-link p-0 fw-bold text-start", type: "button", title: `Détail de « ${f.title} »` }, [f.title]);
    open.addEventListener("click", () => onPick(f.mediaId));
    const tr = el("tr", { class: "cursor-pointer" }, [
      el("td", {}, [open]),
      el("td", { class: "fw-bold" }, [String(f.plays)]),
      el("td", { class: "text-secondary" }, [String(f.completed)]),
      el("td", {}, [
        // Le taux d'achèvement dit si le film TIENT le spectateur — un fort volume de lectures
        // massivement interrompues est un signal produit, pas un succès.
        el("span", { class: `badge ${rate >= 70 ? "bg-green-lt" : rate >= 40 ? "bg-yellow-lt" : "bg-red-lt"}` }, [`${rate} %`]),
      ]),
      el("td", { class: "text-secondary" }, [String(f.booths)]),
      el("td", { class: "text-secondary text-nowrap" }, [f.lastAt ? fmtDate(f.lastAt) : "—"]),
    ]);
    tr.addEventListener("click", () => onPick(f.mediaId));
    return tr;
  });

  const totalPlays = totals.reduce((n, f) => n + f.plays, 0);

  return el("div", {}, [
    el("div", { class: "text-secondary mb-2" }, [
      `${totals.length} film${totals.length > 1 ? "s" : ""} joué${totals.length > 1 ? "s" : ""} · ${totalPlays} lecture${totalPlays > 1 ? "s" : ""} au total. Cliquez un film pour son détail.`,
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "table-responsive" }, [
        el("table", { class: "table table-vcenter card-table table-hover" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", {}, ["Film"]),
              el("th", {}, ["Lectures"]),
              el("th", {}, ["Terminées"]),
              el("th", {}, ["Achèvement"]),
              el("th", {}, ["Cabines"]),
              el("th", {}, ["Dernière lecture"]),
            ]),
          ]),
          el("tbody", {}, rows),
        ]),
      ]),
    ]),
  ]);
}

// ── Niveau 2 : détail d'un film ──────────────────────────────────────────────
function renderDetail(
  allRows: readonly FilmPlayRow[],
  totals: readonly FilmTotals[],
  mediaId: string,
  onBack: () => void,
): HTMLElement {
  const rows = allRows.filter((r) => r.mediaId === mediaId);
  const f = totals.find((t) => t.mediaId === mediaId);
  const title = f?.title ?? rows[0]?.title ?? "Film";
  const rate = f && f.plays > 0 ? Math.round((f.completed / f.plays) * 100) : 0;

  const back = el("button", { class: "btn btn-link p-0 mb-1 d-inline-flex align-items-center gap-1", type: "button" }, [
    icon("M15 6l-6 6l6 6", 16),
    "Tous les films",
  ]);
  back.addEventListener("click", onBack);

  const journal = rows.slice(0, 200).map((r) =>
    el("tr", {}, [
      el("td", { class: "text-secondary text-nowrap" }, [fmtDate(r.at)]),
      el("td", {}, [r.boothLabel]),
      el("td", {}, [
        r.completed
          ? el("span", { class: "badge bg-green-lt" }, ["Terminé"])
          : el("span", { class: "badge bg-yellow-lt" }, ["Interrompu"]),
      ]),
      el("td", { class: "text-secondary" }, [r.source === "recommendation" ? "Recommandation ⭑" : "Choix direct"]),
    ]),
  );

  return el("div", {}, [
    back,
    el("h3", { class: "mb-3" }, [title]),
    el("div", { class: "row row-cards g-2 mb-3" }, [
      statTile("Lectures", String(f?.plays ?? 0), "teal"),
      statTile("Terminées", String(f?.completed ?? 0), "green"),
      statTile("Achèvement", `${rate} %`, rate >= 70 ? "green" : rate >= 40 ? "yellow" : "red"),
      statTile("Cabines", String(f?.booths ?? 0), "azure"),
    ]),
    el("div", { class: "card mb-3" }, [
      el("div", { class: "card-body" }, [
        timeSeriesChart({
          title: `Lectures par jour (${DETAIL_DAYS} derniers jours)`,
          points: dailySeries(rows, DETAIL_DAYS),
          kind: "area",
          hue: "var(--tblr-teal)",
          formatValue: (n) => `${n} lecture${n > 1 ? "s" : ""}`,
        }),
      ]),
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-header" }, [
        el("h3", { class: "card-title m-0" }, ["Journal des lectures"]),
        ...(rows.length > 200 ? [el("div", { class: "card-subtitle" }, [`200 dernières sur ${rows.length}`])] : []),
      ]),
      el("div", { class: "table-responsive" }, [
        el("table", { class: "table table-vcenter card-table" }, [
          el("thead", {}, [el("tr", {}, [el("th", {}, ["Date"]), el("th", {}, ["Cabine"]), el("th", {}, ["Statut"]), el("th", {}, ["Origine"])])]),
          el("tbody", {}, journal.length ? journal : [el("tr", {}, [el("td", { colspan: "4", class: "text-secondary text-center py-4" }, ["Aucune lecture."])])]),
        ]),
      ]),
    ]),
  ]);
}
