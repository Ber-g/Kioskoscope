import type { UnlockAdapter, UnlockResult, UnlockStatus } from "./UnlockAdapter";

// Adaptateur de démonstration. Simule un déverrouillage — et surtout ses ÉCHECS
// (refused/timeout/abandoned), afin de pouvoir tester les écrans de repli sans
// aucun matériel — le mock doit simuler aussi les échecs.

export interface MockUnlockOptions {
  /** Issue forcée (utile pour tester un cas précis). Sinon, tirage pondéré. */
  readonly forcedStatus?: UnlockStatus;
  /** Délai simulé avant résolution (ms). */
  readonly delayMs?: number;
}

// Pondération par défaut : le succès domine, mais les échecs arrivent assez
// souvent pour qu'on les rencontre en test manuel.
const DEFAULT_WEIGHTS: ReadonlyArray<readonly [UnlockStatus, number]> = [
  ["success", 0.7],
  ["refused", 0.15],
  ["timeout", 0.1],
  ["abandoned", 0.05],
];

/** Prix simulé d'une séance, en centimes (5,00 €). Le vrai montant viendra de l'adaptateur `card`. */
const MOCK_AMOUNT_CENTS = 500;

function weightedPick(): UnlockStatus {
  const r = Math.random();
  let acc = 0;
  for (const [status, w] of DEFAULT_WEIGHTS) {
    acc += w;
    if (r <= acc) return status;
  }
  return "success";
}

export class MockUnlockAdapter implements UnlockAdapter {
  readonly method = "mock" as const;

  constructor(private readonly options: MockUnlockOptions = {}) {}

  startUnlock(signal?: AbortSignal): Promise<UnlockResult> {
    const delay = this.options.delayMs ?? 900;
    const status = this.options.forcedStatus ?? weightedPick();

    return new Promise<UnlockResult>((resolve) => {
      if (signal?.aborted) {
        resolve(this.result("abandoned"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(this.result(status));
      }, delay);

      const onAbort = () => {
        clearTimeout(timer);
        resolve(this.result("abandoned"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private result(status: UnlockStatus): UnlockResult {
    // Un déverrouillage RÉUSSI porte un montant (en centimes) : sans lui, la séance remonte
    // avec `amount_cents = null`, aucune transaction n'est créée et le menu Revenus reste
    // vide — la boucle « le visiteur paie → le revenu remonte » n'était donc jamais prouvée
    // (SPEC F9 : « Revenus fonctionne dès maintenant avec les sessions en mode mock »).
    // Un échec ne prélève rien (cohérent avec l'écran de repli « aucun montant prélevé »).
    if (status !== "success") return { status, method: this.method, amount: null, paymentProviderRef: null };
    return { status, method: this.method, amount: MOCK_AMOUNT_CENTS, paymentProviderRef: `mock_${Date.now().toString(36)}` };
  }
}
