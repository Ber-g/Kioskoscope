// Vocabulaire et contrôles de langue COMMUNS aux pistes d'un média — sous-titres ET versions
// vidéo (CIN-094+095). Une piste = une langue, dans les deux cas : c'est la règle qui rend
// l'ajout d'une 2ᵉ piste sans ambiguïté. Source unique pour que les deux tableaux disent
// exactement la même chose d'un même code langue.

/** Ce qu'il faut d'une piste pour juger de sa langue — sous-titre comme version vidéo. */
export interface LangTrack {
  readonly lang: string;
}

/** Langues proposées (suggestions, pas une contrainte : le champ accepte tout code ISO). */
export const COMMON_LANGS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "fr", label: "Français" },
  { code: "en", label: "Anglais" },
  { code: "es", label: "Espagnol" },
  { code: "de", label: "Allemand" },
  { code: "it", label: "Italien" },
  { code: "pt", label: "Portugais" },
  { code: "nl", label: "Néerlandais" },
];

export function langLabel(code: string): string {
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
export function baseLang(code: string): string {
  return code.split(/[-_]/)[0] ?? code;
}

/**
 * Avertissements pour un code saisi, au regard des pistes déjà présentes.
 * Renvoie une liste (vide = rien à signaler) — jamais une erreur bloquante.
 */
export function langWarnings(lang: string, tracks: readonly LangTrack[]): string[] {
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
export function existingAmbiguities(tracks: readonly LangTrack[]): string[] {
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
