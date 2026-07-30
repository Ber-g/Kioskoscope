// Kioskoscope — agent local de la borne (CIN-071 / base système, F17).
//
// Rôle : exposer au menu opérateur (booth-client, dans Chromium) les actions SYSTÈME
// réelles — Wi-Fi, alimentation, luminosité, infos machine — et appliquer les mises à
// jour de l'OS sur commande (patch de sécurité piloté back-office, CIN-077).
// Il inventorie aussi les MÉDIAS présents sur le disque (CIN-112) : la page web n'a aucun
// accès au disque, l'agent si — c'est par lui que passe toute la chaîne hors-ligne.
//
// ─ Modèle de sécurité (non négociable @qa) ─────────────────────────────────────
// • L'agent écoute UNIQUEMENT sur 127.0.0.1 : inatteignable depuis le réseau.
// • Toute requête exige un jeton Bearer (fichier /etc/kioskoscope/agent.token, 0600).
//   → une compromission de la web-app (qui NE connaît PAS ce jeton) ne donne pas la main
//     sur le système ; c'est le booth-client de confiance, provisionné, qui le porte.
// • Les commandes système passent par `execFile` (JAMAIS de shell) avec des arguments
//   validés → pas d'injection. Les binaires privilégiés sont en liste blanche sudoers.
// • Chaque action est journalisée (qui/quoi/quand) pour remontée back-office.
//
// Volontairement sans dépendances (http/child_process natifs) : se déploie avec un
// simple `node agent.mjs`, pas de build ni de node_modules sur la borne.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { scanMediaLibrary } from "../lib/media.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.KIOSK_AGENT_PORT ?? 4599);
const TOKEN_FILE = process.env.KIOSK_AGENT_TOKEN_FILE ?? "/etc/kioskoscope/agent.token";
const LOG_FILE = process.env.KIOSK_AGENT_LOG ?? "/var/log/kioskoscope-agent.log";
const BACKLIGHT = process.env.KIOSK_BACKLIGHT ?? "/sys/class/backlight/intel_backlight";
// Bibliothèque média locale (CIN-112 lot 1) : les fichiers réellement présents sur le disque
// de la borne. Partagée avec le serveur local, qui les SERT (`GET /media/<hash>`).
const MEDIA_ROOT = process.env.KIOSK_MEDIA_ROOT ?? "/var/lib/kioskoscope/media";

/** Jeton partagé (fichier 0600). Absent ⇒ l'agent refuse de démarrer (fail-closed). */
function loadToken() {
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length < 16) throw new Error("jeton trop court");
    return t;
  } catch (e) {
    console.error(`[agent] jeton illisible (${TOKEN_FILE}) : ${e.message}. Arrêt.`);
    process.exit(1);
  }
}
const TOKEN = loadToken();

function journal(action, detail) {
  const line = JSON.stringify({ at: new Date().toISOString(), action, detail }) + "\n";
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    /* le journal ne doit jamais faire tomber l'agent */
  }
}

/** Exécute un binaire SANS shell (arguments = tableau). Rejette si code ≠ 0. */
function run(cmd, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message));
      else resolve(stdout.toString());
    });
  });
}

