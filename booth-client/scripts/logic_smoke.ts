// Smoke test DOM-free de la logique CŒUR du booth-client : moteur de
// recommandation (RuleBasedRecommender) + cycle de vie de session (SessionManager).
// Aucun DOM, aucun réseau : on fabrique des fixtures `Film` et on exerce les
// invariants réels lus dans le code (pas devinés). Garde de non-régression.
// Lancer : esbuild scripts/logic_smoke.ts --bundle --platform=node --format=esm \
//   --outfile=node_modules/.cache/logic_smoke.mjs && node node_modules/.cache/logic_smoke.mjs
import { RuleBasedRecommender } from "../src/reco/RuleBasedRecommender";
import type { RecoContext } from "../src/reco/Recommender";
import { SessionManager } from "../src/session/SessionManager";
import { FACTICE_CATALOG, auditCatalog, localMediaUrl, type CatalogEntry } from "../src/domain/catalog";
import { normalizeDeviceError, normalizeMediaLibrary, parseKioskConfig } from "../src/setup/kioskAgent";
import { restoreOfflineCatalog, describeOfflineCatalog } from "../src/domain/offlineCatalog";
import { reconcileDeviceIdentity } from "../src/domain/deviceIdentity";
import type { Film, Play } from "../src/domain/types";

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("  ✗ ÉCHEC: " + msg);
    throw new Error("ÉCHEC: " + msg);
  }
  passed += 1;
  console.log("  ✓ " + msg);
}

// ── Fabrique de fixtures ────────────────────────────────────────────────────
// Base = premier film factice réel (Media complet, tous champs valides), sur
// lequel on ne surcharge que ce qui compte pour le test. Évite un littéral Media
// de 25 champs et garantit la validité du type.
const BASE: Film = FACTICE_CATALOG[0];
let seq = 0;
function makeFilm(overrides: Partial<Film>): Film {
  seq += 1;
  return { ...BASE, id: `fx-${seq}`, title: `Fixture ${seq}`, ...overrides };
}

function ctx(overrides: Partial<RecoContext["query"]> = {}, alreadyPlayed: readonly Play[] = []): RecoContext {
  return {
    alreadyPlayed,
    query: { mood: null, maxDurationSeconds: null, ...overrides },
  };
}

function ids(films: readonly Film[]): string[] {
  return films.map((f) => f.id);
}

