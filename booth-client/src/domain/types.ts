// Types de booth-client. Le modèle canonique (Media, Session, Play, enums…) vient
// du domaine partagé `@kioskoscope/domain` ; ici, uniquement les types spécifiques
// au parcours Kiosk + les alias historiques.

import type { Media } from "@kioskoscope/domain";

export type { UnlockMethod, PlaySource, PlayEndReason, Subtitle, Session, Play, Media } from "@kioskoscope/domain";

/** Un court métrage jouable = un `Media` (alias historique du booth-client). */
export type Film = Media;

/** Critères d'entrée du parcours de choix (F6) : humeur et/ou durée souhaitée. */
export interface MoodDurationQuery {
  readonly mood: string | null;
  /** Durée max souhaitée en secondes, ou null = indifférent. */
  readonly maxDurationSeconds: number | null;
}
