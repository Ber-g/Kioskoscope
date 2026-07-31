// Kioskoscope — serveur local de la borne (CIN-071, couche de service front).
//
// Quatre rôles, sur 127.0.0.1 uniquement :
//   1. sert le build statique du `booth-client` à Chromium (kiosk) ;
//   2. sert `GET /kiosk-config.json` — état du provisionnement, SANS aucun secret d'agent ;
//   3. **relaie `/agent/*` vers l'agent local en injectant le jeton lui-même** (CIN-128) ;
//   4. sert les MÉDIAS du disque local (`GET /media/<sha256>`) en streaming HTTP Range —
//      c'est ce qui permet à un film de se lire réseau débranché (CIN-112 lot 1).
//
// CIN-128 — POURQUOI LE JETON NE DESCEND PLUS DANS LA PAGE. Avant, `/kiosk-config.json` le
// servait en clair et la page le portait dans chaque appel. C'était fin — le fichier n'est servi
// qu'en même origine — mais le secret vivait dans le DOM : une faille XSS du booth-client
// l'exfiltrait, et il reste valable hors de la machine. Depuis le relais, le jeton ne quitte plus
// les processus Node. Effet de bord : tout est en même origine, donc plus aucun CORS (BUG-020
// devient sans objet sur ce chemin).
// ⚠️ CE QUE ÇA NE CORRIGE PAS : une page compromise peut TOUJOURS appeler les actions système,
// elle est dans la même origine. Le gain est « le secret n'est plus copiable », rien de plus.
//
// Node natif, aucune dépendance : se déploie avec `node server.mjs`.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { serveMedia } from "../lib/media.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.KIOSK_WEB_PORT ?? 8080);
const WEB_ROOT = process.env.KIOSK_WEB_ROOT ?? "/opt/kioskoscope/booth-client/dist";
// Bibliothèque média locale (CIN-112 lot 1) — même dossier que celui inventorié par l'agent.
const MEDIA_ROOT = process.env.KIOSK_MEDIA_ROOT ?? "/var/lib/kioskoscope/media";
const AGENT_URL = process.env.KIOSK_AGENT_URL ?? "http://127.0.0.1:4599";
const TOKEN_FILE = process.env.KIOSK_AGENT_TOKEN_FILE ?? "/etc/kioskoscope/agent.token";
// Creds Supabase du device (boothId/orgId/deviceEmail/devicePassword), provisionnés en local.
// Fournis au runtime au booth-client → JAMAIS dans le bundle (un build public reste inerte).
const DEVICE_FILE = process.env.KIOSK_DEVICE_FILE ?? "/etc/kioskoscope/device.json";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".vtt": "text/vtt",
};