// ── RECO ────────────────────────────────────────────────────────────────────
function testReco(): void {
  const rec = new RuleBasedRecommender();

  console.log("R1. Filtre par humeur : les films de l'humeur demandée passent en tête");
  {
    // Poids réel : humeur = 10, durée = max 3, jitter aléatoire < 0.5. Donc tout
    // film de la bonne humeur (score >= 10) précède TOUJOURS un film sans (score <= 3.5).
    const withMood1 = makeFilm({ moods: ["apaisant"], durationSeconds: 300 });
    const withMood2 = makeFilm({ moods: ["apaisant", "léger"], durationSeconds: 200 });
    const without1 = makeFilm({ moods: ["tendu"], durationSeconds: 250 });
    const without2 = makeFilm({ moods: ["énergique"], durationSeconds: 250 });
    const catalog = [without1, withMood1, without2, withMood2];
    const out = rec.recommend(catalog, ctx({ mood: "apaisant" }));
    const outIds = ids(out);
    const idxLastMood = Math.max(outIds.indexOf(withMood1.id), outIds.indexOf(withMood2.id));
    const idxFirstNo = Math.min(outIds.indexOf(without1.id), outIds.indexOf(without2.id));
    assert(idxLastMood < idxFirstNo, "tous les films de l'humeur demandée devant ceux sans");
    // Règle réelle : les films hors-humeur ne sont PAS écartés, seulement dépriorisés.
    assert(out.length === 4, "les films hors-humeur restent présents (dépriorisés, pas exclus)");
  }

  console.log("R2. Respecte la durée max : les films trop longs sont exclus");
  {
    const shortA = makeFilm({ durationSeconds: 200, moods: [] });
    const shortB = makeFilm({ durationSeconds: 300, moods: [] });
    const tooLong = makeFilm({ durationSeconds: 900, moods: [] });
    const out = rec.recommend([shortA, tooLong, shortB], ctx({ maxDurationSeconds: 300 }));
    assert(!ids(out).includes(tooLong.id), "film > maxDurationSeconds exclu du résultat");
    assert(out.length === 2, "seuls les films <= durée max sont retournés");
    // Borne : durée == max est acceptée (<=, pas <).
    const exact = makeFilm({ durationSeconds: 300, moods: [] });
    const outExact = rec.recommend([exact], ctx({ maxDurationSeconds: 300 }));
    assert(outExact.length === 1, "durée == max acceptée (borne inclusive)");
  }

  console.log("R3. Exclut les films déjà joués (alreadyPlayed)");
  {
    const seen = makeFilm({ moods: ["apaisant"] });
    const fresh = makeFilm({ moods: ["apaisant"] });
    const play: Play = {
      id: "p1", sessionId: "s1", filmId: seen.id, position: 0,
      startedAt: Date.now(), completed: true, source: "user_choice",
    };
    const out = rec.recommend([seen, fresh], ctx({ mood: "apaisant" }, [play]));
    assert(!ids(out).includes(seen.id), "film référencé dans alreadyPlayed exclu");
    assert(ids(out).includes(fresh.id), "film non joué toujours recommandé");
    assert(out.length === 1, "seul le film non joué reste");
  }

  console.log("R4. Films inactifs exclus (active:false)");
  {
    const on = makeFilm({ active: true });
    const off = makeFilm({ active: false });
    const out = rec.recommend([on, off], ctx());
    assert(ids(out).includes(on.id) && !ids(out).includes(off.id), "film inactif jamais recommandé");
  }

  console.log("R5. Catalogue vide → [] sans crash");
  {
    const out = rec.recommend([], ctx({ mood: "apaisant", maxDurationSeconds: 300 }));
    assert(Array.isArray(out) && out.length === 0, "catalogue vide → tableau vide");
  }

  console.log("R6. Déterminisme du contrat : même ENTRÉE → même ensemble + même partition humeur");
  {
    // NB réel : score() ajoute un jitter Math.random()*0.5 pour éviter un ordre figé
    // entre ex æquo. L'ordre TOTAL n'est donc PAS strictement reproductible par
    // design. Ce qui EST déterministe (jitter 0.5 << poids humeur 10) : l'ensemble
    // retourné et la frontière humeur/non-humeur. On teste l'invariant réel.
    const withMood = [makeFilm({ moods: ["apaisant"] }), makeFilm({ moods: ["apaisant"] })];
    const without = [makeFilm({ moods: ["tendu"] }), makeFilm({ moods: ["sombre"] })];
    const catalog = [without[0], withMood[0], without[1], withMood[1]];
    const moodIds = new Set(withMood.map((f) => f.id));
    let refSet: string = "";
    for (let run = 0; run < 25; run++) {
      const out = rec.recommend(catalog, ctx({ mood: "apaisant" }));
      const setKey = [...ids(out)].sort().join(",");
      if (run === 0) refSet = setKey;
      assert(setKey === refSet || run > 0 && setKey === refSet, `run ${run} : ensemble retourné stable`);
      // Partition stable : aucun film hors-humeur avant un film humeur.
      let sawNonMood = false;
      let partitionOk = true;
      for (const f of out) {
        if (moodIds.has(f.id)) {
          if (sawNonMood) partitionOk = false;
        } else {
          sawNonMood = true;
        }
      }
      assert(partitionOk, `run ${run} : partition humeur avant non-humeur respectée`);
    }
  }
}

