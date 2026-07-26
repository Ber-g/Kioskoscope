// Registre des modules activables par organisation (CIN-080 / F18).
// Philosophie : simplicité + modularité. Ajouter un module = UNE entrée ici.
// `view` (optionnel) relie le module à un menu du dashboard, qui sera grisé si non accordé.

export interface ModuleDef {
  readonly key: string;
  readonly label: string;
  readonly view?: string; // menu gated par ce module (si applicable)
}

export const MODULES: readonly ModuleDef[] = [
  { key: "rights", label: "Droits & redevances", view: "rights" },
  { key: "personalization", label: "Personnalisation (Mes styles)" }, // UI à venir (F19)
  // CIN-099 : une org qui ne facture RIEN au spectateur (forfaitaire, festival) n'a pas de
  // revenus à lire — le menu est masqué, pas grisé (voir `app.ts`). Gating par MODULE et non
  // par type de souscription : le contenu des paliers n'est pas figé (cf. SUBSCRIPTION_TYPES),
  // donc c'est le super-admin qui accorde le module org par org. Le comptage d'activité reste
  // lisible sans ce module : la page Séances n'est gatée par aucun module (décision CIN-099).
  { key: "revenue", label: "Revenus (billetterie)", view: "revenue" },
];

export const ALL_MODULE_KEYS: readonly string[] = MODULES.map((m) => m.key);

export interface SubscriptionType {
  readonly key: string;
  readonly label: string;
}

// Contenu des paliers NON figé (l'exploitant) : ici on ne fait que porter la structure.
export const SUBSCRIPTION_TYPES: readonly SubscriptionType[] = [
  { key: "demo", label: "Démo" },
  { key: "free_flat", label: "Forfaitaire Libre" },
  { key: "subscription", label: "Abonnement" },
  { key: "per_screening", label: "Licence séance-par-séance" },
];
