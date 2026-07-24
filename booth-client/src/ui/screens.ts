import type { Film, Play } from "../domain/types";
import type { UnlockStatus } from "../unlock/UnlockAdapter";
import { getBrand, isCustomBrand } from "../domain/brand";
import { createCountdown, el, formatDuration, renderQrDataUrl } from "./dom";
import { isKioskLocked } from "../setup/kioskLockdown";
import { FocusRing } from "../input/focusRing";
import type { Intent, IntentHandler } from "../input/intents";

// Chaque écran renvoie un noeud + une fonction de nettoyage optionnelle (timers,
// vidéo…) + son handler d'intentions (F14 : modèle de focus / contrôles média).
// Un seul écran est monté à la fois par App, qui branche `handler` à l'InputController.
export interface ScreenResult {
  readonly node: HTMLElement;
  readonly dispose?: () => void;
  /** Handler d'intentions de l'écran (navigation au focus, contrôles média…). */
  readonly handler?: IntentHandler;
}

const screen = (name: string, children: Array<Node | string>): HTMLElement =>
  el("section", { class: `screen screen--${name}` }, children);

// Assainit une URL avant de l'injecter dans un `url("…")` CSS : retire guillemets, parenthèses,
// antislash et sauts de ligne qui pourraient casser/échapper la déclaration. L'URL vient du style
// d'org (super_user), mais on ne fait jamais confiance à une chaîne pour construire du CSS.
function cssUrl(url: string): string {
  return url.replace(/["'()\\\s]/g, (c) => encodeURIComponent(c));
}

// Bande de vignettes « en savoir plus ». Utilise les vraies images si le film en
// a ; sinon génère des placeholders dégradés déterministes (déclinés par titre).
function stillTiles(film: Film, count = 3): HTMLElement {
  const tiles: HTMLElement[] = [];
  if (film.stills.length > 0) {
    for (const src of film.stills.slice(0, count)) {
      tiles.push(el("img", { class: "still", src, alt: `Extrait — ${film.title}`, loading: "lazy" }));
    }
  } else {
    // Placeholder : dégradé dérivé du tmdbId/titre pour une variété stable.
    const seed = film.tmdbId ?? film.title.length;
    for (let i = 0; i < count; i++) {
      const hue = (seed * 47 + i * 61) % 360;
      const tile = el("div", { class: "still still--placeholder" }, [
        el("span", { class: "still__label" }, [film.title]),
      ]);
      tile.style.background = `linear-gradient(135deg, hsl(${hue} 40% 22%), hsl(${(hue + 40) % 360} 45% 14%))`;
      tiles.push(tile);
    }
  }
  return el("div", { class: "stills" }, tiles);
}

// Bloc de valorisation de l'auteur : réalisateur, synopsis, extraits, lien.
function authorBlock(film: Film): HTMLElement {
  const children: Array<Node | string> = [
    el("p", { class: "eyebrow" }, ["Un film de"]),
    el("h3", { class: "author__name" }, [film.director]),
    el("p", { class: "author__synopsis" }, [film.synopsis]),
    stillTiles(film),
  ];
  if (film.learnMoreUrl) {
    // Sur la borne verrouillée (CIN-072), ouvrir un onglet externe = évasion du kiosque.
    // On propose un QR : le visiteur ouvre le lien sur SON téléphone, la borne reste scellée.
    // En dev / hors kiosque, on garde le lien cliquable (pratique de test).
    children.push(isKioskLocked() ? learnMoreQr(film.learnMoreUrl) : learnMoreLink(film.learnMoreUrl));
  }
  return el("div", { class: "author" }, children);
}

/** Lien « En savoir plus » cliquable (dev / hors kiosque). */
function learnMoreLink(url: string): HTMLElement {
  return el("a", { class: "btn btn--ghost", href: url, target: "_blank", rel: "noopener" }, ["En savoir plus"]);
}

/** QR « En savoir plus » (borne verrouillée) : le visiteur ouvre le lien sur son téléphone. */
function learnMoreQr(url: string): HTMLElement {
  const img = el("img", { class: "learn-more__qr", alt: "QR — en savoir plus", width: "132", height: "132" }) as HTMLImageElement;
  void renderQrDataUrl(url).then((src) => (img.src = src)).catch(() => undefined);
  return el("div", { class: "learn-more" }, [
    el("p", { class: "learn-more__label" }, ["En savoir plus"]),
    img,
    el("p", { class: "learn-more__hint" }, ["Scannez avec votre téléphone"]),
  ]);
}

// ── Écran d'accueil (idle / attract loop) ───────────────────────────────────
// `hasFilms=false` (org sans média jouable) → PAS de bouton de démarrage : le visiteur ne peut
// pas déverrouiller (donc jamais payer) pour un catalogue vide ; message humain à la place.
export function idleScreen(onStart: () => void, hasFilms = true): ScreenResult {
  const start = el("button", { class: "btn btn--primary btn--xl", type: "button" }, [
    "Toucher pour commencer",
  ]);
  start.addEventListener("click", onStart);
  const unavailable = el("p", { class: "muted idle-unavailable" }, [
    "Aucune séance disponible pour le moment. Revenez bientôt.",
  ]);
  // F19 : titre/accroche viennent de la marque de l'org (repli maître). Logo v2 = si présent,
  // il remplace le titre typographique ; sinon le titre reste. « powered by » non supprimable.
  const brand = getBrand();
  const heading = brand.logoUrl
    ? el("img", { class: "brand__logo", src: brand.logoUrl, alt: brand.title })
    : el("h1", { class: "brand__title" }, [brand.title]);
  const brandChildren = [heading, el("p", { class: "brand__tagline" }, [brand.tagline])];
  // Mention non supprimable, uniquement sur une marque d'org (redondante si marque = maître).
  if (isCustomBrand()) brandChildren.push(el("p", { class: "brand__powered" }, ["propulsé par Kioskoscope"]));
  const node = screen("idle", [el("div", { class: "brand" }, brandChildren), hasFilms ? start : unavailable]);
  // F19 v2 : image d'attente de l'org en fond (assets). Un voile sombre (via .has-idle-image)
  // garde le titre/bouton lisibles quelle que soit l'image. Absente → fond de marque par défaut.
  if (brand.idleImageUrl) {
    node.classList.add("has-idle-image");
    node.style.setProperty("--idle-image", `url("${cssUrl(brand.idleImageUrl)}")`);
  }
  return { node, handler: new FocusRing({ items: hasFilms ? [start] : [] }) };
}

// ── Déverrouillage en cours ──────────────────────────────────────────────────
export function unlockingScreen(onCancel: () => void): ScreenResult {
  const cancel = el("button", { class: "btn btn--ghost", type: "button" }, ["Annuler"]);
  cancel.addEventListener("click", onCancel);
  return {
    node: screen("unlocking", [
      el("div", { class: "spinner", "aria-hidden": "true" }, []),
      el("h2", {}, ["Déverrouillage de votre séance…"]),
      el("p", { class: "muted" }, ["Suivez les instructions à l'écran."]),
      cancel,
    ]),
    handler: new FocusRing({ items: [cancel], onBack: onCancel }),
  };
}

// ── Repli après échec de déverrouillage (jamais d'écran technique) ───────────
export function unlockFallbackScreen(status: UnlockStatus, onRetry: () => void): ScreenResult {
  // Copie non-technique, actionnable, adaptée à chaque cas.
  const messages: Record<Exclude<UnlockStatus, "success">, { title: string; body: string }> = {
    refused: {
      title: "Le déverrouillage n'a pas abouti",
      body: "Aucun montant n'a été prélevé. Vous pouvez réessayer quand vous voulez.",
    },
    timeout: {
      title: "Un peu trop long…",
      body: "La séance ne s'est pas déverrouillée à temps. On réessaie ?",
    },
    abandoned: {
      title: "Séance annulée",
      body: "Pas de souci — revenez quand vous êtes prêt·e.",
    },
  };
  const m = messages[status as Exclude<UnlockStatus, "success">] ?? messages.refused;
  const retry = el("button", { class: "btn btn--primary", type: "button" }, ["Réessayer"]);
  retry.addEventListener("click", onRetry);
  return {
    node: screen("fallback", [
      el("h2", {}, [m.title]),
      el("p", { class: "muted" }, [m.body]),
      retry,
    ]),
    handler: new FocusRing({ items: [retry], onBack: onRetry }),
  };
}

// ── Sélection par humeur / durée ─────────────────────────────────────────────
export interface SelectChoice {
  readonly mood: string | null;
  readonly maxDurationSeconds: number | null;
}

export function selectScreen(
  moods: readonly string[],
  onChoose: (choice: SelectChoice) => void,
): ScreenResult {
  let mood: string | null = null;
  let maxDuration: number | null = null;

  const moodButtons = moods.map((m) => {
    const b = el("button", { class: "chip", type: "button", "data-mood": m }, [m]);
    b.addEventListener("click", () => {
      mood = mood === m ? null : m;
      for (const other of moodButtons) other.classList.toggle("chip--on", other === b && mood === m);
    });
    return b;
  });

  const durations: Array<{ label: string; value: number | null }> = [
    { label: "Court (< 5 min)", value: 300 },
    { label: "Moyen (< 10 min)", value: 600 },
    { label: "Peu importe", value: null },
  ];
  let durationButtons: HTMLButtonElement[] = [];
  durationButtons = durations.map((d) => {
    const b = el("button", { class: "chip", type: "button" }, [d.label]);
    b.addEventListener("click", () => {
      maxDuration = d.value;
      for (const other of durationButtons) other.classList.toggle("chip--on", other === b);
    });
    return b;
  });

  const go = el("button", { class: "btn btn--primary btn--lg", type: "button" }, [
    "Voir les suggestions",
  ]);
  go.addEventListener("click", () => onChoose({ mood, maxDurationSeconds: maxDuration }));

  return {
    node: screen("select", [
      el("h2", {}, ["Quelle humeur, ce soir ?"]),
      el("p", { class: "muted" }, ["Choisissez une ambiance et une durée — ou laissez-vous guider."]),
      el("div", { class: "group" }, [
        el("h3", { class: "group__label" }, ["Ambiance"]),
        el("div", { class: "chips" }, moodButtons),
      ]),
      el("div", { class: "group" }, [
        el("h3", { class: "group__label" }, ["Durée"]),
        el("div", { class: "chips" }, durationButtons),
      ]),
      go,
    ]),
    handler: new FocusRing({ items: [...moodButtons, ...durationButtons, go] }),
  };
}

// ── Recommandation : proposition principale + alternatives ───────────────────
export interface RecoCallbacks {
  readonly onPlayRecommended: (film: Film) => void;
  readonly onPlayChosen: (film: Film) => void;
  readonly onNoneEndSession: () => void;
}

export function recoScreen(recommended: readonly Film[], cb: RecoCallbacks): ScreenResult {
  if (recommended.length === 0) {
    const end = el("button", { class: "btn btn--primary", type: "button" }, ["Terminer la séance"]);
    end.addEventListener("click", cb.onNoneEndSession);
    return {
      node: screen("reco", [
        el("h2", {}, ["Vous avez fait le tour !"]),
        el("p", { class: "muted" }, ["Plus de film à proposer pour ces critères."]),
        end,
      ]),
      handler: new FocusRing({ items: [end], onBack: cb.onNoneEndSession }),
    };
  }

  const [top, ...rest] = recommended;
  const playTop = el("button", { class: "btn btn--primary btn--lg", type: "button" }, ["Lancer ce film"]);
  playTop.addEventListener("click", () => cb.onPlayRecommended(top!));

  const restCards = rest.slice(0, 3).map((f) => {
    const card = el("button", { class: "filmcard", type: "button" }, [
      el("span", { class: "filmcard__title" }, [f.title]),
      el("span", { class: "filmcard__meta" }, [`${formatDuration(f.durationSeconds)} · ${f.genres.join(", ")}`]),
    ]);
    card.addEventListener("click", () => cb.onPlayChosen(f));
    return card;
  });

  return {
    node: screen("reco", [
      el("p", { class: "eyebrow" }, ["On vous propose"]),
      el("div", { class: "hero" }, [
        el("h2", { class: "hero__title" }, [top!.title]),
        el("p", { class: "hero__meta" }, [
          `${top!.year} · ${formatDuration(top!.durationSeconds)} · ${top!.moods.join(", ")}`,
        ]),
      ]),
      playTop,
      rest.length > 0
        ? el("div", { class: "group" }, [
            el("h3", { class: "group__label" }, ["Ou plutôt…"]),
            el("div", { class: "filmcards" }, restCards),
          ])
        : el("span", {}, []),
    ]),
    handler: new FocusRing({ items: [playTop, ...restCards] }),
  };
}

// ── Lecture (réelle si storageUrl, sinon simulée) ────────────────────────────
export function playerScreen(film: Film, onFinished: () => void): ScreenResult {
  const title = el("div", { class: "player__title" }, [film.title]);
  const bar = el("div", { class: "progress__bar" }, []);
  const progress = el("div", { class: "progress" }, [bar]);
  const skip = el("button", { class: "btn btn--ghost btn--corner", type: "button" }, ["Passer (démo)"]);

  let disposed = false;
  const finishOnce = () => {
    if (disposed) return;
    disposed = true;
    onFinished();
  };
  skip.addEventListener("click", finishOnce);

  let intervalId: number | undefined;
  let videoEl: HTMLVideoElement | undefined;

  if (film.storageUrl) {
    // Lecture réelle.
    videoEl = el("video", { class: "player__video", src: film.storageUrl, autoplay: true, playsinline: true });
    videoEl.addEventListener("ended", finishOnce);
    videoEl.addEventListener("error", finishOnce); // jamais bloquer sur un fichier absent/corrompu
    // Barre de progression RÉELLE (avant : figée à 0 % pour une vraie vidéo, animée seulement en démo).
    videoEl.addEventListener("timeupdate", () => {
      const v = videoEl;
      if (v && v.duration > 0) bar.style.width = `${Math.min(100, (v.currentTime / v.duration) * 100)}%`;
    });
    // Autoplay peut être refusé (chaîne de gestes rompue) : on avale le rejet du play() pour éviter
    // une promesse non gérée. `error`/`ended` couvrent l'échec dur ; le repli UI reste à faire (#2).
    void videoEl.play?.().catch(() => undefined);
  } else {
    // Lecture SIMULÉE : progression accélérée (~12 s) pour tester le parcours.
    const SIM_MS = 12000;
    const started = performance.now();
    intervalId = window.setInterval(() => {
      const ratio = Math.min(1, (performance.now() - started) / SIM_MS);
      bar.style.width = `${ratio * 100}%`;
      if (ratio >= 1) finishOnce();
    }, 100);
  }

  const badge = film.storageUrl
    ? el("span", {}, [])
    : el("span", { class: "sim-badge" }, ["DÉMO · lecture simulée"]);

  const node = screen("player", [
    videoEl ?? el("div", { class: "player__stage" }, [badge, title, el("p", { class: "muted" }, [
      `${formatDuration(film.durationSeconds)} · ${film.year}`,
    ])]),
    progress,
    skip,
  ]);

  // Contrôles média en intentions (F14) : le lecteur expose play/pause/stop/volume
  // en actions de premier plan (avant : « passer » uniquement). Navigation/confirm
  // délégués à l'anneau (le bouton « Passer »).
  const ring = new FocusRing({ items: [skip], onBack: finishOnce });
  const handler: IntentHandler = {
    handle(intent: Intent): void {
      switch (intent) {
        case "playPause":
          if (videoEl) {
            if (videoEl.paused) void videoEl.play();
            else videoEl.pause();
          }
          break;
        case "stop":
          finishOnce();
          break;
        case "volumeUp":
          if (videoEl) videoEl.volume = Math.min(1, videoEl.volume + 0.1);
          break;
        case "volumeDown":
          if (videoEl) videoEl.volume = Math.max(0, videoEl.volume - 0.1);
          break;
        default:
          ring.handle(intent);
      }
    },
  };

  return {
    node,
    handler,
    dispose: () => {
      disposed = true;
      if (intervalId !== undefined) clearInterval(intervalId);
      if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute("src");
      }
    },
  };
}

// ── Après un film : valorisation de l'auteur + choix + compte à rebours ──────
export interface AfterFilmCallbacks {
  readonly onAnother: () => void;
  readonly onEnd: () => void;
  /** Fin du compte à rebours sans action → passage à la page de fin (QR). */
  readonly onExpire: () => void;
}

export function afterFilmScreen(
  film: Film,
  watchedCount: number,
  countdownSeconds: number,
  cb: AfterFilmCallbacks,
): ScreenResult {
  const another = el("button", { class: "btn btn--primary btn--lg", type: "button" }, ["Encore un film"]);
  another.addEventListener("click", cb.onAnother);
  const end = el("button", { class: "btn btn--ghost", type: "button" }, ["Terminer la séance"]);
  end.addEventListener("click", cb.onEnd);

  const countdown = createCountdown(countdownSeconds, cb.onExpire);

  return {
    node: screen("after", [
      el("p", { class: "muted" }, [watchedCount === 1 ? "Vous venez de voir" : `${watchedCount}ᵉ film · vous venez de voir`]),
      el("h2", { class: "after__title" }, [`${film.title} (${film.year})`]),
      authorBlock(film),
      el("div", { class: "actions" }, [another, end]),
      countdown.node,
    ]),
    handler: new FocusRing({ items: [another, end], onBack: cb.onEnd }),
    dispose: countdown.dispose,
  };
}

// ── Fin de séance : récap + QR de partage ────────────────────────────────────
export function endScreen(
  plays: readonly Play[],
  filmLookup: (id: string) => Film | undefined,
  shareUrl: string,
  onDone: () => void,
): ScreenResult {
  const recapItems = plays.map((p, i) => {
    const f = filmLookup(p.filmId);
    return el("li", { class: "recap__item" }, [
      el("span", { class: "recap__index" }, [String(i + 1)]),
      el("span", { class: "recap__text" }, [
        el("span", { class: "recap__title" }, [f ? `${f.title} (${f.year})` : p.filmId]),
        f ? el("span", { class: "recap__author" }, [`de ${f.director}`]) : el("span", {}, []),
      ]),
      p.source === "recommendation" ? el("span", { class: "recap__tag" }, ["suggéré"]) : el("span", {}, []),
    ]);
  });

  const qrImg = el("img", { class: "qr", alt: "QR code vers votre séance", width: 220, height: 220 });
  void renderQrDataUrl(shareUrl).then((dataUrl) => {
    qrImg.src = dataUrl;
  });

  const done = el("button", { class: "btn btn--primary", type: "button" }, ["Terminer"]);
  done.addEventListener("click", onDone);

  return {
    node: screen("end", [
      el("h2", {}, ["Votre séance"]),
      el("ol", { class: "recap" }, recapItems),
      el("div", { class: "share" }, [
        qrImg,
        el("p", { class: "muted" }, ["Scannez pour retrouver et partager votre séance."]),
        el("p", { class: "fineprint" }, ["Lien public et temporaire — aucune donnée personnelle."]),
      ]),
      done,
    ]),
    handler: new FocusRing({ items: [done], onBack: onDone }),
  };
}