// ── SESSION ─────────────────────────────────────────────────────────────────
function testSession(): void {
  const BOOTH = "booth-42";
  const ORG = "org-perchoir";

  console.log("S1. État initial : aucune session active");
  {
    const mgr = new SessionManager(BOOTH, ORG);
    assert(mgr.current === null, "current === null avant start()");
    assert(mgr.currentPlays.length === 0, "currentPlays vide avant start()");
  }

  console.log("S2. start() crée une session portant le bon booth/org");
  {
    const mgr = new SessionManager(BOOTH, ORG);
    const session = mgr.start("free", null, null);
    assert(session.boothId === BOOTH, "session.boothId == boothId du manager");
    assert(session.organizationId === ORG, "session.organizationId == organizationId du manager");
    assert(session.endedAt === null, "session non close (endedAt null)");
    assert(typeof session.shareToken === "string" && session.shareToken.length > 0, "shareToken généré");
    assert(mgr.current === session, "current reflète la session démarrée");
  }

  console.log("S3. recordPlayStart : plays cohérents, currentPlays suit l'état");
  {
    const mgr = new SessionManager(BOOTH, ORG);
    const session = mgr.start("mock", 500, "pref_123");
    const f1 = makeFilm({});
    const f2 = makeFilm({});
    const p1 = mgr.recordPlayStart(f1, "user_choice");
    const p2 = mgr.recordPlayStart(f2, "recommendation");
    assert(mgr.currentPlays.length === 2, "currentPlays reflète 2 films lancés");
    assert(p1.filmId === f1.id && p2.filmId === f2.id, "chaque play porte le bon filmId");
    assert(p1.sessionId === session.id && p2.sessionId === session.id, "plays rattachés à la session");
    assert(p1.position === 0 && p2.position === 1, "positions 0-based séquentielles");
    assert(p1.source === "user_choice" && p2.source === "recommendation", "source user_choice/recommendation préservée");
    assert(p1.completed === false, "play non complété à l'ouverture");
  }

  console.log("S4. markPlayCompleted marque le bon play");
  {
    const mgr = new SessionManager(BOOTH, ORG);
    mgr.start("free", null, null);
    const p = mgr.recordPlayStart(makeFilm({}), "user_choice");
    mgr.markPlayCompleted(p.id);
    assert(mgr.currentPlays[0].completed === true, "markPlayCompleted → completed true");
    mgr.markPlayCompleted("id-inexistant"); // no-op, ne doit pas lever
    assert(true, "markPlayCompleted sur id inconnu = no-op sans exception");
  }

  console.log("S5. end() clôt, renvoie un snapshot figé, remet l'état à zéro");
  {
    const mgr = new SessionManager(BOOTH, ORG);
    const session = mgr.start("card", 700, "stripe_x");
    mgr.recordPlayStart(makeFilm({}), "user_choice");
    mgr.recordPlayStart(makeFilm({}), "recommendation");
    const snap = mgr.end();
    assert(snap.session.id === session.id, "snapshot porte la session close");
    assert(snap.session.endedAt !== null, "endedAt renseigné à la clôture");
    assert(snap.plays.length === 2, "snapshot fige les 2 plays");
    assert(mgr.current === null, "current === null après end()");
    assert(mgr.currentPlays.length === 0, "currentPlays vidé après end()");
    // Le snapshot est figé : un nouveau parcours ne le modifie pas.
    mgr.start("free", null, null);
    mgr.recordPlayStart(makeFilm({}), "user_choice");
    assert(snap.plays.length === 2, "snapshot immuable : nouveau parcours ne l'affecte pas");
  }

  console.log("S6. Sink de fin appelé exactement une fois, avec le snapshot");
  {
    const calls: Array<{ session: { id: string }; plays: readonly Play[] }> = [];
    const mgr = new SessionManager(BOOTH, ORG, (s) => calls.push(s));
    const session = mgr.start("free", null, null);
    mgr.recordPlayStart(makeFilm({}), "recommendation");
    const snap = mgr.end();
    assert(calls.length === 1, "sink appelé exactement une fois à la clôture");
    assert(calls[0].session.id === session.id, "sink reçoit la session close");
    assert(calls[0].plays.length === 1 && snap.plays.length === 1, "sink reçoit les plays de la séance");
  }

  console.log("S7. Garde-fous : opérations hors session lèvent");
  {
    const mgr = new SessionManager(BOOTH, ORG);
    let threwPlay = false;
    try {
      mgr.recordPlayStart(makeFilm({}), "user_choice");
    } catch {
      threwPlay = true;
    }
    assert(threwPlay, "recordPlayStart sans session active → exception");
    let threwEnd = false;
    try {
      mgr.end();
    } catch {
      threwEnd = true;
    }
    assert(threwEnd, "end() sans session active → exception");
  }

  console.log("S8. shareToken unique par session");
  {
    const mgr = new SessionManager(BOOTH, ORG);
    const t1 = mgr.start("free", null, null).shareToken;
    mgr.end();
    const t2 = mgr.start("free", null, null).shareToken;
    assert(t1 !== t2, "deux sessions → deux shareToken distincts");
  }

  // ── S9. Mesure d'écoute (F21 / CIN-105) ────────────────────────────────────
  // Ces chiffres servent de base déclarative auprès d'ayants droit : chaque invariant ci-dessous
  // protège contre une SUR-déclaration (compter plus que ce qui a été vu).
  console.log("S9. mesure d'écoute — déciles, monotonie, achèvement");
  {
    const mgr = new SessionManager(BOOTH, ORG);
    mgr.start("free", null, null);
    const film = makeFilm({ durationSeconds: 100 });
    const play = mgr.recordPlayStart(film, "user_choice");

    assert(play.watchedSeconds === 0, "à l'ouverture : 0 seconde vue");
    assert(play.decilesReached.length === 10, "10 déciles initialisés");
    assert(play.decilesReached.every((d) => d === false), "aucun décile atteint au départ");
    assert(play.endedAt === null, "lecture en cours : pas de fin");

    mgr.recordPlayProgress(play.id, 25, 100);
    assert(play.watchedSeconds === 25, "progression → 25 s vues");
    assert(play.decilesReached[2] === true, "25 % → 3ᵉ décile atteint");
    assert(play.decilesReached[3] === false, "25 % → 4ᵉ décile PAS atteint");

    // Retour en arrière : une seconde revue n'est pas une seconde vue en plus, et une seconde
    // déjà vue ne peut pas être « dé-vue ». Sans cette monotonie, un spectateur qui rembobine
    // ferait baisser la durée déclarée.
    mgr.recordPlayProgress(play.id, 10, 100);
    assert(play.watchedSeconds === 25, "retour arrière → la durée vue ne redescend PAS");
    assert(play.decilesReached[2] === true, "retour arrière → les déciles atteints le restent");

    // Saut en avant : la courbe de rétention ne doit pas se « trouer », mais la durée vue ne
    // doit PAS être gonflée par un passage non regardé.
    mgr.recordPlayProgress(play.id, 80, 100);
    assert(play.decilesReached[7] === true, "saut à 80 % → 8ᵉ décile atteint");
    assert(play.decilesReached.slice(0, 8).every((d) => d), "saut en avant → aucun trou dans la courbe");

    // Durée inconnue (métadonnées absentes) : on n'invente pas de déciles.
    const play2 = mgr.recordPlayStart(film, "user_choice");
    mgr.recordPlayProgress(play2.id, 30, 0);
    assert(play2.watchedSeconds === 30, "durée inconnue → la durée vue est quand même comptée");
    assert(play2.decilesReached.every((d) => d === false), "durée inconnue → aucun décile inventé");

    // Position négative / non finie : ignorée plutôt que propagée.
    mgr.recordPlayProgress(play2.id, -5, 100);
    assert(play2.watchedSeconds === 30, "position négative ignorée");

    // Interruption vs achèvement — la distinction qui protège le taux d'achèvement déclaré.
    mgr.markPlayStopped(play2.id);
    assert(play2.completed === false, "lecture interrompue → PAS achevée");
    assert(play2.endedAt !== null, "lecture interrompue → horodatée");
    assert(play2.decilesReached[9] === false, "interruption → le dernier décile reste non atteint");

    mgr.markPlayCompleted(play.id);
    assert(play.completed === true, "fin naturelle → achevée");
    assert(play.decilesReached.every((d) => d === true), "fin naturelle → tous les déciles atteints");
  }
}

