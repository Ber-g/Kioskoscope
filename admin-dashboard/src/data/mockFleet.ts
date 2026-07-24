import type { Booth, DailyStat, Membership, Organization, User } from "../domain/types";

// ⚠️ DONNÉES MOCK — préfigurent le futur backend (fleet-api). À remplacer par des
// appels réseau réels. Structure identique au modèle de domaine.

const MIN = 60_000;
const DAY = 86_400_000;
const now = Date.now();

/** Génère 14 jours d'historique (sessions + bande passante) de façon stable. */
function genHistory(seed: number, scale: number): DailyStat[] {
  const out: DailyStat[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(now - i * DAY).toISOString().slice(0, 10);
    // Pseudo-aléatoire déterministe (stable entre les rendus).
    const r = Math.abs(Math.sin(seed * 12.9898 + i * 78.233)) % 1;
    const weekend = [0, 6].includes(new Date(now - i * DAY).getDay()) ? 1.5 : 1;
    const sessions = Math.round(r * 20 * scale * weekend);
    // Bande passante corrélée aux sessions (~350 Mo/film) + trafic de sync.
    const bandwidthMb = Math.round(sessions * 350 + r * 800);
    out.push({ date, sessions, bandwidthMb });
  }
  return out;
}

// Littéraux « seed » avec ownerId ; le mapping ci-dessous les transpose vers le
// modèle V2 (organizationId + adresse + GPS nullable).
type SeedBooth = Omit<Booth, "organizationId" | "address" | "gpsLat" | "gpsLng" | "venueType" | "serial"> & { ownerId: string };

const SEED_BOOTHS: readonly SeedBooth[] = [
  {
    id: "booth-paris-01",
    label: "Kioskoscope — Le Perchoir",
    location: "Paris 11e · Bar Le Perchoir",
    health: "operational",
    indicators: ["powered", "in_use"],
    lastHeartbeatAt: now - 12_000,
    softwareVersion: "0.2.0",
    sessionsToday: 23,
    revenueTodayCents: 11500,
    telemetry: { uptimePct: 99.4, temperatureC: 41, storageFreePct: 62, cpuLoadPct: 34, currentFilmTitle: "Aurora", connection: "wifi", signalPct: 82 },
    logs: [
      { at: now - 12_000, level: "info", message: "Heartbeat OK" },
      { at: now - 5 * MIN, level: "info", message: "Session démarrée (unlock: mock)" },
    ],
    history: genHistory(1, 1.3),
    ownerId: "mgr-perchoir",
    notes: "",
  },
  {
    id: "booth-paris-02",
    label: "Kioskoscope — Comptoir Général",
    location: "Paris 10e · Le Comptoir Général",
    health: "attention",
    indicators: ["powered"],
    lastHeartbeatAt: now - 30_000,
    softwareVersion: "0.2.0",
    sessionsToday: 8,
    revenueTodayCents: 4000,
    telemetry: { uptimePct: 97.1, temperatureC: 47, storageFreePct: 11, cpuLoadPct: 52, currentFilmTitle: null, connection: "wifi", signalPct: 45 },
    logs: [
      { at: now - 30_000, level: "warn", message: "Stockage faible : 11% libre" },
      { at: now - 40 * MIN, level: "info", message: "Sync catalogue terminée" },
    ],
    history: genHistory(2, 0.8),
    ownerId: "mgr-comptoir",
    notes: "Prévoir purge du cache films.",
  },
  {
    id: "booth-lyon-01",
    label: "Kioskoscope — La Commune",
    location: "Lyon 7e · La Commune",
    health: "error",
    indicators: ["powered"],
    lastHeartbeatAt: now - 90_000,
    softwareVersion: "0.1.9",
    sessionsToday: 2,
    revenueTodayCents: 1000,
    telemetry: { uptimePct: 88.0, temperatureC: 55, storageFreePct: 44, cpuLoadPct: 12, currentFilmTitle: null, connection: "lte", signalPct: 61 },
    logs: [
      { at: now - 90_000, level: "error", message: "Crash lecteur : redémarrage watchdog #3" },
      { at: now - 95_000, level: "error", message: "Paiement refusé (adaptateur mock: timeout)" },
    ],
    history: genHistory(3, 0.5),
    ownerId: "mgr-commune",
    notes: "",
  },
  {
    id: "booth-lyon-02",
    label: "Kioskoscope — Hangar 14",
    location: "Lyon 2e · Hangar 14",
    health: "offline",
    indicators: [],
    lastHeartbeatAt: now - 46 * MIN,
    softwareVersion: "0.1.9",
    sessionsToday: 0,
    revenueTodayCents: 0,
    telemetry: { uptimePct: 61.2, temperatureC: 0, storageFreePct: 70, cpuLoadPct: 0, currentFilmTitle: null, connection: "lte", signalPct: 0 },
    logs: [{ at: now - 46 * MIN, level: "warn", message: "Dernier heartbeat — puis silence" }],
    history: genHistory(4, 0.6),
    ownerId: "mgr-hangar",
    notes: "Vérifier alim / réseau du lieu.",
  },
  {
    id: "booth-marseille-01",
    label: "Kioskoscope — Le Molotov",
    location: "Marseille 6e · Le Molotov",
    health: "maintenance",
    indicators: ["powered", "updating"],
    lastHeartbeatAt: now - 20_000,
    softwareVersion: "0.2.0",
    sessionsToday: 0,
    revenueTodayCents: 0,
    telemetry: { uptimePct: 98.8, temperatureC: 38, storageFreePct: 80, cpuLoadPct: 66, currentFilmTitle: null, connection: "wifi", signalPct: 73 },
    logs: [{ at: now - 20_000, level: "info", message: "Mise à jour 0.2.0 → 0.2.1 en cours (34%)" }],
    history: genHistory(5, 1.0),
    ownerId: "mgr-molotov",
    notes: "",
  },
  {
    id: "booth-nantes-01",
    label: "Kioskoscope — La Cantine",
    location: "Nantes · La Cantine du Voyage",
    health: "operational",
    indicators: ["powered"],
    lastHeartbeatAt: now - 8_000,
    softwareVersion: "0.2.0",
    sessionsToday: 15,
    revenueTodayCents: 7500,
    telemetry: { uptimePct: 99.9, temperatureC: 39, storageFreePct: 55, cpuLoadPct: 28, currentFilmTitle: null, connection: "lte", signalPct: 88 },
    logs: [{ at: now - 8_000, level: "info", message: "Heartbeat OK" }],
    history: genHistory(6, 1.1),
    ownerId: "mgr-cantine",
    notes: "",
  },
];

