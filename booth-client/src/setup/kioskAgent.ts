// Client de l'agent local de la borne (CIN-071, câblage booth-client → agent).
//
// Le menu opérateur pilotait des STUBS ; sur la Kiosk réelle il appelle l'agent local
// (127.0.0.1, cf. kiosk/agent/agent.mjs) qui exécute nmcli/systemctl/amixer/backlight.
//
// ⚠️ Le jeton de l'agent NE DOIT PAS être embarqué dans le bundle (sinon un contenu web
// compromis obtiendrait le privilège système — principe F17). Il est fourni AU RUNTIME
// par la couche de service locale de la borne via `/kiosk-config.json` (lu par la borne,
// hors bundle). Absent (dev navigateur) → `loadKioskConfig()` renvoie null → on retombe
// sur les stubs (WifiManager mock + réglages locaux).

import type { WifiAdapter, WifiConnectResult, WifiNetwork } from "./wifi";
import type { OperatorSettingsHooks } from "./operatorMenu";

/** Identifiants Supabase du device — fournis AU RUNTIME, jamais compilés dans le bundle. */
export interface KioskDeviceConfig {
  readonly boothId: string;
  readonly orgId: string;
  readonly deviceEmail: string;
  readonly devicePassword: string;
}

/**
 * Pourquoi la borne n'a PAS d'identifiants (BUG-017). `absent` = jamais provisionné (poste de dev) ;
 * `incomplete`/`unreadable` = quelqu'un a bien déposé un fichier de provisionnement mais il est
 * cassé → erreur de déploiement, jamais un choix. La distinction pilote le message affiché.
 */
export type KioskDeviceErrorKind = "absent" | "incomplete" | "unreadable";

export interface KioskDeviceError {
  readonly kind: KioskDeviceErrorKind;
  /** Noms des champs manquants/vides (jamais de valeur — surtout pas le mot de passe). */
  readonly missing?: readonly string[];
  readonly reason?: string;
}

export interface KioskConfig {
  readonly agentUrl: string;
  readonly agentToken: string;
  /** Creds device, servis localement par la borne. Absent = build public inerte (mock). */
  readonly device?: KioskDeviceConfig;
  /** Renseigné dès que `device` manque : dit POURQUOI. Toujours présent si `device` est absent. */
  readonly deviceError?: KioskDeviceError;
}

const DEVICE_FIELDS = ["boothId", "orgId", "deviceEmail", "devicePassword"] as const;

function parseDevice(d: unknown): KioskDeviceConfig | undefined {
  if (!d || typeof d !== "object") return undefined;
  const o = d as Record<string, unknown>;
  const ok = DEVICE_FIELDS.every((k) => typeof o[k] === "string" && (o[k] as string).trim() !== "");
  return ok
    ? { boothId: String(o.boothId), orgId: String(o.orgId), deviceEmail: String(o.deviceEmail), devicePassword: String(o.devicePassword) }
    : undefined;
}

/**
 * Normalise le `deviceError` servi par le serveur local. On ne recopie JAMAIS tel quel une chaîne
 * venue du réseau vers l'écran : `kind` est ramené à l'énumération connue et `missing` est filtré
 * sur la liste blanche des noms de champs. `reason` est borné en longueur.
 *
 * Exporté pour être testé (logique PURE, sans réseau ni DOM) — pas pour être appelé ailleurs.
 */
