import type { OrgStyle, Subtitle } from "@kioskoscope/domain";
import type { Film, Play, Session } from "../domain/types";
import type { AccessLogEntry } from "../setup/accessCache";
import type { AccessEntry, AccessTable, OperatorRole } from "../setup/auth";
import { supabase } from "./supabase";

// Adaptateur backend de la Kiosk : lit le catalogue réel (médias de son org) et
// remonte les séances/lectures vers Supabase. La borne = un DEVICE authentifié
// (compte membre de l'org) → la RLS scope automatiquement lecture et écriture.
//
// ⚠️ Sécurité (@qa, à durcir avant la rue) : pour le prototype, le compte-device peut
// être un compte à droits d'écriture (super_user/manager). À terme : un rôle `device`
// dédié + une policy d'INSERT minimale (sessions/plays de SA Kiosk uniquement).

interface BoothConfig {
  readonly boothId: string;
  readonly orgId: string;
  readonly deviceEmail: string;
  readonly devicePassword: string;
}

// DEV UNIQUEMENT : creds depuis le .env local. En PRODUCTION, les identifiants device
// viennent du RUNTIME (/kiosk-config.json servi par la borne), jamais du bundle — sinon un
// build public embarquerait le mot de passe device en clair (finding sécu 2026-07-08).
function readDevConfig(): BoothConfig | null {
  if (!import.meta.env.DEV) return null;
  const boothId = import.meta.env.VITE_BOOTH_ID as string | undefined;
  const orgId = import.meta.env.VITE_ORG_ID as string | undefined;
  const deviceEmail = import.meta.env.VITE_DEVICE_EMAIL as string | undefined;
  const devicePassword = import.meta.env.VITE_DEVICE_PASSWORD as string | undefined;
  if (boothId && orgId && deviceEmail && devicePassword) return { boothId, orgId, deviceEmail, devicePassword };
  return null;
}

/** Ligne `media` (snake_case) → `Film` (= `Media`, camelCase). */
function rowToFilm(row: Record<string, unknown>, subs: readonly Subtitle[] = []): Film {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    contentHash: String(row.content_hash ?? ""),
    title: String(row.title ?? ""),
    year: (row.year as number | null) ?? 0,
    durationSeconds: Number(row.duration_seconds ?? 0),
    storageUrl: (row.storage_url as string | null) ?? null,
    version: Number(row.version ?? 1),
    active: Boolean(row.active),
    tmdbId: (row.tmdb_id as number | null) ?? null,
    genres: arr(row.genres),
    moods: arr(row.moods),
    tags: arr(row.tags),
    audienceTags: arr(row.audience_tags),
    language: String(row.language ?? "fr"),
    subtitles: subs,
    director: String(row.director ?? ""),
    synopsis: String(row.synopsis ?? ""),
    stills: arr(row.stills),
    learnMoreUrl: (row.learn_more_url as string | null) ?? null,
    reviewedAt: row.reviewed_at ? new Date(String(row.reviewed_at)).getTime() : null,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    protection: (row.protection as Film["protection"]) ?? "none",
    drmScheme: (row.drm_scheme as string | null) ?? null,
    sourceProtected: Boolean(row.source_protected),
  };
}

export class BoothBackend {
  private readonly cfg: BoothConfig | null;

  /** `runtime` = creds fournis par la borne (/kiosk-config.json). Repli .env en DEV seulement. */
  constructor(runtime?: BoothConfig) {
    this.cfg = runtime ?? readDevConfig();
  }

  /** La Kiosk est-elle branchée sur Supabase (config présente + client) ? */
  get isConfigured(): boolean {
    return this.cfg !== null && supabase !== null;
  }
  get boothId(): string {
    return this.cfg?.boothId ?? "";
  }
  get organizationId(): string {
    return this.cfg?.orgId ?? "";
  }
  /**
   * Secret (en-process) pour chiffrer le cache d'accès AU REPOS (CIN-073 S4). On réutilise
   * le mot de passe device : provisionné, jamais stocké dans localStorage à côté du chiffré.
   * ⚠️ Sur la Kiosk packagée, la clé doit venir du trousseau OS, pas du bundle.
   */
  get cacheSecret(): string {
    return this.cfg?.devicePassword ?? "";
  }

