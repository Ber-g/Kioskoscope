import type { Booth, CurrentIdentity, Media, MediaInstance, OrgRole, StorageLocation, User } from "../domain/types";
import { MOCK_BOOTHS, MOCK_MEMBERSHIPS, MOCK_ORGS, MOCK_USERS } from "./mockFleet";
import { isSupabaseConfigured, supabase } from "./supabase";
import { boothToRow, mediaToRow, rowToBooth, rowToMedia, rowToMediaInstance, rowToStorageLocation, rowToTransaction, type TransactionRecord } from "./mappers";
import { sha256Hex } from "./hash";
import { buildAccessEntry, type OperatorRole, type OrgStyle, type OrgStyleAssets, type OrgStyleFonts, type OrgStylePalette } from "@kioskoscope/domain";

/** Accès opérateur cabine (CIN-073) — vue back-office (jamais le PIN, seulement méta). */
export interface OperatorAccessRecord {
  readonly id: string;
  readonly identifier: string;
  readonly role: OperatorRole;
  readonly boothId: string | null;
  readonly expiresAt: string | null;
  readonly revoked: boolean;
  readonly label: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Ligne du journal d'accès opérateur (remontée par la Kiosk). */
export interface OperatorLogRecord {
  readonly id: string;
  readonly at: string;
  readonly boothId: string | null;
  readonly identifier: string | null;
  readonly action: string;
  readonly detail: string | null;
}

/** Agrégats de lecture d'un média (dashboard F8). */
export interface MediaStat {
  readonly mediaId: string;
  readonly title: string;
  readonly plays: number;
  readonly playSeconds: number;
}
export interface MediaStatsResult {
  readonly totalPlays: number;
  readonly totalSeconds: number;
  /** Médias les plus lus, décroissant (top 10). */
  readonly top: readonly MediaStat[];
}

/** Résumé d'organisation exposé à l'UI (avec région/devise — 1 org = 1 région). */
export interface OrgSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly region: string | null;
  readonly currency: string;
  readonly whitelistTags: readonly string[];
  readonly themeId: string | null;
}

/** Membre d'une organisation (jointure memberships × users). */
export interface OrgMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly isSelf: boolean;
}

/** Invitation en attente / traitée. */
export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly status: "pending" | "accepted" | "revoked" | "expired";
  readonly token: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Séance (session) avec les films joués — menu Sessions (F9). */
export interface SessionRow {
  readonly id: string;
  readonly boothLabel: string;
  readonly startedAt: number;
  readonly unlockMethod: string;
  readonly amountCents: number | null;
  readonly films: ReadonlyArray<{ title: string; source: string; completed: boolean }>;
}

/**
 * UNE LECTURE de film (ligne de `plays`), enrichie du contexte de sa séance (CIN-099).
 *
 * C'est l'unité comptable du produit : « ce film a été lu N fois ». Volontairement INDÉPENDANTE
 * de toute notion de revenu — une séance gratuite (forfait, festival, location) produit des
 * lectures qu'il faut compter pour les rapports aux ayants droit, même quand elle rapporte 0 €.
 */
export interface FilmPlayRow {
  readonly mediaId: string;
  readonly title: string;
  readonly boothLabel: string;
  readonly at: number;
  readonly completed: boolean;
  readonly source: string;
  // ── Profondeur d'écoute (F21 / CIN-105, migration 0026) ────────────────────
  /** Secondes réellement vues. 0 pour les lectures antérieures à l'instrumentation. */
  readonly watchedSeconds: number;
  /** Déciles atteints (10 booléens) — matière de la courbe de rétention. */
  readonly decilesReached: readonly boolean[];
  /** Durée du média au moment de l'affichage — dénominateur du taux d'écoute. 0 si inconnue. */
  readonly durationSeconds: number;
  /** Séance d'origine : sert à ne compter son montant QU'UNE fois malgré N lectures. */
  readonly sessionId: string;
  /** Montant de la séance (null = gratuite). Porté par chaque lecture, dédoublonné à l'agrégat. */
  readonly sessionAmountCents: number | null;
}

/** Version logicielle déployable (Phase 4 / F10). */
export interface Release {
  readonly id: string;
  readonly version: string;
  readonly urgency: "normal" | "urgent";
  readonly notes: string;
  readonly createdAt: number;
}
/** État de déploiement d'une release sur une Kiosk. */
export interface BoothUpdate {
  readonly id: string;
  readonly boothId: string;
  readonly releaseId: string;
  readonly status: "pending" | "scheduled" | "applying" | "applied" | "failed" | "rolled_back";
  readonly scheduledFor: number | null;
  readonly appliedAt: number | null;
  readonly error: string;
}
/** Ligne de rapport MAJ par Kiosk. */
export interface UpdatesRow {
  readonly boothId: string;
  readonly boothLabel: string;
  readonly currentVersion: string;
  readonly lastHeartbeat: number;
  readonly maintenanceHour: number;
  readonly latest: { version: string; urgency: "normal" | "urgent"; status: BoothUpdate["status"]; updateId: string } | null;
}
export interface UpdatesReport {
  readonly releases: readonly Release[];
  readonly rows: readonly UpdatesRow[];
}

/** Commande de MAJ OS (back-office → borne), CIN-077. Une par borne à la fois. */
export interface OsUpdateCommand {
  readonly id: string;
  readonly boothId: string;
  readonly status: "pending" | "running" | "done" | "failed";
  readonly packagesPending: number | null;
  readonly requestedAt: number;
  readonly finishedAt: number | null;
  readonly log: string;
  readonly error: string;
}

/** Distributeur (ayant droit) — org-scoped, donc rattaché au territoire de l'org. */
export interface Distributor {
  readonly id: string;
  readonly name: string;
  readonly territory: string;
  readonly contactEmail: string;
  readonly notes: string;
}

export type RoyaltyModel = "free" | "per_screening" | "revenue_share" | "flat";

/** Licence de diffusion d'un média (termes de droits). Une par (org, média). */
export interface MediaLicense {
  readonly id: string;
  readonly mediaId: string;
  readonly distributorId: string | null;
  readonly royaltyModel: RoyaltyModel;
  readonly royaltyCents: number;
  readonly revenueSharePct: number;
  readonly minimumGuaranteeCents: number | null;
  readonly maxScreenings: number | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly notes: string;
}

/** Plafond/scope par machine pour une licence (optionnel). */
export interface LicenseBooth {
  readonly id: string;
  readonly licenseId: string;
  readonly boothId: string;
  readonly maxScreenings: number | null;
}

/** Ligne du rapport droits & redevances (par média). */
export interface RightsRow {
  readonly mediaId: string;
  readonly title: string;
  readonly distributorName: string | null;
  readonly royaltyModel: RoyaltyModel | null;
  readonly screeningsUsed: number;
  readonly maxScreenings: number | null;
  readonly capScope: "org" | "per_booth" | "none";
  readonly perBooth: ReadonlyArray<{ boothId: string; boothLabel: string; used: number; cap: number | null }>;
  readonly royaltyOwedCents: number;
  readonly status: "no_license" | "expired" | "over_cap" | "ok";
}
export interface RightsReport {
  readonly rows: readonly RightsRow[];
  readonly totalOwedCents: number;
  readonly overCapCount: number;
  readonly noLicenseCount: number;
  readonly currency: string;
}

/** Intégration de paiement (config NON-SECRÈTE ; secrets côté serveur via secretRef). */
export interface PaymentIntegration {
  readonly id: string;
  readonly provider: string;
  readonly mode: "test" | "live";
  readonly status: "active" | "inactive" | "error";
  readonly label: string;
  readonly config: Record<string, unknown>;
  readonly secretRef: string | null;
}

/** Enregistrement sous-titre (table `subtitles`) — le domaine `Subtitle` n'a ni id ni mediaId. */
export interface SubtitleRecord {
  readonly id: string;
  readonly mediaId: string;
  readonly lang: string;
  readonly format: "vtt" | "srt";
  readonly url: string;
  readonly workflowStatus: "todo" | "rework" | "verified";
}

/**
 * Une VERSION VIDÉO d'un média, dans une langue (CIN-095, table `media_videos` / migration 0027).
 * Pendant exact de `SubtitleRecord` : une version = une langue, ajouter une langue n'écrase
 * jamais les autres. `isPrimary` = la version servie aux cabines (miroir de `media.storage_url`).
 * `originalFilename` / `sizeBytes` / `createdAt` / `createdBy` répondent à « quel fichier est en
 * ligne, depuis quand, envoyé par qui » (CIN-104) — nuls pour les fichiers d'avant le suivi.
 */
export interface MediaVideoRecord {
  readonly id: string;
  readonly mediaId: string;
  readonly lang: string;
  readonly storageUrl: string;
  readonly originalFilename: string | null;
  readonly sizeBytes: number | null;
  readonly createdAt: number | null;
  readonly createdBy: string | null;
  readonly isPrimary: boolean;
}

// Store = cache en mémoire + couche d'accès aux données. Deux modes :
// - `mock`     : données factices + localStorage (sans backend).
// - `supabase` : données réelles ; l'ISOLATION est imposée par la RLS Postgres
//   (les requêtes ne renvoient déjà que les lignes autorisées).
// Les getters restent SYNCHRONES (lisent le cache) ; les écritures et le chargement
// sont async et déclenchent `emit()` → re-render.

const LS_BOOTHS = "kioskoscope.admin.booths.v2";
const LS_IDENTITY = "kioskoscope.admin.identity.v2";
const LS_LAYOUT = "kioskoscope.admin.layout.v1";

type Listener = () => void;

/**
 * Ligne `org_styles` (jsonb) → `OrgStyle` du domaine. Chaque bloc est optionnel : une colonne
 * NULL retombe sur le style maître. exactOptionalPropertyTypes → spreads conditionnels (jamais
 * de clé posée à `undefined`).
 */
function rowToOrgStyle(row: Record<string, unknown>): OrgStyle {
  const palette = (row.palette as Partial<OrgStylePalette> | null) ?? null;
  const fonts = (row.fonts as Partial<OrgStyleFonts> | null) ?? null;
  const assets = (row.assets as OrgStyleAssets | null) ?? null;
  const title = (row.title as string | null) ?? null;
  return {
    ...(palette ? { palette } : {}),
    ...(fonts ? { fonts } : {}),
    ...(assets ? { assets } : {}),
    ...(title ? { title } : {}),
  };
}

/**
 * Type d'asset de marque uploadable (F19 v2). La valeur EST le segment de chemin storage
 * (`{orgId}/{kind}.webp`, bucket public `org-assets`). Contrat fixé par la migration 0019.
 */
export type OrgAssetKind = "logo-light" | "logo-dark" | "idle" | "banner";

/** Brouillon mutable du bloc `assets` figé du domaine (exactOptionalPropertyTypes). */
type OrgAssetsDraft = { -readonly [K in keyof OrgStyleAssets]?: string };

