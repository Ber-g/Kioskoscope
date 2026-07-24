// @kioskoscope/domain — modèle de domaine CANONIQUE partagé par toutes les apps
// (booth-client, admin-dashboard, fleet-api). Source de vérité unique des entités
// et énumérations. Aligné V2 : multi-organisations, isolation par `organizationId`.
//
// Règle : une entité tenant-scoped porte TOUJOURS `organizationId`.

// ── Énumérations ─────────────────────────────────────────────────────────────
export type UnlockMethod = "mock" | "card" | "coin" | "token" | "free";
export type PlaySource = "user_choice" | "recommendation";
export type OrgRole = "super_user" | "manager" | "operator" | "viewer";
export type OrganizationType = "bar" | "festival" | "event";
export type HealthStatus = "operational" | "attention" | "error" | "offline" | "maintenance";
export type BoothIndicator = "powered" | "in_use" | "updating";
export type ConnectionType = "wifi" | "lte";
export type StorageType = "local" | "usb" | "object";

// ── Tenancy : organisations, utilisateurs, appartenances ─────────────────────
export interface Organization {
  readonly id: string;
  name: string;
  type: OrganizationType;
  /** Région d'opération. Règle : 1 org = 1 région (code libre "FR", "BE"…), nullable au départ. */
  region?: string | null;
  /** Devise ISO-4217 (défaut EUR). Pilote le formatage monétaire de l'org. */
  currency?: string;
  settings: { themeId?: string; whitelistTags: string[] };
}

export interface User {
  readonly id: string;
  name: string;
  email: string;
  /** Accès transverse à TOUT (l'exploitant). Contourne le scoping par org. */
  isGlobalAdmin: boolean;
}

/** Appartenance user × organisation × rôle (un user a 0..n memberships). */
export interface Membership {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: OrgRole;
}

// ── Médias ───────────────────────────────────────────────────────────────────
export interface Subtitle {
  readonly lang: string; // ISO (fr, en…)
  readonly format: "vtt" | "srt";
  readonly url: string;
  readonly workflowStatus: "todo" | "rework" | "verified";
}

/**
 * Média canonique (un court métrage). Tenant-scoped. `contentHash` (SHA-256) =
 * dedup (unique par org) + intégrité. Les apps peuvent en exposer un sous-ensemble.
 */
export interface Media {
  readonly id: string;
  readonly organizationId: string;
  readonly contentHash: string;
  readonly title: string;
  readonly year: number;
  readonly durationSeconds: number;
  readonly storageUrl: string | null;
  readonly version: number;
  readonly active: boolean;
  readonly tmdbId: number | null;
  readonly genres: readonly string[];
  readonly moods: readonly string[];
  /** Tags éditoriaux (nuit, lent…), distincts des tags d'audience. */
  readonly tags: readonly string[];
  /** Tags d'audience pour la whitelist (18+, enfant, bar, festival…). */
  readonly audienceTags: readonly string[];
  readonly language: string;
  readonly subtitles: readonly Subtitle[];
  readonly director: string;
  readonly synopsis: string;
  readonly stills: readonly string[];
  readonly learnMoreUrl: string | null;
  /** Validation humaine (opérateur) : epoch ms de la validation, `null` si non validée. */
  readonly reviewedAt: number | null;
  /** Id de l'utilisateur ayant validé (audit), `null` si non validée. */
  readonly reviewedBy: string | null;
  /** Protection du fichier (anti-copie). La DRM elle-même est portée par la borne signée. */
  readonly protection?: "none" | "encrypted" | "drm";
  /** Schéma DRM si `protection = 'drm'` (widevine, playready, fairplay, custom). */
  readonly drmScheme?: string | null;
  /** Le master a été livré déjà protégé par le distributeur. */
  readonly sourceProtected?: boolean;
}

