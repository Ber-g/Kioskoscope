// i18n de la CABINE (socle de CIN-115). Distinct de celui du back-office : ni les mêmes textes,
// ni les mêmes contraintes, ni le même public.
//
// TROIS RÈGLES QUI VIENNENT DU LIEU. Ce module ne ressemble pas à une lib i18n habituelle, et
// c'est délibéré — une cabine n'est pas une application :
//
//   1. **Un visiteur ne doit JAMAIS voir une clé.** Pas de `t("player.skip")` affiché à l'écran
//      parce qu'une traduction manque. Une clé absente retombe sur le FRANÇAIS, qui est la langue
//      de référence et toujours complète. Le trou est signalé en console, pas au public.
//   2. **La langue ne change pas pendant une séance.** Elle est choisie à l'ENTRÉE, par le bouton
//      sur lequel le visiteur appuie, et vaut jusqu'à la fin. On ne transforme pas une salle en
//      télécommande (arbitré 2026-07-26).
//   3. **Pas de détection automatique.** Une borne n'a pas de `navigator.language` qui veuille
//      dire quelque chose : c'est le matériel de l'exploitant, pas l'appareil du visiteur. La
//      langue vient d'un geste, jamais d'une devinette.

export type Lang = "fr" | "en";

/** Langue de RÉFÉRENCE : elle définit l'ensemble des clés et sert de repli. Toujours complète. */
export const REFERENCE_LANG: Lang = "fr";

const FR = {
  // ── Accueil ──
  "idle.start": "Toucher pour commencer",
  "idle.unavailable": "Aucune séance disponible pour le moment. Revenez bientôt.",
  "idle.poweredBy": "propulsé par Kioskoscope",
  // ── Déverrouillage ──
  "unlock.inProgress": "Déverrouillage de votre séance…",
  "unlock.followScreen": "Suivez les instructions à l'écran.",
  "unlock.cancel": "Annuler",
  "unlock.refused.title": "Le déverrouillage n'a pas abouti",
  "unlock.refused.body": "Aucun montant n'a été prélevé. Vous pouvez réessayer quand vous voulez.",
  "unlock.timeout.title": "Un peu trop long…",
  "unlock.timeout.body": "La séance ne s'est pas déverrouillée à temps. On réessaie ?",
  "unlock.cancelled.title": "Séance annulée",
  "unlock.cancelled.body": "Pas de souci — revenez quand vous êtes prêt·e.",
  "unlock.retry": "Réessayer",
  // ── Choix d'humeur et de durée ──
  "select.title": "Quelle humeur, ce soir ?",
  "select.duration": "Combien de temps avez-vous ?",
  "select.duration.short": "Court (< 5 min)",
  "select.duration.medium": "Moyen (< 10 min)",
  "select.duration.any": "Peu importe",
  "select.go": "Voir les suggestions",
  // ── Recommandations ──
  "reco.exhausted": "Vous avez fait le tour !",
  "reco.endSession": "Terminer la séance",
  "reco.playTop": "Lancer ce film",
  "reco.otherChoices": "Autres choix",
  // ── Lecteur ──
  "player.skip": "Passer",
  "player.tapToPlay": "Toucher pour lancer",
  "player.unavailable": "Ce film n'est pas disponible",
  "player.subtitles": "Sous-titres",
  "player.subtitles.off": "Sans",
  "player.volume": "Volume",
  "film.directedBy": "Un film de",
  // ── En savoir plus ──
  "learnMore.label": "En savoir plus",
  "learnMore.scan": "Scannez avec votre téléphone",
  "learnMore.qrAlt": "QR — en savoir plus",
} as const;

/** Clé de traduction : l'ensemble est FIGÉ par le français. Une clé inconnue ne compile pas. */
export type MessageKey = keyof typeof FR;