  /** Authentifie le device. `false` si non configuré ou échec (→ mode mock). */
  async init(): Promise<boolean> {
    if (!this.cfg || !supabase) return false;
    const { error } = await supabase.auth.signInWithPassword({ email: this.cfg.deviceEmail, password: this.cfg.devicePassword });
    if (error) {
      console.error("[booth] authentification device échouée :", error.message);
      return false;
    }
    return true;
  }

  /** Remonte l'état vivant de la Kiosk : version logicielle + dernier contact (F3). */
  async reportHeartbeat(version: string): Promise<void> {
    if (!supabase || !this.cfg) return;
    const { error } = await supabase
      .from("booths")
      .update({ software_version: version, last_heartbeat_at: new Date().toISOString() })
      .eq("id", this.cfg.boothId);
    if (error) console.error("[booth] heartbeat :", error.message);
  }

  /**
   * Updater embarqué (F10, prototype) : applique les déploiements en attente pour CETTE Kiosk
   * dont la fenêtre est échue. Ne pouvant pas swapper le code d'une web-app, on SIMULE
   * l'application (statut → `applied`, version Kiosk = version de la release). Le vrai
   * updater embarqué (télécharger/redémarrer/watchdog/rollback) viendra avec le déploiement OS.
   * Renvoie la version courante après application.
   */
  async applyPendingUpdates(currentVersion: string): Promise<string> {
    if (!supabase || !this.cfg) return currentVersion;
    const nowIso = new Date().toISOString();
    const { data } = await supabase
      .from("booth_updates")
      .select("id,release_id,status,scheduled_for")
      .eq("booth_id", this.cfg.boothId)
      .in("status", ["pending", "scheduled"]);
    const due = ((data ?? []) as Array<{ id: string; release_id: string; scheduled_for: string | null }>).filter((u) => !u.scheduled_for || u.scheduled_for <= nowIso);
    if (due.length === 0) return currentVersion;

    const { data: rels } = await supabase.from("releases").select("id,version,created_at").in("id", due.map((u) => u.release_id));
    const byId = new Map(((rels ?? []) as Array<{ id: string; version: string; created_at: string }>).map((r) => [r.id, r]));

    let newVersion = currentVersion;
    let newest = 0;
    for (const u of due) {
      await supabase.from("booth_updates").update({ status: "applied", applied_at: nowIso }).eq("id", u.id);
      const rel = byId.get(u.release_id);
      if (rel) {
        const t = new Date(rel.created_at).getTime();
        if (t >= newest) { newest = t; newVersion = rel.version; }
      }
    }
    await supabase.from("booths").update({ software_version: newVersion, last_heartbeat_at: nowIso }).eq("id", this.cfg.boothId);
    console.info(`[booth] MAJ appliquée${due.length > 1 ? ` (${due.length})` : ""} → version ${newVersion}`);
    return newVersion;
  }

