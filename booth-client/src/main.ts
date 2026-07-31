import "./styles.css";
import { applyOrgStyle } from "./styles/orgStyle";
import { setBrand } from "./domain/brand";
import { initAccessibility } from "./setup/accessibility";
import { RuleBasedRecommender } from "./reco/RuleBasedRecommender";
import { SessionManager } from "./session/SessionManager";
import { MockUnlockAdapter } from "./unlock/MockUnlockAdapter";
import { BoothBackend } from "./data/backend";
import { SessionJournal } from "./data/sessionJournal";
import { setCatalog } from "./domain/catalog";
import { restoreOfflineCatalog, describeOfflineCatalog } from "./domain/offlineCatalog";
import type { Film, Play, Session } from "./domain/types";
import { App } from "./ui/app";
import { showBoothStatus } from "./ui/boothStatus";
import { WifiManager, type WifiAdapter } from "./setup/wifi";
import { AgentWifiAdapter, KioskAgentClient, createAgentSettings, loadKioskConfig } from "./setup/kioskAgent";
import { enableKioskLockdown } from "./setup/kioskLockdown";
import {
  EncryptedAccessStore,
  LocalStorageAccessJournal,
  LocalStorageAccessStore,
  seedDemoAccessTable,
  type AccessStore,
} from "./setup/accessCache";
import { OperatorMenu, type OperatorSettingsHooks } from "./setup/operatorMenu";

// Point d'entrée. C'est ICI, et nulle part ailleurs, qu'on choisit les implémentations
// concrètes (déverrouillage, reco) et qu'on branche — ou non — le backend Supabase :
// - config VITE présente (.env) → catalogue RÉEL de l'org + remontée des séances/plays.
// - sinon → catalogue factice + sessions en mémoire (parcours testable hors ligne).

