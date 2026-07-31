import type { FleetStore, SessionRow } from "../data/store";
import { el, formatMoney, icon } from "./dom";
import { t } from "../i18n";
import { boothLabelEl } from "./components";
import { filmPlaysView } from "./filmPlays";

// Menu Sessions (F9, 2e tranche) : liste des séances (Kiosk, date, méthode de
// déverrouillage, films joués, montant) + quelques KPI. Données réelles : `sessions`
// + `plays` (scopées RLS). Complète le menu Revenus pour boucler F9 (hors LTE).

const METHOD_LABELS: Record<string, string> = {
  mock: "Démo",
  card: "Carte",
  coin: "Monnayeur",
  token: "Jeton",
  free: "Gratuit",
};

/**
 * Lecture des ouvertures de page de partage sur un lot de séances (CIN-106).
 *
 * POURQUOI UN TAUX ET PAS UN VOLUME. « 47 ouvertures » ne dit rien sans son dénominateur :
 * 47 sur 50 séances est un succès, 47 sur 4000 est un signal d'échec. Le chiffre qui porte le
 * sens est donc « part des séances dont la page a été ouverte au moins une fois ».
 *
 * DEUX NOMBRES DISTINCTS, VOLONTAIREMENT. `opens` compte les ouvertures (ré-ouvertures
 * comprises : le spectateur revoit sa liste plus tard) ; `sessionsOpened` compte les séances
 * concernées. Seul le second peut servir de numérateur — sinon un visiteur qui rafraîchit sa
 * page fait monter le « taux » au-dessus de 100 %.
 */
export interface ShareOpenStats {
  /** La mesure est-elle lisible ? `false` ⇒ ne RIEN afficher comme un zéro. */
  readonly available: boolean;
  readonly opens: number;
  readonly sessionsOpened: number;
  readonly sessions: number;
  /** `sessionsOpened / sessions`, entre 0 et 1. `null` si le taux n'a pas de sens (0 séance). */
  readonly rate: number | null;
}

export function shareOpenStats(rows: readonly SessionRow[]): ShareOpenStats {
  const measured = rows.filter((s) => s.shareOpens !== null);
  if (measured.length === 0) return { available: false, opens: 0, sessionsOpened: 0, sessions: rows.length, rate: null };
  let opens = 0;
  let sessionsOpened = 0;
  for (const s of measured) {
    const n = s.shareOpens ?? 0;
    opens += n;
    if (n > 0) sessionsOpened += 1;
  }
  return {
    available: true,
    opens,
    sessionsOpened,
    sessions: measured.length,
    rate: measured.length > 0 ? sessionsOpened / measured.length : null,
  };
}

function kpiTile(label: string, value: string, hue: string, iconPath: string): HTMLElement {
  // 5 tuiles : `col-xl` (largeurs égales) plutôt que `col-xl-3`, qui laisserait la 5e seule
  // sur une ligne. Sur petit écran on reste à 2 par ligne.
  return el("div", { class: "col-sm-6 col-xl" }, [
    el("div", { class: "card card-sm" }, [
      el("div", { class: "card-body" }, [
        el("div", { class: "row align-items-center" }, [
          el("div", { class: "col-auto" }, [el("span", { class: `bg-${hue}-lt text-${hue} avatar` }, [icon(iconPath, 22)])]),
          el("div", { class: "col" }, [el("div", { class: "fs-2 fw-bold lh-1" }, [value]), el("div", { class: "text-secondary" }, [label])]),
        ]),
      ]),
    ]),
  ]);
}

/**
 * Cellule « QR ouvert » d'une séance. Trois états à ne pas confondre, d'où trois rendus :
 * mesure indisponible (tiret discret + infobulle), aucune ouverture (tiret), ouvert (compte).
 */