/** Jeton de l'agent, relu à chaque requête (suit une rotation sans redémarrage). */
function agentToken() {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

const DEVICE_FIELDS = ["boothId", "orgId", "deviceEmail", "devicePassword"];

/**
 * État du provisionnement device (BUG-017). Quatre cas VOLONTAIREMENT distincts — avant, tout
 * échec retombait sur `null` et la borne démarrait en mode démo *en silence*, indiscernable d'une
 * borne de production :
 *   - `ok`         : les 4 champs sont présents → borne de production.
 *   - `absent`     : aucun fichier → poste de développement / build public légitime (bac à sable).
 *   - `incomplete` : fichier présent mais champ(s) vide(s) ou manquant(s) → ERREUR DE DÉPLOIEMENT.
 *   - `unreadable` : fichier présent mais illisible (droits) ou JSON invalide → idem.
 *
 * `incomplete`/`unreadable` ne doivent JAMAIS pouvoir passer pour `absent` : quelqu'un a déposé un
 * fichier, donc l'intention était de provisionner une VRAIE borne. C'est un incident, pas un choix.
 *
 * ⚠️ Aucune valeur de champ ne sort d'ici en dehors du cas `ok` : on ne renvoie et on ne journalise
 * que des NOMS de champs. `devicePassword` n'est jamais exposé, même tronqué, même « masqué ».
 */
function deviceState() {
  let raw;
  try {
    raw = readFileSync(DEVICE_FILE, "utf8");
  } catch (e) {
    // ENOENT = jamais provisionné (dev). Tout autre code (EACCES, EISDIR…) = le fichier est là mais
    // hors d'atteinte : c'est un déploiement cassé, on refuse de le confondre avec un poste de dev.
    if (e && e.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: (e && e.code) || "lecture impossible" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", reason: "JSON invalide" };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "unreadable", reason: "objet JSON attendu" };
  const missing = DEVICE_FIELDS.filter((k) => typeof parsed[k] !== "string" || parsed[k].trim() === "");
  if (missing.length > 0) return { kind: "incomplete", missing };
  return {
    kind: "ok",
    device: {
      boothId: parsed.boothId,
      orgId: parsed.orgId,
      deviceEmail: parsed.deviceEmail,
      devicePassword: parsed.devicePassword,
    },
  };
}

/** Résumé journalisable d'un état device — sans aucune valeur de champ. */
function describeDeviceState(state) {
  switch (state.kind) {
    case "ok":
      return "device provisionné";
    case "absent":
      return `device NON provisionné (${DEVICE_FILE} absent) — bac à sable, aucune séance réelle`;
    case "incomplete":
      return `device INCOMPLET — champ(s) manquant(s) ou vide(s) : ${state.missing.join(", ")}`;
    default:
      return `device ILLISIBLE — ${state.reason}`;
  }
}

/**
 * Forme d'une route d'agent acceptée par le relais. Volontairement ÉTROITE : ce relais ajoute un
 * privilège système (le jeton) à une requête venue de la page. Tout ce qui n'est pas une suite de
 * segments alphanumériques est refusé — pas d'échappement, pas de `..`, pas de `//`, pas de
 * changement de schéma. On rejette la forme inattendue plutôt que d'essayer de l'assainir.
 * ⚠️ Cette contrainte s'applique au CHEMIN seul ; la query string est recopiée telle quelle.
 */
const AGENT_PATH_RE = /^\/[a-z0-9]+(?:[/-][a-z0-9]+)*$/;

/** Corps de requête accepté par le relais. Au-delà, on coupe : rien de légitime n'est si gros. */
const MAX_RELAY_BODY = 4 * 1024 * 1024;

function relayError(res, status, message) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: message }));
}

/** Lit le corps d'une requête, borné. Renvoie `null` si le plafond est dépassé. */
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_RELAY_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Relaie un appel de la page vers l'agent local en injectant le jeton (CIN-128).
 *
 * ⚠️ AUCUN en-tête du client n'est transmis. Ni `authorization` (on impose le nôtre — une page ne
 * doit pas pouvoir proposer un autre jeton), ni le reste (pas de contrebande d'en-têtes vers un
 * processus privilégié). Seul `content-type` est reposé, et seulement en `application/json` :
 * c'est aussi ce qui force un préflight CORS sur toute tentative venue d'une autre origine, donc
 * ce qui empêche une page tierce de déclencher une action système en aveugle.
 */
async function relayToAgent(req, res, route) {
  const token = agentToken();
  if (!token) return relayError(res, 503, "agent indisponible sur cette borne");
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end();
    return;
  }
  const path = route === "" ? "/" : route;
  if (!AGENT_PATH_RE.test(path)) return relayError(res, 404, "route inconnue");
  if (req.method === "POST") {
    const ctype = String(req.headers["content-type"] ?? "");
    if (!ctype.startsWith("application/json")) return relayError(res, 415, "corps JSON attendu");
  }

  let body;
  if (req.method === "POST") {
    body = await readBody(req);
    if (body === null) return relayError(res, 413, "corps trop volumineux");
  }

  const query = (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?")) : "";
  const headers = { authorization: `Bearer ${token}` };
  if (req.method === "POST") headers["content-type"] = "application/json";

  let upstream;
  try {
    upstream = await fetch(`${AGENT_URL}${path}${query}`, { method: req.method, headers, body });
  } catch (e) {
    // L'agent est arrêté / en train de redémarrer : c'est un fait NORMAL sur une borne, pas une
    // erreur du serveur web. 502 le dit, et le message reste sans détail d'implémentation.
    console.warn(`[web] relais agent injoignable (${path}) : ${e && e.message}`);
    return relayError(res, 502, "agent injoignable");
  }

  // Statut et corps propagés tels quels : la page doit voir le refus de l'agent (401, 400…)
  // exactement comme s'il lui répondait — sinon on lui ferait croire à un succès.
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body).pipe(res);
}