/** Correspondance kind storage → champ `assets` du domaine (`OrgStyleAssets`). */
const ORG_ASSET_FIELD: Record<OrgAssetKind, keyof OrgStyleAssets> = {
  "logo-light": "logoLight",
  "logo-dark": "logoDark",
  idle: "idleImage",
  banner: "banner",
};

function mockIdentityFor(userId: string): CurrentIdentity {
  const user = MOCK_USERS.find((u) => u.id === userId) ?? (MOCK_USERS[0] as User);
  if (user.isGlobalAdmin) return { user, activeOrganizationId: null, role: null };
  const membership = MOCK_MEMBERSHIPS.find((m) => m.userId === user.id);
  return { user, activeOrganizationId: membership?.organizationId ?? null, role: membership?.role ?? null };
}

export class FleetStore {
  readonly mode: "mock" | "supabase" = isSupabaseConfigured ? "supabase" : "mock";
  private booths: Booth[] = [];
  private media: Media[] = [];
  private storageLocations: StorageLocation[] = [];
  private mediaInstances: MediaInstance[] = [];
  private subtitles: SubtitleRecord[] = [];
  private mediaVideos: MediaVideoRecord[] = [];
  private transactions: TransactionRecord[] = [];
  private distributors: Distributor[] = [];
  private mediaLicensesCache: MediaLicense[] = [];
  private licenseBoothsCache: LicenseBooth[] = [];
  private releases: Release[] = [];
  private boothUpdates: BoothUpdate[] = [];
  private osUpdateCommands: OsUpdateCommand[] = [];
  private orgs: OrgSummary[] = [];
  // Feature gating (CIN-080) : entitlements par org (souscription + modules). Absent = tout ON.
  private entitlements = new Map<string, { subscriptionType: string; enabledModules: string[] }>();
  // Styles d'org (F19, table 0018). Absent (pas de ligne) = style maître Kioskoscope.
  private orgStyles = new Map<string, OrgStyle>();
  private identity: CurrentIdentity | null = null;
  private authed = false;
  /**
   * Vrai tant que `init()` n'a pas répondu (CIN-118).
   *
   * `getSession()` est asynchrone : entre le premier rendu et sa réponse, on ne SAIT PAS si
   * l'utilisateur est connecté. Afficher l'écran de connexion pendant cet intervalle est une
   * affirmation fausse — c'est ce qui renvoyait au login à chaque rechargement de page, alors
   * que la session était parfaitement valide. « Je ne sais pas encore » ≠ « pas connecté ».
   */
  private booting = true;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ── Initialisation (async) ──────────────────────────────────────────────────
  /** Vrai tant que la restauration de session n'a pas répondu (CIN-118). */
  get isBooting(): boolean {
    return this.booting;
  }

  async init(): Promise<void> {
    try {
      await this.bootstrap();
    } finally {
      // `finally` : même si la restauration échoue, on doit SORTIR de l'état « je ne sais pas ».
      // Rester bloqué sur « Chargement… » serait pire que d'afficher l'écran de connexion.
      this.booting = false;
      this.emit();
    }
  }

  private async bootstrap(): Promise<void> {
    if (this.mode === "mock") {
      this.booths = this.loadMockBooths();
      this.orgs = MOCK_ORGS.map((o) => ({
        id: o.id, name: o.name, type: o.type, region: o.region ?? null, currency: o.currency ?? "EUR",
        whitelistTags: o.settings.whitelistTags ?? [], themeId: o.settings.themeId ?? null,
      }));
      this.identity = mockIdentityFor(localStorage.getItem(LS_IDENTITY) ?? "user-admin");
      this.authed = true;
      this.emit();
      return;
    }
    const { data } = await supabase!.auth.getSession();
    if (data.session) await this.loadFromSupabase();
    else this.emit(); // pas de session → écran de connexion
  }

  // ── Auth (mode supabase) ────────────────────────────────────────────────────
  get needsAuth(): boolean {
    return this.mode === "supabase" && !this.authed;
  }
  async signIn(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
    const { error } = await supabase!.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    // BUG-015 : une connexion est aussi une transition. Sans ça, un chargement lancé pour le
    // compte PRÉCÉDENT et encore en vol pourrait publier ses données par-dessus la nouvelle
    // session — c'est-à-dire montrer l'organisation de quelqu'un d'autre.
    this.authGeneration++;
    await this.loadFromSupabase();
    return { ok: true };
  }
  /**
   * Recharge les données depuis Supabase (CIN-117).
   *
   * Le back-office n'avait AUCUN rafraîchissement : `loadFromSupabase()` ne tournait qu'à la
   * connexion et après une écriture. Une séance jouée en cabine restait donc invisible jusqu'à
   * un F5 — alors que le SPEC promet à l'opérateur de savoir « en temps réel » si une cabine
   * fonctionne.
   *
   * Ne fait rien hors mode Supabase authentifié : en mock il n'y a rien à recharger.
   * L'appelant est responsable de vérifier qu'un rechargement est SÛR (cf. `App.canAutoRefresh`).
   */
  async refresh(): Promise<void> {
    if (this.mode !== "supabase" || !this.authed) return;
    await this.loadFromSupabase();
  }

  /**
   * Génération d'authentification — incrémentée à CHAQUE transition (connexion, déconnexion).
   *
   * BUG-015. `loadFromSupabase()` dure longtemps : une quinzaine de requêtes réseau enchaînées.
   * Elle pose `identity` au début et `authed = true` **à la fin**. Une déconnexion survenue
   * pendant ce trajet était donc écrasée par la fin du chargement : `identity` restait `null`
   * (remis par `signOut`) mais `authed` repassait à `true` — combinaison qui ne correspond à
   * AUCUN écran (`needsAuth` faux, `current` nul) et bloquait sur « Chargement… » jusqu'à un F5.
   *
   * Un chargement capture la génération à son entrée et **refuse de publier** ses résultats si
   * elle a changé entre-temps. Une réponse tardive ne peut plus décider de l'état courant.
   */
  private authGeneration = 0;

  async signOut(): Promise<void> {
    // AVANT l'await : tout chargement déjà en vol est périmé dès l'instant du clic, pas à
    // l'instant où le serveur répond.
    this.authGeneration++;
    this.authed = false;
    this.identity = null;
    this.booths = [];
    this.media = [];
    this.orgs = [];
    this.emit(); // écran de connexion IMMÉDIAT : ne pas faire attendre le réseau pour partir
    try {
      await supabase!.auth.signOut();
    } catch (e) {
      // La session locale est déjà oubliée ; l'échec de révocation côté serveur ne doit pas
      // laisser l'utilisateur sur un écran connecté. On journalise et on reste déconnecté.
      console.error("[dashboard] révocation de session échouée —", e);
    }
  }

