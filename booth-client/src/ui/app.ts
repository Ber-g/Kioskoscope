import { activeCatalog, availableMoods, filmById } from "../domain/catalog";
import type { Film, MoodDurationQuery } from "../domain/types";
import type { Recommender } from "../reco/Recommender";
import { SessionManager } from "../session/SessionManager";
import type { UnlockAdapter } from "../unlock/UnlockAdapter";
import type { ScreenResult } from "./screens";
import {
  afterFilmScreen,
  endScreen,
  idleScreen,
  playerScreen,
  recoScreen,
  selectScreen,
  unlockFallbackScreen,
  unlockingScreen,
} from "./screens";
import { applyMoodTheme, resetMoodTheme } from "./moodTheme";
import { InputController } from "../input/InputController";
import { KeyboardInputSource } from "../input/sources/keyboard";

export interface AppConfig {
  readonly boothId: string;
  /** Base de l'URL publique de partage. La page vit dans le backend (à venir). */
  readonly shareBaseUrl: string;
  /** Délai de retour à l'accueil après la fin de séance (ms). */
  readonly endAutoReturnMs: number;
  /** Temps laissé au public pour choisir après un film, avant la page de fin (s). */
  readonly afterFilmCountdownSeconds: number;
}

/**
 * Contrôleur du parcours. State machine explicite : un seul écran monté à la
 * fois. Ne référence JAMAIS un fournisseur de paiement ni un algo de reco
 * concret — uniquement les interfaces UnlockAdapter et Recommender injectées.
 */
export class App {
  private readonly root: HTMLElement;
  private currentDispose: (() => void) | undefined;
  private lastQuery: MoodDurationQuery = { mood: null, maxDurationSeconds: null };
  private unlockController: AbortController | undefined;
  private endTimer: number | undefined;
  // F14 : une seule instance pour toute la session. Les sources d'entrée (clavier
  // maintenant, boutons physiques plus tard) sont attachées une fois ; chaque écran
  // monté devient le handler actif via mount().
  private readonly input: InputController;

  constructor(
    root: HTMLElement,
    private readonly unlock: UnlockAdapter,
    private readonly recommender: Recommender,
    private readonly sessions: SessionManager,
    private readonly config: AppConfig,
  ) {
    this.root = root;
    this.input = new InputController([new KeyboardInputSource()]);
  }

  start(): void {
    this.goIdle();
  }

  // ── Montage d'écran ────────────────────────────────────────────────────────
  private mount(result: ScreenResult): void {
    this.currentDispose?.();
    if (this.endTimer !== undefined) {
      clearTimeout(this.endTimer);
      this.endTimer = undefined;
    }
    this.root.replaceChildren(result.node);
    this.currentDispose = result.dispose;
    // L'écran monté devient le seul récepteur d'intentions (undefined = personne).
    this.input.setHandler(result.handler);
  }

  // ── États ──────────────────────────────────────────────────────────────────
  private goIdle(): void {
    resetMoodTheme(); // retour à la palette neutre entre deux visiteurs
    // Catalogue vide (org sans média jouable) → écran d'attente SANS démarrage : jamais de
    // déverrouillage/paiement pour du vide. La borne reste vivante (menu opérateur inchangé).
    const hasFilms = activeCatalog().length > 0;
    this.mount(idleScreen(() => this.beginUnlock(), hasFilms));
  }

  private beginUnlock(): void {
    this.unlockController = new AbortController();
    this.mount(
      unlockingScreen(() => {
        this.unlockController?.abort();
      }),
    );

    void this.unlock.startUnlock(this.unlockController.signal).then((result) => {
      if (result.status === "success") {
        this.sessions.start(result.method, result.amount, result.paymentProviderRef);
        this.goSelect();
      } else {
        this.mount(unlockFallbackScreen(result.status, () => this.beginUnlock()));
      }
    });
  }

  private goSelect(): void {
    this.mount(
      selectScreen(availableMoods(), (choice) => {
        this.lastQuery = choice;
        applyMoodTheme(choice.mood); // la couleur suit l'humeur choisie
        this.goReco();
      }),
    );
  }

  private goReco(): void {
    const recommended = this.recommender.recommend(activeCatalog(), {
      alreadyPlayed: this.sessions.currentPlays,
      query: this.lastQuery,
    });
    this.mount(
      recoScreen(recommended, {
        onPlayRecommended: (film) => this.playFilm(film, "recommendation"),
        onPlayChosen: (film) => this.playFilm(film, "user_choice"),
        onNoneEndSession: () => this.goEnd(),
      }),
    );
  }

  private playFilm(film: Film, source: "recommendation" | "user_choice"): void {
    // La couleur suit l'humeur dominante du film lancé.
    applyMoodTheme(film.moods[0] ?? this.lastQuery.mood);
    const play = this.sessions.recordPlayStart(film, source);
    this.mount(
      playerScreen(film, () => {
        this.sessions.markPlayCompleted(play.id);
        this.goAfterFilm(film);
      }),
    );
  }

  private goAfterFilm(film: Film): void {
    const count = this.sessions.currentPlays.length;
    this.mount(
      afterFilmScreen(film, count, this.config.afterFilmCountdownSeconds, {
        onAnother: () => this.goSelect(),
        onEnd: () => this.goEnd(),
        onExpire: () => this.goEnd(), // pas de choix à temps → page de fin (QR)
      }),
    );
  }

  private goEnd(): void {
    const { session, plays } = this.sessions.end();
    const shareUrl = `${this.config.shareBaseUrl}/s/${session.shareToken}`;
    this.mount(
      endScreen(plays, (id) => filmById(id), shareUrl, () => this.goIdle()),
    );
    // Retour automatique à l'accueil si personne ne clique (kiosque).
    this.endTimer = window.setTimeout(() => this.goIdle(), this.config.endAutoReturnMs);
  }
}