  /**
   * Relais MAJ OS (CIN-077) : lit les commandes `pending` de CETTE borne, applique chacune via
   * l'agent local (`runUpdate`, injecté → le backend ne dépend pas de l'agent) et remonte le
   * résultat (`running` → `done`/`failed` + journal apt). La RLS device n'autorise que SA borne.
   * Fire-and-forget : une erreur agent → commande `failed`, jamais de crash du parcours.
   */
  async relayOsUpdates(runUpdate: () => Promise<{ log?: string; pending?: number }>): Promise<void> {
    if (!supabase || !this.cfg) return;
    const { data, error } = await supabase
      .from("os_update_commands")
      .select("id,status")
      .eq("booth_id", this.cfg.boothId)
      .eq("status", "pending");
    if (error) {
      console.error("[booth] lecture commandes MAJ OS :", error.message);
      return;
    }
    for (const cmd of (data ?? []) as Array<{ id: string }>) {
      // Prend la commande (running). Le with-check RLS garantit qu'elle est bien à cette borne.
      await supabase.from("os_update_commands").update({ status: "running", started_at: new Date().toISOString() }).eq("id", cmd.id);
      try {
        const res = await runUpdate();
        await supabase
          .from("os_update_commands")
          .update({ status: "done", finished_at: new Date().toISOString(), log: (res.log ?? "").slice(0, 8000), packages_pending: res.pending ?? null, error: "" })
          .eq("id", cmd.id);
        console.info("[booth] MAJ OS appliquée.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Échec MAJ OS.";
        await supabase.from("os_update_commands").update({ status: "failed", finished_at: new Date().toISOString(), error: msg.slice(0, 2000) }).eq("id", cmd.id);
        console.error("[booth] MAJ OS échouée :", msg);
      }
    }
  }

  /** Catalogue réel de l'org (médias actifs, scoping RLS) + sous-titres VÉRIFIÉS (F12). */
  async loadCatalog(): Promise<Film[]> {
    if (!supabase) return [];
    const { data, error } = await supabase.from("media").select("*").eq("active", true);
    if (error) {
      console.error("[booth] chargement catalogue :", error.message);
      return [];
    }
    // F12 : sous-titres — UNIQUEMENT format VTT (natif navigateur, pas de conversion SRT côté borne)
    // et workflow_status = 'verified' (jamais un brouillon 'todo'/'rework' sur une borne publique).
    // Nécessite la policy device sur `subtitles` (migration 0021). Échec silencieux → catalogue sans subs.
    const subsByMedia = new Map<string, Subtitle[]>();
    const { data: subRows, error: subErr } = await supabase
      .from("subtitles")
      .select("media_id,lang,format,url,workflow_status")
      .eq("format", "vtt")
      .eq("workflow_status", "verified");
    if (subErr) {
      console.warn("[booth] sous-titres non chargés :", subErr.message);
    } else {
      for (const r of (subRows ?? []) as Array<Record<string, unknown>>) {
        const mid = String(r.media_id);
        const list = subsByMedia.get(mid) ?? [];
        list.push({
          lang: String(r.lang),
          format: "vtt",
          url: String(r.url),
          workflowStatus: "verified",
        });
        subsByMedia.set(mid, list);
      }
    }
    return (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return rowToFilm(row, subsByMedia.get(String(row.id)) ?? []);
    });
  }

  /**
   * Style d'organisation « Mes styles » (F19). La borne LIT le style de son org (RLS device
   * SELECT scopée `device_org()`) et le passe à `applyOrgStyle`. `null` si aucune ligne = style
   * MAÎTRE Kioskoscope (défaut). Les colonnes jsonb reviennent déjà désérialisées.
   */
  async loadOrgStyle(): Promise<OrgStyle | null> {
    if (!supabase || !this.cfg) return null;
    const { data, error } = await supabase
      .from("org_styles")
      .select("palette,fonts,assets,title")
      .eq("organization_id", this.cfg.orgId)
      .maybeSingle();
    if (error) {
      console.error("[booth] chargement style d'org :", error.message);
      return null;
    }
    if (!data) return null;
    const row = data as { palette?: unknown; fonts?: unknown; assets?: unknown; title?: unknown };
    // On ne conserve que les slots présents ; `applyOrgStyle` retombe sur le maître pour le reste.
    const style: OrgStyle = {
      ...(row.palette ? { palette: row.palette as NonNullable<OrgStyle["palette"]> } : {}),
      ...(row.fonts ? { fonts: row.fonts as NonNullable<OrgStyle["fonts"]> } : {}),
      ...(row.assets ? { assets: row.assets as NonNullable<OrgStyle["assets"]> } : {}),
      ...(typeof row.title === "string" ? { title: row.title } : {}),
    };
    return style;
  }

  /**
   * Enforcement des droits (F15, CIN-010) : renvoie les `media_id` à EXCLURE du catalogue de
   * CETTE Kiosk — licence expirée / pas encore valide, Kiosk non autorisée, ou plafond de
   * séances atteint (par Kiosk ou org-wide). Calculé côté serveur (fonction `security definer`
   * `blocked_media_for_booth`) : la borne n'a pas besoin de lire licences/plays.
   */
  async loadBlockedMedia(): Promise<Set<string>> {
    if (!supabase || !this.cfg) return new Set();
    const { data, error } = await supabase.rpc("blocked_media_for_booth", { p_booth: this.cfg.boothId });
    if (error) {
      console.error("[booth] enforcement droits :", error.message);
      return new Set(); // en cas d'erreur, ne pas bloquer le parcours (fail-open côté produit)
    }
    return new Set(((data ?? []) as Array<{ media_id: string }>).map((r) => String(r.media_id)));
  }

