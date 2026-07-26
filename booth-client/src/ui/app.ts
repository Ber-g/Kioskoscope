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
  /** Inactivité max sur les écrans de CHOIX (sélection/reco) avant retour à l'accueil (ms). Évite
   *  qu'une borne reste bloquée sur le choix si un visiteur abandonne après avoir déverrouillé. */
  readonly parcoursInactivityMs: number;
  /** Hook appelé À CHAQUE retour à l'accueil (entre deux visiteurs) — sert à rafraîchir le catalogue/
   *  style depuis le back-office sans reboot. Fire-and-forget ; jamais pendant une séance. Optionnel. */
  readonly onIdle?: () => void;
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
  private inactivityTimer: number | undefined;
  private inactivityMs = 0; // >0 seulement sur les écrans de choix (sélection/reco)
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
    // Toute interaction ré-arme le minuteur d'inactivité (no-op hors écrans de choix).
    this.root.addEventListener("pointerdown", () => this.armInactivity());
    window.addEventListener("keydown", () => this.armInactivity());
  }

  /** (Ré)arme le minuteur d'inactivité des écrans de choix ; à expiration → abandon → accueil. */
  private armInactivity(): void {
    if (this.inactivityTimer !== undefined) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
    if (this.inactivityMs > 0) this.inactivityTimer = window.setTimeout(() => this.abandonToIdle(), this.inactivityMs);
  }

  /** Abandon en cours de choix : on TERMINE la séance déjà payée (enregistrée, 0 film → pas de perte
   *  de revenu) puis on revient à l'accueil pour le visiteur suivant. */
  private abandonToIdle(): void {
    if (this.sessions.current) this.sessions.end();
    this.goIdle();
  }

  start(): void {
    this.goIdle();
  }

  /**
   * Filet de sécurité kiosque : ramène le parcours à l'accueil après une erreur non gérée — une borne
   * publique ne doit JAMAIS rester sur un écran mort. N'enregistre RIEN (l'état peut être corrompu) ;
   * annule un déverrouillage en cours. Le menu opérateur (couche séparée) n'est pas affecté.
   */
  recover(): void {
    try {
      this.unlockController?.abort();
    } catch {
      // annulation best-effort — ne jamais faire échouer la récupération.
    }
    this.goIdle();
  }

  // ── Montage d'écran ────────────────────────────────────────────────────────
  private mount(result: ScreenResult, inactivityMs = 0): void {
    this.currentDispose?.();
    if (this.endTimer !== undefined) {
      clearTimeout(this.endTimer);
      this.endTimer = undefined;
    }
    this.root.replaceChildren(result.node);
    this.currentDispose = result.dispose;
    // L'écran monté devient le seul récepteur d'intentions (undefined = personne).
    this.input.setHandler(result.handler);
    // Minuteur d'inactivité : armé seulement sur les écrans de choix (inactivityMs>0), sinon annulé
    // (jamais pendant la lecture d'un film — l'absence d'interaction y est normale).
    this.inactivityMs = inactivityMs;
    this.armInactivity();
  }

  // ── États ──────────────────────────────────────────────────────────────────
  private goIdle(): void {
    resetMoodTheme(); // retour à la palette neutre entre deux visiteurs
    // Rafraîchissement back-office ENTRE deux visiteurs (jamais en séance) : catalogue/style à jour
    // sans reboot. Fire-and-forget, débounce côté hook. Erreur avalée (ne casse pas le retour accueil).
    try {
      this.config.onIdle?.();
    } catch {
      // hook défaillant : on ne compromet jamais l'affichage de l'accueil.
    }
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
      this.config.parcoursInactivityMs, // abandon au choix → retour accueil (séance payée enregistrée)
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
      this.config.parcoursInactivityMs, // abandon au choix → retour accueil (séance payée enregistrée)
    );
  }

  private playFilm(film: Film, source: "recommendation" | "user_choice"): void {
    // La couleur suit l'humeur dominante du film lancé.
    applyMoodTheme(film.moods[0] ?? this.lastQuery.mood);
    const play = this.sessions.recordPlayStart(film, source);
    this.mount(
      playerScreen(
        film,
        (reason) => {
          // Seule une fin NATURELLE vaut achèvement (F21). Un film passé ou un fichier illisible
          // gonfleraient un taux d'achèvement destiné à des ayants droit.
          if (reason === "ended") this.sessions.markPlayCompleted(play.id);
          else this.sessions.markPlayStopped(play.id);
          this.goAfterFilm(film);
        },
        (positionSeconds, durationSeconds) => this.sessions.recordPlayProgress(play.id, positionSeconds, durationSeconds),
      ),
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
