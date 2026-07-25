import type { Film } from "../domain/types";
import type { RecoContext, Recommender } from "./Recommender";

// Implémentation prototype : règles simples sur les métadonnées. Score chaque
// film candidat selon l'adéquation humeur/durée, exclut les films déjà vus.
// Remplaçable par n'importe quel autre moteur sans toucher à l'UI.

const MOOD_MATCH_WEIGHT = 10;
const DURATION_FIT_WEIGHT = 3;

export class RuleBasedRecommender implements Recommender {
  recommend(catalog: readonly Film[], context: RecoContext): readonly Film[] {
    const seen = new Set(context.alreadyPlayed.map((p) => p.filmId));
    const { mood, maxDurationSeconds } = context.query;
    const active = catalog.filter((f) => f.active);
    const rank = (films: readonly Film[]): readonly Film[] =>
      films
        .map((film) => ({ film, score: this.score(film, mood, maxDurationSeconds) }))
        .sort((a, b) => b.score - a.score)
        .map((s) => s.film);

    // Repli en CASCADE : un visiteur qui a PAYÉ ne doit jamais aboutir à une liste vide tant que le
    // catalogue contient des films. La durée reste une PRÉFÉRENCE (score), pas un filtre bloquant.
    const unseen = active.filter((f) => !seen.has(f.id));
    // 1. Idéal : non vus qui tiennent dans la durée demandée.
    const fit = unseen.filter((f) => maxDurationSeconds === null || f.durationSeconds <= maxDurationSeconds);
    if (fit.length > 0) return rank(fit);
    // 2. Repli : non vus, toutes durées (les plus courts remontent via le score).
    if (unseen.length > 0) return rank(unseen);
    // 3. Repli ultime : tout le catalogue actif (le visiteur a déjà tout vu mais a re-payé une séance).
    return rank(active);
  }

  private score(film: Film, mood: string | null, maxDurationSeconds: number | null): number {
    let score = 0;

    // Correspondance d'humeur : le signal le plus fort.
    if (mood !== null && film.moods.includes(mood)) {
      score += MOOD_MATCH_WEIGHT;
    }

    // Adéquation de durée : plus le film est proche (sous) la durée max, mieux
    // c'est — on récompense l'usage de l'enveloppe de temps sans la dépasser.
    if (maxDurationSeconds !== null && film.durationSeconds <= maxDurationSeconds) {
      const fit = film.durationSeconds / maxDurationSeconds; // 0..1
      score += fit * DURATION_FIT_WEIGHT;
    }

    // Léger bruit déterministe-évitant pour éviter un ordre figé entre ex æquo.
    score += Math.random() * 0.5;

    return score;
  }
}
