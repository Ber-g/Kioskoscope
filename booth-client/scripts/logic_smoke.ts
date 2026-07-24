// Smoke test DOM-free de la logique CŒUR du booth-client : moteur de
// recommandation (RuleBasedRecommender) + cycle de vie de session (SessionManager).
// Aucun DOM, aucun réseau : on fabrique des fixtures `Film` et on exerce les
// invariants réels lus dans le code (pas devinés). Garde de non-régression.
// Lancer : esbuild scripts/logic_smoke.ts --bundle --platform=node --format=esm \
//   --outfile=node_modules/.cache/logic_smoke.mjs && node node_modules/.cache/logic_smoke.mjs
import { RuleBasedRecommender } from "../src/reco/RuleBasedRecommender";
import type { RecoContext } from "../src/reco/Recommender";
import { SessionManager } from "../src/session/SessionManager";
import { FACTICE_CATALOG } from "../src/domain/catalog";
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
}

function main(): void {
  console.log("=== RECO : RuleBasedRecommender ===");
  testReco();
  console.log("\n=== SESSION : SessionManager ===");
  testSession();
  console.log(`\n✅ logic_smoke : ${passed} assertions vérifiées (reco + session)`);
}

try {
  main();
} catch (err) {
  console.error("\n❌ logic_smoke a échoué :", err instanceof Error ? err.message : err);
  process.exit(1);
}
