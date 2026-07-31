// Smoke test du RELAIS `/agent/*` du serveur local (CIN-128).
//
// Test de bout en bout, pas de simulacre : on lance le VRAI `server.mjs` dans un processus, avec
// un faux agent en face, et on parle HTTP. C'est délibéré — la leçon de BUG-020 est qu'une
// surface relue et documentée peut n'avoir jamais été exercée par son seul client réel. Ce qui est
// prouvé ici : le jeton est injecté par le serveur, il n'est JAMAIS servi à la page, et les
// requêtes malformées sont refusées avant d'atteindre un processus privilégié.
//
// Lancer : node kiosk/tests/relay_smoke.mjs

import { createServer } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("  ✗ ÉCHEC: " + msg);
    throw new Error("ÉCHEC: " + msg);
  }
  passed += 1;
  console.log("  ✓ " + msg);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server", "server.mjs");
const TOKEN = "jeton-de-test-0123456789";

/** Faux agent : renvoie ce qu'il a REÇU, pour qu'on puisse inspecter ce que le relais a envoyé. */
function startFakeAgent() {
  const seen = [];
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === "/refuse") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "jeton invalide" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sawAuth: req.headers.authorization ?? null, body }));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port }));
  });
}

/** Lance le vrai serveur local et attend qu'il réponde. */
async function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${env.KIOSK_WEB_PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/kiosk-config.json`);
      return { child, base };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  child.kill();
  throw new Error("le serveur local n'a jamais répondu");
}

/**
 * Envoie une ligne de requête HTTP BRUTE, sans passer par un client qui normaliserait l'URL.
 * C'est la seule façon d'exercer les formes qu'un attaquant écrit à la main.
 */
function rawRequest(port, requestLine) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      raw += d;
    });
    sock.on("error", reject);
    sock.on("end", () => {
      const status = Number(raw.slice(9, 12));
      resolve({ status, text: raw });
    });
  });
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "kiosk-relay-"));
  const tokenFile = join(dir, "agent.token");
  await writeFile(tokenFile, TOKEN + "\n");

  const agent = await startFakeAgent();
  const port = 18080 + (process.pid % 500);
  const { child, base } = await startServer({
    KIOSK_WEB_PORT: String(port),
    KIOSK_WEB_ROOT: dir, // aucun front déployé : sans importance, on ne teste que /agent et la config
    KIOSK_MEDIA_ROOT: dir,
    KIOSK_AGENT_URL: `http://127.0.0.1:${agent.port}`,
    KIOSK_AGENT_TOKEN_FILE: tokenFile,
    KIOSK_DEVICE_FILE: join(dir, "device-absent.json"),
  });

  try {
    console.log("\n— Contrat /kiosk-config.json —");
    {
      const res = await fetch(`${base}/kiosk-config.json`);
      const cfg = await res.json();
      assert(res.status === 200, "config servie en 200 même sans device provisionné");
      assert(cfg.agentBase === "/agent", "la config annonce le préfixe de relais");
      assert(cfg.agentReady === true, "le jeton est présent → relais annoncé opérationnel");
      // LE point du ticket : le secret ne doit apparaître NULLE PART dans ce que voit la page.
      const raw = JSON.stringify(cfg);
      assert(!raw.includes(TOKEN), "le jeton n'apparaît pas dans la config servie à la page");
      assert(!("agentToken" in cfg), "le champ `agentToken` a disparu du contrat");
      assert(!("agentUrl" in cfg), "l'adresse directe de l'agent n'est plus publiée");
      assert(cfg.deviceError && cfg.deviceError.kind === "absent", "device non provisionné : dit explicitement");
    }

    console.log("\n— Le relais injecte le jeton —");
    {
      const res = await fetch(`${base}/agent/system/os-update/status`);
      const data = await res.json();
      assert(res.status === 200, "GET relayé, statut propagé");
      assert(data.sawAuth === `Bearer ${TOKEN}`, "l'agent a bien reçu le jeton, posé par le serveur");
      const last = agent.seen[agent.seen.length - 1];
      assert(last.url === "/system/os-update/status", "la route est transmise telle quelle");
    }

    console.log("\n— POST : corps transmis, en-têtes du client ignorés —");
    {
      const res = await fetch(`${base}/agent/wifi/connect`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer JETON-FORGE", "x-contrebande": "1" },
        body: JSON.stringify({ ssid: "Chez Paul", password: "secret" }),
      });
      assert(res.status === 200, "POST relayé");
      const last = agent.seen[agent.seen.length - 1];
      assert(JSON.parse(last.body).ssid === "Chez Paul", "le corps JSON arrive intact à l'agent");
      // Une page ne doit pas pouvoir proposer son propre jeton, ni faire passer d'en-tête à un
      // processus privilégié : le serveur repose les siens et jette tout le reste.
      assert(last.headers.authorization === `Bearer ${TOKEN}`, "le jeton forgé par la page est ÉCRASÉ, pas transmis");
      assert(last.headers["x-contrebande"] === undefined, "aucun en-tête du client n'est passé en contrebande");
    }

    console.log("\n— Statut d'erreur de l'agent propagé tel quel —");
    {
      const res = await fetch(`${base}/agent/refuse`);
      assert(res.status === 401, "un refus de l'agent reste un 401 pour la page (jamais un faux succès)");
      assert((await res.json()).error === "jeton invalide", "le corps d'erreur est propagé");
    }

    console.log("\n— Routes et méthodes refusées AVANT d'atteindre l'agent —");
    {
      const before = agent.seen.length;
      // ⚠️ `fetch` NORMALISE l'URL avant de l'envoyer (`%2e%2e` → `..` → segment résolu) : passer
      // par lui testerait le client, pas le serveur. Un attaquant, lui, écrit la ligne de requête
      // à la main — donc le test aussi.
      const encoded = await rawRequest(port, "GET /agent/%2e%2e/kiosk-config.json HTTP/1.1");
      const traversal = await rawRequest(port, "GET /agent/../kiosk-config.json HTTP/1.1");
      const nul = await rawRequest(port, "GET /agent/wifi/scan%00 HTTP/1.1");
      const absolute = await rawRequest(port, "GET /agent/http://exemple.invalid/x HTTP/1.1");
      const put = await fetch(`${base}/agent/wifi/scan`, { method: "PUT" });
      const form = await fetch(`${base}/agent/wifi/scan`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "ssid=x",
      });
      // ⚠️ CONSTAT, pas préférence : `new URL()` résout `..` ET `%2e%2e` AVANT que le relais ne
      // voie le chemin — la requête sort donc de `/agent/` et retombe sur la config statique
      // (200). Ce n'est pas un contournement : elle n'atteint jamais l'agent, et depuis CIN-128
      // la config ne contient plus de secret. L'invariant testé est celui qui compte.
      assert(encoded.status === 200 && !encoded.text.includes("sawAuth"), "traversée encodée : n'atteint pas l'agent");
      assert(traversal.status === 200 && !traversal.text.includes("sawAuth"), "traversée en clair : n'atteint pas l'agent");
      assert(nul.status === 404, "octet nul dans la route : refusé");
      assert(absolute.status === 404, "URL absolue glissée dans la route : refusée");
      assert(put.status === 405, "méthode PUT : refusée");
      assert(form.status === 415, "POST non-JSON : refusé (c'est ce qui force un préflight cross-origin)");
      assert(!encoded.text.includes(TOKEN) && !traversal.text.includes(TOKEN), "aucune traversée ne ramène le jeton");
      assert(agent.seen.length === before, "AUCUNE de ces requêtes n'a atteint l'agent");
    }

    console.log("\n— Agent injoignable : 502, jamais un silence —");
    {
      await new Promise((r) => agent.srv.close(r));
      const res = await fetch(`${base}/agent/wifi/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert(res.status === 502, "agent arrêté → 502 explicite");
      assert((await res.json()).error === "agent injoignable", "le motif est dit, sans détail d'implémentation");
    }

    console.log("\n— Sans jeton : le relais ferme, la borne reste une borne —");
    {
      await rm(tokenFile);
      const res = await fetch(`${base}/agent/wifi/scan`);
      assert(res.status === 503, "jeton absent → 503 sur le relais");
      const cfg = await (await fetch(`${base}/kiosk-config.json`)).json();
      assert(cfg.agentReady === false, "la config annonce le relais inopérant…");
      assert(cfg.agentBase === "/agent", "…sans cesser d'être une config de borne (pas de retour au mode démo)");
    }
  } finally {
    child.kill();
    agent.srv.close();
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n✅ relay_smoke : ${passed} assertions vérifiées (jeton hors page + garde du relais)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