// On NE refuse PAS de démarrer sur un device incomplet, et c'est délibéré : sans serveur local,
// Chromium affiche une page d'erreur réseau du navigateur — illisible, non traduite, et surtout
// elle emporte AUSSI le menu opérateur (Wi-Fi, réglages, redémarrage). Or c'est précisément par ce
// menu qu'on rattrape une borne mal déployée sur place. On sert donc la config avec un bloc
// `deviceError` explicite : le booth-client affiche un diagnostic PLEIN ÉCRAN et n'ouvre aucune
// séance. La borne reste administrable, mais elle ne peut plus faire semblant d'être en production.
let lastLoggedDeviceKind = "";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  let path = decodeURIComponent(url.pathname);

  // Config borne : jeton au runtime, hors bundle, non caché, même origine seulement.
  if (path === "/kiosk-config.json") {
    const token = agentToken();
    const state = deviceState();
    // Journalisé au CHANGEMENT d'état seulement (une borne recharge sa page : pas de spam de log).
    if (state.kind !== lastLoggedDeviceKind) {
      lastLoggedDeviceKind = state.kind;
      const line = `[web] ${describeDeviceState(state)}`;
      if (state.kind === "ok" || state.kind === "absent") console.info(line);
      else console.error(line);
    }
    // ⚠️ 200 MÊME SANS JETON D'AGENT — correction d'un couplage dangereux (CIN-128). Avant, un
    // jeton absent renvoyait 503, le client lisait `null`, et la borne se croyait alors sur un
    // POSTE DE DÉVELOPPEMENT : pas de verrouillage kiosque, creds device ignorés, catalogue de
    // démonstration. Un agent mal provisionné transformait donc une borne de production en borne
    // de démo — la classe BUG-011/BUG-017, atteinte par un tout autre chemin. Le jeton de l'agent
    // et l'identité de la borne sont deux faits INDÉPENDANTS : ils se répondent séparément.
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify({
        // Le client appelle l'agent par ce préfixe, en MÊME ORIGINE. Aucun jeton ne descend ici.
        agentBase: "/agent",
        // `false` = relais inopérant (jeton absent) : le menu opérateur retombe sur ses stubs,
        // mais la borne reste une borne (verrouillage, creds device, catalogue réel).
        agentReady: Boolean(token),
        // `device` OU `deviceError` — jamais rien d'implicite : le client ne doit pas avoir à
        // déduire d'une absence de champ s'il est sur un poste de dev ou sur une borne cassée.
        ...(state.kind === "ok"
          ? { device: state.device }
          : {
              deviceError: {
                kind: state.kind,
                ...(state.missing ? { missing: state.missing } : {}),
                ...(state.reason ? { reason: state.reason } : {}),
              },
            }),
      }),
    );
    return;
  }

  // Relais vers l'agent local (CIN-128) : `/agent/<route>` → `AGENT_URL/<route>`, jeton injecté ici.
  if (path === "/agent" || path.startsWith("/agent/")) {
    await relayToAgent(req, res, path.slice("/agent".length));
    return;
  }

  // Média local (CIN-112) : `<video src="/media/<sha256>">`. Servi en streaming Range depuis le
  // disque de la borne — aucune URL signée, aucun réseau, donc aucune expiration possible.
  // Placé AVANT le statique : `/media/…` ne doit jamais tomber dans le repli SPA (qui renverrait
  // un `index.html` en guise de vidéo, et un lecteur qui échoue sans rien dire).
  if (path.startsWith("/media/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    await serveMedia(req, res, path.slice("/media/".length), MEDIA_ROOT);
    return;
  }

  // Statique : anti-traversal (le chemin résolu doit rester sous WEB_ROOT).
  if (path === "/" || path === "") path = "/index.html";
  const file = join(WEB_ROOT, normalize(path));
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + "/")) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    // Repli SPA : toute route inconnue → index.html.
    try {
      const idx = await readFile(join(WEB_ROOT, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(idx);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }
});

server.listen(PORT, HOST, () => {
  console.info(`[web] Kioskoscope front sur http://${HOST}:${PORT} (racine ${WEB_ROOT}, médias ${MEDIA_ROOT})`);
  // État du provisionnement dit AU DÉMARRAGE : un exploitant qui branche un écran/ssh voit
  // immédiatement pourquoi sa borne ne propose rien, sans avoir à ouvrir la console du navigateur.
  const state = deviceState();
  lastLoggedDeviceKind = state.kind;
  const line = `[web] ${describeDeviceState(state)}`;
  if (state.kind === "ok" || state.kind === "absent") console.info(line);
  else console.error(line);
});