function shareCell(s: SessionRow): HTMLElement {
  if (s.shareOpens === null) return el("span", { class: "text-secondary", title: "Mesure indisponible sur cette base" }, ["—"]);
  if (s.shareOpens === 0) return el("span", { class: "text-secondary" }, ["—"]);
  const when = s.lastShareOpenAt
    ? `Dernière ouverture : ${new Date(s.lastShareOpenAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
    : "";
  return el("span", { class: "badge bg-yellow-lt", title: when }, [s.shareOpens > 1 ? `${s.shareOpens} ×` : "1 ×"]);
}

export function sessionsPage(store: FleetStore, onOpenBooth?: (id: string) => void): HTMLElement {
  const container = el("div", {}, [el("div", { class: "text-secondary p-3" }, ["Chargement des séances…"])]);
  // Deux lectures du MÊME fait (une cabine a joué des films), selon la question posée :
  // « qu'est-ce qui s'est passé ce soir-là ? » (séances) ou « combien de fois ce film
  // a-t-il tourné ? » (par film — CIN-099). Charger les deux jeux en parallèle évite un
  // temps d'attente à la bascule.
  void Promise.all([store.sessionsList(), store.filmPlaysList()]).then(([rows, plays]) => {
    let mode: "sessions" | "films" = "sessions";
    const paint = (): void => {
      const seg = (label: string, m: typeof mode): HTMLElement => {
        const b = el("button", { class: `btn ${mode === m ? "btn-primary" : ""}`, type: "button" }, [label]);
        b.addEventListener("click", () => {
          mode = m;
          paint();
        });
        return b;
      };
      const toggle = el("div", { class: "btn-group mb-3", role: "group" }, [seg("Séances", "sessions"), seg("Par film", "films")]);
      container.replaceChildren(
        el("div", { class: "mb-1" }, [
          el("h2", { class: "page-title m-0" }, [t("page.sessions")]),
          el("div", { class: "text-secondary" }, [
            "Séances et films joués, remontés par les Kiosks. Ces compteurs sont indépendants des revenus : une séance gratuite (location, festival, forfait) est comptée ici même si elle ne génère aucune transaction.",
          ]),
        ]),
        toggle,
        mode === "sessions" ? render(store, rows, onOpenBooth) : filmPlaysView(plays),
      );
    };
    paint();
  });
  return container;
}

function render(store: FleetStore, rows: readonly SessionRow[], onOpenBooth?: (id: string) => void): HTMLElement {
  const cur = store.activeCurrency();
  const todayStr = new Date().toISOString().slice(0, 10);
  // SessionRow ne porte que le libellé → on retrouve l'id via le store pour ouvrir la cabine
  // (entrée cohérente). Libellés de cabine uniques en pratique ; sinon repli texte.
  const idByLabel = new Map(store.visibleBooths().map((b) => [b.label, b.id]));

  const totalFilms = rows.reduce((n, s) => n + s.films.length, 0);
  const avgFilms = rows.length > 0 ? (totalFilms / rows.length).toFixed(1) : "0";
  const todayCount = rows.filter((s) => new Date(s.startedAt).toISOString().slice(0, 10) === todayStr).length;

  // Répartition des méthodes de déverrouillage.
  const byMethod = new Map<string, number>();
  for (const s of rows) byMethod.set(s.unlockMethod, (byMethod.get(s.unlockMethod) ?? 0) + 1);
  const methodChips = [...byMethod.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) =>
    el("span", { class: "badge bg-secondary-lt me-1" }, [`${METHOD_LABELS[m] ?? m} · ${n}`]),
  );

  // Ouvertures de QR (CIN-106) : signal de valeur SECONDAIRE de l'étoile polaire — « repartir
  // avec sa liste » est un acte volontaire, donc la meilleure preuve que la séance a compté.
  const share = shareOpenStats(rows);
  const shareValue = !share.available ? "—" : share.rate === null ? "—" : `${Math.round(share.rate * 100)} %`;
  const shareLabel = !share.available
    ? "QR ouverts — mesure indisponible"
    : `QR ouverts · ${share.sessionsOpened}/${share.sessions} séances`;

  const tableRows = rows.map((s) => {
    const filmList = s.films.length
      ? el("div", {}, [
          el("div", {}, [`${s.films.length} film${s.films.length > 1 ? "s" : ""}`]),
          el("div", { class: "text-secondary small" }, [
            s.films.map((f) => `${f.title}${f.source === "recommendation" ? " ⭑" : ""}${f.completed ? "" : " (interrompu)"}`).join(" · "),
          ]),
        ])
      : el("span", { class: "text-secondary" }, ["—"]);
    return el("tr", {}, [
      el("td", { class: "text-secondary text-nowrap" }, [new Date(s.startedAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })]),
      el("td", {}, [boothLabelEl(s.boothLabel, onOpenBooth && idByLabel.has(s.boothLabel) ? () => onOpenBooth(idByLabel.get(s.boothLabel)!) : undefined)]),
      el("td", {}, [el("span", { class: "badge bg-secondary-lt" }, [METHOD_LABELS[s.unlockMethod] ?? s.unlockMethod])]),
      el("td", { style: "min-width:220px" }, [filmList]),
      el("td", { class: "text-center text-nowrap" }, [shareCell(s)]),
      el("td", { class: "text-end text-nowrap" }, [s.amountCents != null ? formatMoney(s.amountCents, cur) : "—"]),
    ]);
  });

  // Le titre et le chapô sont posés par `sessionsPage` (communs aux deux modes).
  return el("div", {}, [
    el("div", { class: "row row-cards g-2 mb-3" }, [
      kpiTile("Séances", String(rows.length), "purple", "M8 4v16M16 4v16M4 8h16M4 16h16"),
      kpiTile("Films / séance", avgFilms, "azure", "M4 5h16v14H4zM4 9h16M10 13l3 2l-3 2z"),
      kpiTile("Séances (aujourd'hui)", String(todayCount), "green", "M12 7v5l3 3M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0 -18"),
      kpiTile("Films joués", String(totalFilms), "teal", "M10 13l3 2l-3 2zM4 5h16v14H4z"),
      kpiTile(shareLabel, shareValue, "yellow", "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"),
    ]),
    methodChips.length ? el("div", { class: "mb-3" }, [el("span", { class: "text-secondary me-2" }, ["Déverrouillage :"]), ...methodChips]) : el("span", {}, []),
    el("div", { class: "card" }, [
      el("div", { class: "card-header" }, [el("h3", { class: "card-title m-0" }, ["Dernières séances"])]),
      el("div", { class: "table-responsive" }, [
        el("table", { class: "table table-vcenter card-table" }, [
          el("thead", {}, [el("tr", {}, [el("th", {}, ["Date"]), el("th", {}, ["Kiosk"]), el("th", {}, ["Méthode"]), el("th", {}, ["Films joués"]), el("th", { class: "text-center" }, ["QR ouvert"]), el("th", { class: "text-end" }, ["Montant"])])]),
          el("tbody", {}, tableRows.length ? tableRows : [el("tr", {}, [el("td", { colspan: "6", class: "text-secondary text-center py-4" }, ["Aucune séance."])])]),
        ]),
      ]),
    ]),
    el("div", { class: "text-secondary small mt-2" }, ["⭑ = film issu d'une recommandation."]),
    el("div", { class: "text-secondary small" }, [
      share.available
        ? "« QR ouvert » = la page de partage de la séance a été affichée. Seuls la séance et l'instant sont enregistrés : ni adresse IP, ni appareil, ni identité — la page ne trace personne."
        : "« QR ouvert » : la mesure des ouvertures n'est pas lisible sur cette base. Un tiret ne veut pas dire « personne n'a ouvert », mais « on ne sait pas ».",
    ]),
  ]);
}