// ── Vocabulaire d'humeurs (F6) ───────────────────────────────────────────────
// SOURCE UNIQUE de la taxonomie d'humeurs, partagée par le back-office (saisie),
// le moteur de reco (match `Media.moods`) et le thème Kiosk (palette). Une humeur
// hors de cette liste ne matche NI la reco NI une palette → à ne jamais saisir en
// texte libre. Choix @design : 7 humeurs à température/saturation cohérentes.
export const CANONICAL_MOODS = [
  { key: "apaisant", label: "Apaisant" },
  { key: "mélancolique", label: "Mélancolique" },
  { key: "énergique", label: "Énergique" },
  { key: "léger", label: "Léger" },
  { key: "joyeux", label: "Joyeux" },
  { key: "tendu", label: "Tendu" },
  { key: "sombre", label: "Sombre" },
] as const;

/** Clé d'humeur canonique (union dérivée de {@link CANONICAL_MOODS}). */
export type CanonicalMood = (typeof CANONICAL_MOODS)[number]["key"];

export interface StorageLocation {
  readonly id: string;
  readonly boothId: string;
  readonly type: StorageType;
  label: string;
  capacityBytes: number;
  freeBytes: number;
}

/** Présence physique d'un média sur un support de stockage. */
export interface MediaInstance {
  readonly id: string;
  readonly mediaId: string;
  readonly storageLocationId: string;
}

// ── Kiosks (Booth) ──────────────────────────────────────────────────────────
export interface DailyStat {
  readonly date: string; // ISO "YYYY-MM-DD"
  readonly sessions: number;
  readonly bandwidthMb: number;
}

