// Journal OFFLINE des séances (F9, résilience). Une borne peut perdre le réseau EN COURS
// d'exploitation ; sans buffer, une séance terminée (et son PAIEMENT) serait définitivement perdue
// quand `saveSession` échoue. On la met de côté en localStorage et on la rejoue à la reconnexion.
//
// Idempotence : chaque entrée porte un `id` de séance STABLE (réutilisé à chaque tentative) → le
// backend fait un UPSERT (on conflict do nothing) → aucun double-comptage de revenu même si l'on
// rejoue une séance déjà partiellement remontée.

import type { Play, Session } from "../domain/types";

export interface PendingSession {
  /** Id de séance stable (PK côté Supabase) — garantit un rejeu idempotent. */
  readonly id: string;
  readonly session: Session;
  readonly plays: readonly Play[];
}

const KEY = "ko-session-journal";
const CAP = 500; // borne le buffer si la synchro traîne (FIFO) — largement au-dessus d'un usage réel

function safeParse(raw: string | null): PendingSession[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as PendingSession[]) : [];
  } catch {
    return [];
  }
}

/** Buffer local des séances non encore remontées. Dégradation silencieuse si localStorage indispo. */
export class SessionJournal {
  constructor(private readonly key: string = KEY) {}

  private read(): PendingSession[] {
    try {
      return safeParse(localStorage.getItem(this.key));
    } catch {
      return [];
    }
  }

  private write(list: PendingSession[]): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(list));
    } catch {
      // stockage plein/indispo : on ne peut pas bufferiser — non bloquant (mieux que crasher).
    }
  }

  /** Met une séance de côté (échec de remontée). FIFO borné pour ne pas croître sans fin. */
  append(entry: PendingSession): void {
    const all = this.read();
    // Évite les doublons d'id si on rebufferise une entrée déjà en attente.
    const deduped = all.filter((e) => e.id !== entry.id);
    deduped.push(entry);
    this.write(deduped.length > CAP ? deduped.slice(deduped.length - CAP) : deduped);
  }

  /** Séances en attente de remontée. */
  peek(): readonly PendingSession[] {
    return this.read();
  }

  /** Retire une séance une fois remontée avec succès. */
  remove(id: string): void {
    this.write(this.read().filter((e) => e.id !== id));
  }
}