// ── CATALOGUE JOUABLE (BUG-017) ─────────────────────────────────────────────
// Invariant protégé : un média sans fichier lisible ne doit JAMAIS être proposé. Il était
// recommandé puis « joué » en lecture simulée — une séance payée contre une barre de progression.
function testPlayableCatalog(): void {
  const entry = (overrides: Partial<Film>, declaredPath: string | null): CatalogEntry => ({
    film: makeFilm(overrides),
    declaredPath,
  });

  console.log("C1. Un média SANS fichier déclaré est écarté (donnée incomplète)");
  {
    const e = entry({ storageUrl: null, title: "Vertige" }, null);
    const a = auditCatalog([e]);
    assert(a.playable.length === 0, "aucun média jouable si storage_url est nul");
    assert(a.withoutFile.length === 1, "le média sans fichier est classé 'withoutFile'");
    assert(a.unresolved.length === 0, "sans fichier déclaré, ce n'est PAS un incident de signature");
  }

  console.log("C2. Un média AVEC fichier déclaré mais URL non résolue est écarté (incident)");
  {
    const e = entry({ storageUrl: null }, "org/media/film.mp4");
    const a = auditCatalog([e]);
    assert(a.playable.length === 0, "URL de signature échouée → média non jouable");
    assert(a.unresolved.length === 1, "classé 'unresolved' — c'est un incident, pas une fiche à compléter");
    assert(a.withoutFile.length === 0, "un fichier était bien déclaré : pas 'withoutFile'");
  }

  console.log("C3. Un média avec URL résolue passe");
  {
    const e = entry({ storageUrl: "https://signed.example/film.mp4?token=x" }, "org/media/film.mp4");
    const a = auditCatalog([e]);
    assert(a.playable.length === 1, "média avec URL résolue → jouable");
    assert(a.playable[0].storageUrl !== null, "l'URL résolue est conservée sur le film jouable");
  }

  console.log("C4. Chaînes vides traitées comme absentes (jamais comme une URL valide)");
  {
    const declaredBlank = auditCatalog([entry({ storageUrl: "https://ok/x.mp4" }, "   ")]);
    assert(declaredBlank.withoutFile.length === 1, "chemin déclaré blanc = aucun fichier rattaché");
    const resolvedBlank = auditCatalog([entry({ storageUrl: "" }, "org/media/film.mp4")]);
    assert(resolvedBlank.unresolved.length === 1, "URL résolue vide = non résolue, jamais jouable");
  }

  console.log("C5. Catalogue mixte : seuls les jouables sortent, les autres sont tracés");
  {
    const a = auditCatalog([
      entry({ storageUrl: "https://signed/a.mp4" }, "a.mp4"),
      entry({ storageUrl: null, title: "Vertige" }, null),
      entry({ storageUrl: null }, "c.mp4"),
      entry({ storageUrl: "https://signed/d.mp4" }, "d.mp4"),
    ]);
    assert(a.playable.length === 2, "2 médias jouables sur 4");
    assert(a.withoutFile.length === 1 && a.unresolved.length === 1, "les 2 exclus sont classés par CAUSE distincte");
    assert(
      a.playable.length + a.withoutFile.length + a.unresolved.length === 4,
      "partition totale : aucun média perdu ni compté deux fois",
    );
  }

  console.log("C6. Catalogue entièrement injouable → catalogue VIDE (règle BUG-011)");
  {
    const a = auditCatalog([entry({ storageUrl: null }, null), entry({ storageUrl: null }, "b.mp4")]);
    assert(a.playable.length === 0, "aucun repli : un catalogue vide est un état honnête");
  }

  console.log("C7. Le catalogue FACTICE est intégralement injouable (aucun fichier)");
  {
    // Garde de non-régression : si un jour un film factice recevait une URL, la lecture simulée
    // cesserait d'être le seul chemin possible pour lui — et cette hypothèse doit rester vraie.
    const a = auditCatalog(FACTICE_CATALOG.map((f) => ({ film: f, declaredPath: f.storageUrl })));
    assert(a.playable.length === 0, "aucun film de démonstration n'est jouable");
    assert(a.withoutFile.length === FACTICE_CATALOG.length, "tous les films factices sont 'sans fichier'");
  }

  console.log("C8. Entrée vide → partition vide sans crash");
  {
    const a = auditCatalog([]);
    assert(a.playable.length === 0 && a.withoutFile.length === 0 && a.unresolved.length === 0, "[] → tout vide");
  }
}