// Chaque ancien propriétaire = une organisation cliente (V2).
const ORG_BY_OWNER: Readonly<Record<string, string>> = {
  "mgr-perchoir": "org-perchoir",
  "mgr-comptoir": "org-comptoir",
  "mgr-commune": "org-lyon",
  "mgr-hangar": "org-lyon",
  "mgr-molotov": "org-molotov",
  "mgr-cantine": "org-cantine",
};

export const MOCK_BOOTHS: readonly Booth[] = SEED_BOOTHS.map(({ ownerId, ...b }) => ({
  ...b,
  organizationId: ORG_BY_OWNER[ownerId] ?? "org-unknown",
  address: b.location,
  gpsLat: null,
  gpsLng: null,
  venueType: null,
  serial: null,
}));

// ── Organisations, utilisateurs, appartenances (mock V2) ─────────────────────
export const MOCK_ORGS: readonly Organization[] = [
  { id: "org-perchoir", name: "Le Perchoir", type: "bar", settings: { whitelistTags: ["bar", "18+"] } },
  { id: "org-comptoir", name: "Le Comptoir Général", type: "bar", settings: { whitelistTags: ["bar"] } },
  { id: "org-lyon", name: "Collectif Lyon", type: "festival", settings: { whitelistTags: ["festival", "18+"] } },
  { id: "org-molotov", name: "Le Molotov", type: "bar", settings: { whitelistTags: ["bar"] } },
  { id: "org-cantine", name: "La Cantine du Voyage", type: "event", settings: { whitelistTags: ["event", "enfant"] } },
];

export const MOCK_USERS: readonly User[] = [
  { id: "user-admin", name: "Admin", email: "admin@kioskoscope.com", isGlobalAdmin: true },
  { id: "user-camille", name: "Camille (Le Perchoir)", email: "camille@leperchoir.fr", isGlobalAdmin: false },
];

export const MOCK_MEMBERSHIPS: readonly Membership[] = [
  { userId: "user-camille", organizationId: "org-perchoir", role: "super_user" },
];