const EN: Partial<Record<MessageKey, string>> = {
  "idle.start": "Touch to start",
  "idle.unavailable": "No screening available right now. Please come back soon.",
  "idle.poweredBy": "powered by Kioskoscope",
  "unlock.inProgress": "Unlocking your screening…",
  "unlock.followScreen": "Follow the instructions on screen.",
  "unlock.cancel": "Cancel",
  "unlock.refused.title": "The unlock didn't go through",
  "unlock.refused.body": "You have not been charged. Feel free to try again.",
  "unlock.timeout.title": "That took a little long…",
  "unlock.timeout.body": "The screening didn't unlock in time. Shall we try again?",
  "unlock.cancelled.title": "Screening cancelled",
  "unlock.cancelled.body": "No worries — come back whenever you're ready.",
  "unlock.retry": "Try again",
  "select.title": "What mood are you in tonight?",
  "select.duration": "How much time do you have?",
  "select.duration.short": "Short (< 5 min)",
  "select.duration.medium": "Medium (< 10 min)",
  "select.duration.any": "Doesn't matter",
  "select.go": "See suggestions",
  "reco.exhausted": "You've seen them all!",
  "reco.endSession": "End the screening",
  "reco.playTop": "Play this film",
  "reco.otherChoices": "Other choices",
  "player.skip": "Skip",
  "player.tapToPlay": "Touch to play",
  "player.unavailable": "This film is unavailable",
  "player.subtitles": "Subtitles",
  "player.subtitles.off": "Off",
  "player.volume": "Volume",
  "film.directedBy": "A film by",
  "learnMore.label": "Learn more",
  "learnMore.scan": "Scan with your phone",
  "learnMore.qrAlt": "QR — learn more",
};

const DICTS: Record<Lang, Partial<Record<MessageKey, string>>> = { fr: FR, en: EN };

/**
 * Nom de chaque langue DANS SA PROPRE LANGUE.
 *
 * ⚠️ Règle non négociable de l'écran d'accueil : un anglophone doit reconnaître SON bouton sans
 * lire un mot de français. « Anglais » écrit en français rate toute la cible.
 */
export const LANG_ENDONYM: Record<Lang, string> = { fr: "Français", en: "English" };

/** Langues réellement servies par la cabine. L'ordre est celui d'affichage à l'accueil. */
export const AVAILABLE_LANGS: readonly Lang[] = ["fr", "en"];

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (AVAILABLE_LANGS as readonly string[]).includes(value);
}

let current: Lang = REFERENCE_LANG;

/** Langue courante du parcours. Fixée à l'entrée, constante jusqu'à la fin de la séance. */
export function currentLang(): Lang {
  return current;
}

/**
 * Fixe la langue du parcours. Appelé UNIQUEMENT par le bouton d'entrée (CIN-115) — la ré-appeler
 * en cours de séance changerait la langue sous les yeux du visiteur, ce que l'arbitrage exclut.
 */
export function setLang(lang: Lang): void {
  current = lang;
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

/**
 * Traduit une clé dans la langue courante (ou celle passée en second argument).
 *
 * Repli en cascade : langue demandée → français → la clé elle-même. Le dernier échelon ne devrait
 * jamais être atteint (le type `MessageKey` l'interdit à la compilation) ; il existe pour ne
 * JAMAIS lever d'exception en pleine séance, devant un visiteur.
 */
export function t(key: MessageKey, lang: Lang = current): string {
  const hit = DICTS[lang]?.[key];
  if (hit !== undefined) return hit;
  const fallback = DICTS[REFERENCE_LANG][key];
  if (fallback !== undefined) {
    // Signalé à l'exploitation, jamais au public : l'écran affiche du français correct.
    if (lang !== REFERENCE_LANG) console.warn(`[i18n] traduction ${lang} manquante : ${key}`);
    return fallback;
  }
  console.error(`[i18n] clé inconnue : ${key}`);
  return key;
}

/**
 * Clés absentes d'une langue, par rapport au français. PURE — c'est la fonction que teste la CI :
 * un dictionnaire incomplet doit casser le build, pas se découvrir devant un visiteur.
 */
export function missingKeys(lang: Lang): MessageKey[] {
  const keys = Object.keys(FR) as MessageKey[];
  return keys.filter((k) => DICTS[lang][k] === undefined);
}
