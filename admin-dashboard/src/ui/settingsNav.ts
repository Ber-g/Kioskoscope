// Résolution de la navigation du menu Organisation (onglet + org affichée) — CIN-118.
//
// ── Pourquoi un module à part, sans DOM ─────────────────────────────────────────────────────
// Même raison que `router.ts` : `settings.ts` tire `bootstrap`, qui n'existe pas sous Node — le
// jour où la règle de repli vit dans l'écran, elle n'est plus vérifiable ailleurs qu'à la main
// dans un onglet. Ici elle est pure, donc couverte par `scripts/logic_smoke.ts`. Et le fichier
// vit sous `src/` pour être vu par `tsc` (`scripts/` n'est pas typé).
//
// ── Pourquoi une SEULE fonction pour deux replis ────────────────────────────────────────────
// Ces deux règles existaient déjà, mais séparées par le rendu : l'org disparue était rattrapée
// avant de construire la page, l'onglet devenu invisible pendant. Entre les deux, l'URL avait
// déjà été publiée — elle annonçait donc un onglet que l'écran n'affichait pas. Les réunir sans
// céder la main est ce qui garantit qu'on publie l'état FINAL, une seule fois.

import type { SettingsTab } from "./router";

/**
 * Onglets de pilotage PLATEFORME : l'organisation les subit, elle ne les règle pas. Masqués —
 * pas grisés — hors global_admin (un client n'a pas à savoir qu'un écran d'attribution existe).
 *
 * Déclarés ICI et non dans `settings.ts` : c'est le résolveur qui décide de la visibilité, donc
 * un onglet ne peut pas être déclaré « admin » côté écran sans l'être côté repli.
 */
export const ADMIN_ONLY_SETTINGS_TABS: readonly SettingsTab[] = ["subscription"];

/** Contexte de résolution — tout ce dont la décision dépend, capturé d'un seul tenant. */
export interface SettingsNavContext {
  /** Orgs visibles par le compte, dans l'ordre d'affichage. */
  readonly orgIds: readonly string[];
  /** Org DU COMPTE. `null` pour un global_admin : la plateforme n'a pas d'org « sienne ». */
  readonly accountOrgId: string | null;
  /** Org demandée par l'URL / l'ouverture depuis le roster. */
  readonly targetOrgId: string | null;
  readonly isGlobalAdmin: boolean;
}

/**
 * Résout l'état de navigation demandé en un état AFFICHABLE.
 *
 * `changed` dit si la résolution a modifié la demande — c'est le seul cas où l'URL doit être
 * réécrite. Sans lui, on republierait l'adresse à chaque rendu (bruit dans l'historique) et,
 * pire, on tairait le cas qui compte : une adresse qui annonce autre chose que l'écran.
 *
 * Aucune I/O, aucun `await` : la décision est prise d'un seul tenant, jamais à cheval sur un
 * rendu — c'est la règle que l'ancien découpage violait.
 */
export function resolveSettingsNav(
  req: { tab: SettingsTab; orgId: string | null },
  ctx: SettingsNavContext,
): { tab: SettingsTab; orgId: string | null; changed: boolean } {
  const visible = (id: string | null): string | null => (id !== null && ctx.orgIds.includes(id) ? id : null);

  // Une org mémorisée qui n'existe plus (supprimée, ou droits perdus depuis) ne doit pas produire
  // une page vide et muette : on retombe sur la cible demandée, puis sur l'org du compte, puis
  // sur la première visible (cas du global_admin, qui n'a pas d'org à lui).
  const orgId =
    visible(req.orgId) ?? visible(ctx.targetOrgId) ?? visible(ctx.accountOrgId) ?? ctx.orgIds[0] ?? null;

  // Un onglet plateforme peut avoir disparu entre-temps (rôle global_admin perdu) : sans ce
  // repli, la page afficherait un contenu sans onglet actif visible — et l'URL le nommerait.
  const tab = ADMIN_ONLY_SETTINGS_TABS.includes(req.tab) && !ctx.isGlobalAdmin ? "general" : req.tab;

  return { tab, orgId, changed: tab !== req.tab || orgId !== req.orgId };
}

/**
 * Org DÉSIGNÉE : celle qu'on administre pour quelqu'un d'autre, ou `null` si c'est la sienne.
 *
 * Une seule définition, parce que trois écrans en dépendent et qu'ils divergeaient : l'adresse
 * (`#/organizations/<id>` vs `#/settings`), le surlignage du menu (« Organisations » vs « Mon
 * organisation ») et le lien de retour vers le roster. Quand ils ne s'accordent pas, l'URL
 * prétend une chose et l'écran en montre une autre.
 *
 * `accountOrgId === null` ⇒ global_admin : il n'administre JAMAIS « la sienne », donc toute org
 * affichée est une org désignée.
 */
export function designatedOrgId(displayedOrgId: string | null, accountOrgId: string | null): string | null {
  if (displayedOrgId === null) return null;
  return displayedOrgId === accountOrgId ? null : displayedOrgId;
}
