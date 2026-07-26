import type { FilmPlayRow } from "../data/store";
import { el, formatMoney, icon } from "./dom";
import { timeSeriesChart } from "./chart";
import { PLAY_DECILES, watchRatio } from "@kioskoscope/domain";

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
  /** Taux d'écoute moyen [0,1], `null` si AUCUNE lecture n'est mesurée. */
  readonly avgWatch: number | null;
  /** Nombre de lectures effectivement mesurées (cf. `isMeasured`). */
  readonly measured: number;
  /** Part du chiffre d'affaires attribuée à ce film (règle F15, voir `aggregate`). */
  readonly revenueCents: number;
}

/**
 * Une lecture est-elle MESURÉE ?
 *
 * Les lectures antérieures à la migration 0026 portent les valeurs par défaut (0 seconde vue,
 * aucun décile) : les inclure dans une moyenne la tirerait mécaniquement vers zéro et afficherait
 * « 4 % vu en moyenne » sur un film pourtant regardé en entier. On les EXCLUT et on annonce
 * combien de lectures sont réellement mesurées — un chiffre honnête sur un sous-ensemble vaut
 * mieux qu'un chiffre faux sur tout.
 */
function isMeasured(r: FilmPlayRow): boolean {
  return r.watchedSeconds > 0 && r.durationSeconds > 0;
}

function aggregate(rows: readonly FilmPlayRow[]): FilmTotals[] {
  // ── Attribution du revenu (règle F15, reprise à l'identique) ────────────────
  // Une séance paie un FORFAIT, pas un film : rien n'y rattache un montant à un titre. La règle
  // déjà utilisée pour les redevances `revenue_share` (store.ts) répartit le chiffre d'affaires
  // au prorata des lectures TERMINÉES. On la réutilise telle quelle — si les statistiques et les
  // redevances divisaient le même argent différemment, aucun ayant droit ne croirait ni l'une ni
  // l'autre. Un montant de séance n'est compté qu'UNE fois, quel que soit son nombre de lectures.
  const seenSessions = new Set<string>();
  let totalRevenueCents = 0;
  for (const r of rows) {
    if (r.sessionAmountCents == null || seenSessions.has(r.sessionId)) continue;
    seenSessions.add(r.sessionId);
    totalRevenueCents += r.sessionAmountCents;
  }
  const totalCompleted = rows.reduce((n, r) => n + (r.completed ? 1 : 0), 0);

  const byMedia = new Map<
    string,
    { title: string; plays: number; completed: number; booths: Set<string>; lastAt: number; watchSum: number; measured: number }
  >();
  for (const r of rows) {
    let acc = byMedia.get(r.mediaId);
    if (!acc) {
      acc = { title: r.title, plays: 0, completed: 0, booths: new Set(), lastAt: 0, watchSum: 0, measured: 0 };
      byMedia.set(r.mediaId, acc);
    }
    acc.plays += 1;
    if (r.completed) acc.completed += 1;
    acc.booths.add(r.boothLabel);
    if (r.at > acc.lastAt) acc.lastAt = r.at;
    if (isMeasured(r)) {
      acc.watchSum += watchRatio(r.watchedSeconds, r.durationSeconds) ?? 0;
      acc.measured += 1;
    }
  }
  return [...byMedia.entries()]
    .map(([mediaId, a]) => ({
      mediaId,
      title: a.title,
      plays: a.plays,
      completed: a.completed,
      booths: a.booths.size,
      lastAt: a.lastAt,
      avgWatch: a.measured > 0 ? a.watchSum / a.measured : null,
      measured: a.measured,
      revenueCents: totalCompleted > 0 ? Math.round(totalRevenueCents * (a.completed / totalCompleted)) : 0,
    }))
    .sort((a, b) => b.plays - a.plays);
}

/**
 * Courbe de rétention : part des lectures ayant atteint chaque décile du film.
 * Répond à « jusqu'où c'est regardé » — la question qu'un compteur de lectures ne peut pas
 * trancher. Ne porte que sur les lectures MESURÉES.
 */
function retentionCurve(rows: readonly FilmPlayRow[]): { pct: number[]; measured: number } {
  const measured = rows.filter((r) => r.decilesReached.length === PLAY_DECILES && isMeasured(r));
  const pct = new Array<number>(PLAY_DECILES).fill(0);
  if (measured.length === 0) return { pct, measured: 0 };
  for (let i = 0; i < PLAY_DECILES; i++) {
    pct[i] = measured.filter((r) => r.decilesReached[i]).length / measured.length;
  }
  return { pct, measured: measured.length };
}

