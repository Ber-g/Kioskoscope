// Identité de la borne : ce que le SERVEUR sait d'elle, confronté à ce que son fichier de
// configuration prétend (CIN-098).
//
// La règle tient en une phrase : une borne ne déclare pas son identité, elle la CONSTATE.
// `booths.device_user_id` est le seul lien qui fasse autorité, et il vit en base ; tout ce qui est
// posé à côté (`VITE_BOOTH_ID`, `/kiosk-config.json`) n'est qu'une copie, donc une copie qui peut
// dériver — borne recréée, `.env` recopié d'une autre machine, org renommée.
//
// Ce que coûtait la dérive (BUG-008) : la borne s'authentifie, lit son catalogue, joue les
// films… et chaque INSERT de séance est refusé par la RLS (`booth_id = current_device_booth()`
// ne matche pas). Aucune erreur devant l'exploitant : juste des statistiques qui ne bougent plus.
// Un refus RLS est muet par construction — c'est précisément ce qui en fait un bon piège.

/** Identité résolue côté serveur (RPC `current_device_booth()` / `device_org()`, migration 0009). */
export interface DeviceIdentity {
  readonly boothId: string;
  readonly orgId: string;
}

/** Champs pouvant avoir dérivé. Des NOMS, jamais les valeurs : ils finissent dans un log lisible. */
export type IdentityDriftField = "boothId" | "orgId";

export interface IdentityReconciliation {
  /** Identité à utiliser désormais — toujours celle du serveur. */
  readonly identity: DeviceIdentity;
  /** Champs où la configuration locale contredisait le serveur. Vide = provisionnement sain. */
  readonly drift: readonly IdentityDriftField[];
}

/**
 * Confronte la configuration locale à l'identité résolue. Le serveur gagne TOUJOURS — il n'y a
 * pas de cas où obéir à une valeur locale contredite par la base produirait autre chose qu'une
 * panne silencieuse.
 *
 * Une valeur locale ABSENTE n'est pas une dérive : c'est le cas nominal depuis CIN-098, où l'env
 * ne porte plus l'identité. Seule une valeur locale *présente et différente* est un signal.
 */
export function reconcileDeviceIdentity(
  configured: { readonly boothId?: string; readonly orgId?: string },
  resolved: DeviceIdentity,
): IdentityReconciliation {
  const drift: IdentityDriftField[] = [];
  if (configured.boothId && configured.boothId !== resolved.boothId) drift.push("boothId");
  if (configured.orgId && configured.orgId !== resolved.orgId) drift.push("orgId");
  return { identity: resolved, drift };
}
