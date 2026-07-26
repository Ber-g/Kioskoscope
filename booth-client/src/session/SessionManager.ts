import type { Film, Play, PlaySource, Session, UnlockMethod } from "../domain/types";
import { PLAY_DECILES, emptyDeciles } from "@kioskoscope/domain";

// Gère le cycle de vie d'une session côté Kiosk : création, enregistrement des
// films lancés (Play), clôture. Pour l'instant tout est en mémoire ; la remontée
// vers le backend viendra plus tard (aucune dépendance réseau ici).

/**
 * Génère un share_token non devinable — CSPRNG, 16 octets = 128 bits d'entropie,
 * encodé base64url. La route publique /s/{token} doit reposer sur un secret de
 * capacité, pas un ID énumérable.
 */
export function generateShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomId(prefix: string): string {
  // Identifiant local lisible ; unicité suffisante pour une Kiosk unique.
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionManager {
  private session: Session | null = null;
  private plays: Play[] = [];

  constructor(
    private readonly boothId: string,
    private readonly organizationId: string,
    /** Remontée optionnelle de la séance close (Supabase). Fire-and-forget : n'interrompt pas le parcours. */
    private readonly sink?: (snapshot: { session: Session; plays: readonly Play[] }) => void,
  ) {}

  /** Démarre une session après un déverrouillage réussi. */
  start(unlockMethod: UnlockMethod, amount: number | null, paymentProviderRef: string | null): Session {
    const now = Date.now();
    this.session = {
      id: randomId("sess"),
      boothId: this.boothId,
      organizationId: this.organizationId,
      startedAt: now,
      endedAt: null,
      shareToken: generateShareToken(),
      unlockMethod,
      amount,
      paymentProviderRef,
    };
    this.plays = [];
    return this.session;
  }

  /** Enregistre le lancement d'un film. `source` distingue choix vs reco (North Star). */
  recordPlayStart(film: Film, source: PlaySource): Play {
    const session = this.requireSession();
    const play: Play = {
      id: randomId("play"),
      sessionId: session.id,
      filmId: film.id,
      position: this.plays.length,
      startedAt: Date.now(),
      completed: false,
      source,
      endedAt: null,
      watchedSeconds: 0,
      decilesReached: emptyDeciles(),
    };
    this.plays.push(play);
    return play;
  }

  /**
   * Progression d'écoute (F21 / CIN-105) — appelée pendant la lecture.
   *
   * `watchedSeconds` est MONOTONE : on ne redescend jamais, même si le spectateur revient en
   * arrière. Une seconde revue n'est pas une seconde vue en plus, et une seconde déjà vue ne
   * peut pas être « dé-vue » — c'est ce qui rend le chiffre défendable devant un ayant droit.
   */
  recordPlayProgress(playId: string, positionSeconds: number, durationSeconds: number): void {
    const play = this.plays.find((p) => p.id === playId);
    if (!play) return;
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return;

    if (positionSeconds > play.watchedSeconds) play.watchedSeconds = positionSeconds;

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    // Décile atteint = la tranche dans laquelle se trouve la tête de lecture. On marque toutes
    // les tranches jusqu'à celle-ci : un saut en avant ne doit pas « trouer » la courbe, mais il
    // ne gonfle pas `watchedSeconds` pour autant (les deux mesures répondent à deux questions).
    const reached = Math.min(PLAY_DECILES, Math.floor((positionSeconds / durationSeconds) * PLAY_DECILES) + 1);
    for (let i = 0; i < reached; i++) play.decilesReached[i] = true;
  }

  /** Marque le dernier film comme terminé (atteint la fin, pas interrompu). */
  markPlayCompleted(playId: string): void {
    const play = this.plays.find((p) => p.id === playId);
    if (!play) return;
    play.completed = true;
    play.endedAt = Date.now();
    for (let i = 0; i < PLAY_DECILES; i++) play.decilesReached[i] = true;
  }

  /** Fin de lecture SANS achèvement (interruption, abandon, passage au film suivant). */
  markPlayStopped(playId: string): void {
    const play = this.plays.find((p) => p.id === playId);
    if (play && play.endedAt === null) play.endedAt = Date.now();
  }

  /** Clôt la session et renvoie un instantané figé (session + plays). */
  end(): { session: Session; plays: readonly Play[] } {
    const session = this.requireSession();
    session.endedAt = Date.now();
    const snapshot = { session, plays: [...this.plays] };
    this.session = null;
    this.plays = [];
    this.sink?.(snapshot); // remontée backend (si branché) — ne bloque pas le retour à l'accueil
    return snapshot;
  }

  get current(): Session | null {
    return this.session;
  }

  get currentPlays(): readonly Play[] {
    return this.plays;
  }

  private requireSession(): Session {
    if (!this.session) throw new Error("Aucune session active");
    return this.session;
  }
}
