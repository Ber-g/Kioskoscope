// Bandeau d'état de la borne (BUG-017) — la seule surface de diagnostic d'une machine sans
// clavier ni souris.
//
// Le problème qu'il résout : une borne mal déployée démarrait EXACTEMENT comme une borne de
// production (plein écran, verrouillage kiosque actif, catalogue de démonstration) et le seul
// signal était un `console.info`. Sur une borne scellée, personne n'ouvre jamais la console : le
// diagnostic doit être À L'ÉCRAN ou il n'existe pas.
//
// Choix de forme, assumé :
//   - un BANDEAU, pas un écran plein — l'écran d'attente reste maître du message adressé au PUBLIC
//     (« aucune séance disponible », déjà défini) ; le bandeau parle à qui est sur place pour
//     réparer. Deux publics, deux registres, une seule surface partagée.
//   - `pointer-events: none` : il ne doit JAMAIS avaler un appui destiné au parcours ni au
//     hotspot du menu opérateur (coin bas-gauche) — le menu est le moyen de rattraper la borne.
//   - un code court et stable (`device · incomplete · orgId`) en petits caractères : assez pour
//     dicter le problème au téléphone, jamais une trace technique.
//   - il n'est pas refermable : un défaut de déploiement n'est pas une notification.
//
// ⚠️ Rien de ce qui transite ici ne doit contenir de secret. Les appelants ne passent que des
// NOMS de champs (`orgId`, `devicePassword`), jamais de valeur.

export type BoothStatusLevel = "fault" | "demo" | "offline";

export interface BoothStatusMessage {
  readonly level: BoothStatusLevel;
  /** Titre en capitales, lisible à 2 m. Court. */
  readonly title: string;
  /** Une phrase en français clair, adressée à la personne présente devant la borne. */
  readonly detail: string;
  /** Code de diagnostic dictable (facultatif). Jamais une valeur, seulement des noms/états. */
  readonly code?: string;
}

let node: HTMLElement | undefined;

/**
 * Affiche (ou remplace) le bandeau d'état. Idempotent : un seul bandeau par borne.
 * Retourne le noeud pour les tests / le nettoyage éventuel.
 */
export function showBoothStatus(msg: BoothStatusMessage): HTMLElement {
  if (!node) {
    node = document.createElement("div");
    node.setAttribute("role", "status");
    // Annonce polie : ce message ne doit pas couper la lecture d'un lecteur d'écran en cours.
    node.setAttribute("aria-live", "polite");
    document.body.appendChild(node);
  }
  node.className = `booth-status booth-status--${msg.level}`;
  node.replaceChildren();

  const title = document.createElement("strong");
  title.className = "booth-status__title";
  title.textContent = msg.title;
  const detail = document.createElement("span");
  detail.className = "booth-status__detail";
  detail.textContent = msg.detail;
  node.append(title, detail);

  if (msg.code) {
    const code = document.createElement("span");
    code.className = "booth-status__code";
    code.textContent = msg.code;
    node.appendChild(code);
  }
  return node;
}

/** Retire le bandeau (retour à un état sain — sert surtout aux tests). */
export function clearBoothStatus(): void {
  node?.remove();
  node = undefined;
}