const FALLBACK_BOOTH_ID = "booth-proto-01";
const FALLBACK_ORG_ID = "org-perchoir";
const BOOTH_VERSION = "0.3.0-proto"; // version logicielle de la Kiosk (remontée en heartbeat)

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("Élément #app introuvable");

  // F13 — direction visuelle. La borne est « salle obscure » : thème sombre par défaut
  // (le système de tokens porte aussi clair + haute visibilité, activables via data-theme/
  // data-contrast). Style d'org appliqué plus bas une fois le backend connu (F19) ; par
  // défaut = maître Kioskoscope.
  document.documentElement.dataset.theme ||= "dark";
  applyOrgStyle();
  // A11y : restaure le mode haute visibilité si l'opérateur l'a déjà activé (data-contrast).
  initAccessibility();

  // Config borne au RUNTIME (jeton agent + creds device), fournie par le serveur local
  // via /kiosk-config.json — jamais dans le bundle. Absente (dev/déploiement public) → mock.
  const kioskConfig = await loadKioskConfig();
  // Verrouillage kiosque (CIN-072) : dès qu'on tourne sur une borne réelle (agent présent),
  // on neutralise menu contextuel / sélection / raccourcis d'évasion. Jamais en dev navigateur.
  if (kioskConfig) enableKioskLockdown();
  // Agent local : créé ICI (et non plus au moment du menu opérateur) parce que le catalogue en a
  // besoin dès le boot — c'est lui qui sait ce qu'il y a sur le disque. Une seule instance, réutilisée.
  // CIN-128 : le client d'agent n'existe que si le RELAIS est opérationnel (jeton présent côté
  // serveur local). Une borne sans jeton reste une borne — verrouillage et creds device inchangés,
  // seul le menu opérateur retombe sur ses stubs. Ces deux faits sont désormais indépendants.
  const agent = kioskConfig?.agentReady ? new KioskAgentClient(kioskConfig) : null;
  if (kioskConfig && !kioskConfig.agentReady) {
    console.error("[kiosk] agent local indisponible (jeton absent) — réglages système inopérants, borne néanmoins active.");
  }
  /**
   * Médias présents sur le DISQUE de la borne (CIN-112 lot 1). Relu à chaque rafraîchissement :
   * un média approvisionné pendant la journée devient jouable sans redémarrer la borne.
   * Hors borne (dev navigateur) : ensemble vide → tout passe par les URLs signées, comme avant.
   */
  const readLocalMedia = async (): Promise<ReadonlySet<string>> => (agent ? agent.localMediaHashes() : new Set<string>());
  const backend = new BoothBackend(kioskConfig?.device);
  /**
   * Enregistre le catalogue jouable pour le prochain boot hors ligne (CIN-112 lot 2).
   * Fire-and-forget, et volontairement : un visiteur est peut-être devant la borne à cet instant.
   */
  const persistCatalogSnapshot = async (films: readonly Film[]): Promise<void> => {
    if (!agent || !backend.isConfigured) return;
    // CIN-098 : on estampille l'instantané avec l'identité RÉSOLUE par le serveur, pas avec celle
    // du fichier de config. Les deux ne divergent que si le provisionnement a dérivé — et dans ce
    // cas, au prochain boot hors ligne, le rapprochement échouera (catalogue vide + bandeau) au
    // lieu de servir le catalogue d'une AUTRE org. Un refus visible vaut mieux qu'une confusion.
    await agent.saveCatalogSnapshot({ orgId: backend.organizationId, boothId: backend.boothId, films });
  };
  let boothId = FALLBACK_BOOTH_ID;
  let organizationId = FALLBACK_ORG_ID;
  let online = false;
  let sink: ((s: { session: Session; plays: readonly Play[] }) => void) | undefined;
  // F9 résilience : sur une VRAIE borne (creds présents), on ne perd JAMAIS une séance/paiement même
  // hors ligne — on bufferise en localStorage et on rejoue à la reconnexion. Absent en dev/mock.
  const sessionJournal = backend.isConfigured ? new SessionJournal() : undefined;

  // CIN-098 / BUG-007 : `init()` ne répond plus par oui/non mais par un MOTIF, utilisé plus bas
  // pour que le bandeau dise laquelle des trois pannes s'est produite.
  const initResult = backend.isConfigured ? await backend.init() : null;
  if (initResult?.ok) {
    online = true;
    boothId = backend.boothId;
    organizationId = backend.organizationId;
    await backend.reportHeartbeat(BOOTH_VERSION); // remonte version + dernier contact
    await backend.applyPendingUpdates(BOOTH_VERSION); // updater : applique les déploiements dus
    const films = await backend.loadCatalog(await readLocalMedia());
    const blocked = await backend.loadBlockedMedia(); // droits F15 : exclure expiré / au plafond
    const playable = films.filter((f) => !blocked.has(f.id));
    // En ligne, le catalogue = la RÉALITÉ de l'org, même VIDE. On ne retombe JAMAIS sur les films
    // de démo pour une vraie org sans média (sinon on montrerait du faux contenu / on ferait payer
    // pour rien). L'écran d'attente affiche un état « aucune séance » si vide (cf. app.ts goIdle).
    setCatalog(playable);
    // CIN-112 lot 2 : on enregistre CE catalogue — déjà filtré par les droits (CIN-010) — pour le
    // prochain démarrage sans réseau. Sur le disque via l'agent, pas en `localStorage` : un vidage
    // de cache Chromium emporterait l'état, et la borne redeviendrait muette sans raison visible.
    void persistCatalogSnapshot(playable);
    // F19 : style de l'org (Mes styles). La palette/les fontes → tokens CSS (applyOrgStyle) ;
    // le titre + les assets → contenu de marque (setBrand, lu par l'écran d'attente). Absent =
    // maître (déjà appliqué au boot).
    const orgStyle = await backend.loadOrgStyle();
    applyOrgStyle(orgStyle ?? undefined);
    if (orgStyle) {
      setBrand({
        ...(orgStyle.title ? { title: orgStyle.title } : {}),
        idleImageUrl: orgStyle.assets?.idleImage ?? null,
        logoUrl: orgStyle.assets?.logoDark ?? orgStyle.assets?.logoLight ?? null,
      });
    }
    // Drain des séances bufferisées hors ligne (rejeu idempotent par id stable) : on ne retire du
    // journal que ce qui est effectivement remonté → zéro perte, zéro double-comptage.
    if (sessionJournal) {
      const pending = sessionJournal.peek();
      let drained = 0;
      for (const p of pending) {
        if (await backend.saveSession({ session: p.session, plays: p.plays }, p.id)) {
          sessionJournal.remove(p.id);
          drained += 1;
        }
      }
      if (pending.length > 0) console.info(`[booth] séances hors-ligne rejouées : ${drained}/${pending.length}`);
    }
    console.info(
      `[booth] branché Supabase · org ${organizationId} · ${playable.length} film(s)` +
        (blocked.size > 0 ? ` (${blocked.size} exclu(s) : droits/plafond)` : ""),
    );
  } else if (initResult && !initResult.ok && (initResult.reason === "auth-failed" || initResult.reason === "unlinked-device")) {
    // BORNE RÉELLE QUE LE SERVEUR A REFUSÉE (BUG-007 / CIN-098). Ce n'est PAS le cas hors ligne :
    // le serveur a répondu, et il a dit non. Deux formes : identifiants device rejetés, ou compte
    // device rattaché à aucune borne (`booths.device_user_id` vide).
    //
    // On ne restaure PAS le catalogue hors ligne ici, contrairement à la coupure réseau. Une
    // coupure se répare toute seule : les séances bufferisées repartiront. Un refus, non — rien ne
    // remontera JAMAIS. Servir des films dans cet état, c'est encaisser des séances qui
    // n'existeront dans aucune comptabilité. Catalogue vide, et on dit pourquoi.
    setCatalog([]);
    const refused = initResult.reason === "auth-failed";
    showBoothStatus({
      level: "fault",
      title: refused ? "Borne refusée" : "Borne non rattachée",
      // CIN-129 : ce message ENVOYAIT VERS UN ÉCRAN QUI N'EXISTE PAS. Mesuré le 2026-07-31 —
      // `device_user_id` n'apparaît nulle part dans `admin-dashboard/src`. Le rattachement est,
      // par conception, une opération de PROVISIONNEMENT de flotte (recette R1, en SQL), et non
      // une action d'exploitant : autoriser une org à rattacher un compte device arbitraire à
      // une borne serait une porte d'escalade entre organisations. Le message dit donc ce qui est
      // vrai — une panne de provisionnement, à traiter par celui qui provisionne.
      detail: refused
        ? "Le serveur a rejeté les identifiants de cette borne. Aucune séance ne peut être proposée tant que le provisionnement n'est pas refait."
        : "Le compte de cette borne n'est rattaché à aucune borne enregistrée. C'est une erreur de provisionnement : contactez le support, cette borne ne peut pas se réparer seule.",
      // Noms d'états seulement — jamais un identifiant ni un fragment de secret (F17).
      code: `device · ${initResult.reason}`,
    });
    console.error(`[booth] démarrage refusé par le serveur (${initResult.reason}) — catalogue VIDÉ : ${initResult.detail}`);
  } else if (backend.isConfigured) {
    // BORNE RÉELLE dont le backend n'a pas répondu (réseau coupé, Supabase injoignable).
    //
    // ⚠️ Le catalogue d'exécution démarre sur `FACTICE_CATALOG` (catalog.ts) : sans cette
    // branche, personne n'appelle `setCatalog` et la borne propose des films de DÉMONSTRATION —
    // titres inventés, `storageUrl: null` donc lecture simulée. Un visiteur pouvait donc payer
    // une séance pour regarder un film qui n'existe pas. On vide donc le catalogue : l'écran
    // d'attente bascule sur « aucune séance disponible » (idleScreen `hasFilms=false`) et ne
    // propose même pas de déverrouiller — pas de paiement possible, donc pas de déception.
    //
    // Un catalogue VIDE est un état honnête ; un catalogue FAUX ne l'est jamais. Même règle que
    // pour une org réelle sans média (cf. commentaire `setCatalog(playable)` ci-dessus).
    //
    // CIN-112 lot 2 — MAIS on ne part plus forcément de rien : si la borne a déjà été en ligne,
    // l'agent détient le dernier catalogue valide sur le disque. On le restaure, INTERSECTÉ avec
    // les médias réellement présents (lot 1). La règle reste celle de BUG-011 : ce qui est proposé
    // doit être projetable — un film restauré dont le fichier n'est pas là ne réapparaît jamais.
    //
    // Prudence assumée sur les droits (cf. `offlineCatalog.ts`) : hors ligne, la borne ne peut
    // réévaluer ni les licences ni les plafonds. Passé la fenêtre de confiance — ou si l'horloge
    // a reculé — le catalogue redevient VIDE. Dans le doute, on ne joue pas.
    const restored = restoreOfflineCatalog({
      snapshot: agent ? await agent.loadCatalogSnapshot() : null,
      localMedia: await readLocalMedia(),
      orgId: backend.organizationId,
      now: Date.now(),
    });
    setCatalog(restored.films);
    const diagnostic = describeOfflineCatalog(restored);
    if (restored.reason === "restored") {
      // Ça marche : le bandeau parle à l'exploitant (« répare le réseau quand tu peux »), pas au
      // visiteur — dont le parcours est, lui, parfaitement normal.
      showBoothStatus({
        level: "offline",
        title: "Hors ligne",
        detail: "La borne fonctionne avec son catalogue enregistré. Les séances seront remontées à la reconnexion.",
        code: `films: ${restored.films.length}${restored.missingLocally > 0 ? ` · absents du disque: ${restored.missingLocally}` : ""}`,
      });
      console.warn(`[booth] backend injoignable — ${diagnostic}`);
    } else {
      // Rien à proposer : l'écran d'attente dit « aucune séance » au public, et le bandeau dit
      // POURQUOI à qui est sur place. Sans ça, une borne muette est indiscernable d'une borne en panne.
      showBoothStatus({
        level: "fault",
        title: "Hors ligne — aucune séance",
        detail: diagnostic.charAt(0).toUpperCase() + diagnostic.slice(1) + ".",
        code: `offline · ${restored.reason}`,
      });
      console.warn(`[booth] backend injoignable — catalogue VIDE : ${diagnostic}`);
    }
  } else if (kioskConfig) {
    // ⚠️ TROISIÈME PORTE (BUG-017) — AGENT LOCAL PRÉSENT + AUCUN IDENTIFIANT DEVICE.
    //
    // C'est une VRAIE borne mal déployée : le serveur local de la borne répond, le verrouillage
    // kiosque vient d'être activé (l'app est plein écran, inéchappable)… mais aucun compte device.
    // `backend.isConfigured` est faux, donc AUCUNE des deux branches ci-dessus ne s'exécutait et
    // le catalogue restait sur FACTICE_CATALOG : la borne servait « Vertige » & co, films inventés
    // sans fichier, à des visiteurs payants. Le seul signal était un console.info que personne ne
    // lit sur une machine sans clavier.
    //
    // DÉCISION : le bandeau ne suffit PAS, on refuse aussi le catalogue factice. Le bac à sable
    // n'a de sens que là où quelqu'un peut le reconnaître comme tel — devant un écran de dev. Dès
    // que l'agent local est là, la machine est en exploitation : y afficher des films de démo,
    // même estampillés, c'est offrir un bouton « payer » sur du vide. Un bandeau seul laisserait
    // le parcours d'achat ouvert derrière lui.
    //
    // Les deux ensemble, donc : catalogue vidé (→ écran « aucune séance disponible », pas de
    // déverrouillage possible, même règle que BUG-011) + diagnostic à l'écran pour que la
    // personne sur place sache que c'est réparable et comment le dire.
    setCatalog([]);
    const err = kioskConfig.deviceError;
    const isBroken = err?.kind === "incomplete" || err?.kind === "unreadable";
    showBoothStatus({
      level: "fault",
      title: "Borne non configurée",
      // Deux registres : `incomplete`/`unreadable` = quelqu'un a provisionné et ça a raté (le plus
      // grave, ça se répare tout de suite) ; `absent` = jamais provisionné.
      detail: isBroken
        ? "Les identifiants de cette borne sont incomplets ou illisibles. Aucune séance ne peut être proposée tant que le provisionnement n'est pas refait."
        : "Cette borne n'a pas encore été provisionnée. Aucune séance ne peut être proposée.",
      // Dictable au téléphone. Uniquement des NOMS de champs — jamais une valeur (F17).
      code: [
        `device: ${err?.kind ?? "absent"}`,
        err?.missing?.length ? `manquants: ${err.missing.join(",")}` : "",
        err?.reason ? `motif: ${err.reason}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
    console.error(
      `[booth] BORNE NON CONFIGURÉE (device: ${err?.kind ?? "absent"}` +
        (err?.missing?.length ? `, champs manquants : ${err.missing.join(", ")}` : "") +
        ") — catalogue VIDÉ, aucun film de démonstration servi.",
    );
  } else {
    // Dev / déploiement public sans agent local : le catalogue factice est ICI légitime, c'est le
    // bac à sable qui permet de parcourir l'expérience sans backend. Un badge permanent (discret)
    // suffit à ce niveau — mais il est obligatoire : une capture d'écran ou une démo ne doit jamais
    // pouvoir passer pour une borne réelle, c'est exactement la confusion qui a produit BUG-017.
    showBoothStatus({
      level: "demo",
      title: "Mode démonstration",
      detail: "Films fictifs · lecture simulée · aucune séance enregistrée",
    });
    console.info("[booth] mode démo (aucun identifiant borne) — catalogue factice, sessions en mémoire");
  }

  // Sink de fin de séance. VRAIE borne : on tente la remontée ; en cas d'échec (réseau coupé, ou
  // borne bootée hors ligne), on BUFFERISE la séance (+ paiement) → rejouée à la prochaine
  // reconnexion. Dev/mock (pas de creds) : pas de sink (sessions en mémoire).
  if (sessionJournal) {
    sink = (snapshot) => {
      const id = crypto.randomUUID();
      void backend.saveSession(snapshot, id).then((ok) => {
        if (!ok) sessionJournal.append({ id, session: snapshot.session, plays: snapshot.plays });
      });
    };
  }

  // CIN-014 : heartbeat RÉGULIER (pas seulement au boot) → la flotte repère vite une borne
  // muette (F3). Le device est authentifié (JWT) ; anti-rejeu serveur = différé (faible
  // risque, et une garde monotone risquerait de faux « silencieux » sur dérive d'horloge).
  if (online) {
    const HEARTBEAT_MS = 60_000;
    window.setInterval(() => void backend.reportHeartbeat(BOOTH_VERSION), HEARTBEAT_MS);
  }

  // Base de l'URL de partage (QR de fin → /s/{token}). La page récap est servie par
  // Cloudflare Pages (le domaine functions.supabase.co neutralise le HTML). Définir
  // VITE_SHARE_BASE_URL sur l'URL Pages (…pages.dev) ; défaut = futur domaine public.
  const shareBaseUrl =
    (import.meta.env.VITE_SHARE_BASE_URL as string | undefined) ?? "https://my.kioskoscope.com";

  // Rafraîchissement back-office ENTRE deux visiteurs (appelé par App.goIdle) : catalogue + droits +
  // style/marque à jour sans reboot. Débounce (≤ 1×/5 min) + online only + fire-and-forget. On part
  // avec `lastRefresh=maintenant` → le 1er retour accueil juste après le boot ne re-fetch pas inutilement.
  let lastRefresh = Date.now();
  const REFRESH_MIN_MS = 5 * 60_000;
  const refreshFromBackOffice = (): void => {
    if (!online || Date.now() - lastRefresh < REFRESH_MIN_MS) return;
    lastRefresh = Date.now();
    void (async () => {
      try {
        const films = await backend.loadCatalog(await readLocalMedia());
        const blk = await backend.loadBlockedMedia();
        setCatalog(films.filter((f) => !blk.has(f.id)));
        const style = await backend.loadOrgStyle();
        applyOrgStyle(style ?? undefined);
        if (style) {
          setBrand({
            ...(style.title ? { title: style.title } : {}),
            idleImageUrl: style.assets?.idleImage ?? null,
            logoUrl: style.assets?.logoDark ?? style.assets?.logoLight ?? null,
          });
        }
        console.info("[booth] catalogue/style rafraîchis (back-office)");
      } catch (e) {
        console.warn("[booth] rafraîchissement back-office échoué :", e);
      }
    })();
  };

  const app = new App(
    root,
    new MockUnlockAdapter(), // mock : simule succès ET échecs
    new RuleBasedRecommender(), // reco prototype : règles sur métadonnées
    new SessionManager(boothId, organizationId, sink),
    {
      boothId,
      shareBaseUrl,
      endAutoReturnMs: 45_000,
      afterFilmCountdownSeconds: 60, // 1 min max pour choisir après un film
      parcoursInactivityMs: 90_000, // abandon au choix → retour accueil (borne jamais bloquée)
      onIdle: refreshFromBackOffice, // catalogue/style à jour sans reboot
    },
  );

  app.start();

  // Filet de sécurité kiosque (F4) : une erreur JS non gérée ne doit JAMAIS laisser la borne sur un
  // écran mort. On journalise, on ramène à l'accueil ; en cas d'ORAGE d'erreurs (≥3 en 10 s, ex. la
  // récupération elle-même échoue) on recharge — le serveur local ressert l'app → retour propre.
  let errWindowStart = 0;
  let errCount = 0;
  const onFatal = (label: string, detail: unknown): void => {
    console.error(`[booth] erreur non gérée (${label}) :`, detail);
    const now = Date.now();
    if (now - errWindowStart > 10_000) { errWindowStart = now; errCount = 0; }
    errCount += 1;
    if (errCount >= 3) { console.error("[booth] orage d'erreurs → rechargement"); location.reload(); return; }
    app.recover();
  };
  window.addEventListener("error", (e) => onFatal("error", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => onFatal("rejection", e.reason));

  // ── Menu opérateur Kiosk (F17 volet A, CIN-070/073) ──────────────────────────
  // Surface de service par-dessus le parcours, gardée par une auth OFFLINE (PIN).
  // Wi-Fi/réglages/redémarrage = hooks (stubs en dev ; services locaux réels différés
  // CIN-071/072). La table d'accès viendra du back-office ; en DEV seulement on la
  // seed avec des comptes de démo (jamais en build de production).
  // Cache d'accès CHIFFRÉ au repos si la Kiosk est provisionnée (secret device dispo, S4) ;
  // sinon (dev sans config) repli localStorage clair pour la table de démo.
  const accessStore: AccessStore = backend.isConfigured
    ? await EncryptedAccessStore.create(backend.cacheSecret, boothId)
    : new LocalStorageAccessStore();
  const accessJournal = new LocalStorageAccessJournal();
  if (online) {
    // En ligne : rafraîchir le cache d'accès depuis le back-office (sync eventually
    // consistent : révocations/expirations effectives à ce moment) puis pousser le
    // journal bufferisé hors ligne. On ne draine QU'APRÈS un push réussi → zéro perte.
    const table = await backend.syncOperatorAccess();
    if (table) {
      accessStore.save(table);
      console.info(`[booth] table d'accès synchronisée · ${table.entries.length} accès`);
    }
    const pending = accessJournal.peek();
    if (pending.length > 0 && (await backend.pushAccessLog(pending))) {
      accessJournal.drain();
    }
  } else if (import.meta.env.DEV && !accessStore.load()) {
    // Repli DEV hors ligne uniquement : table de démo pour exercer le menu sans back-office.
    accessStore.save(await seedDemoAccessTable(organizationId, boothId));
    console.info("[booth] table d'accès de DÉMO chargée (dev) · op PIN 246810 / admin PIN 135790");
  }

  // Services système : si la borne fournit l'agent local (jeton via /kiosk-config.json,
  // HORS bundle, déjà chargé plus haut), Wi-Fi/réglages sont RÉELS ; sinon (dev) stubs.
  let wifi: WifiAdapter;
  let settings: OperatorSettingsHooks;
  if (agent) {
    wifi = new AgentWifiAdapter(agent);
    settings = createAgentSettings(agent);
    console.info("[booth] agent local détecté · Wi-Fi/réglages pilotés par la borne");

    // CIN-077 : relais MAJ OS. Si branché Supabase, la borne interroge périodiquement ses
    // commandes de patch et les applique via l'agent local (apt). Écriture réservée global_admin
    // côté serveur → seule la plateforme déclenche ; la borne ne fait qu'exécuter et remonter.
    if (online) {
      const OS_POLL_MS = 5 * 60_000;
      const relay = (): void => void backend.relayOsUpdates(() => agent.osUpdate());
      relay();
      window.setInterval(relay, OS_POLL_MS);
    }
  } else {
    let volume = 70;
    let brightness = 100;
    wifi = new WifiManager();
    settings = {
      getVolume: () => volume,
      setVolume: (v) => {
        volume = v;
      },
      getBrightness: () => brightness,
      setBrightness: (v) => {
        brightness = v;
        // Effet tangible en dev : la vraie luminosité passe par l'agent sur la borne.
        document.documentElement.style.filter = v === 100 ? "" : `brightness(${v}%)`;
      },
      restart: () => {
        console.info("[booth] redémarrage demandé (stub dev)");
        location.reload();
      },
    };
  }

  const operator = new OperatorMenu({
    store: accessStore,
    journal: accessJournal,
    wifi,
    settings,
    status: () => ({ boothId, orgId: organizationId, version: BOOTH_VERSION, online }),
  });
  operator.attachRevealGesture(document.body);
}

// Résilience au DÉMARRAGE : si une exception survient AVANT que le filet d'erreur runtime ne soit posé
// (ex. hoquet réseau pendant l'init), la borne resterait sur un écran blanc. On journalise et on
// retente par rechargement après un court délai (le serveur local ressert l'app → nouvelle chance).
void main().catch((e) => {
  console.error("[booth] échec de démarrage — rechargement dans 5 s :", e);
  window.setTimeout(() => location.reload(), 5000);
});
