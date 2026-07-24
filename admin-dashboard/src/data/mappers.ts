import type { Booth, BoothTelemetry, Media, MediaInstance, StorageLocation } from "../domain/types";

// Conversion entre les lignes Postgres (snake_case) et le modèle de domaine
// (camelCase). Les agrégats (sessions/revenu/historique/logs du jour) viennent de
// requêtes séparées (sessions/plays/daily_stats) — ici on mappe la ligne `booths`
// et on met des valeurs par défaut pour ces agrégats (remplies ensuite).

interface BoothRow {
  id: string;
  organization_id: string;
  label: string;
  location: string;
  address: string;
  gps_lat: number | null;
  gps_lng: number | null;
  venue_type: string | null;
  serial: string | null;
  health: Booth["health"];
  indicators: string[];
  software_version: string;
  last_heartbeat_at: string | null;
  telemetry: Partial<BoothTelemetry> | null;
  notes: string;
  signed_at: string | null;
  device_key_ref: string | null;
  maintenance_hour: number | null;
}

const DEFAULT_TELEMETRY: BoothTelemetry = {
  uptimePct: 0,
  temperatureC: 0,
  storageFreePct: 0,
  cpuLoadPct: 0,
  currentFilmTitle: null,
  connection: "wifi",
  signalPct: 0,
};

export function rowToBooth(row: BoothRow): Booth {
  return {
    id: row.id,
    organizationId: row.organization_id,
    label: row.label,
    location: row.location,
    address: row.address,
    gpsLat: row.gps_lat,
    gpsLng: row.gps_lng,
    venueType: row.venue_type ?? null,
    serial: row.serial ?? null,
    health: row.health,
    indicators: (row.indicators ?? []) as Booth["indicators"],
    softwareVersion: row.software_version,
    lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0,
    telemetry: { ...DEFAULT_TELEMETRY, ...(row.telemetry ?? {}) },
    notes: row.notes ?? "",
    signedAt: row.signed_at ? new Date(row.signed_at).getTime() : null,
    deviceKeyRef: row.device_key_ref ?? null,
    maintenanceHour: row.maintenance_hour ?? 3,
    // Agrégats calculés séparément (Phase 1 suite) :
    sessionsToday: 0,
    revenueTodayCents: 0,
    history: [],
    logs: [],
  };
}

// ── Médias ───────────────────────────────────────────────────────────────────
interface MediaRow {
  id: string;
  organization_id: string;
  content_hash: string;
  title: string;
  year: number | null;
  duration_seconds: number;
  storage_url: string | null;
  version: number;
  active: boolean;
  tmdb_id: number | null;
  genres: string[] | null;
  moods: string[] | null;
  tags: string[] | null;
  audience_tags: string[] | null;
  language: string;
  director: string;
  synopsis: string;
  stills: string[] | null;
  learn_more_url: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  protection: "none" | "encrypted" | "drm" | null;
  drm_scheme: string | null;
  source_protected: boolean | null;
}

export function rowToMedia(row: MediaRow): Media {
  return {
    id: row.id,
    organizationId: row.organization_id,
    contentHash: row.content_hash,
    title: row.title,
    year: row.year ?? 0,
    durationSeconds: row.duration_seconds,
    storageUrl: row.storage_url,
    version: row.version,
    active: row.active,
    tmdbId: row.tmdb_id,
    genres: row.genres ?? [],
    moods: row.moods ?? [],
    tags: row.tags ?? [],
    audienceTags: row.audience_tags ?? [],
    language: row.language,
    subtitles: [],
    director: row.director,
    synopsis: row.synopsis,
    stills: row.stills ?? [],
    learnMoreUrl: row.learn_more_url,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).getTime() : null,
    reviewedBy: row.reviewed_by,
    protection: row.protection ?? "none",
    drmScheme: row.drm_scheme,
    sourceProtected: row.source_protected ?? false,
  };
}

export function mediaToRow(m: Media): Record<string, unknown> {
  return {
    id: m.id,
    organization_id: m.organizationId,
    content_hash: m.contentHash,
    title: m.title,
    year: m.year,
    duration_seconds: m.durationSeconds,
    storage_url: m.storageUrl,
    version: m.version,
    active: m.active,
    tmdb_id: m.tmdbId,
    genres: m.genres,
    moods: m.moods,
    tags: m.tags,
    audience_tags: m.audienceTags,
    language: m.language,
    director: m.director,
    synopsis: m.synopsis,
    stills: m.stills,
    learn_more_url: m.learnMoreUrl,
    // Protection : le fait d'être protégé (la clé DRM vit sur la borne signée, pas ici).
    protection: m.protection ?? "none",
    drm_scheme: m.drmScheme ?? null,
    source_protected: m.sourceProtected ?? false,
  };
}

// ── Supports de stockage & présence des médias ───────────────────────────────
interface StorageLocationRow {
  id: string;
  booth_id: string;
  type: StorageLocation["type"];
  label: string;
  capacity_bytes: number;
  free_bytes: number;
}

export function rowToStorageLocation(row: StorageLocationRow): StorageLocation {
  return {
    id: row.id,
    boothId: row.booth_id,
    type: row.type,
    label: row.label,
    capacityBytes: Number(row.capacity_bytes),
    freeBytes: Number(row.free_bytes),
  };
}

interface MediaInstanceRow {
  id: string;
  media_id: string;
  storage_location_id: string;
}

export function rowToMediaInstance(row: MediaInstanceRow): MediaInstance {
  return { id: row.id, mediaId: row.media_id, storageLocationId: row.storage_location_id };
}

// ── Transactions (revenus, F9) ───────────────────────────────────────────────
export interface TransactionRecord {
  readonly id: string;
  readonly boothId: string;
  readonly organizationId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly provider: string;
  readonly createdAt: number; // epoch ms
}

interface TransactionRow {
  id: string;
  booth_id: string;
  organization_id: string;
  amount_cents: number;
  currency: string | null;
  provider: string | null;
  created_at: string;
}

export function rowToTransaction(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    boothId: row.booth_id,
    organizationId: row.organization_id,
    amountCents: row.amount_cents,
    currency: row.currency ?? "EUR",
    provider: row.provider ?? "mock",
    createdAt: new Date(row.created_at).getTime(),
  };
}

/** Ligne à écrire dans `booths` (upsert). Les agrégats ne sont pas persistés ici. */
export function boothToRow(b: Booth): Record<string, unknown> {
  return {
    id: b.id,
    organization_id: b.organizationId,
    label: b.label,
    location: b.location,
    address: b.address,
    gps_lat: b.gpsLat,
    gps_lng: b.gpsLng,
    venue_type: b.venueType,
    serial: b.serial ?? null,
    health: b.health,
    indicators: b.indicators,
    software_version: b.softwareVersion,
    telemetry: b.telemetry,
    notes: b.notes,
  };
}