export function normalizeDeviceError(raw: unknown, hadDeviceBlock: boolean): KioskDeviceError {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kinds: readonly KioskDeviceErrorKind[] = ["absent", "incomplete", "unreadable"];
  const kind = kinds.find((k) => k === o.kind);
  const missing = Array.isArray(o.missing)
    ? (o.missing as unknown[]).filter((m): m is string => DEVICE_FIELDS.some((f) => f === m))
    : undefined;
  const reason = typeof o.reason === "string" ? o.reason.slice(0, 120) : undefined;
  return {
    // Serveur local d'une version antérieure (pas de `deviceError`) : un bloc `device` présent mais
    // refusé par `parseDevice` reste une configuration INCOMPLÈTE — jamais un « absent » anodin.
    kind: kind ?? (hadDeviceBlock ? "incomplete" : "absent"),
    ...(missing && missing.length > 0 ? { missing } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Charge la config locale de la borne (jeton + creds device, hors bundle). null = pas de borne (dev). */
export async function loadKioskConfig(): Promise<KioskConfig | null> {
  try {
    const res = await fetch("/kiosk-config.json", { cache: "no-store" });
    if (!res.ok) return null;
    const cfg = (await res.json()) as Record<string, unknown>;
    if (typeof cfg.agentUrl === "string" && typeof cfg.agentToken === "string") {
      const device = parseDevice(cfg.device);
      return device
        ? { agentUrl: cfg.agentUrl, agentToken: cfg.agentToken, device }
        : {
            agentUrl: cfg.agentUrl,
            agentToken: cfg.agentToken,
            deviceError: normalizeDeviceError(cfg.deviceError, cfg.device !== undefined),
          };
    }
    return null;
  } catch {
    return null;
  }
}

/** Appelle l'agent local avec le jeton Bearer. Lève en cas d'erreur réseau/HTTP. */
export class KioskAgentClient {
  constructor(private readonly cfg: KioskConfig) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.cfg.agentToken}` };
    const init: RequestInit = { method, headers };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(`${this.cfg.agentUrl}${path}`, init);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error((data.error as string) ?? `agent ${res.status}`);
    return data as T;
  }

  wifiScan(): Promise<{ networks: WifiNetwork[] }> {
    return this.call("POST", "/wifi/scan");
  }
  wifiConnect(ssid: string, password: string): Promise<{ ok: boolean }> {
    return this.call("POST", "/wifi/connect", { ssid, password });
  }
  setBrightness(pct: number): Promise<unknown> {
    return this.call("POST", "/display/brightness", { pct });
  }
  setVolume(pct: number): Promise<unknown> {
    return this.call("POST", "/audio/volume", { pct });
  }
  restart(): Promise<unknown> {
    return this.call("POST", "/power/restart");
  }
  /** MAJ OS (apt) — CIN-077. Renvoie la queue de sortie + le nb de paquets restants. */
  osUpdate(): Promise<{ ok: boolean; log?: string; pending?: number }> {
    return this.call("POST", "/system/os-update");
  }
  /** Nombre de paquets système en attente (sans rien appliquer). */
  osUpdateStatus(): Promise<{ pending: number }> {
    return this.call("GET", "/system/os-update/status");
  }

  /**
   * Médias RÉELLEMENT présents sur le disque de la borne (CIN-112 lot 1). Un échec n'est jamais
   * fatal : la borne retombe sur les URLs signées, c'est-à-dire sur le comportement d'avant.
   */
  async localMediaHashes(): Promise<ReadonlySet<string>> {
    try {
      return normalizeMediaLibrary(await this.call("GET", "/media/library"));
    } catch (e) {
      console.warn("[kiosk] bibliothèque média locale illisible :", e instanceof Error ? e.message : e);
      return new Set();
    }
  }
}

/**
 * Empreintes de la bibliothèque locale, filtrées. PURE (testée isolément).
 *
 * Ces empreintes finissent dans une URL (`/media/<hash>`) construite par la page : on n'accepte
 * donc QUE la forme attendue — 64 hexadécimaux minuscules — plutôt que d'échapper après coup.
 * Un octet de plus, un caractère de moins : l'entrée est ignorée, pas corrigée.
 */
export function normalizeMediaLibrary(raw: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  const list = (raw as { media?: unknown } | null)?.media;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o !== "object") continue;
    if (typeof o.hash !== "string" || !/^[0-9a-f]{64}$/.test(o.hash)) continue;
    // Taille absente = agent d'une version antérieure : on ne rejette pas. Taille présente et
    // nulle = fichier vide, donc pas jouable (téléchargement interrompu).
    if (typeof o.bytes === "number" && o.bytes <= 0) continue;
    out.add(o.hash);
  }
  return out;
}

/** Adaptateur Wi-Fi réel (agent) — même contrat que le mock `WifiManager`. */
export class AgentWifiAdapter implements WifiAdapter {
  private connectedSsid: string | null = null;

  constructor(private readonly client: KioskAgentClient) {}

  get current(): string | null {
    return this.connectedSsid;
  }

  async scan(): Promise<readonly WifiNetwork[]> {
    const { networks } = await this.client.wifiScan();
    return networks;
  }

  async connect(network: WifiNetwork, password: string): Promise<WifiConnectResult> {
    try {
      await this.client.wifiConnect(network.ssid, password);
      this.connectedSsid = network.ssid;
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "Échec de la connexion." };
    }
  }
}

/**
 * Réglages réels (agent). L'interface `OperatorSettingsHooks` est synchrone (le menu lit
 * la valeur pour l'afficher) : on garde une valeur en cache (défaut) et on pousse le
 * changement à l'agent en arrière-plan — l'opérateur règle en relatif.
 */
export function createAgentSettings(
  client: KioskAgentClient,
  defaults: { volume: number; brightness: number } = { volume: 70, brightness: 100 },
): OperatorSettingsHooks {
  let volume = defaults.volume;
  let brightness = defaults.brightness;
  return {
    getVolume: () => volume,
    setVolume: (v) => {
      volume = v;
      void client.setVolume(v).catch((e) => console.error("[kiosk] volume :", e));
    },
    getBrightness: () => brightness,
    setBrightness: (v) => {
      brightness = v;
      void client.setBrightness(v).catch((e) => console.error("[kiosk] luminosité :", e));
    },
    restart: () => {
      void client.restart().catch((e) => console.error("[kiosk] redémarrage :", e));
    },
  };
}