// ── DIAGNOSTIC DE PROVISIONNEMENT (BUG-017) ─────────────────────────────────
// Invariant protégé : une borne mal provisionnée ne doit jamais pouvoir passer pour un poste de
// développement légitime — c'est ce qui la faisait démarrer en mode démo sans que personne le voie.
function testDeviceError(): void {
  console.log("D1. Chaque cause servie par la borne est conservée telle quelle");
  {
    assert(normalizeDeviceError({ kind: "absent" }, false).kind === "absent", "'absent' préservé");
    assert(normalizeDeviceError({ kind: "incomplete" }, true).kind === "incomplete", "'incomplete' préservé");
    assert(normalizeDeviceError({ kind: "unreadable" }, true).kind === "unreadable", "'unreadable' préservé");
  }

  console.log("D2. Un bloc device présent mais refusé ⇒ 'incomplete', jamais 'absent'");
  {
    // Cas d'un serveur local d'une version antérieure : il sert un `device` partiel sans
    // `deviceError`. Le confondre avec « pas provisionné » rouvrirait exactement le trou.
    const e = normalizeDeviceError(undefined, true);
    assert(e.kind === "incomplete", "device présent mais invalide → erreur de déploiement");
    const none = normalizeDeviceError(undefined, false);
    assert(none.kind === "absent", "aucun bloc device et aucune erreur → poste non provisionné");
  }

  console.log("D3. `kind` inconnu ou forgé n'est jamais recopié");
  {
    const e = normalizeDeviceError({ kind: "tout_va_bien" }, true);
    assert(e.kind === "incomplete", "valeur hors énumération → repli sur la cause déduite");
    assert(!["tout_va_bien"].includes(e.kind as string), "aucune chaîne arbitraire ne devient un 'kind'");
  }

  console.log("D4. `missing` filtré sur la liste blanche des NOMS de champs");
  {
    const e = normalizeDeviceError({ kind: "incomplete", missing: ["orgId", "<img src=x>", "boothId", 42] }, true);
    assert(e.missing?.length === 2, "seuls les noms de champs connus sont retenus");
    assert(e.missing?.includes("orgId") === true && e.missing?.includes("boothId") === true, "noms légitimes conservés");
    assert(e.missing?.some((m) => m.includes("<")) !== true, "aucune chaîne arbitraire ne part vers le DOM");
  }

  console.log("D5. Le nom `devicePassword` circule, jamais sa valeur");
  {
    // On diagnostique un mot de passe MANQUANT : c'est le NOM du champ qui est utile. Le contrat
    // interdit toute valeur — la structure ne porte d'ailleurs aucun champ pour en transporter une.
    const e = normalizeDeviceError({ kind: "incomplete", missing: ["devicePassword"], value: "hunter2" }, true);
    assert(e.missing?.[0] === "devicePassword", "le nom du champ manquant est diagnostiquable");
    assert(!Object.values(e).flat().includes("hunter2"), "aucune valeur du fichier device ne traverse");
  }

  console.log("D6. `reason` borné en longueur (pas de bandeau noyé par une chaîne hostile)");
  {
    const e = normalizeDeviceError({ kind: "unreadable", reason: "x".repeat(5000) }, true);
    assert((e.reason?.length ?? 0) <= 120, "motif tronqué à 120 caractères");
  }

  console.log("D7. Charge utile absurde → cause déduite, aucun crash");
  {
    assert(normalizeDeviceError(null, true).kind === "incomplete", "null + device refusé → incomplete");
    assert(normalizeDeviceError("bonjour", false).kind === "absent", "chaîne → absent");
    assert(normalizeDeviceError({ missing: "orgId" }, true).missing === undefined, "missing non-tableau ignoré");
  }

  // ── Contrat de config de borne (CIN-128) ────────────────────────────────────
  // Cette fonction décide d'UNE chose : « suis-je sur une borne ? ». S'en tromper ne se voit pas
  // à l'écran — ça se voit en comptabilité, quand une borne de production a servi du catalogue de
  // démonstration sans verrouillage. D'où le soin porté aux cas d'entre-deux.
  const device = { boothId: "b1", orgId: "o1", deviceEmail: "d@k.local", devicePassword: "x" };

  console.log("D8. Config moderne : relais annoncé, aucun jeton attendu");
  {
    const cfg = parseKioskConfig({ agentBase: "/agent", agentReady: true, device });
    assert(cfg !== null, "config reconnue");
    assert(cfg?.agentBase === "/agent", "préfixe de relais retenu");
    assert(cfg?.agentReady === true, "relais opérationnel");
    assert(cfg?.device?.boothId === "b1", "creds device transmis");
    assert(!("agentToken" in (cfg as object)), "aucun jeton n'entre dans l'objet de config");
  }

  console.log("D9. Jeton absent côté serveur : c'est toujours une borne");
  {
    const cfg = parseKioskConfig({ agentBase: "/agent", agentReady: false, device });
    assert(cfg !== null, "une borne sans jeton d'agent reste une borne (verrouillage, creds)");
    assert(cfg?.agentReady === false, "…mais le relais est annoncé inopérant");
  }

  console.log("D10. Serveur local ANTÉRIEUR à CIN-128 : borne sans relais, jamais un poste de dev");
  {
    const cfg = parseKioskConfig({ agentUrl: "http://127.0.0.1:4599", agentToken: "secret-de-la-borne", device });
    assert(cfg !== null, "ancien contrat reconnu comme borne");
    assert(cfg?.agentReady === false, "pas de relais → menu opérateur en stubs");
    assert(!JSON.stringify(cfg).includes("secret-de-la-borne"), "le jeton de l'ancien contrat est IGNORÉ, jamais recopié");
  }

  console.log("D11. Ce qui n'est pas une borne reste `null`");
  {
    assert(parseKioskConfig({}) === null, "objet vide → pas une borne");
    assert(parseKioskConfig(null) === null, "null → pas une borne");
    assert(parseKioskConfig("borne") === null, "chaîne → pas une borne");
    assert(parseKioskConfig({ agentBase: "https://ailleurs.example/agent" }) === null, "préfixe non relatif refusé");
    const broken = parseKioskConfig({ agentBase: "/agent", agentReady: true, device: { boothId: "b1" } });
    assert(broken?.deviceError?.kind === "incomplete", "device partiel → erreur explicite, pas d'absence muette");
  }
}