// ─ Validation d'entrées ────────────────────────────────────────────────────────
const isStr = (v, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max;
const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

// ─ Bibliothèque média locale (CIN-112 lot 1) ───────────────────────────────────
//
// Un fichier est nommé par son empreinte : `<sha256 minuscule>.<mp4|webm>`. C'est la MÊME
// empreinte que `media.content_hash` en base (calculée à l'upload back-office), donc la borne
// peut rapprocher son catalogue de son disque sans rien demander au réseau.
//
// L'inventaire lui-même vit dans `kiosk/lib/media.mjs` : le serveur local, qui SERT ces fichiers,
// doit partager exactement la même liste blanche d'extensions (cf. l'en-tête de ce module).
async function mediaLibrary() {
  return { root: MEDIA_ROOT, media: await scanMediaLibrary(MEDIA_ROOT) };
}

// ─ Actions système (chacune = une commande en liste blanche) ────────────────────
const actions = {
  async systemInfo() {
    const [host, uptime, disk, osVer, wifi] = await Promise.all([
      run("hostname", []).catch(() => ""),
      run("uptime", ["-p"]).catch(() => ""),
      run("df", ["-h", "--output=size,used,avail,pcent", "/"]).catch(() => ""),
      run("lsb_release", ["-ds"]).catch(() => ""),
      run("nmcli", ["-t", "-f", "ACTIVE,SSID", "dev", "wifi"]).catch(() => ""),
    ]);
    const current = wifi.split("\n").find((l) => l.startsWith("yes:"))?.slice(4) ?? null;
    return {
      hostname: host.trim(),
      uptime: uptime.trim(),
      os: osVer.trim().replace(/^"|"$/g, ""),
      disk: disk.trim(),
      wifiCurrent: current,
    };
  },

  async wifiScan() {
    const out = await run("nmcli", ["-t", "-f", "SSID,SIGNAL,SECURITY", "dev", "wifi", "list", "--rescan", "yes"]);
    const seen = new Set();
    const networks = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [ssid, signal, security] = line.split(":");
      if (!ssid || seen.has(ssid)) continue;
      seen.add(ssid);
      networks.push({ ssid, signalPct: Number(signal) || 0, secured: (security ?? "").trim() !== "" });
    }
    return { networks };
  },

  async wifiConnect(body) {
    if (!isStr(body?.ssid, 64)) throw new Error("ssid invalide");
    const args = ["dev", "wifi", "connect", body.ssid];
    if (isStr(body.password, 128)) args.push("password", body.password);
    await run("nmcli", args, { timeoutMs: 40_000 });
    journal("wifi_connect", body.ssid); // jamais le mot de passe
    return { ok: true };
  },

  async displayBrightness(body) {
    const pct = clampPct(body?.pct);
    // `max_brightness` lu, puis écriture via helper sudo (pas d'accès sysfs direct).
    const max = Number((await run("cat", [`${BACKLIGHT}/max_brightness`])).trim()) || 100;
    const value = Math.round((pct / 100) * max);
    await run("sudo", ["/usr/local/sbin/kiosk-brightness", String(value)]);
    journal("brightness", String(pct));
    return { ok: true, pct };
  },

  async audioVolume(body) {
    // Volume de session (ALSA Master) — pas de privilège (session audio de l'utilisateur).
    const pct = clampPct(body?.pct);
    await run("amixer", ["-q", "sset", "Master", `${pct}%`]);
    journal("volume", String(pct));
    return { ok: true, pct };
  },

  async powerRestart() {
    journal("restart", "kiosk-service");
    // Redémarre l'app kiosk, pas la machine (moins brutal). Reboot complet = /power/reboot.
    await run("sudo", ["/usr/bin/systemctl", "restart", "kioskoscope-kiosk.service"]);
    return { ok: true };
  },

  async powerReboot() {
    journal("reboot", "machine");
    await run("sudo", ["/usr/bin/systemctl", "reboot"]);
    return { ok: true };
  },

  async osUpdateStatus() {
    const list = await run("apt-get", ["-s", "upgrade"]).catch(() => "");
    const pending = (list.match(/^Inst /gm) ?? []).length;
    return { pending };
  },

  async osUpdate() {
    // MAJ OS pilotée back-office (CIN-077) : patch de sécurité. Liste blanche sudoers.
    journal("os_update", "start");
    await run("sudo", ["/usr/bin/apt-get", "update"], { timeoutMs: 120_000 });
    const out = await run("sudo", ["/usr/bin/apt-get", "-y", "upgrade"], { timeoutMs: 600_000 });
    journal("os_update", "done");
    // Queue de sortie apt (remontée telle quelle au back-office par le relais device).
    const tail = String(out).split("\n").slice(-40).join("\n").trim();
    const { pending } = await this.osUpdateStatus().catch(() => ({ pending: 0 }));
    return { ok: true, log: tail, pending };
  },
};

// ─ Routage ──────────────────────────────────────────────────────────────────────
const ROUTES = {
  "GET /health": () => ({ ok: true }),
  "GET /system/info": () => actions.systemInfo(),
  "POST /wifi/scan": () => actions.wifiScan(),
  "POST /wifi/connect": (b) => actions.wifiConnect(b),
  "POST /display/brightness": (b) => actions.displayBrightness(b),
  "POST /audio/volume": (b) => actions.audioVolume(b),
  "POST /power/restart": () => actions.powerRestart(),
  "POST /power/reboot": () => actions.powerReboot(),
  "GET /system/os-update/status": () => actions.osUpdateStatus(),
  "POST /system/os-update": () => actions.osUpdate(),
  "GET /media/library": () => mediaLibrary(),
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy(); // garde-fou
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  // Auth : jeton Bearer obligatoire (sauf /health, utile pour le watchdog local).
  const key = `${req.method} ${req.url}`;
  if (key !== "GET /health") {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${TOKEN}`) return send(401, { error: "non autorisé" });
  }

  const handler = ROUTES[key];
  if (!handler) return send(404, { error: "route inconnue" });

  const body = req.method === "POST" ? await readBody(req) : {};
  if (body === null) return send(400, { error: "JSON invalide" });

  try {
    send(200, await handler(body));
  } catch (e) {
    journal("error", `${key}: ${e.message}`);
    send(500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.info(`[agent] Kioskoscope agent local sur http://${HOST}:${PORT} (jeton requis)`);
});