export interface BoothLog {
  readonly at: number; // epoch ms
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

export interface BoothTelemetry {
  readonly uptimePct: number;
  readonly temperatureC: number;
  readonly storageFreePct: number;
  readonly cpuLoadPct: number;
  readonly currentFilmTitle: string | null;
  readonly connection: ConnectionType;
  readonly signalPct: number;
}

export interface Booth {
  readonly id: string;
  label: string;
  location: string;
  health: HealthStatus;
  indicators: BoothIndicator[];
  readonly lastHeartbeatAt: number;
  softwareVersion: string;
  sessionsToday: number;
  revenueTodayCents: number;
  telemetry: BoothTelemetry;
  logs: BoothLog[];
  history: readonly DailyStat[];
  /** Organisation propriétaire (isolation stricte). */
  organizationId: string;
  address: string;
  gpsLat: number | null;
  gpsLng: number | null;
  /** Catégorie du LIEU où est posée la Kiosk (bar, musée, festival…). Propre à la Kiosk. */
  venueType: string | null;
  /** Numéro physique de la borne (2ᵉ id, ÉDITABLE — distinct de l'UUID `id` qui, lui, est stable
   * et ancre l'historique). Modifiable par le global_admin uniquement. Texte libre, non unique. */
  serial: string | null;
  notes: string;
  /** Machine signée (DRM) : epoch ms de signature du device, `null` si non signée. */
  readonly signedAt?: number | null;
  /** Référence côté serveur de la clé/cert DRM du device — jamais la clé elle-même. */
  readonly deviceKeyRef?: string | null;
  /** Heure locale (0-23) de la fenêtre de MAJ non urgente (F10). */
  readonly maintenanceHour?: number;
}

// ── Notifications (F15) ──────────────────────────────────────────────────────
// Modèle piloté par CATALOGUE : `type` est une clé libre du registry ci-dessous,
// jamais un enum figé en base → ajouter un type = 0 migration. Préférences à
// l'échelle du USER (globales, tous orgs confondus). Livraison MVP = in-app.
export type NotificationSeverity = "critical" | "warning" | "info";
export type NotificationChannel = "in_app" | "email" | "push" | "sms";

/** Entrée du catalogue de types de notification (définition, pas instance). */
export interface NotificationTypeDef {
  readonly key: string;
  /** Regroupement pour la page de réglages (ex. "Kiosks", "Paiements"). */
  readonly category: string;
  readonly label: string;
  readonly severity: NotificationSeverity;
  /** Canaux cochés par défaut tant que le user n'a pas d'override. */
  readonly defaultChannels: readonly NotificationChannel[];
  /** Rôles pouvant recevoir/voir ce type ; vide = tous les rôles. */
  readonly roleScope: readonly OrgRole[];
  /** Réservé au global_admin (debug/sécurité) — invisible pour les opérateurs. */
  readonly adminOnly?: boolean;
}

/** Une notification délivrée à un user (instance). */
export interface Notification {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string | null;
  readonly type: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly boothId: string | null;
  readonly data: Record<string, unknown>;
  readonly readAt: number | null;
  readonly createdAt: number;
}

/** Préférence GLOBALE (per-user) pour un type. Absente ⇒ défauts du catalogue.
 *  `channels` vide ⇒ notif désactivée (muette) pour ce type. */
export interface NotificationPreference {
  readonly userId: string;
  readonly type: string;
  readonly channels: readonly NotificationChannel[];
}

/**
 * CATALOGUE des types de notification — source unique consommée par le rendu de
 * la cloche ET la page de réglages. Amorcé avec des types dérivés de la
 * télémétrie existante ; la liste définitive sera fournie plus tard. Ajouter une
 * entrée ici suffit : aucun changement de schéma ni d'UI requis.
 */
export const NOTIFICATION_TYPES: readonly NotificationTypeDef[] = [
  { key: "booth_offline", category: "Kiosks", label: "Kiosk hors ligne", severity: "critical", defaultChannels: ["in_app"], roleScope: [] },
  { key: "storage_low", category: "Kiosks", label: "Stockage faible", severity: "warning", defaultChannels: ["in_app"], roleScope: [] },
  { key: "temperature_high", category: "Kiosks", label: "Température élevée", severity: "warning", defaultChannels: ["in_app"], roleScope: [] },
  { key: "payment_failed", category: "Paiements", label: "Paiement en échec", severity: "warning", defaultChannels: ["in_app"], roleScope: ["super_user", "manager"] },
  { key: "update_available", category: "Maintenance", label: "Mise à jour disponible", severity: "info", defaultChannels: ["in_app"], roleScope: ["super_user", "manager"] },
];

/** Résout les canaux effectifs d'un type pour un user (override sinon défaut). */
export function resolveChannels(
  typeKey: string,
  prefs: readonly NotificationPreference[],
): readonly NotificationChannel[] {
  const override = prefs.find((p) => p.type === typeKey);
  if (override) return override.channels;
  return NOTIFICATION_TYPES.find((t) => t.key === typeKey)?.defaultChannels ?? [];
}

// ── Sessions & lectures ──────────────────────────────────────────────────────
export interface Session {
  readonly id: string;
  readonly boothId: string;
  readonly organizationId: string;
  readonly startedAt: number; // epoch ms
  endedAt: number | null;
  readonly shareToken: string;
  readonly unlockMethod: UnlockMethod;
  readonly amount: number | null;
  readonly paymentProviderRef: string | null;
}

export interface Play {
  readonly id: string;
  readonly sessionId: string;
  readonly filmId: string;
  readonly position: number; // 0-based
  readonly startedAt: number;
  completed: boolean;
  readonly source: PlaySource;
}

// ── Accès opérateur cabine (CIN-073, F17 volet A) ────────────────────────────
// Auth opérateur OFFLINE : le menu opérateur d'une Kiosk doit s'ouvrir même hors
// ligne (Wi-Fi tombé). On ne rejoue donc PAS un login en ligne : on valide un PIN
// contre une table d'accès mise en cache localement, poussée par le back-office
// quand la Kiosk est en ligne. Le secret est le PIN — jamais stocké en clair, ni en
// base ni sur la Kiosk : seule l'empreinte (PBKDF2-SHA256 + sel par entrée) circule.
//
// Source UNIQUE (booth-client ET admin-dashboard l'importent) : le dashboard hache à
// la création d'un accès, la Kiosk vérifie hors ligne — la constante de coût ne peut
// donc pas diverger. WebCrypto (`crypto.subtle`) est présent côté navigateur ET Node 20+.

export type OperatorRole = "global_admin" | "super_user" | "operator";

export interface AccessEntry {
  /** Identifiant opérateur, non secret. Ex. « PERCHOIR-CAB001-OP ». */
  readonly identifier: string;
  /** Empreinte PBKDF2-SHA256 du PIN, en hexadécimal. Jamais le PIN en clair. */
  readonly pinHash: string;
  /** Sel par entrée, en hexadécimal. */
  readonly salt: string;
  /** Nombre d'itérations PBKDF2 utilisées pour cette empreinte. */
  readonly iterations: number;
  readonly role: OperatorRole;
  /** Date d'expiration ISO, ou null = pas d'expiration. */
  readonly expiresAt: string | null;
  readonly revoked: boolean;
}

export interface AccessTable {
  readonly orgId: string;
  readonly boothId: string;
  /** Quand le back-office a poussé cette table (ISO). Sert à afficher la fraîcheur. */
  readonly updatedAt: string;
  readonly entries: readonly AccessEntry[];
}

export type VerifyResult =
  | { ok: true; role: OperatorRole; identifier: string }
  | { ok: false; reason: "invalid" | "expired" | "revoked" };

/**
 * PIN = secret à faible entropie (6 chiffres ≈ 20 bits). Le coût PBKDF2 élevé est
 * la seule barrière si le cache fuit ; on vise ~200 ms/essai sur du matériel modeste.
 * (Le durcissement complémentaire = chiffrement du cache au repos + verrou d'essais UI.)
 */
export const PBKDF2_ITERATIONS = 210_000;
const OPERATOR_HASH_BYTES = 32;

const operatorSubtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto indisponible (crypto.subtle)");
  return c.subtle;
};

function operatorToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Sel aléatoire cryptographique, en hexadécimal (défaut 16 octets). */
export function randomSalt(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return operatorToHex(buf);
}

function operatorHexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Dérive l'empreinte hex d'un PIN pour un sel + un coût donnés (PBKDF2-SHA256). */
export async function hashPin(pin: string, saltHex: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const key = await operatorSubtle().importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await operatorSubtle().deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: operatorHexToBytes(saltHex), iterations },
    key,
    OPERATOR_HASH_BYTES * 8,
  );
  return operatorToHex(new Uint8Array(bits));
}

/** Normalise un identifiant pour comparaison (tolère espaces / casse à la saisie). */
export function normalizeIdentifier(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Compare deux chaînes hex en temps ~constant (évite les fuites par timing). */
function operatorConstantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Construit une entrée d'accès (côté back-office / seed). Le PIN n'est jamais
 * conservé : seule l'empreinte l'est.
 */
export async function buildAccessEntry(params: {
  identifier: string;
  pin: string;
  role: OperatorRole;
  expiresAt?: string | null;
  revoked?: boolean;
}): Promise<AccessEntry> {
  const salt = randomSalt();
  const pinHash = await hashPin(params.pin, salt, PBKDF2_ITERATIONS);
  return {
    identifier: normalizeIdentifier(params.identifier),
    pinHash,
    salt,
    iterations: PBKDF2_ITERATIONS,
    role: params.role,
    expiresAt: params.expiresAt ?? null,
    revoked: params.revoked ?? false,
  };
}

/**
 * Valide un couple identifiant + PIN contre la table en cache, hors ligne.
 *
 * L'état d'une entrée (révoquée / expirée) n'est révélé QUE si le PIN est correct :
 * sans le bon PIN, on renvoie toujours « invalid » — pas d'énumération des
 * identifiants ni de leur statut.
 */
// ── F19 — Style d'organisation (« Mes styles ») ──────────────────────────────
// Contrat de personnalisation qu'une org (client, super_user) POSE et que la cabine
// CONSOMME (elle n'écrit rien). Le super-admin (global_admin) peut le borner ou le
// réinitialiser au style maître (F20 : « reset » = absence de surcharge). Forme figée =
// 7 slots couleur + fontes + assets. **Source unique cabine + dashboard : ne pas dupliquer.**
// La précédence de rendu côté cabine est : maître Kioskoscope < ce style d'org < humeur runtime.

/** 7 slots de couleur : 3 dominantes + 2 secondaires + 2 textes (cf. F19). */
export interface OrgStylePalette {
  /** Dominante 1 — fond profond (salle obscure). */
  readonly bg: string;
  /** Dominante 2 — surface (cartes, panneaux). */
  readonly surface: string;
  /** Dominante 3 — surface surélevée (boutons neutres, éléments actifs). */
  readonly surfaceRaised: string;
  /** Secondaire 1 — accent chaud : actions, sélection (ambre projecteur par défaut). */
  readonly accent: string;
  /** Secondaire 2 — accent froid : lueur d'écran, focus (CRT par défaut). */
  readonly accent2: string;
  /** Texte 1 — corps lisible. */
  readonly text: string;
  /** Texte 2 — mis en valeur (titres, chiffres). */
  readonly textEmphasis: string;
}

/** Piles de fontes (chaînes CSS `font-family`). Titre / corps / utilitaire (UI, data). */
export interface OrgStyleFonts {
  readonly display: string;
  readonly body: string;
  readonly ui: string;
}

/** Assets de marque. URLs (ou data:) — light + dark, image d'attente, bandeau. */
export interface OrgStyleAssets {
  readonly logoLight?: string;
  readonly logoDark?: string;
  readonly idleImage?: string;
  readonly banner?: string;
}

/**
 * Style d'une organisation. Tous les champs sont OPTIONNELS et partiels : un slot absent
 * retombe sur le style maître (Kioskoscope). La mention « powered by Kioskoscope » reste
 * NON supprimable côté rendu, quel que soit ce style.
 */
export interface OrgStyle {
  readonly palette?: Partial<OrgStylePalette>;
  readonly fonts?: Partial<OrgStyleFonts>;
  readonly assets?: OrgStyleAssets;
  /** Titre de marque affiché (écran d'attente). */
  readonly title?: string;
}

// ── Contraste (WCAG) — source UNIQUE cabine + dashboard ───────────────────────
// Le contraste texte/fond d'un style d'org est AUTOMATIQUE (jamais une décision opérateur) :
// la cabine choisit l'encre lisible sur un accent, le dashboard prévient si un couple est sous
// le seuil AA. Ces helpers vivent ici pour éviter toute divergence entre les apps.

/** Parse #rgb / #rrggbb → [r,g,b] 0-255, ou null si invalide. */
export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Luminance relative WCAG d'un hex. Repli 0.5 (neutre) si non parsable. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHexColor(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ratio de contraste WCAG entre deux couleurs (1 → 21). AA texte normal = ≥ 4.5. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Encre lisible (foncée/claire) sur un fond donné, par luminance. `dark`/`light` = les deux
 * encres candidates (défauts = encre projecteur foncée / papier clair). Seuil ~0.4.
 */
export function readableInk(bg: string, dark = "#1a1206", light = "#f4f2ee"): string {
  return relativeLuminance(bg) > 0.4 ? dark : light;
}

export async function verifyOperator(
  table: AccessTable,
  identifier: string,
  pin: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const id = normalizeIdentifier(identifier);
  const entry = table.entries.find((e) => e.identifier === id);

  // Identifiant inconnu : on hache quand même (temps ~constant) puis on rejette.
  if (!entry) {
    await hashPin(pin, "00", PBKDF2_ITERATIONS);
    return { ok: false, reason: "invalid" };
  }

  const candidate = await hashPin(pin, entry.salt, entry.iterations);
  if (!operatorConstantTimeEqual(candidate, entry.pinHash)) return { ok: false, reason: "invalid" };

  // PIN correct : on peut maintenant révéler l'état sans risque d'énumération.
  if (entry.revoked) return { ok: false, reason: "revoked" };
  if (entry.expiresAt !== null && Date.parse(entry.expiresAt) <= now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, role: entry.role, identifier: entry.identifier };
}