// ── Médias locaux : la borne préfère son disque au réseau (CIN-112 lot 1) ───────
function testLocalMedia(): void {
  const H = "a".repeat(64); // 64 hexadécimaux minuscules = la seule forme acceptée
  const lib = (media: unknown): ReadonlySet<string> => normalizeMediaLibrary({ media });

  console.log("L1. Une empreinte présente sur le disque donne une URL locale, même origine");
  {
    assert(localMediaUrl(H, new Set([H])) === `/media/${H}`, "média sur disque → /media/<hash>");
    assert(localMediaUrl(H, new Set()) === null, "média absent du disque → null (il faudra le réseau)");
  }

  console.log("L2. Une empreinte mal formée ne produit JAMAIS d'URL (elle finit dans un chemin)");
  {
    // Le pire cas n'est pas l'empreinte absurde, c'est celle qui essaie de sortir du dossier.
    const evil = "../../etc/passwd";
    assert(localMediaUrl(evil, new Set([evil])) === null, "traversée de chemin refusée même si 'présente'");
    assert(localMediaUrl(H.toUpperCase(), new Set([H.toUpperCase()])) === null, "hexadécimal majuscule refusé");
    assert(localMediaUrl(H.slice(1), new Set([H.slice(1)])) === null, "63 caractères refusés (longueur exacte)");
    assert(localMediaUrl("", new Set([""])) === null, "empreinte vide refusée");
  }

  console.log("L3. L'inventaire de l'agent est filtré, jamais recopié tel quel");
  {
    assert(lib([{ hash: H, bytes: 42 }]).has(H), "entrée valide retenue");
    assert(lib([{ hash: H, bytes: 0 }]).size === 0, "fichier de 0 octet écarté (téléchargement interrompu)");
    assert(lib([{ hash: H }]).has(H), "taille absente (agent plus ancien) → on ne rejette pas");
    assert(lib([{ hash: "../x" }]).size === 0, "empreinte hors forme écartée à l'entrée aussi");
    assert(lib([null, "x", 7, { hash: H }]).size === 1, "entrées non-objets ignorées sans faire tomber le reste");
  }

  console.log("L4. Un agent muet ou cassé donne une bibliothèque VIDE, pas une exception");
  {
    assert(normalizeMediaLibrary(null).size === 0, "réponse nulle → vide");
    assert(normalizeMediaLibrary({}).size === 0, "réponse sans champ media → vide");
    assert(normalizeMediaLibrary({ media: "beaucoup" }).size === 0, "media non-tableau → vide");
  }

  console.log("L5. Un média local est JOUABLE même sans URL signée (le cas hors ligne)");
  {
    // Reproduit ce que fait loadCatalog : le fichier local sert de chemin déclaré ET d'URL résolue.
    const local = localMediaUrl(H, new Set([H]));
    const a = auditCatalog([{ film: makeFilm({ storageUrl: local }), declaredPath: local }]);
    assert(a.playable.length === 1, "média sur disque → jouable sans avoir signé quoi que ce soit");
    assert(a.unresolved.length === 0, "et ce n'est surtout pas un incident de signature");
  }
}