/** Histogramme de rétention — barres CSS, aucune dépendance, lisible en clair comme en sombre. */
function retentionChart(curve: { pct: number[]; measured: number }): HTMLElement {
  if (curve.measured === 0) {
    return el("div", { class: "text-secondary small text-center py-4" }, [
      "Profondeur d'écoute non mesurée pour ces lectures (antérieures à l'instrumentation).",
    ]);
  }
  const bars = curve.pct.map((p, i) =>
    el("div", { class: "d-flex flex-column align-items-center", style: "flex:1;min-width:0" }, [
      el("div", { class: "w-100 d-flex align-items-end", style: "height:7rem" }, [
        el("div", {
          class: "w-100 rounded-top",
          style: `height:${Math.max(2, p * 100)}%;background:var(--tblr-teal);opacity:${0.45 + p * 0.55}`,
          title: `${Math.round(p * 100)} % des lectures atteignent ce point`,
        }, []),
      ]),
      el("div", { class: "text-secondary", style: "font-size:.7rem" }, [`${(i + 1) * 10}%`]),
    ]),
  );
  return el("div", {}, [
    el("div", { class: "d-flex align-items-end gap-1" }, bars),
    el("div", { class: "text-secondary small mt-2" }, [
      `Part des lectures atteignant chaque point du film · ${curve.measured} lecture${curve.measured > 1 ? "s" : ""} mesurée${curve.measured > 1 ? "s" : ""}.`,
    ]),
  ]);
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
    const watchPct = f.avgWatch === null ? null : Math.round(f.avgWatch * 100);
    const tr = el("tr", { class: "cursor-pointer" }, [
      el("td", {}, [open]),
      el("td", { class: "fw-bold" }, [String(f.plays)]),
      el("td", { class: "text-secondary" }, [String(f.completed)]),
      el("td", {}, [
        // Le taux d'achèvement dit si le film TIENT le spectateur — un fort volume de lectures
        // massivement interrompues est un signal produit, pas un succès.
        el("span", { class: `badge ${rate >= 70 ? "bg-green-lt" : rate >= 40 ? "bg-yellow-lt" : "bg-red-lt"}` }, [`${rate} %`]),
      ]),
      // « Jusqu'où c'est regardé » : la moyenne du taux d'écoute, distincte de l'achèvement.
      // Un film peut n'être « terminé » que rarement tout en étant vu à 80 % — deux signaux
      // différents, qu'on n'agrège donc pas en un seul chiffre.
      el("td", {}, [
        watchPct === null
          ? el("span", { class: "text-secondary small", title: "Lectures antérieures à l'instrumentation" }, ["—"])
          : el("span", { class: `badge ${watchPct >= 70 ? "bg-green-lt" : watchPct >= 40 ? "bg-yellow-lt" : "bg-red-lt"}`, title: `Moyenne sur ${f.measured} lecture(s) mesurée(s)` }, [`${watchPct} %`]),
      ]),
      el("td", { class: "text-secondary text-nowrap" }, [f.revenueCents > 0 ? formatMoney(f.revenueCents) : "—"]),
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
              el("th", { title: "Part des lectures allées jusqu'au bout" }, ["Achèvement"]),
              el("th", { title: "Part du film réellement regardée, en moyenne" }, ["Vu en moyenne"]),
              el("th", { title: "Chiffre d'affaires réparti au prorata des lectures terminées (même règle que les redevances)" }, ["Revenu attribué"]),
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
      statTile("Achèvement", `${rate} %`, rate >= 70 ? "green" : rate >= 40 ? "yellow" : "red"),
      statTile("Vu en moyenne", f?.avgWatch == null ? "—" : `${Math.round(f.avgWatch * 100)} %`, "azure"),
      statTile("Revenu attribué", formatMoney(f?.revenueCents ?? 0), "green"),
    ]),
    el("div", { class: "card mb-3" }, [
      el("div", { class: "card-header" }, [
        el("h3", { class: "card-title m-0" }, ["Jusqu'où le film est regardé"]),
        el("div", { class: "card-subtitle" }, ["Courbe de rétention"]),
      ]),
      el("div", { class: "card-body" }, [retentionChart(retentionCurve(rows))]),
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
