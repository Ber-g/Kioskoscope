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
  /**
   * Préfixe d'appel de l'agent, en MÊME ORIGINE (CIN-128). Le serveur local relaie et injecte
   * le jeton lui-même : plus aucun secret ne descend dans la page, et il n'y a plus de CORS.
   */
  readonly agentBase: string;
  /** `false` = pas de jeton sur la borne → le relais répondra 503. La borne reste une borne. */
  readonly agentReady: boolean;
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

/**
 * Interprète la réponse de `/kiosk-config.json`. PURE (testée sans réseau).
 *
 * `null` = on n'est PAS sur une borne (dev navigateur : le fichier n'existe pas). Tout le reste
 * de l'application en dépend — verrouillage kiosque, creds device, catalogue réel — d'où la
 * règle : ne renvoyer `null` que lorsque la réponse ne ressemble pas du tout à une borne.
 *
 * ⚠️ Un serveur local ANTÉRIEUR à CIN-128 sert `agentUrl` + `agentToken` et ignore `agentBase`.
 * On le reconnaît et on le traite comme une borne SANS relais (`agentReady: false`) plutôt que
 * comme un poste de dev : mieux vaut une borne dont le menu opérateur retombe sur ses stubs
 * qu'une borne de production qui se croit en bac à sable. Le jeton qu'il envoie est IGNORÉ — on
 * ne le recopie nulle part, c'est tout l'objet du ticket.
 */
export function parseKioskConfig(raw: unknown): KioskConfig | null {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const modern = typeof cfg.agentBase === "string" && cfg.agentBase.startsWith("/");
  const legacy = typeof cfg.agentUrl === "string";
  if (!modern && !legacy) return null;
  const device = parseDevice(cfg.device);
  return {
    agentBase: modern ? String(cfg.agentBase) : "/agent",
    agentReady: modern ? cfg.agentReady === true : false,
    ...(device ? { device } : { deviceError: normalizeDeviceError(cfg.deviceError, cfg.device !== undefined) }),
  };
}

/** Charge la config locale de la borne (creds device + relais agent). null = pas de borne (dev). */
export async function loadKioskConfig(): Promise<KioskConfig | null> {
  try {
    const res = await fetch("/kiosk-config.json", { cache: "no-store" });
    if (!res.ok) return null;
    return parseKioskConfig(await res.json());
  } catch {
    return null;
  }
}

/**
 * Appelle l'agent local À TRAVERS le serveur local (CIN-128). Lève en cas d'erreur réseau/HTTP.
 *
 * Cette classe ne connaît AUCUN secret : c'est le serveur local qui pose le jeton. Une faille XSS
 * dans le booth-client peut donc déclencher les mêmes actions (même origine), mais elle ne repart
 * avec rien de réutilisable ailleurs. Ne pas vendre ce gain pour plus qu'il n'est.
 */
export class KioskAgentClient {
  constructor(private readonly cfg: KioskConfig) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const init: RequestInit = { method, headers };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(`${this.cfg.agentBase}${path}`, init);
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

  /**
   * Instantané du dernier catalogue valide, relu sur le disque (CIN-112 lot 2).
   * `null` = jamais écrit, illisible, ou agent d'une version antérieure — tous équivalents pour
   * l'appelant : il n'y a pas de catalogue de secours, la borne sera vide et honnête.
   */
  async loadCatalogSnapshot(): Promise<unknown | null> {
    try {
      const res = await this.call<{ snapshot?: unknown }>("GET", "/state/catalog");
      return res.snapshot ?? null;
    } catch (e) {
      console.warn("[kiosk] catalogue de secours illisible :", e instanceof Error ? e.message : e);
      return null;
    }
  }

  /**
   * Persiste le catalogue courant pour le prochain démarrage hors ligne. Fire-and-forget : un
   * échec ne doit JAMAIS gêner un visiteur présent — au pire le prochain boot hors ligne est vide.
   * ⚠️ L'agent repose SON horodatage : celui qu'on enverrait d'ici ne serait pas retenu (une page
   * compromise se donnerait sinon une fenêtre hors-ligne illimitée).
   */
  async saveCatalogSnapshot(payload: { orgId: string; boothId: string; films: readonly unknown[] }): Promise<boolean> {
    try {
      await this.call("POST", "/state/catalog", { version: 1, ...payload });
      return true;
    } catch (e) {
      console.warn("[kiosk] catalogue de secours non enregistré :", e instanceof Error ? e.message : e);
      return false;
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