// ── Catalogue de secours hors ligne (CIN-112 lot 2) ────────────────────────────
// ── CIN-098 : l'identité de la borne se constate, elle ne se déclare pas ────────────────────
function testDeviceIdentity(): void {
  const RESOLVED = { boothId: "booth-vrai", orgId: "org-vrai" };

  // Cas nominal : la config locale ne porte plus d'identité (elle n'est plus requise).
  const nu = reconcileDeviceIdentity({}, RESOLVED);
  assert(nu.identity.boothId === "booth-vrai" && nu.identity.orgId === "org-vrai", "config vide → l'identité vient du serveur");
  assert(nu.drift.length === 0, "config vide → aucune dérive signalée (absence ≠ contradiction)");

  // Config saine : elle dit la même chose que le serveur.
  const sain = reconcileDeviceIdentity({ ...RESOLVED }, RESOLVED);
  assert(sain.drift.length === 0, "config conforme → aucune dérive");

  // BUG-008 : le `.env` recopié d'une autre borne. C'est CE cas qui figeait les statistiques.
  const derive = reconcileDeviceIdentity({ boothId: "booth-autre", orgId: "org-vrai" }, RESOLVED);
  assert(derive.identity.boothId === "booth-vrai", "boothId dérivé → le serveur gagne, la valeur locale est écrasée");
  assert(derive.drift.length === 1 && derive.drift[0] === "boothId", "boothId dérivé → signalé, et lui seul");

  // Les deux à la fois : borne recréée dans une autre org.
  const deux = reconcileDeviceIdentity({ boothId: "b-x", orgId: "o-x" }, RESOLVED);
  assert(deux.drift.length === 2 && deux.drift.includes("orgId"), "boothId + orgId dérivés → les deux sont nommés");
  assert(deux.identity.orgId === "org-vrai", "orgId dérivé → le serveur gagne aussi sur l'org");
}