  private async loadFromSupabase(): Promise<void> {
    // BUG-015 : génération capturée à l'entrée. Toute écriture d'état en aval doit la vérifier —
    // sans quoi une réponse arrivée après une déconnexion ressusciterait la session.
    const gen = this.authGeneration;
    // `getUser()` est un appel RÉSEAU. Il échoue sur une coupure, un timeout ou un 5xx — et
    // renvoie alors `user: undefined`, exactement comme une absence de session.
    //
    // BUG-010 : cette méthode est rejouée après CHAQUE écriture, y compris à la fin d'un
    // téléversement de film (plusieurs centaines de Mo, connexion saturée, plusieurs minutes).
    // Un seul échec transitoire suffisait alors à faire `authed = false` → écran de connexion,
    // avec le média pourtant bien envoyé. On ne confond donc plus « pas de session » et
    // « impossible de vérifier » : seule la première déconnecte.
    const { data: userRes, error: userErr } = await supabase!.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) {
      // `getSession()` lit le jeton stocké localement (et ne tente un rafraîchissement qu'en cas
      // d'expiration). Une session encore présente ⇒ l'échec vient du réseau, pas des droits :
      // on garde l'utilisateur en place et on laisse les données actuelles à l'écran.
      const { data: sessionRes } = await supabase!.auth.getSession();
      if (sessionRes.session) {
        console.error("loadFromSupabase : vérification d'identité indisponible, session conservée —", userErr?.message ?? "raison inconnue");
        return; // ne touche NI à `authed`, NI à `identity`, NI aux caches
      }
      if (gen !== this.authGeneration) return; // déconnexion entre-temps : elle fait autorité
      this.authed = false;
      this.identity = null; // sans ça, l'identité périmée survivait à la déconnexion
      this.emit();
      return;
    }
    if (gen !== this.authGeneration) return; // idem avant de publier une identité
    // Profil + appartenances (la RLS n'expose que ce qui est autorisé).
    const { data: profile } = await supabase!.from("users").select("*").eq("id", uid).maybeSingle();
    const { data: memberships } = await supabase!.from("memberships").select("*").eq("user_id", uid);
    const isGlobal = Boolean(profile?.is_global_admin);
    const first = memberships?.[0];
    this.identity = {
      user: { id: uid, name: profile?.name ?? "", email: userRes.user?.email ?? "", isGlobalAdmin: isGlobal },
      activeOrganizationId: isGlobal ? null : (first?.organization_id ?? null),
      role: isGlobal ? null : ((first?.role as OrgRole) ?? null),
    };
    // Kiosks + médias : la RLS scope déjà par organisation → on charge tel quel.
    const { data: booths } = await supabase!.from("booths").select("*");
    this.booths = (booths ?? []).map(rowToBooth);
    const { data: media } = await supabase!.from("media").select("*");
    this.media = (media ?? []).map(rowToMedia);
    // select("*") : robuste avant/après la migration 0005 (region/currency absentes → défaut).
    const { data: orgs } = await supabase!.from("organizations").select("*");
    this.orgs = (orgs ?? []).map((o: Record<string, unknown>) => {
      const settings = (o.settings as { themeId?: string; whitelistTags?: string[] } | null) ?? {};
      return {
        id: String(o.id),
        name: String(o.name),
        type: String(o.type ?? "bar"),
        region: (o.region as string | null) ?? null,
        currency: (o.currency as string | undefined) ?? "EUR",
        whitelistTags: settings.whitelistTags ?? [],
        themeId: settings.themeId ?? null,
      };
    });
    // Entitlements (CIN-080) : gracieux si 0011 pas encore appliquée (table absente → tout ON).
    this.entitlements = new Map();
    const { data: ents } = await supabase!.from("org_entitlements").select("*");
    for (const e of (ents ?? []) as Array<Record<string, unknown>>) {
      this.entitlements.set(String(e.organization_id), {
        subscriptionType: String(e.subscription_type ?? "demo"),
        enabledModules: Array.isArray(e.enabled_modules) ? (e.enabled_modules as string[]) : [],
      });
    }
    // Styles d'org (F19, table 0018) : gracieux si 0018 pas encore appliquée (table absente
    // → aucune surcharge, style maître). Une org sans ligne = maître (pas de clé dans la map).
    this.orgStyles = new Map();
    const { data: styles } = await supabase!.from("org_styles").select("*");
    for (const s of (styles ?? []) as Array<Record<string, unknown>>) {
      this.orgStyles.set(String(s.organization_id), rowToOrgStyle(s));
    }
    // Supports physiques + présence des médias (F8 : envoi batch, couverture Kiosk).
    const { data: locations } = await supabase!.from("storage_locations").select("*");
    this.storageLocations = (locations ?? []).map(rowToStorageLocation);
    const { data: instances } = await supabase!.from("media_instances").select("id,media_id,storage_location_id");
    this.mediaInstances = (instances ?? []).map(rowToMediaInstance);
    const { data: subs } = await supabase!.from("subtitles").select("id,media_id,lang,format,url,workflow_status");
    this.subtitles = (subs ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id),
      mediaId: String(r.media_id),
      lang: String(r.lang),
      format: r.format as SubtitleRecord["format"],
      url: String(r.url),
      workflowStatus: r.workflow_status as SubtitleRecord["workflowStatus"],
    }));
    // Versions vidéo (0027). `select` tolérant : si la migration n'est pas encore appliquée, on
    // repart sur une liste vide plutôt que de casser TOUT le chargement du dashboard.
    const { data: vids, error: vidsErr } = await supabase!
      .from("media_videos")
      .select("id,media_id,lang,storage_url,original_filename,size_bytes,created_at,created_by,is_primary");
    if (vidsErr) {
      this.mediaVideos = [];
      if (!/does not exist|relation|schema cache/i.test(vidsErr.message)) console.error("media_videos:", vidsErr.message);
    } else {
      this.mediaVideos = (vids ?? []).map((r: Record<string, unknown>) => ({
        id: String(r.id),
        mediaId: String(r.media_id),
        lang: String(r.lang),
        storageUrl: String(r.storage_url),
        originalFilename: r.original_filename == null ? null : String(r.original_filename),
        sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
        createdAt: r.created_at == null ? null : new Date(String(r.created_at)).getTime(),
        createdBy: r.created_by == null ? null : String(r.created_by),
        isPrimary: Boolean(r.is_primary),
      }));
    }
    const { data: tx } = await supabase!.from("transactions").select("id,booth_id,organization_id,amount_cents,currency,provider,created_at");
    this.transactions = (tx ?? []).map(rowToTransaction);
    // Droits & redevances (tables 0007 ; gracieux si pas encore appliquée → cache vide).
    const { data: dist } = await supabase!.from("distributors").select("*");
    this.distributors = ((dist ?? []) as Array<Record<string, unknown>>).map((d) => ({
      id: String(d.id), name: String(d.name), territory: String(d.territory ?? ""),
      contactEmail: String(d.contact_email ?? ""), notes: String(d.notes ?? ""),
    }));
    const { data: lic } = await supabase!.from("media_licenses").select("*");
    this.mediaLicensesCache = ((lic ?? []) as Array<Record<string, unknown>>).map((l) => ({
      id: String(l.id), mediaId: String(l.media_id), distributorId: (l.distributor_id as string | null) ?? null,
      royaltyModel: l.royalty_model as RoyaltyModel, royaltyCents: Number(l.royalty_cents ?? 0),
      revenueSharePct: Number(l.revenue_share_pct ?? 0), minimumGuaranteeCents: (l.minimum_guarantee_cents as number | null) ?? null,
      maxScreenings: (l.max_screenings as number | null) ?? null, validFrom: (l.valid_from as string | null) ?? null,
      validTo: (l.valid_to as string | null) ?? null, notes: String(l.notes ?? ""),
    }));
    const { data: lb } = await supabase!.from("license_booths").select("*");
    this.licenseBoothsCache = ((lb ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id), licenseId: String(r.license_id), boothId: String(r.booth_id),
      maxScreenings: (r.max_screenings as number | null) ?? null,
    }));
    // Mises à jour (tables 0008 ; gracieux si pas encore appliquée).
    const { data: rel } = await supabase!.from("releases").select("*");
    this.releases = ((rel ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id), version: String(r.version), urgency: r.urgency as Release["urgency"],
      notes: String(r.notes ?? ""), createdAt: new Date(String(r.created_at)).getTime(),
    }));
    const { data: bu } = await supabase!.from("booth_updates").select("*");
    this.boothUpdates = ((bu ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id), boothId: String(r.booth_id), releaseId: String(r.release_id),
      status: r.status as BoothUpdate["status"], scheduledFor: r.scheduled_for ? new Date(String(r.scheduled_for)).getTime() : null,
      appliedAt: r.applied_at ? new Date(String(r.applied_at)).getTime() : null, error: String(r.error ?? ""),
    }));
    // MAJ OS (table 0017 ; gracieux si pas encore appliquée → tableau vide).
    const { data: osc } = await supabase!.from("os_update_commands").select("*");
    this.osUpdateCommands = ((osc ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id), boothId: String(r.booth_id), status: r.status as OsUpdateCommand["status"],
      packagesPending: (r.packages_pending as number | null) ?? null,
      requestedAt: new Date(String(r.requested_at)).getTime(),
      finishedAt: r.finished_at ? new Date(String(r.finished_at)).getTime() : null,
      log: String(r.log ?? ""), error: String(r.error ?? ""),
    }));
    await this.enrichBooths();
    // Dernière porte, la plus importante : c'est CETTE ligne qui ressuscitait une session
    // déconnectée (BUG-015). Les caches remplis au-dessus le sont peut-être pour rien ; ils ne
    // sont jamais affichés hors session, et la prochaine connexion les réécrit entièrement.
    if (gen !== this.authGeneration) {
      this.booths = [];
      this.media = [];
      this.orgs = [];
      return;
    }
    this.authed = true;
    this.emit();
  }

  /**
   * Complète chaque Kiosk avec ses agrégats (non portés par `booths`) :
   * historique 14 j + sessions/bande passante du jour (daily_stats), revenu du
   * jour (transactions), journaux (alerts). Toutes ces requêtes sont scopées par
   * la RLS. Peu de requêtes groupées plutôt qu'une par Kiosk.
   */
  private async enrichBooths(): Promise<void> {
    if (this.booths.length === 0) return;
    const todayStr = new Date().toISOString().slice(0, 10);
    const sinceStr = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);

    interface StatRow { booth_id: string; date: string; sessions: number; bandwidth_mb: number }
    interface AlertRow { booth_id: string | null; severity: string; message: string; created_at: string }

    const [stats, alerts] = await Promise.all([
      supabase!.from("daily_stats").select("booth_id,date,sessions,bandwidth_mb").gte("date", sinceStr),
      supabase!.from("alerts").select("booth_id,severity,message,created_at").order("created_at", { ascending: false }),
    ]);
    const statRows = (stats.data ?? []) as StatRow[];
    const alertRows = (alerts.data ?? []) as AlertRow[];
    // Revenus : réutilise le cache transactions (déjà chargé) plutôt qu'un 2e fetch.
    const txByBooth = new Map<string, number>();
    for (const t of this.transactions) {
      if (new Date(t.createdAt).toISOString().slice(0, 10) === todayStr) {
        txByBooth.set(t.boothId, (txByBooth.get(t.boothId) ?? 0) + t.amountCents);
      }
    }

    this.booths = this.booths.map((b) => {
      const history = statRows
        .filter((s) => s.booth_id === b.id)
        .sort((a, c) => (a.date < c.date ? -1 : 1))
        .map((s) => ({ date: s.date, sessions: s.sessions, bandwidthMb: s.bandwidth_mb }));
      const todayStat = statRows.find((s) => s.booth_id === b.id && s.date === todayStr);
      const revenueTodayCents = txByBooth.get(b.id) ?? 0;
      const logs = alertRows
        .filter((a) => a.booth_id === b.id)
        .map((a) => ({
          at: new Date(a.created_at).getTime(),
          level: (a.severity === "critical" ? "error" : a.severity) as "info" | "warn" | "error",
          message: a.message,
        }));
      return { ...b, history, sessionsToday: todayStat?.sessions ?? 0, revenueTodayCents, logs };
    });
  }

  // ── Identité / rôle ─────────────────────────────────────────────────────────
  get current(): CurrentIdentity | null {
    return this.identity;
  }
  get isGlobalAdmin(): boolean {
    return this.identity?.user.isGlobalAdmin ?? false;
  }
  /** Bascule d'identité — mode mock uniquement (démo). */
  switchUser(userId: string): void {
    if (this.mode !== "mock") return;
    this.identity = mockIdentityFor(userId);
    localStorage.setItem(LS_IDENTITY, userId);
    this.emit();
  }

  // ── Lecture (scopée) ────────────────────────────────────────────────────────
  visibleBooths(): Booth[] {
    // En mode supabase, la RLS a déjà filtré → tout le cache est visible.
    if (this.mode === "supabase") return [...this.booths];
    if (this.isGlobalAdmin) return [...this.booths];
    const orgId = this.identity?.activeOrganizationId;
    return orgId ? this.booths.filter((b) => b.organizationId === orgId) : [];
  }
  boothById(id: string): Booth | undefined {
    return this.visibleBooths().find((b) => b.id === id);
  }

  // ── Écriture ────────────────────────────────────────────────────────────────
  upsertBooth(booth: Booth): void {
    // Cache optimiste + persistance selon le mode.
    const idx = this.booths.findIndex((b) => b.id === booth.id);
    if (idx >= 0) this.booths[idx] = booth;
    else this.booths.push(booth);
    this.emit();
    if (this.mode === "mock") {
      this.persistMock();
    } else {
      void supabase!.from("booths").upsert(boothToRow(booth)).then(({ error }) => {
        if (error) console.error("upsertBooth:", error.message);
      });
    }
  }
  deleteBooth(id: string): void {
    this.booths = this.booths.filter((b) => b.id !== id);
    this.emit();
    if (this.mode === "mock") {
      this.persistMock();
    } else {
      void supabase!.from("booths").delete().eq("id", id).then(({ error }) => {
        if (error) console.error("deleteBooth:", error.message);
      });
    }
  }

  // ── Médias ──────────────────────────────────────────────────────────────────
  mediaList(): Media[] {
    return [...this.media];
  }
  organizations(): OrgSummary[] {
    return [...this.orgs];
  }
  /** Devise d'une organisation (défaut EUR). */
  orgCurrency(orgId: string | null | undefined): string {
    return this.orgs.find((o) => o.id === orgId)?.currency ?? "EUR";
  }
  /** Devise de la vue courante : celle de l'org active ; EUR par défaut (global_admin). */
  activeCurrency(): string {
    return this.orgCurrency(this.identity?.activeOrganizationId);
  }

  // ── Feature gating / modules (CIN-080, F18) ─────────────────────────────────
  /** Souscription + modules d'une org. Absent (pas de ligne / 0011 non appliquée) = tout ON. */
  entitlementFor(orgId: string | null | undefined): { subscriptionType: string; enabledModules: string[] } | null {
    return orgId ? (this.entitlements.get(orgId) ?? null) : null;
  }

  /** L'org a-t-elle ce module ? Défaut ouvert (pas d'entitlement = tous les modules). */
  hasModule(orgId: string | null | undefined, key: string): boolean {
    const e = orgId ? this.entitlements.get(orgId) : null;
    return e ? e.enabledModules.includes(key) : true;
  }

  /** Module accordé pour l'org active ? Le global_admin voit tout. */
  activeHasModule(key: string): boolean {
    if (this.isGlobalAdmin) return true;
    return this.hasModule(this.identity?.activeOrganizationId, key);
  }

  /** Écrit la souscription + les modules d'une org. RLS : global_admin uniquement. */
  async saveEntitlements(orgId: string, patch: { subscriptionType?: string; enabledModules?: string[] }): Promise<{ ok: boolean; error?: string }> {
    if (!supabase) return { ok: false, error: "hors ligne" };
    const current = this.entitlements.get(orgId);
    const row = {
      organization_id: orgId,
      subscription_type: patch.subscriptionType ?? current?.subscriptionType ?? "demo",
      enabled_modules: patch.enabledModules ?? current?.enabledModules ?? [],
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("org_entitlements").upsert(row, { onConflict: "organization_id" });
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  // ── Styles d'organisation (F19 « Mes styles ») ──────────────────────────────
  // Source unique cabine + dashboard : le type `OrgStyle` vient de @kioskoscope/domain.
  // Pas de ligne = style maître Kioskoscope (aucune surcharge). Écriture RLS (0018) :
  // super_user de l'org OU global_admin.

  /** Style surchargé d'une org, ou null si elle tourne sur le style maître. */
  orgStyleFor(orgId: string | null | undefined): OrgStyle | null {
    return orgId ? (this.orgStyles.get(orgId) ?? null) : null;
  }

  /**
   * Projection LOCALE d'une ligne `org_styles` — remplace un `loadFromSupabase()` complet.
   *
   * Écrire une ligne déclenchait une quinzaine de requêtes réseau pour recharger tout le parc,
   * juste pour rafraîchir un objet que l'on connaît déjà. Le coût n'était pas que la latence :
   * ce rechargement `emit()`, donc il reconstruisait l'écran EN PLEIN GESTE — c'est la mécanique
   * qui rendait la réinitialisation apparemment sans effet.
   *
   * La projection est FIDÈLE parce que la migration 0018 n'a ni trigger ni colonne calculée : les
   * colonnes stockées sont exactement celles qu'on vient d'envoyer, le serveur n'a rien à en dire
   * de plus. Si un trigger y était ajouté un jour, cette hypothèse tomberait — et il faudrait
   * relire la ligne écrite plutôt que de la projeter.
   *
   * `row === null` = pas de ligne = style maître Kioskoscope.
   */
  private setOrgStyleLocal(orgId: string, row: Record<string, unknown> | null): void {
    if (row === null) this.orgStyles.delete(orgId);
    else this.orgStyles.set(orgId, rowToOrgStyle(row));
    this.emit();
  }

  /**
   * Upsert du style d'une org. Le dashboard (F19 v1) possède palette/fontes/titre ; ces trois
   * champs reflètent EXACTEMENT le patch (une valeur vide/omise → null = retour au maître pour
   * ce slot). Les `assets` (v2, upload) ne sont pas édités ici : on préserve l'existant.
   */
  async upsertOrgStyle(orgId: string, patch: OrgStyle): Promise<{ ok: boolean; error?: string }> {
    const current = this.orgStyles.get(orgId);
    // Une seule définition de la ligne pour les deux modes : ce que le mock affiche est
    // exactement ce que la base recevrait.
    const row = {
      organization_id: orgId,
      palette: patch.palette ?? null,
      fonts: patch.fonts ?? null,
      assets: patch.assets ?? current?.assets ?? null,
      title: patch.title ?? null,
      updated_at: new Date().toISOString(),
    };
    if (this.mode === "mock") {
      this.setOrgStyleLocal(orgId, row);
      return { ok: true };
    }
    if (!supabase) return { ok: false, error: "hors ligne" };
    const { error } = await supabase.from("org_styles").upsert(row, { onConflict: "organization_id" });
    if (error) return { ok: false, error: error.message };
    this.setOrgStyleLocal(orgId, row);
    return { ok: true };
  }

  /** Réinitialise au style maître : supprime la ligne (absence de surcharge). */
  async resetOrgStyle(orgId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.mode === "mock") {
      this.setOrgStyleLocal(orgId, null);
      return { ok: true };
    }
    if (!supabase) return { ok: false, error: "hors ligne" };
    const { error } = await supabase.from("org_styles").delete().eq("organization_id", orgId);
    if (error) return { ok: false, error: error.message };
    this.setOrgStyleLocal(orgId, null);
    return { ok: true };
  }

  // ── Actions par lot — super-admin flotte (CIN-084) ──────────────────────────
  // Réservées au global_admin (imposé par la RLS 0011/0018, jamais par l'app). Écrivent TOUTES
  // les lignes puis rechargent UNE fois (même patron que `sendMediaToBooths`) — évite N reloads.

  /**
   * Applique une souscription + un jeu de modules à PLUSIEURS orgs d'un coup. Un champ omis du
   * patch préserve la valeur courante de CHAQUE org (fusion par org, comme la version unitaire).
   */
  async saveEntitlementsBatch(
    orgIds: readonly string[],
    patch: { subscriptionType?: string; enabledModules?: string[] },
  ): Promise<{ ok: boolean; updated: number; error?: string }> {
    if (!supabase) return { ok: false, updated: 0, error: "hors ligne" };
    if (orgIds.length === 0) return { ok: true, updated: 0 };
    const now = new Date().toISOString();
    const rows = orgIds.map((orgId) => {
      const current = this.entitlements.get(orgId);
      return {
        organization_id: orgId,
        subscription_type: patch.subscriptionType ?? current?.subscriptionType ?? "demo",
        enabled_modules: patch.enabledModules ?? current?.enabledModules ?? [],
        updated_at: now,
      };
    });
    const { error } = await supabase.from("org_entitlements").upsert(rows, { onConflict: "organization_id" });
    if (error) return { ok: false, updated: 0, error: error.message };
    await this.loadFromSupabase();
    return { ok: true, updated: rows.length };
  }

  /** Réinitialise PLUSIEURS orgs au style maître (supprime leurs lignes `org_styles`). */
  async resetOrgStylesBatch(orgIds: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    if (orgIds.length === 0) return { ok: true };
    if (this.mode === "mock") {
      this.forgetOrgStylesLocal(orgIds);
      return { ok: true };
    }
    if (!supabase) return { ok: false, error: "hors ligne" };
    const { error } = await supabase.from("org_styles").delete().in("organization_id", [...orgIds]);
    if (error) return { ok: false, error: error.message };
    this.forgetOrgStylesLocal(orgIds);
    return { ok: true };
  }

  /** Pendant par lot de `setOrgStyleLocal(id, null)` : un SEUL rendu pour tout le lot. */
  private forgetOrgStylesLocal(orgIds: readonly string[]): void {
    for (const id of orgIds) this.orgStyles.delete(id);
    this.emit();
  }

  // ── Assets de marque (F19 v2, bucket PUBLIC `org-assets`, migration 0019) ─────
  // Chemin storage : `{orgId}/{kind}.webp`. Écriture RLS = super_user de l'org ; lecture
  // publique (getPublicUrl). Le blob reçu est DÉJÀ recadré + compressé WebP côté UI. On stocke
  // l'URL publique dans le bloc `assets` de `org_styles` (merge : les autres assets sont préservés).
  // Même patron d'upload que les médias (`supabase.storage.from(...).upload`).

  /**
   * Téléverse un asset de marque puis enregistre son URL publique dans `org_styles.assets`.
   * `upsert:true` écrase l'objet au même chemin → l'URL publique est stable, on la suffixe donc
   * d'une version (`?v=`) pour invalider le cache navigateur/CDN après remplacement.
   */
  async uploadOrgAsset(orgId: string, kind: OrgAssetKind, blob: Blob): Promise<{ ok: boolean; url?: string; error?: string }> {
    let url: string;
    if (this.mode === "mock") {
      // Pas de bucket en mock. Sans cette branche, la voie de SUCCÈS de l'envoi était
      // invérifiable au navigateur (tout finissait sur « hors ligne ») — donc jamais recettée.
      // Une URL d'objet local est une URL publique parfaitement valable pour cet usage.
      url = URL.createObjectURL(blob);
    } else {
      if (!supabase) return { ok: false, error: "hors ligne" };
      const path = `${orgId}/${kind}.webp`;
      const up = await supabase.storage.from("org-assets").upload(path, blob, { upsert: true, contentType: "image/webp" });
      if (up.error) return { ok: false, error: `Téléversement échoué : ${up.error.message}` };
      const { data: pub } = supabase.storage.from("org-assets").getPublicUrl(path);
      url = `${pub.publicUrl}?v=${Date.now()}`;
    }
    const draft: OrgAssetsDraft = { ...(this.orgStyles.get(orgId)?.assets ?? {}) };
    draft[ORG_ASSET_FIELD[kind]] = url;
    const res = await this.upsertOrgStyleWithAssets(orgId, draft);
    if (!res.ok) return { ok: false, ...(res.error ? { error: res.error } : {}) };
    return { ok: true, url };
  }

  /**
   * Retire un asset de marque : supprime l'objet storage puis efface le champ correspondant
   * dans `org_styles.assets` (les autres assets sont préservés).
   */
  async removeOrgAsset(orgId: string, kind: OrgAssetKind): Promise<{ ok: boolean; error?: string }> {
    // En mock il n'y a pas d'objet storage à retirer : seule la référence dans `assets` compte.
    if (this.mode !== "mock") {
      if (!supabase) return { ok: false, error: "hors ligne" };
      const path = `${orgId}/${kind}.webp`;
      const { error } = await supabase.storage.from("org-assets").remove([path]);
      if (error) return { ok: false, error: `Suppression échouée : ${error.message}` };
    }
    const draft: OrgAssetsDraft = { ...(this.orgStyles.get(orgId)?.assets ?? {}) };
    delete draft[ORG_ASSET_FIELD[kind]];
    return this.upsertOrgStyleWithAssets(orgId, draft);
  }

  /**
   * Écrit un nouveau bloc `assets` en PRÉSERVANT palette/fontes/titre courants (contrairement à
   * `upsertOrgStyle`, dont le contrat v1 remet ces champs au patch fourni). Réservé aux assets.
   */
  private async upsertOrgStyleWithAssets(orgId: string, assets: OrgAssetsDraft): Promise<{ ok: boolean; error?: string }> {
    const current = this.orgStyles.get(orgId) ?? {};
    const patch: OrgStyle = { ...current, assets };
    return this.upsertOrgStyle(orgId, patch);
  }

  // ── Gestion d'organisation (menu Organisation — RBAC, invitations, paiement) ─
  /** L'utilisateur courant est-il super_user de l'org (ou global_admin) ? */
  canManageOrg(orgId: string | null | undefined): boolean {
    if (this.isGlobalAdmin) return true;
    return this.identity?.activeOrganizationId === orgId && this.identity?.role === "super_user";
  }

  /** Met à jour les réglages généraux d'une organisation (super_user only côté RLS). */
  async updateOrganization(
    orgId: string,
    patch: { name?: string; type?: string; region?: string | null; currency?: string; whitelistTags?: string[]; themeId?: string | null },
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.mode === "mock") {
      this.orgs = this.orgs.map((o) => (o.id === orgId ? { ...o, ...patch, whitelistTags: patch.whitelistTags ?? o.whitelistTags } : o));
      this.emit();
      return { ok: true };
    }
    const current = this.orgs.find((o) => o.id === orgId);
    const settings: Record<string, unknown> = { whitelistTags: patch.whitelistTags ?? current?.whitelistTags ?? [] };
    const themeId = patch.themeId ?? current?.themeId ?? null;
    if (themeId) settings.themeId = themeId;
    const row: Record<string, unknown> = { settings };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.type !== undefined) row.type = patch.type;
    if (patch.region !== undefined) row.region = patch.region;
    if (patch.currency !== undefined) row.currency = patch.currency;
    const { error } = await supabase!.from("organizations").update(row).eq("id", orgId);
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  /** Membres d'une organisation (jointure memberships × users, scopée RLS). */
  async orgMembers(orgId: string): Promise<OrgMember[]> {
    if (this.mode !== "supabase") return [];
    const { data: ms } = await supabase!.from("memberships").select("id,user_id,role").eq("organization_id", orgId);
    const rows = (ms ?? []) as Array<{ id: string; user_id: string; role: OrgRole }>;
    const ids = rows.map((r) => r.user_id);
    const { data: us } = ids.length ? await supabase!.from("users").select("id,name,email").in("id", ids) : { data: [] };
    const byId = new Map((us ?? []).map((u: { id: string; name: string; email: string }) => [u.id, u]));
    const self = this.identity?.user.id;
    return rows.map((r) => ({
      membershipId: r.id,
      userId: r.user_id,
      name: byId.get(r.user_id)?.name ?? "",
      email: byId.get(r.user_id)?.email ?? "—",
      role: r.role,
      isSelf: r.user_id === self,
    }));
  }

  async setMemberRole(membershipId: string, role: OrgRole): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("memberships").update({ role }).eq("id", membershipId);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  async removeMember(membershipId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("memberships").delete().eq("id", membershipId);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  // ── Invitations ──────────────────────────────────────────────────────────────
  async orgInvitations(orgId: string): Promise<Invitation[]> {
    if (this.mode !== "supabase") return [];
    const { data } = await supabase!
      .from("invitations")
      .select("id,email,role,status,token,created_at,expires_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      email: String(r.email),
      role: r.role as OrgRole,
      status: r.status as Invitation["status"],
      token: String(r.token),
      createdAt: new Date(String(r.created_at)).getTime(),
      expiresAt: new Date(String(r.expires_at)).getTime(),
    }));
  }

  /** Crée une invitation (token à haute entropie généré côté client) + renvoie le lien. */
  async createInvitation(orgId: string, email: string, role: OrgRole): Promise<{ ok: boolean; link?: string; error?: string }> {
    const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
    const link = `${location.origin}${location.pathname}?invite=${token}`;
    if (this.mode !== "supabase") return { ok: true, link };
    const { error } = await supabase!.from("invitations").insert({
      organization_id: orgId,
      email: email.trim().toLowerCase(),
      role,
      token,
      invited_by: this.identity?.user.id ?? null,
    });
    return error ? { ok: false, error: error.message } : { ok: true, link };
  }

  async revokeInvitation(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("invitations").update({ status: "revoked" }).eq("id", id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  /** Accepte une invitation via son token (fonction security-definer côté base). */
  async acceptInvitation(token: string): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.rpc("accept_invitation", { invite_token: token });
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  // ── Accès opérateur cabine (CIN-073, F17 volet A) ────────────────────────────
  // Le back-office gère les identifiants+PIN d'accès au menu opérateur ; la Kiosk les
  // met en cache et valide HORS LIGNE. Le PIN est haché ici (domaine, source unique) et
  // n'est JAMAIS relu : seule l'empreinte part en base. Écriture = super_user/manager (RLS).
  async listOperatorAccess(orgId: string): Promise<OperatorAccessRecord[]> {
    if (this.mode !== "supabase") return [];
    const { data } = await supabase!
      .from("operator_access")
      .select("id,identifier,role,booth_id,expires_at,revoked,label,created_at,updated_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      identifier: String(r.identifier),
      role: String(r.role) as OperatorRole,
      boothId: (r.booth_id as string | null) ?? null,
      expiresAt: (r.expires_at as string | null) ?? null,
      revoked: Boolean(r.revoked),
      label: String(r.label ?? ""),
      createdAt: String(r.created_at ?? ""),
      updatedAt: String(r.updated_at ?? ""),
    }));
  }

  async createOperatorAccess(
    orgId: string,
    params: { identifier: string; pin: string; role: OperatorRole; boothId?: string | null; expiresAt?: string | null; label?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    // Hachage PBKDF2 côté back-office (domaine) : le PIN clair ne quitte jamais ce navigateur.
    const entry = await buildAccessEntry({ identifier: params.identifier, pin: params.pin, role: params.role });
    const { error } = await supabase!.from("operator_access").insert({
      organization_id: orgId,
      booth_id: params.boothId ?? null,
      identifier: entry.identifier,
      pin_hash: entry.pinHash,
      salt: entry.salt,
      iterations: entry.iterations,
      role: entry.role,
      expires_at: params.expiresAt ?? null,
      label: params.label ?? "",
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  async setOperatorAccessRevoked(id: string, revoked: boolean): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("operator_access").update({ revoked }).eq("id", id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  async setOperatorAccessExpiry(id: string, expiresAt: string | null): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("operator_access").update({ expires_at: expiresAt }).eq("id", id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  async deleteOperatorAccess(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("operator_access").delete().eq("id", id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  async listOperatorAccessLog(orgId: string, limit = 100): Promise<OperatorLogRecord[]> {
    if (this.mode !== "supabase") return [];
    const { data } = await supabase!
      .from("operator_access_log")
      .select("id,at,booth_id,identifier,action,detail")
      .eq("organization_id", orgId)
      .order("at", { ascending: false })
      .limit(limit);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      at: String(r.at),
      boothId: (r.booth_id as string | null) ?? null,
      identifier: (r.identifier as string | null) ?? null,
      action: String(r.action),
      detail: (r.detail as string | null) ?? null,
    }));
  }

  // ── Intégrations de paiement (config non-secrète) ────────────────────────────
  async orgPaymentIntegrations(orgId: string): Promise<PaymentIntegration[]> {
    if (this.mode !== "supabase") return [];
    const { data } = await supabase!.from("payment_integrations").select("*").eq("organization_id", orgId);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      provider: String(r.provider),
      mode: r.mode as PaymentIntegration["mode"],
      status: r.status as PaymentIntegration["status"],
      label: String(r.label ?? ""),
      config: (r.config as Record<string, unknown>) ?? {},
      secretRef: (r.secret_ref as string | null) ?? null,
    }));
  }

  async savePaymentIntegration(
    orgId: string,
    data: { id?: string; provider: string; mode: string; status: string; label: string },
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const row = { organization_id: orgId, provider: data.provider, mode: data.mode, status: data.status, label: data.label };
    const res = data.id
      ? await supabase!.from("payment_integrations").update(row).eq("id", data.id)
      : await supabase!.from("payment_integrations").insert(row);
    return res.error ? { ok: false, error: res.error.message } : { ok: true };
  }

  async deletePaymentIntegration(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("payment_integrations").delete().eq("id", id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  /**
   * Ajoute un média. Si un fichier est fourni, calcule son SHA-256 (dedup +
   * intégrité) et le téléverse (Supabase Storage). Le doublon est refusé par la
   * base (`unique(organization_id, content_hash)`) → message clair.
   */
  async addMedia(input: Media, file: File | null): Promise<{ ok: boolean; error?: string }> {
    const contentHash = file ? await sha256Hex(file) : input.contentHash;

    if (this.mode === "mock") {
      if (this.media.some((m) => m.organizationId === input.organizationId && m.contentHash === contentHash)) {
        return { ok: false, error: "Doublon : ce fichier existe déjà dans cette organisation." };
      }
      this.media.push({ ...input, contentHash });
      this.emit();
      return { ok: true };
    }

    let storageUrl = input.storageUrl;
    if (file) {
      const path = `${input.organizationId}/${contentHash}`;
      const up = await supabase!.storage.from("media").upload(path, file, { upsert: false });
      if (up.error && !/already exists/i.test(up.error.message)) {
        return { ok: false, error: `Téléversement échoué : ${up.error.message}` };
      }
      storageUrl = path;
    }

    const { error } = await supabase!.from("media").insert(mediaToRow({ ...input, contentHash, storageUrl }));
    if (error) {
      if (error.code === "23505") return { ok: false, error: "Doublon : ce fichier existe déjà dans cette organisation." };
      return { ok: false, error: error.message };
    }
    await this.loadFromSupabase();
    return { ok: true };
  }

  async updateMedia(m: Media): Promise<void> {
    if (this.mode === "mock") {
      const i = this.media.findIndex((x) => x.id === m.id);
      if (i >= 0) this.media[i] = m;
      this.emit();
      return;
    }
    const { error } = await supabase!.from("media").update(mediaToRow(m)).eq("id", m.id);
    if (error) console.error("updateMedia:", error.message);
    else await this.loadFromSupabase();
  }

  async deleteMedia(id: string): Promise<void> {
    if (this.mode === "mock") {
      this.media = this.media.filter((m) => m.id !== id);
      this.emit();
      return;
    }
    const { error } = await supabase!.from("media").delete().eq("id", id);
    if (error) console.error("deleteMedia:", error.message);
    else await this.loadFromSupabase();
  }

  /**
   * Marque (ou dé-marque) une vidéo comme « validée par l'opérateur ». Écrit
   * uniquement `reviewed_at`/`reviewed_by` — jamais via l'upsert média, pour ne pas
   * risquer d'écraser d'autres champs. Trace qui valide (audit).
   */
  async setMediaReviewed(media: Media, reviewed: boolean): Promise<{ ok: boolean; error?: string }> {
    const now = reviewed ? Date.now() : null;
    const patchLocal = (m: Media): Media => ({ ...m, reviewedAt: now, reviewedBy: reviewed ? (this.identity?.user.id ?? null) : null });

    if (this.mode === "mock") {
      const i = this.media.findIndex((x) => x.id === media.id);
      if (i >= 0) this.media[i] = patchLocal(this.media[i]!);
      this.emit();
      return { ok: true };
    }

    const patch = reviewed
      ? { reviewed_at: new Date().toISOString(), reviewed_by: this.identity?.user.id ?? null }
      : { reviewed_at: null, reviewed_by: null };
    const { error } = await supabase!.from("media").update(patch).eq("id", media.id);
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  // ── Supports & couverture Kiosk (F8) ────────────────────────────────────────
  /** Kiosks (visibles) sur lesquelles un média est physiquement présent. */
  boothIdsForMedia(mediaId: string): Set<string> {
    const locById = new Map(this.storageLocations.map((l) => [l.id, l.boothId]));
    const boothIds = new Set<string>();
    for (const mi of this.mediaInstances) {
      if (mi.mediaId !== mediaId) continue;
      const boothId = locById.get(mi.storageLocationId);
      if (boothId) boothIds.add(boothId);
    }
    return boothIds;
  }

  /**
   * Médias physiquement présents sur une Kiosk (inverse de `boothIdsForMedia`).
   * Utilisé par le hub cabine (CIN-045) : on part des supports de la borne, on
   * remonte les `media_instances` qui y résident, puis les médias correspondants.
   * Tout est déjà scopé par la RLS (le cache ne contient que l'autorisé).
   */
  mediaForBooth(boothId: string): Media[] {
    const locIds = new Set(this.storageLocations.filter((l) => l.boothId === boothId).map((l) => l.id));
    const mediaIds = new Set<string>();
    for (const mi of this.mediaInstances) {
      if (locIds.has(mi.storageLocationId)) mediaIds.add(mi.mediaId);
    }
    return this.media.filter((m) => mediaIds.has(m.id));
  }

  /** Support cible d'une Kiosk pour un envoi : privilégie le disque local. */
  private targetStorageLocation(boothId: string): StorageLocation | undefined {
    const forBooth = this.storageLocations.filter((l) => l.boothId === boothId);
    return forBooth.find((l) => l.type === "local") ?? forBooth[0];
  }

  /**
   * Envoi batch : place un lot de médias sur plusieurs Kiosks en une action
   * (crée des `media_instances`). Les présences déjà existantes sont ignorées ;
   * une Kiosk sans support de stockage connu est comptée en `skipped`.
   */
  async sendMediaToBooths(
    mediaIds: readonly string[],
    boothIds: readonly string[],
  ): Promise<{ ok: boolean; created: number; skipped: number; boothsWithoutStorage: number; error?: string }> {
    let skipped = 0;
    let boothsWithoutStorage = 0;
    const rows: Array<{ organization_id: string; media_id: string; storage_location_id: string }> = [];

    for (const boothId of boothIds) {
      const target = this.targetStorageLocation(boothId);
      if (!target) {
        boothsWithoutStorage += 1;
        continue;
      }
      for (const mediaId of mediaIds) {
        const media = this.media.find((m) => m.id === mediaId);
        if (!media) continue;
        const already = this.mediaInstances.some((mi) => mi.mediaId === mediaId && mi.storageLocationId === target.id);
        if (already) {
          skipped += 1;
          continue;
        }
        rows.push({ organization_id: media.organizationId, media_id: mediaId, storage_location_id: target.id });
      }
    }

    if (this.mode === "mock") {
      for (const r of rows) this.mediaInstances.push({ id: crypto.randomUUID(), mediaId: r.media_id, storageLocationId: r.storage_location_id });
      this.emit();
      return { ok: true, created: rows.length, skipped, boothsWithoutStorage };
    }

    if (rows.length > 0) {
      const { error } = await supabase!.from("media_instances").insert(rows);
      if (error) return { ok: false, created: 0, skipped, boothsWithoutStorage, error: error.message };
    }
    await this.loadFromSupabase();
    return { ok: true, created: rows.length, skipped, boothsWithoutStorage };
  }

  /**
   * Agrégats de lecture (dashboard médias F8) : nb de lectures et durée totale
   * par média, top 10. Lit `plays` (scoped RLS) ; la durée de lecture est estimée
   * = nb de lectures × durée du média (les `plays` ne portent pas la durée réelle
   * regardée). À affiner si `plays` gagne un champ `watched_seconds`.
   */
  async mediaStats(): Promise<MediaStatsResult> {
    const durationById = new Map(this.media.map((m) => [m.id, m.durationSeconds]));
    const titleById = new Map(this.media.map((m) => [m.id, m.title]));
    const counts = new Map<string, number>();

    if (this.mode === "supabase") {
      const { data } = await supabase!.from("plays").select("media_id");
      for (const p of (data ?? []) as Array<{ media_id: string }>) {
        counts.set(p.media_id, (counts.get(p.media_id) ?? 0) + 1);
      }
    }

    let totalPlays = 0;
    let totalSeconds = 0;
    const stats: MediaStat[] = [];
    for (const [mediaId, plays] of counts) {
      const playSeconds = plays * (durationById.get(mediaId) ?? 0);
      totalPlays += plays;
      totalSeconds += playSeconds;
      stats.push({ mediaId, title: titleById.get(mediaId) ?? "—", plays, playSeconds });
    }
    stats.sort((a, b) => b.plays - a.plays);
    return { totalPlays, totalSeconds, top: stats.slice(0, 10) };
  }

  // ── Revenus (F9) ─────────────────────────────────────────────────────────────
  /** Transactions (scopées RLS), plus récentes d'abord. */
  transactionsList(): TransactionRecord[] {
    return [...this.transactions].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Transactions d'UNE Kiosk (scopées RLS), plus récentes d'abord — hub cabine (CIN-045). */
  transactionsForBooth(boothId: string): TransactionRecord[] {
    return this.transactionsList().filter((t) => t.boothId === boothId);
  }

  /** Liste des séances (F9) : séance + films joués (via `plays`), plus récentes d'abord. */
  async sessionsList(): Promise<SessionRow[]> {
    if (this.mode !== "supabase") return [];
    const { data: sess } = await supabase!
      .from("sessions")
      .select("id,booth_id,started_at,unlock_method,amount_cents")
      .order("started_at", { ascending: false })
      .limit(300);
    const { data: playsData } = await supabase!.from("plays").select("session_id,media_id,position,completed,source");
    const boothLabel = new Map(this.booths.map((b) => [b.id, b.label]));
    const mediaTitle = new Map(this.media.map((m) => [m.id, m.title]));
    const bySession = new Map<string, Array<{ position: number; title: string; source: string; completed: boolean }>>();
    for (const p of (playsData ?? []) as Array<{ session_id: string; media_id: string; position: number; completed: boolean; source: string }>) {
      let arr = bySession.get(p.session_id);
      if (!arr) { arr = []; bySession.set(p.session_id, arr); }
      arr.push({ position: p.position, title: mediaTitle.get(p.media_id) ?? "—", source: p.source, completed: p.completed });
    }
    return ((sess ?? []) as Array<{ id: string; booth_id: string; started_at: string; unlock_method: string; amount_cents: number | null }>).map((s) => ({
      id: s.id,
      boothLabel: boothLabel.get(s.booth_id) ?? "—",
      startedAt: new Date(s.started_at).getTime(),
      unlockMethod: s.unlock_method,
      amountCents: s.amount_cents ?? null,
      films: (bySession.get(s.id) ?? []).sort((a, b) => a.position - b.position).map(({ title, source, completed }) => ({ title, source, completed })),
    }));
  }

  /**
   * Toutes les lectures de films, à plat (CIN-099). Sert la comptabilisation PAR FILM :
   * l'agrégation (par titre, par jour) est faite côté UI, qui décide de la maille affichée.
   *
   * Même source que `sessionsList()` mais orientée film plutôt que séance — d'où une méthode
   * distincte : joindre les deux forcerait l'appelant à re-déplier des tableaux imbriqués.
   * Les lignes sont scopées par la RLS (une org ne voit que ses propres lectures).
   */
  async filmPlaysList(): Promise<FilmPlayRow[]> {
    if (this.mode !== "supabase") return [];
    const { data: sess } = await supabase!
      .from("sessions")
      .select("id,booth_id,started_at,amount_cents")
      .order("started_at", { ascending: false })
      .limit(1000);
    // `watched_seconds` / `deciles_reached` viennent de 0026 : on les demande explicitement pour
    // que la vue puisse dire JUSQU'OÙ un film a été regardé, et pas seulement combien de fois.
    const { data: playsData, error: playsErr } = await supabase!
      .from("plays")
      .select("session_id,media_id,completed,source,watched_seconds,deciles_reached");
    // Base sans 0026 : on retombe sur les colonnes historiques plutôt que de tout perdre.
    const legacy = Boolean(playsErr);
    const fallback = legacy ? await supabase!.from("plays").select("session_id,media_id,completed,source") : null;
    const plays = (legacy ? fallback?.data : playsData) ?? [];

    const boothLabel = new Map(this.booths.map((b) => [b.id, b.label]));
    const mediaById = new Map(this.media.map((m) => [m.id, m]));
    const sessionCtx = new Map(
      ((sess ?? []) as Array<{ id: string; booth_id: string; started_at: string; amount_cents: number | null }>).map((s) => [
        s.id,
        { boothLabel: boothLabel.get(s.booth_id) ?? "—", at: new Date(s.started_at).getTime(), amount: s.amount_cents ?? null },
      ]),
    );
    const rows: FilmPlayRow[] = [];
    for (const p of plays as Array<{
      session_id: string; media_id: string; completed: boolean; source: string;
      watched_seconds?: number; deciles_reached?: boolean[];
    }>) {
      const ctx = sessionCtx.get(p.session_id);
      // Lecture dont la séance est hors fenêtre (au-delà des 1000 dernières) : on l'ignore
      // plutôt que de l'horodater à 1970, ce qui fausserait le graphe.
      if (!ctx) continue;
      const media = mediaById.get(p.media_id);
      rows.push({
        mediaId: p.media_id,
        // Un média supprimé laisse ses lectures derrière lui : on garde la ligne (le compte
        // reste juste) avec un titre explicite plutôt que de la faire disparaître.
        title: media?.title ?? "Média supprimé",
        boothLabel: ctx.boothLabel,
        at: ctx.at,
        completed: p.completed,
        source: p.source,
        watchedSeconds: Number(p.watched_seconds ?? 0),
        decilesReached: Array.isArray(p.deciles_reached) ? p.deciles_reached : [],
        durationSeconds: media?.durationSeconds ?? 0,
        sessionId: p.session_id,
        sessionAmountCents: ctx.amount,
      });
    }
    return rows.sort((a, b) => b.at - a.at);
  }

  // ── Mises à jour & résilience (Phase 4 / F10) ────────────────────────────────
  releasesList(): Release[] {
    return [...this.releases].sort((a, b) => b.createdAt - a.createdAt);
  }

  async saveRelease(orgId: string, data: { version: string; urgency: string; notes: string }): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("releases").insert({ organization_id: orgId, version: data.version, urgency: data.urgency, notes: data.notes });
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  /** Déploie une release sur des Kiosks : crée les `booth_updates` (fenêtre = maintenance_hour ; urgent = tout de suite). */
  async pushRelease(orgId: string, releaseId: string, boothIds: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const rel = this.releases.find((r) => r.id === releaseId);
    const nextAt = (hour: number): Date => {
      const d = new Date();
      d.setHours(hour, 0, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      return d;
    };
    const rows = boothIds.map((bId) => {
      const booth = this.booths.find((b) => b.id === bId);
      const when = rel?.urgency === "urgent" ? new Date() : nextAt(booth?.maintenanceHour ?? 3);
      return { organization_id: orgId, booth_id: bId, release_id: releaseId, status: "scheduled", scheduled_for: when.toISOString() };
    });
    const { error } = await supabase!.from("booth_updates").upsert(rows, { onConflict: "booth_id,release_id", ignoreDuplicates: true });
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  /** Change le statut d'un déploiement (ops/simulation en attendant l'updater embarqué) : `applied` monte la
   *  version de la Kiosk ; `rolled_back`/`failed` créent une alerte. */
  async setUpdateStatus(updateId: string, status: BoothUpdate["status"]): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const bu = this.boothUpdates.find((u) => u.id === updateId);
    const { error } = await supabase!.from("booth_updates").update({ status, applied_at: status === "applied" ? new Date().toISOString() : null }).eq("id", updateId);
    if (error) return { ok: false, error: error.message };
    if (bu) {
      const rel = this.releases.find((r) => r.id === bu.releaseId);
      const booth = this.booths.find((b) => b.id === bu.boothId);
      if (status === "applied" && rel) {
        await supabase!.from("booths").update({ software_version: rel.version, last_heartbeat_at: new Date().toISOString() }).eq("id", bu.boothId);
      } else if ((status === "rolled_back" || status === "failed") && booth) {
        await supabase!.from("alerts").insert({
          organization_id: booth.organizationId,
          booth_id: booth.id,
          severity: status === "failed" ? "critical" : "error",
          message: `${status === "failed" ? "Échec de MAJ" : "Rollback MAJ"} ${rel?.version ?? ""} — ${booth.label}`,
        });
      }
    }
    await this.loadFromSupabase();
    return { ok: true };
  }

  async setMaintenanceHour(boothId: string, hour: number): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("booths").update({ maintenance_hour: hour }).eq("id", boothId);
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  /** Rapport MAJ par Kiosk (version courante, dernier contact, fenêtre, dernier déploiement). */
  updatesReport(): UpdatesReport {
    const rows: UpdatesRow[] = this.visibleBooths().map((b) => {
      const ups = this.boothUpdates
        .filter((u) => u.boothId === b.id)
        .map((u) => ({ u, rel: this.releases.find((r) => r.id === u.releaseId) }))
        .filter((x) => x.rel)
        .sort((a, c) => c.rel!.createdAt - a.rel!.createdAt);
      const latest = ups[0];
      return {
        boothId: b.id,
        boothLabel: b.label,
        currentVersion: b.softwareVersion || "—",
        lastHeartbeat: b.lastHeartbeatAt,
        maintenanceHour: b.maintenanceHour ?? 3,
        latest: latest ? { version: latest.rel!.version, urgency: latest.rel!.urgency, status: latest.u.status, updateId: latest.u.id } : null,
      };
    });
    return { releases: this.releasesList(), rows };
  }

  // ── MAJ OS (CIN-077) ─────────────────────────────────────────────────────────
  /** Dernière commande de MAJ OS d'une borne (celle qui compte pour l'UI). */
  osUpdateFor(boothId: string): OsUpdateCommand | undefined {
    return this.osUpdateCommands
      .filter((c) => c.boothId === boothId)
      .sort((a, b) => b.requestedAt - a.requestedAt)[0];
  }

  /** Déclenche une MAJ OS sur des bornes (réservé global_admin — la plateforme patche). Crée
   *  une commande `pending` par borne ; la borne (device) la relaie vers l'agent local. */
  async requestOsUpdate(boothIds: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    if (!this.isGlobalAdmin) return { ok: false, error: "Réservé à la plateforme." };
    const uid = this.identity?.user.id ?? null;
    const active = new Set(this.osUpdateCommands.filter((c) => c.status === "pending" || c.status === "running").map((c) => c.boothId));
    const rows = boothIds
      .map((bId) => this.booths.find((b) => b.id === bId))
      .filter((b): b is Booth => !!b && !active.has(b.id)) // une borne déjà en cours : on ne re-déclenche pas (index partiel unique).
      .map((b) => ({ organization_id: b.organizationId, booth_id: b.id, status: "pending", requested_by: uid }));
    if (rows.length === 0) return { ok: false, error: "Bornes déjà en cours de MAJ, ou aucune ciblée." };
    const { error } = await supabase!.from("os_update_commands").insert(rows);
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  // ── Droits & redevances / distributeurs ──────────────────────────────────────
  distributorsList(): Distributor[] {
    return [...this.distributors];
  }
  mediaLicenseFor(mediaId: string): MediaLicense | undefined {
    return this.mediaLicensesCache.find((l) => l.mediaId === mediaId);
  }
  licenseBoothsFor(licenseId: string): LicenseBooth[] {
    return this.licenseBoothsCache.filter((lb) => lb.licenseId === licenseId);
  }

  async saveDistributor(orgId: string, d: { id?: string; name: string; territory: string; contactEmail: string }): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const row = { organization_id: orgId, name: d.name, territory: d.territory, contact_email: d.contactEmail };
    const res = d.id ? await supabase!.from("distributors").update(row).eq("id", d.id) : await supabase!.from("distributors").insert(row);
    if (res.error) return { ok: false, error: res.error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }
  async deleteDistributor(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("distributors").delete().eq("id", id);
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  /** Enregistre (upsert) la licence d'un média (une par org+média). */
  async saveMediaLicense(orgId: string, l: Omit<MediaLicense, "id"> & { id?: string }): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const row = {
      organization_id: orgId, media_id: l.mediaId, distributor_id: l.distributorId,
      royalty_model: l.royaltyModel, royalty_cents: l.royaltyCents, revenue_share_pct: l.revenueSharePct,
      minimum_guarantee_cents: l.minimumGuaranteeCents, max_screenings: l.maxScreenings,
      valid_from: l.validFrom, valid_to: l.validTo, notes: l.notes,
    };
    const { error } = await supabase!.from("media_licenses").upsert(row, { onConflict: "organization_id,media_id" });
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }
  async deleteMediaLicense(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    const { error } = await supabase!.from("media_licenses").delete().eq("id", id);
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }
  /** Remplace le scope/plafond par machine d'une licence (delete + insert). */
  async setLicenseBooths(orgId: string, licenseId: string, entries: Array<{ boothId: string; maxScreenings: number | null }>): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: true };
    await supabase!.from("license_booths").delete().eq("license_id", licenseId);
    if (entries.length > 0) {
      const rows = entries.map((e) => ({ organization_id: orgId, license_id: licenseId, booth_id: e.boothId, max_screenings: e.maxScreenings }));
      const { error } = await supabase!.from("license_booths").insert(rows);
      if (error) return { ok: false, error: error.message };
    }
    await this.loadFromSupabase();
    return { ok: true };
  }

  /**
   * Rapport droits & redevances (F9) : par média, séances (plays `completed`) vs plafond
   * (org-wide ou par Kiosk), redevance estimée, statut. Le journal de vision est `plays`,
   * rattaché à la Kiosk via `session.booth_id`.
   */
  async rightsReport(): Promise<RightsReport> {
    const emptyReport: RightsReport = { rows: [], totalOwedCents: 0, overCapCount: 0, noLicenseCount: 0, currency: this.activeCurrency() };
    if (this.mode !== "supabase") return emptyReport;

    const { data: playsData } = await supabase!.from("plays").select("media_id,session_id,completed");
    const { data: sessData } = await supabase!.from("sessions").select("id,booth_id");
    const sessionBooth = new Map(((sessData ?? []) as Array<{ id: string; booth_id: string }>).map((s) => [s.id, s.booth_id]));

    const completedByMedia = new Map<string, number>();
    const byMediaBooth = new Map<string, Map<string, number>>();
    let totalCompleted = 0;
    for (const p of (playsData ?? []) as Array<{ media_id: string; session_id: string; completed: boolean }>) {
      if (!p.completed) continue;
      totalCompleted += 1;
      completedByMedia.set(p.media_id, (completedByMedia.get(p.media_id) ?? 0) + 1);
      const booth = sessionBooth.get(p.session_id);
      if (booth) {
        let m = byMediaBooth.get(p.media_id);
        if (!m) { m = new Map(); byMediaBooth.set(p.media_id, m); }
        m.set(booth, (m.get(booth) ?? 0) + 1);
      }
    }

    const totalRevenueCents = this.transactions.reduce((n, t) => n + t.amountCents, 0);
    const boothLabel = new Map(this.booths.map((b) => [b.id, b.label]));
    const distName = new Map(this.distributors.map((d) => [d.id, d.name]));
    const today = new Date().toISOString().slice(0, 10);

    const rows: RightsRow[] = this.media.map((media) => {
      const lic = this.mediaLicensesCache.find((l) => l.mediaId === media.id);
      const used = completedByMedia.get(media.id) ?? 0;
      const lbs = lic ? this.licenseBoothsCache.filter((lb) => lb.licenseId === lic.id) : [];
      const capScope: RightsRow["capScope"] = lbs.length > 0 ? "per_booth" : lic && lic.maxScreenings != null ? "org" : "none";
      const mb = byMediaBooth.get(media.id) ?? new Map<string, number>();
      const perBooth = lbs.length > 0
        ? lbs.map((lb) => ({ boothId: lb.boothId, boothLabel: boothLabel.get(lb.boothId) ?? "—", used: mb.get(lb.boothId) ?? 0, cap: lb.maxScreenings ?? lic!.maxScreenings ?? null }))
        : [...mb.entries()].map(([bId, u]) => ({ boothId: bId, boothLabel: boothLabel.get(bId) ?? "—", used: u, cap: null as number | null }));

      let status: RightsRow["status"] = "ok";
      if (!lic) status = "no_license";
      else if (lic.validTo && lic.validTo < today) status = "expired";
      else if (capScope === "per_booth" && perBooth.some((pb) => pb.cap != null && pb.used >= pb.cap)) status = "over_cap";
      else if (capScope === "org" && lic.maxScreenings != null && used >= lic.maxScreenings) status = "over_cap";

      let owed = 0;
      if (lic) {
        if (lic.royaltyModel === "per_screening") owed = used * lic.royaltyCents;
        else if (lic.royaltyModel === "flat") owed = lic.minimumGuaranteeCents ?? 0;
        else if (lic.royaltyModel === "revenue_share") owed = totalCompleted > 0 ? Math.round(totalRevenueCents * (used / totalCompleted) * (lic.revenueSharePct / 100)) : 0;
      }

      return {
        mediaId: media.id, title: media.title,
        distributorName: lic?.distributorId ? distName.get(lic.distributorId) ?? null : null,
        royaltyModel: lic?.royaltyModel ?? null, screeningsUsed: used, maxScreenings: lic?.maxScreenings ?? null,
        capScope, perBooth, royaltyOwedCents: owed, status,
      };
    });

    return {
      rows,
      totalOwedCents: rows.reduce((n, r) => n + r.royaltyOwedCents, 0),
      overCapCount: rows.filter((r) => r.status === "over_cap").length,
      noLicenseCount: rows.filter((r) => r.status === "no_license").length,
      currency: this.activeCurrency(),
    };
  }

  // ── Versions vidéo par langue (CIN-095, migration 0027) ──────────────────────
  /** Versions vidéo d'un média — primaire d'abord, puis par langue. */
  videosFor(mediaId: string): MediaVideoRecord[] {
    return this.mediaVideos
      .filter((v) => v.mediaId === mediaId)
      .sort((a, b) => (a.isPrimary === b.isPrimary ? a.lang.localeCompare(b.lang) : a.isPrimary ? -1 : 1));
  }

  /**
   * Téléverse une version vidéo dans une langue et l'enregistre.
   *
   * La PREMIÈRE version d'un média devient automatiquement primaire : un média dont aucune
   * version n'est servie serait injouable en cabine sans que rien ne le signale.
   * Chemin storage `{org}/{hash}/video/{lang}` → couvert par les policies d'isolation existantes
   * (1er segment = org), au même titre que la vidéo principale et les sous-titres.
   */
  async saveMediaVideo(
    media: Media,
    lang: string,
    file: File,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: false, error: "hors ligne" };
    const safeLang = lang.trim().toLowerCase() || "fr";
    const path = `${media.organizationId}/${media.contentHash}/video/${safeLang}`;

    // Le bucket `media` (0003) n'a pas de policy UPDATE : remplacer une version passe par
    // suppression puis insertion (même contrainte que pour les sous-titres, cf. saveSubtitle).
    await supabase!.storage.from("media").remove([path]);
    const up = await supabase!.storage.from("media").upload(path, file, { upsert: false, contentType: file.type || "video/mp4" });
    if (up.error) return { ok: false, error: `Téléversement échoué : ${up.error.message}` };

    const existing = this.mediaVideos.find((v) => v.mediaId === media.id && v.lang === safeLang);
    const isFirst = this.mediaVideos.filter((v) => v.mediaId === media.id).length === 0;
    const row = {
      organization_id: media.organizationId,
      media_id: media.id,
      lang: safeLang,
      storage_url: path,
      original_filename: file.name,
      size_bytes: file.size,
      created_by: this.identity?.user.id ?? null,
      ...(isFirst ? { is_primary: true } : {}),
    };
    const { error } = existing
      ? await supabase!.from("media_videos").update(row).eq("id", existing.id)
      : await supabase!.from("media_videos").insert(row);
    if (error) return { ok: false, error: error.message };

    // La borne lit toujours `media.storage_url` : on l'aligne sur la version primaire, sinon la
    // cabine continuerait de servir l'ancien fichier sans que rien ne l'indique.
    if (isFirst || existing?.isPrimary) {
      const { error: me } = await supabase!.from("media").update({ storage_url: path }).eq("id", media.id);
      if (me) return { ok: false, error: me.message };
    }
    await this.loadFromSupabase();
    return { ok: true };
  }

  /** Désigne la version servie aux cabines (et aligne `media.storage_url`). */
  async setPrimaryMediaVideo(video: MediaVideoRecord): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: false, error: "hors ligne" };
    // L'index unique partiel n'autorise qu'une primaire : on retire l'ancienne AVANT de poser la
    // nouvelle, sinon l'update est rejeté.
    const { error: clearErr } = await supabase!.from("media_videos").update({ is_primary: false }).eq("media_id", video.mediaId).eq("is_primary", true);
    if (clearErr) return { ok: false, error: clearErr.message };
    const { error } = await supabase!.from("media_videos").update({ is_primary: true }).eq("id", video.id);
    if (error) return { ok: false, error: error.message };
    const { error: me } = await supabase!.from("media").update({ storage_url: video.storageUrl }).eq("id", video.mediaId);
    if (me) return { ok: false, error: me.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  /** Supprime une version vidéo (objet storage + ligne). Refuse de retirer la dernière version. */
  async deleteMediaVideo(video: MediaVideoRecord): Promise<{ ok: boolean; error?: string }> {
    if (this.mode !== "supabase") return { ok: false, error: "hors ligne" };
    // Garde-fou : supprimer la seule version rendrait le média injouable en cabine. On le refuse
    // explicitement plutôt que de laisser un média « vivant » sans fichier.
    if (this.videosFor(video.mediaId).length <= 1) {
      return { ok: false, error: "Dernière version : supprimez le média entier plutôt que son seul fichier." };
    }
    if (video.isPrimary) {
      return { ok: false, error: "Version servie aux cabines : désignez-en une autre avant de la supprimer." };
    }
    await supabase!.storage.from("media").remove([video.storageUrl]);
    const { error } = await supabase!.from("media_videos").delete().eq("id", video.id);
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  // ── Aperçu média & sous-titres (F8/F12) ──────────────────────────────────────
  /** Sous-titres enregistrés pour un média. */
  subtitlesFor(mediaId: string): SubtitleRecord[] {
    return this.subtitles.filter((s) => s.mediaId === mediaId);
  }

  /**
   * URL signée temporaire pour lire un objet du bucket privé `media` dans le
   * navigateur (le bucket n'est pas public). `null` si pas de chemin ou en mock.
   */
  async signedUrl(path: string | null, ttlSeconds = 3600): Promise<string | null> {
    if (!path || this.mode !== "supabase") return null;
    const { data, error } = await supabase!.storage.from("media").createSignedUrl(path, ttlSeconds);
    if (error) {
      console.error("signedUrl:", error.message);
      return null;
    }
    return data.signedUrl;
  }

  /**
   * Enregistre une piste de sous-titres calée (offset déjà baké dans le VTT) :
   * upload dans Storage à un chemin déterministe puis upsert de la ligne
   * `subtitles`. Chemin = `{org}/{hash}/subs/{lang}.vtt` → 1er segment = org, donc
   * couvert par les mêmes policies storage que la vidéo (isolation préservée).
   */
  async saveSubtitle(media: Media, lang: string, vttText: string): Promise<{ ok: boolean; error?: string }> {
    const safeLang = lang.trim().toLowerCase() || "fr";
    if (this.mode === "mock") {
      this.subtitles = this.subtitles.filter((s) => !(s.mediaId === media.id && s.lang === safeLang));
      this.subtitles.push({ id: crypto.randomUUID(), mediaId: media.id, lang: safeLang, format: "vtt", url: `mock/${safeLang}.vtt`, workflowStatus: "verified" });
      this.emit();
      return { ok: true };
    }

    const path = `${media.organizationId}/${media.contentHash}/subs/${safeLang}.vtt`;
    const blob = new Blob([vttText], { type: "text/vtt" });
    // Le bucket `media` (0003) n'a pas de policy UPDATE sur storage.objects → un
    // `upsert` d'un objet EXISTANT (re-calage d'une même langue) est refusé par la
    // RLS. On supprime d'abord (policy DELETE OK) puis on insère (policy INSERT OK).
    await supabase!.storage.from("media").remove([path]);
    const up = await supabase!.storage.from("media").upload(path, blob, { upsert: false, contentType: "text/vtt" });
    if (up.error) return { ok: false, error: `Téléversement des sous-titres échoué : ${up.error.message}` };

    // Upsert manuel (pas de contrainte unique (media_id,lang) sur la table).
    const existing = this.subtitles.find((s) => s.mediaId === media.id && s.lang === safeLang);
    if (existing) {
      const { error } = await supabase!.from("subtitles").update({ format: "vtt", url: path, workflow_status: "verified" }).eq("id", existing.id);
      if (error) return { ok: false, error: error.message };
    } else {
      const { error } = await supabase!
        .from("subtitles")
        .insert({ organization_id: media.organizationId, media_id: media.id, lang: safeLang, format: "vtt", url: path, workflow_status: "verified" });
      if (error) return { ok: false, error: error.message };
    }
    await this.loadFromSupabase();
    return { ok: true };
  }

  /** Supprime une piste de sous-titres : l'objet Storage puis la ligne `subtitles`. */
  async deleteSubtitle(sub: SubtitleRecord): Promise<{ ok: boolean; error?: string }> {
    if (this.mode === "mock") {
      this.subtitles = this.subtitles.filter((s) => s.id !== sub.id);
      this.emit();
      return { ok: true };
    }
    // L'objet peut déjà être absent (piste orpheline) → on ignore l'erreur storage.
    await supabase!.storage.from("media").remove([sub.url]);
    const { error } = await supabase!.from("subtitles").delete().eq("id", sub.id);
    if (error) return { ok: false, error: error.message };
    await this.loadFromSupabase();
    return { ok: true };
  }

  /** Récupère le contenu texte d'un sous-titre stocké (via URL signée). */
  async fetchSubtitleText(path: string): Promise<string | null> {
    const url = await this.signedUrl(path, 300);
    if (!url) return null;
    try {
      const res = await fetch(url);
      return res.ok ? await res.text() : null;
    } catch (e) {
      console.error("fetchSubtitleText:", e);
      return null;
    }
  }

  // ── Disposition des widgets ─────────────────────────────────────────────────
  loadLayout(): unknown | null {
    const raw = localStorage.getItem(LS_LAYOUT);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  saveLayout(layout: unknown): void {
    localStorage.setItem(LS_LAYOUT, JSON.stringify(layout));
  }

  // ── Persistance mock ────────────────────────────────────────────────────────
  private persistMock(): void {
    localStorage.setItem(LS_BOOTHS, JSON.stringify(this.booths));
  }
  private loadMockBooths(): Booth[] {
    const raw = localStorage.getItem(LS_BOOTHS);
    if (raw) {
      try {
        return JSON.parse(raw) as Booth[];
      } catch {
        /* retombe sur le mock */
      }
    }
    return MOCK_BOOTHS.map((b) => structuredClone(b));
  }
}
