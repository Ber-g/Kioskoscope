// i18n (F12 / CIN-041) — infra minimale : dictionnaires FR/EN + `t()` + langue courante.
// Philosophie : simplicité + modularité. Ajouter une chaîne = 1 clé dans les 2 dictionnaires.
// Ajouter une langue = 1 entrée dans DICT. Fallback : clé absente → FR → la clé brute.

export type Lang = "fr" | "en";
export const LANGS: readonly Lang[] = ["fr", "en"];

const LANG_KEY = "kioskoscope.admin.lang.v1";

// Dictionnaires. Clés namespacées (nav.*, overview.*, kpi.*…). Pilote = nav + vue d'ensemble.
const DICT: Record<Lang, Record<string, string>> = {
  fr: {
    "nav.overview": "Vue d'ensemble",
    "nav.map": "Carte",
    "nav.media": "Médias",
    "nav.revenue": "Revenus",
    "nav.rights": "Droits & redevances",
    "nav.sessions": "Sessions",
    "nav.maintenance": "Maintenance",
    "nav.organization": "Organisation",
    "nav.fleet": "Flotte",
    "nav.locked": "Module non inclus dans votre offre — contactez Kioskoscope pour l'activer",
    "overview.title": "Vue d'ensemble de la flotte",
    "overview.subtitle": "Les Kiosks de votre organisation.",
    "overview.subtitleAdmin": "Tous les Kiosks (global admin).",
    "overview.allBooths": "Tous les Kiosks",
    "kpi.booths": "Kiosks",
    "kpi.operational": "Opérationnels",
    "kpi.attention": "Attention",
    "kpi.errorOffline": "En panne / hors-ligne",
    "kpi.sessionsToday": "Sessions (aujourd'hui)",
    "kpi.revenueToday": "Revenu (aujourd'hui)",
    "action.add": "Ajouter",
    "action.edit": "Éditer",
    "action.editDone": "Terminer",
    "overview.distribution": "Répartition de la flotte",
    "table.booth": "Kiosk",
    "table.health": "Santé",
    "table.connection": "Connexion",
    "table.sessions": "Sessions",
    "table.revenue": "Revenu",
    "table.version": "Version",
    "table.seen": "Vu",
    "health.operational": "Opérationnel",
    "health.attention": "Attention",
    "health.error": "En panne",
    "health.offline": "Hors-ligne",
    "health.maintenance": "Maintenance",
    "health.operational.hint": "Tout fonctionne normalement.",
    "health.attention.hint": "À surveiller (stockage, sync, batterie…).",
    "health.error.hint": "Bug bloquant : crash ou paiement KO.",
    "health.offline.hint": "Injoignable — plus de signal de vie.",
    "health.maintenance.hint": "Hors service volontaire (mise à jour).",
    "indicator.powered": "Sous tension",
    "indicator.in_use": "En cours d'utilisation",
    "indicator.updating": "Mise à jour",
    "time.never": "jamais",
    "time.secondsAgo": "il y a {n} s",
    "time.minutesAgo": "il y a {n} min",
    "time.hoursAgo": "il y a {n} h",
    "time.daysAgo": "il y a {n} j",
    "hb.online": "En ligne",
    "hb.stale": "Silencieux",
    "hb.offline": "Hors-ligne",
    "hb.never": "Jamais vu",
    "hb.online.hint": "Heartbeat récent (< 5 min)",
    "hb.stale.hint": "Pas de heartbeat depuis > 5 min",
    "hb.offline.hint": "Pas de heartbeat depuis > 30 min",
    "page.revenue": "Revenus",
    "page.media": "Médias",
    "page.maintenance": "Maintenance & mises à jour",
    "page.sessions": "Sessions",
    "page.map": "Carte de la flotte",
    "page.rights": "Droits & redevances",
  },
  en: {
    "nav.overview": "Overview",
    "nav.map": "Map",
    "nav.media": "Media",
    "nav.revenue": "Revenue",
    "nav.rights": "Rights & royalties",
    "nav.sessions": "Sessions",
    "nav.maintenance": "Maintenance",
    "nav.organization": "Organization",
    "nav.fleet": "Fleet",
    "nav.locked": "Module not included in your plan — contact Kioskoscope to enable it",
    "overview.title": "Fleet overview",
    "overview.subtitle": "The Kiosks of your organization.",
    "overview.subtitleAdmin": "All Kiosks (global admin).",
    "overview.allBooths": "All Kiosks",
    "kpi.booths": "Kiosks",
    "kpi.operational": "Operational",
    "kpi.attention": "Attention",
    "kpi.errorOffline": "Down / offline",
    "kpi.sessionsToday": "Sessions (today)",
    "kpi.revenueToday": "Revenue (today)",
    "action.add": "Add",
    "action.edit": "Edit",
    "action.editDone": "Done",
    "overview.distribution": "Fleet breakdown",
    "table.booth": "Kiosk",
    "table.health": "Health",
    "table.connection": "Connection",
    "table.sessions": "Sessions",
    "table.revenue": "Revenue",
    "table.version": "Version",
    "table.seen": "Seen",
    "health.operational": "Operational",
    "health.attention": "Attention",
    "health.error": "Down",
    "health.offline": "Offline",
    "health.maintenance": "Maintenance",
    "health.operational.hint": "Everything is working normally.",
    "health.attention.hint": "Keep an eye on it (storage, sync, battery…).",
    "health.error.hint": "Blocking bug: crash or payment failure.",
    "health.offline.hint": "Unreachable — no heartbeat.",
    "health.maintenance.hint": "Intentionally out of service (update).",
    "indicator.powered": "Powered",
    "indicator.in_use": "In use",
    "indicator.updating": "Updating",
    "time.never": "never",
    "time.secondsAgo": "{n}s ago",
    "time.minutesAgo": "{n}min ago",
    "time.hoursAgo": "{n}h ago",
    "time.daysAgo": "{n}d ago",
    "hb.online": "Online",
    "hb.stale": "Quiet",
    "hb.offline": "Offline",
    "hb.never": "Never seen",
    "hb.online.hint": "Recent heartbeat (< 5 min)",
    "hb.stale.hint": "No heartbeat for > 5 min",
    "hb.offline.hint": "No heartbeat for > 30 min",
    "page.revenue": "Revenue",
    "page.media": "Media",
    "page.maintenance": "Maintenance & updates",
    "page.sessions": "Sessions",
    "page.map": "Fleet map",
    "page.rights": "Rights & royalties",
  },
};

function detectLang(): Lang {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored === "fr" || stored === "en") return stored;
  return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

let currentLang: Lang = detectLang();
const listeners = new Set<() => void>();

/** Traduit une clé. Interpole `{name}` depuis `vars`. Fallback : FR puis la clé brute. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = DICT[currentLang][key] ?? DICT.fr[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  return s;
}

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  if (lang === currentLang) return;
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang;
  for (const fn of listeners) fn();
}

/** S'abonne aux changements de langue (l'App re-render). Renvoie une fonction de désabonnement. */
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