function testOfflineCatalog(): void {
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  const ORG = "org-a";
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-07-30T12:00:00.000Z");
  const snap = (over: Record<string, unknown> = {}) => ({
    version: 1,
    orgId: ORG,
    savedAt: new Date(NOW - DAY).toISOString(),
    films: [makeFilm({ contentHash: H1, title: "Le Perchoir" })],
    ...over,
  });
  const run = (over: Record<string, unknown> = {}, local = [H1], orgId = ORG, now = NOW) =>
    restoreOfflineCatalog({ snapshot: snap(over), localMedia: new Set(local), orgId, now });

  console.log("O1. Le cas nominal : catalogue restauré, URL RECALCULÉE depuis le disque");
  {
    const r = run();
    assert(r.reason === "restored" && r.films.length === 1, "instantané récent + média présent → restauré");
    assert(r.films[0].storageUrl === `/media/${H1}`, "URL locale recalculée (jamais l'URL signée conservée, qui serait expirée)");
  }

  console.log("O2. L'intersection avec le disque est la règle : pas de fichier, pas de film");
  {
    const r = run({}, []); // instantané valide, disque vide
    assert(r.reason === "no-local-media" && r.films.length === 0, "aucun média sur disque → catalogue VIDE");
    assert(r.missingLocally === 1, "le film manquant est COMPTÉ (c'est la mesure de l'écart à combler)");
    const partial = restoreOfflineCatalog({
      snapshot: snap({ films: [makeFilm({ contentHash: H1 }), makeFilm({ contentHash: H2 })] }),
      localMedia: new Set([H1]),
      orgId: ORG,
      now: NOW,
    });
    assert(partial.films.length === 1 && partial.missingLocally === 1, "restauration PARTIELLE : on garde ce qui est projetable");
  }

  console.log("O3. Le temps périme le catalogue — dans le doute, on ne joue pas");
  {
    assert(run({ savedAt: new Date(NOW - 6 * DAY).toISOString() }).reason === "restored", "6 jours < fenêtre → encore digne de confiance");
    const old = run({ savedAt: new Date(NOW - 8 * DAY).toISOString() });
    assert(old.reason === "too-old" && old.films.length === 0, "8 jours > fenêtre → VIDE (une licence a pu expirer entre-temps)");
    assert(old.ageMs !== null && old.ageMs > 7 * DAY, "l'âge est remonté pour le diagnostic sur place");
  }

  console.log("O4. Horloge qui recule : on refuse d'en juger les droits");
  {
    // Pile RTC morte, ou quelqu'un qui recule l'horloge pour rouvrir une fenêtre fermée.
    const back = run({}, [H1], ORG, NOW - 3 * DAY);
    assert(back.reason === "clock-behind" && back.films.length === 0, "horloge nettement AVANT l'instantané → VIDE");
    // Petite dérive : tolérée, sinon toute borne sans NTP finirait muette.
    const drift = run({}, [H1], ORG, NOW - DAY - 5 * 60_000);
    assert(drift.reason === "restored", "5 minutes de dérive → toléré, la borne continue de servir");
  }

  console.log("O5. Un instantané d'une AUTRE org n'est jamais servi (borne réaffectée)");
  {
    const r = run({}, [H1], "org-b");
    assert(r.reason === "other-org" && r.films.length === 0, "orgId différent → ignoré en bloc");
    assert(run({ orgId: undefined }).reason === "other-org", "orgId absent → ignoré (jamais 'on suppose que c'est le nôtre')");
  }

  console.log("O6. Tout instantané douteux vaut une absence d'instantané — jamais un crash");
  {
    const bad = (snapshot: unknown) => restoreOfflineCatalog({ snapshot, localMedia: new Set([H1]), orgId: ORG, now: NOW });
    assert(bad(null).reason === "no-snapshot", "null → aucun catalogue");
    assert(bad("bonjour").reason === "no-snapshot", "chaîne → aucun catalogue");
    assert(bad({ version: 2, orgId: ORG, savedAt: new Date().toISOString(), films: [] }).reason === "no-snapshot", "version inconnue → aucun catalogue");
    assert(bad({ version: 1, orgId: ORG, savedAt: "pas une date", films: [] }).reason === "no-snapshot", "date illisible → aucun catalogue");
    assert(bad({ version: 1, orgId: ORG, savedAt: new Date(NOW).toISOString(), films: "beaucoup" }).reason === "no-snapshot", "films non-tableau → aucun catalogue");
    assert(run({ films: [] }).reason === "empty-snapshot", "instantané vide → vide, et on sait le dire");
    // Entrées pourries au milieu d'entrées saines : on garde les saines, on ne tombe pas.
    const mixed = restoreOfflineCatalog({
      snapshot: snap({ films: [null, 7, { contentHash: "../../etc/passwd" }, makeFilm({ contentHash: H1 })] }),
      localMedia: new Set([H1, "../../etc/passwd"]),
      orgId: ORG,
      now: NOW,
    });
    assert(mixed.films.length === 1, "entrées invalides ignorées, la bonne entrée survit");
    assert(mixed.films[0].storageUrl === `/media/${H1}`, "et l'empreinte hors forme n'a produit aucune URL");
  }

  console.log("O7. Chaque refus se DIT — une borne muette sans explication est une borne en panne");
  {
    const reasons = ["no-snapshot", "other-org", "too-old", "clock-behind", "empty-snapshot", "no-local-media"] as const;
    for (const reason of reasons) {
      const msg = describeOfflineCatalog({ films: [], reason, ageMs: 9 * DAY, missingLocally: 2 });
      assert(msg.length > 20 && !msg.includes("undefined"), `diagnostic écrit pour « ${reason} »`);
    }
    assert(describeOfflineCatalog(run()).includes("1 film"), "le cas nominal annonce le nombre de films");
  }
}

function main(): void {
  console.log("=== RECO : RuleBasedRecommender ===");
  testReco();
  console.log("\n=== SESSION : SessionManager ===");
  testSession();
  console.log("\n=== CATALOGUE JOUABLE : auditCatalog ===");
  testPlayableCatalog();
  console.log("\n=== PROVISIONNEMENT : normalizeDeviceError ===");
  testDeviceError();
  console.log("\n=== MÉDIAS LOCAUX : localMediaUrl + normalizeMediaLibrary ===");
  testLocalMedia();
  console.log("\n=== IDENTITÉ DEVICE : reconcileDeviceIdentity ===");
  testDeviceIdentity();
  console.log("\n=== CATALOGUE HORS LIGNE : restoreOfflineCatalog ===");
  testOfflineCatalog();
  console.log(`\n✅ logic_smoke : ${passed} assertions vérifiées (reco + session + catalogue + provisionnement + médias locaux + identité device + hors-ligne)`);
}

try {
  main();
} catch (err) {
  console.error("\n❌ logic_smoke a échoué :", err instanceof Error ? err.message : err);
  process.exit(1);
}