  /**
   * Sync des accès opérateur (CIN-073, F17) : tire la table d'accès de SON org depuis
   * Supabase pour la mettre en cache local, afin que le menu opérateur s'authentifie
   * HORS LIGNE ensuite. La RLS scope déjà les lignes (org du device + portée booth) —
   * on ne relit jamais que des EMPREINTES de PIN, jamais de secret en clair. On garde
   * aussi les entrées révoquées/expirées : la vérif offline doit pouvoir les refuser.
   * Renvoie la table à sauvegarder, ou null si non branché / erreur.
   */
  async syncOperatorAccess(): Promise<AccessTable | null> {
    if (!supabase || !this.cfg) return null;
    const { data, error } = await supabase
      .from("operator_access")
      .select("identifier,pin_hash,salt,iterations,role,expires_at,revoked");
    if (error) {
      console.error("[booth] sync accès opérateur :", error.message);
      return null;
    }
    const entries: AccessEntry[] = (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        identifier: String(row.identifier),
        pinHash: String(row.pin_hash),
        salt: String(row.salt),
        iterations: Number(row.iterations),
        role: String(row.role) as OperatorRole,
        expiresAt: (row.expires_at as string | null) ?? null,
        revoked: Boolean(row.revoked),
      };
    });
    return { orgId: this.cfg.orgId, boothId: this.cfg.boothId, updatedAt: new Date().toISOString(), entries };
  }

  /**
   * Pousse le journal d'accès bufferisé (login, Wi-Fi, redémarrage…) vers Supabase.
   * Append-only côté serveur (policy device = INSERT seul). Renvoie true si le push a
   * réussi — l'appelant ne draine le buffer local QU'À CE MOMENT (pas de perte si offline).
   */
  async pushAccessLog(entries: readonly AccessLogEntry[]): Promise<boolean> {
    if (!supabase || !this.cfg || entries.length === 0) return false;
    const rows = entries.map((e) => ({
      organization_id: this.cfg!.orgId,
      booth_id: this.cfg!.boothId,
      at: e.at,
      identifier: e.identifier,
      action: e.action,
      detail: e.detail ?? null,
    }));
    const { error } = await supabase.from("operator_access_log").insert(rows);
    if (error) {
      console.error("[booth] push journal d'accès :", error.message);
      return false;
    }
    return true;
  }

  /** Remonte une séance close + ses lectures. Fire-and-forget (n'interrompt pas le parcours). */
  async saveSession(snapshot: { session: Session; plays: readonly Play[] }): Promise<void> {
    if (!supabase || !this.cfg) return;
    const s = snapshot.session;
    // Id généré CÔTÉ BORNE : on n'a pas besoin de relire la ligne (RETURNING), ce qui
    // évite d'exiger une policy SELECT sur `sessions` pour le device (droits minimaux, CIN-002).
    const sessionId = crypto.randomUUID();
    const { error } = await supabase
      .from("sessions")
      .insert({
        id: sessionId,
        organization_id: this.cfg.orgId,
        booth_id: this.cfg.boothId,
        started_at: new Date(s.startedAt).toISOString(),
        ended_at: s.endedAt ? new Date(s.endedAt).toISOString() : null,
        share_token: s.shareToken,
        unlock_method: s.unlockMethod,
        amount_cents: s.amount != null ? Math.round(s.amount) : null,
        payment_provider_ref: s.paymentProviderRef,
      });
    if (error) {
      console.error("[booth] remontée séance :", error.message);
      return;
    }
    if (snapshot.plays.length > 0) {
      const rows = snapshot.plays.map((p) => ({
        organization_id: this.cfg!.orgId,
        session_id: sessionId,
        media_id: p.filmId,
        position: p.position,
        started_at: new Date(p.startedAt).toISOString(),
        completed: p.completed,
        source: p.source,
      }));
      const { error: pe } = await supabase.from("plays").insert(rows);
      if (pe) console.error("[booth] remontée lectures :", pe.message);
    }
  }
}
