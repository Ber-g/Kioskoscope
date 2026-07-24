// Kioskoscope — Preuve d'isolation multi-org (RLS).
// @qa : ce test attaque la base avec DEUX sessions authentifiées réelles (clé anon
// + JWT de chaque compte), JAMAIS en service_role. Le SQL editor de Supabase bypasse
// la RLS : il ne prouve rien. Ici, chaque requête porte le JWT d'un super_user scoping
// une seule org — on vérifie qu'il ne peut NI lire NI écrire les données de l'autre org.
//
// Fuite tolérée = 0. Toute fuite → exit(1). Un contrôle positif (l'user PEUT agir sur
// SA propre org) garantit que le test détecte aussi les autorisations légitimes —
// sinon une base « deny all » passerait à tort.
//
// Prérequis (voir README.md) :
//   1. seed.sql appliqué (orgs a1..a4 existent).
//   2. Deux comptes Auth créés, NON global_admin, avec memberships super_user :
//        user A → org A (…a1),  user B → org B (…a2)  (setup_isolation.sql).
//   3. Variables d'environnement : ISO_A_EMAIL/ISO_A_PASSWORD, ISO_B_EMAIL/ISO_B_PASSWORD.
//      URL + clé anon lues depuis admin-dashboard/.env (ou VITE_SUPABASE_* dans l'env).
//
// Lancement :
//   ISO_A_EMAIL=… ISO_A_PASSWORD=… ISO_B_EMAIL=… ISO_B_PASSWORD=… \
//     node supabase/tests/isolation.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

// ── Config ───────────────────────────────────────────────────────────────────
// Orgs de test : UUID fixes du seed. Surchargées via ISO_ORG_A / ISO_ORG_B.
const ORG_A = process.env.ISO_ORG_A ?? "00000000-0000-0000-0000-0000000000a1";
const ORG_B = process.env.ISO_ORG_B ?? "00000000-0000-0000-0000-0000000000a2";

/** Lit VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY depuis l'env, sinon depuis admin-dashboard/.env. */
function loadSupabaseConfig() {
  let url = process.env.VITE_SUPABASE_URL;
  let anon = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    try {
      const envPath = resolve(repoRoot, "admin-dashboard", ".env");
      for (const raw of readFileSync(envPath, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key === "VITE_SUPABASE_URL" && !url) url = val;
        if (key === "VITE_SUPABASE_ANON_KEY" && !anon) anon = val;
      }
    } catch {
      /* .env absent : on tombera sur l'erreur de config ci-dessous */
    }
  }
  return { url, anon };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ Variable d'environnement manquante : ${name}`);
    console.error("  Voir supabase/tests/README.md pour la procédure de setup.");
    process.exit(2);
  }
  return v;
}

// ── Micro-harnais d'assertions ───────────────────────────────────────────────
let failures = 0;
let checks = 0;
function assert(cond, label) {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✖ ${label}`);
  }
}

// ── Batteries de tests par tenant ────────────────────────────────────────────
/**
 * Exécute la batterie de tests pour un acteur `self` (super_user sur `ownOrg`)
 * qui tente d'accéder aux données de `otherOrg`.
 */
async function runTenantSuite(name, client, ownOrg, otherOrg) {
  console.log(`\n▸ ${name} (membre de ${ownOrg}) — tentatives contre ${otherOrg}`);

  // 1. Lecture booths : ne doit voir QUE sa propre org.
  {
    const { data, error } = await client.from("booths").select("id, organization_id");
    assert(!error, `booths lisibles sans erreur (${error?.message ?? "ok"})`);
    const rows = data ?? [];
    const leak = rows.filter((r) => r.organization_id !== ownOrg);
    assert(leak.length === 0, `booths : aucune fuite cross-org (${leak.length} fuite(s))`);
  }

  // 2. Lecture organizations : ne doit voir QUE sa propre org.
  {
    const { data } = await client.from("organizations").select("id");
    const ids = (data ?? []).map((r) => r.id);
    assert(ids.every((id) => id === ownOrg), `organizations : ne voit que la sienne (${ids.length} visible(s))`);
    assert(!ids.includes(otherOrg), `organizations : l'org adverse est invisible`);
  }

  // 3. Lecture media : aucune fuite.
  {
    const { data } = await client.from("media").select("id, organization_id");
    const leak = (data ?? []).filter((r) => r.organization_id !== ownOrg);
    assert(leak.length === 0, `media : aucune fuite cross-org (${leak.length} fuite(s))`);
  }

  // 4. Sonde directe : filtrer explicitement sur l'org adverse doit renvoyer VIDE.
  {
    const { data } = await client.from("booths").select("id").eq("organization_id", otherOrg);
    assert((data ?? []).length === 0, `sonde booths where org=adverse → 0 ligne`);
  }
  {
    const { data } = await client.from("sessions").select("id").eq("organization_id", otherOrg);
    assert((data ?? []).length === 0, `sonde sessions where org=adverse → 0 ligne`);
  }

  // 5. Écriture cross-org (INSERT) : doit être REFUSÉE par la RLS (with check).
  {
    const { data, error } = await client
      .from("booths")
      .insert({ organization_id: otherOrg, label: "ISO-TEST-INTRUSION" })
      .select();
    const inserted = (data ?? []).length;
    assert(error != null || inserted === 0, `INSERT booth dans l'org adverse → refusé (${error ? "erreur RLS" : inserted + " inséré(s)"})`);
    // Filet : si par malheur une ligne est passée, on la retire.
    if (inserted > 0) {
      await client.from("booths").delete().eq("label", "ISO-TEST-INTRUSION");
    }
  }

  // 6. Écriture cross-org (UPDATE) : ne doit toucher AUCUNE ligne adverse.
  {
    const { data } = await client
      .from("booths")
      .update({ notes: "ISO-TEST-TAMPER" })
      .eq("organization_id", otherOrg)
      .select();
    assert((data ?? []).length === 0, `UPDATE booths de l'org adverse → 0 ligne affectée`);
  }

  // 7. Contrôle POSITIF : l'acteur PEUT écrire dans SA propre org (sinon le test
  //    « passerait » sur une base qui refuse tout). Insert puis cleanup immédiat.
  {
    const { data, error } = await client
      .from("booths")
      .insert({ organization_id: ownOrg, label: "ISO-TEST-SELF" })
      .select("id");
    const okId = data?.[0]?.id;
    assert(!error && okId != null, `contrôle positif : INSERT dans sa propre org autorisé (${error?.message ?? "ok"})`);
    if (okId) {
      const { error: delErr } = await client.from("booths").delete().eq("id", okId);
      assert(!delErr, `cleanup : booth de contrôle supprimé (${delErr?.message ?? "ok"})`);
    }
  }

  // 8. Accès opérateur (CIN-073) : les EMPREINTES de PIN et le journal d'une org ne
  //    doivent jamais fuir vers une autre org (lecture, sonde ou écriture).
  {
    const { data, error } = await client.from("operator_access").select("id, organization_id");
    assert(!error, `operator_access lisible sans erreur (${error?.message ?? "ok"})`);
    const leak = (data ?? []).filter((r) => r.organization_id !== ownOrg);
    assert(leak.length === 0, `operator_access : aucune fuite d'empreintes cross-org (${leak.length} fuite(s))`);
  }
  {
    const { data } = await client.from("operator_access").select("id").eq("organization_id", otherOrg);
    assert((data ?? []).length === 0, `sonde operator_access where org=adverse → 0 ligne`);
  }
  {
    const { data } = await client.from("operator_access_log").select("id, organization_id");
    const leak = (data ?? []).filter((r) => r.organization_id !== ownOrg);
    assert(leak.length === 0, `operator_access_log : aucune fuite de journal cross-org (${leak.length} fuite(s))`);
  }
  {
    const { data, error } = await client
      .from("operator_access")
      .insert({ organization_id: otherOrg, identifier: "ISO-INTRUS-OP", pin_hash: "00", salt: "00", iterations: 210000, role: "operator" })
      .select();
    const inserted = (data ?? []).length;
    assert(error != null || inserted === 0, `INSERT operator_access dans l'org adverse → refusé (${error ? "erreur RLS" : inserted + " inséré(s)"})`);
    if (inserted > 0) await client.from("operator_access").delete().eq("identifier", "ISO-INTRUS-OP");
  }
  {
    // Contrôle positif : un admin d'org PEUT créer un accès dans SA propre org.
    const { data, error } = await client
      .from("operator_access")
      .insert({ organization_id: ownOrg, identifier: "ISO-SELF-OP", pin_hash: "00", salt: "00", iterations: 210000, role: "operator" })
      .select("id");
    const okId = data?.[0]?.id;
    assert(!error && okId != null, `contrôle positif : créer un accès dans sa propre org autorisé (${error?.message ?? "ok"})`);
    if (okId) {
      const { error: delErr } = await client.from("operator_access").delete().eq("id", okId);
      assert(!delErr, `cleanup : accès de contrôle supprimé (${delErr?.message ?? "ok"})`);
    }
  }

  // 9. Autorité des releases (CIN-016) : fabriquer une VERSION est réservé à global_admin.
  //    Un super_user d'org (nos comptes de test) ne doit PAS pouvoir INSÉRER une release
  //    (il DÉPLOIE une version existante via booth_updates, mais ne la crée pas).
  {
    const { data, error } = await client
      .from("releases")
      .insert({ organization_id: ownOrg, version: "ISO-TEST-9.9.9" })
      .select();
    const inserted = (data ?? []).length;
    assert(error != null || inserted === 0, `INSERT release par un super_user → refusé (${error ? "erreur RLS" : inserted + " inséré(s)"})`);
    if (inserted > 0) await client.from("releases").delete().eq("version", "ISO-TEST-9.9.9");
  }

  // 10. Canal MAJ OS (CIN-077) : lecture org-scopée + autorité d'ÉCRITURE = global_admin only.
  //     Un super_user VOIT l'état des patchs de son org mais ne DÉCLENCHE pas (la plateforme
  //     décide). Cross-org : aucune fuite. (Skippe proprement si 0017 pas encore appliquée.)
  {
    const { data, error } = await client.from("os_update_commands").select("id, organization_id");
    if (error && /does not exist|relation|schema cache/i.test(error.message)) {
      assert(true, `os_update_commands : table absente (migration 0017 non appliquée) → bloc ignoré`);
    } else {
      assert(!error, `os_update_commands lisible sans erreur (${error?.message ?? "ok"})`);
      const leak = (data ?? []).filter((r) => r.organization_id !== ownOrg);
      assert(leak.length === 0, `os_update_commands : aucune fuite cross-org (${leak.length} fuite(s))`);

      const probe = await client.from("os_update_commands").select("id").eq("organization_id", otherOrg);
      assert((probe.data ?? []).length === 0, `sonde os_update_commands where org=adverse → 0 ligne`);

      // Autorité : même dans SA propre org, un super_user ne peut pas créer une commande.
      const { data: bd } = await client.from("booths").select("id").eq("organization_id", ownOrg).limit(1);
      const boothId = bd?.[0]?.id;
      if (boothId) {
        const { data: ins, error: insErr } = await client
          .from("os_update_commands")
          .insert({ organization_id: ownOrg, booth_id: boothId, status: "pending" })
          .select();
        const inserted = (ins ?? []).length;
        assert(insErr != null || inserted === 0, `INSERT commande MAJ OS par un super_user → refusé (${insErr ? "erreur RLS" : inserted + " inséré(s)"})`);
        if (inserted > 0) await client.from("os_update_commands").delete().eq("id", ins[0].id);
      }
    }
  }

  // 11. Style d'org « Mes styles » (F19) : un super_user écrit le style de SON org, mais JAMAIS
  //     celui d'une autre org ; lecture cross-org = 0 fuite. (Skippe si 0018 pas appliquée.)
  {
    const { data, error } = await client.from("org_styles").select("organization_id, title");
    if (error && /does not exist|relation|schema cache/i.test(error.message)) {
      assert(true, `org_styles : table absente (migration 0018 non appliquée) → bloc ignoré`);
    } else {
      assert(!error, `org_styles lisible sans erreur (${error?.message ?? "ok"})`);
      const leak = (data ?? []).filter((r) => r.organization_id !== ownOrg);
      assert(leak.length === 0, `org_styles : aucune fuite cross-org (${leak.length} fuite(s))`);

      const probe = await client.from("org_styles").select("organization_id").eq("organization_id", otherOrg);
      assert((probe.data ?? []).length === 0, `sonde org_styles where org=adverse → 0 ligne`);

      // Sécurité : écrire le style de l'org ADVERSE → refusé (super_user ≠ global_admin, autre org).
      const { data: ins, error: insErr } = await client
        .from("org_styles")
        .insert({ organization_id: otherOrg, title: "ISO-INTRUS-STYLE" })
        .select();
      const intruded = (ins ?? []).length;
      assert(insErr != null || intruded === 0, `INSERT org_styles dans l'org adverse → refusé (${insErr ? "erreur RLS" : intruded + " inséré(s)"})`);
      if (intruded > 0) await client.from("org_styles").delete().eq("organization_id", otherOrg);

      // Contrôle positif NON destructif : n'écrire dans sa propre org QUE si aucune ligne n'existe
      // (sinon on écraserait un vrai style) → insert puis delete. Sinon on note le skip.
      const own = (data ?? []).find((r) => r.organization_id === ownOrg);
      if (!own) {
        const { data: mine, error: myErr } = await client
          .from("org_styles")
          .insert({ organization_id: ownOrg, title: "ISO-SELF-STYLE" })
          .select();
        const okCreated = (mine ?? []).length === 1;
        assert(!myErr && okCreated, `contrôle positif : écrire le style de SA propre org autorisé (${myErr?.message ?? "ok"})`);
        if (okCreated) await client.from("org_styles").delete().eq("organization_id", ownOrg);
      } else {
        assert(true, `contrôle positif : style d'org déjà présent → écriture propre non retestée (non destructif)`);
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { url, anon } = loadSupabaseConfig();
  if (!url || !anon) {
    console.error("✖ VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY introuvables (env ou admin-dashboard/.env).");
    process.exit(2);
  }
  const aEmail = requireEnv("ISO_A_EMAIL");
  const aPass = requireEnv("ISO_A_PASSWORD");
  const bEmail = requireEnv("ISO_B_EMAIL");
  const bPass = requireEnv("ISO_B_PASSWORD");

  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const clientA = createClient(url, anon, opts);
  const clientB = createClient(url, anon, opts);

  console.log("Kioskoscope — preuve d'isolation multi-org (RLS)");
  console.log(`Projet   : ${url}`);
  console.log(`Org A    : ${ORG_A}\nOrg B    : ${ORG_B}`);

  const signIn = async (client, email, password, who) => {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      console.error(`✖ Connexion ${who} (${email}) échouée : ${error.message}`);
      console.error("  Le compte existe-t-il et son email est-il confirmé ? (voir README.md)");
      process.exit(2);
    }
  };
  await signIn(clientA, aEmail, aPass, "user A");
  await signIn(clientB, bEmail, bPass, "user B");

  // Garde-fou : si un compte de test est global_admin, il bypasse la RLS → test invalide.
  for (const [client, who] of [[clientA, "A"], [clientB, "B"]]) {
    const { data } = await client.from("users").select("is_global_admin").limit(1);
    if (data?.[0]?.is_global_admin) {
      console.error(`✖ Le compte de test ${who} est global_admin — il bypasse la RLS, test invalide.`);
      console.error("  Utilise des comptes NON global_admin pour cette preuve.");
      process.exit(2);
    }
  }

  await runTenantSuite("User A", clientA, ORG_A, ORG_B);
  await runTenantSuite("User B", clientB, ORG_B, ORG_A);

  await runDeviceSuite(url, anon);

  console.log(`\n── Résultat : ${checks - failures}/${checks} vérifications OK ──`);
  if (failures > 0) {
    console.error(`✖ ISOLATION COMPROMISE : ${failures} vérification(s) en échec.`);
    process.exit(1);
  }
  console.log("✓ ISOLATION PROUVÉE : aucune fuite cross-org (lecture ni écriture).");
}

// ── Suite DEVICE ───────────────────────────────────────────────────────────────
// Prouve qu'un COMPTE BORNE (device) ne voit/écrit que SON org — le scénario que la suite
// tenant (comptes super_user) ne couvre pas, et exactement le risque du compte partagé multi-org.
// Optionnelle : fournir ISO_DEVICE_EMAIL / ISO_DEVICE_PASSWORD d'un compte borne « nu » relié à une
// borne. On DÉDUIT son org depuis le catalogue qu'il lit (pas d'hypothèse a1/a2). Skip si absent.
async function runDeviceSuite(url, anon) {
  const email = process.env.ISO_DEVICE_EMAIL;
  const password = process.env.ISO_DEVICE_PASSWORD;
  console.log(`\n▸ Device (compte borne « nu »)`);
  if (!email || !password) {
    assert(true, `bloc device ignoré (ISO_DEVICE_EMAIL / ISO_DEVICE_PASSWORD non fournis)`);
    return;
  }
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signErr } = await client.auth.signInWithPassword({ email, password });
  if (signErr) {
    assert(false, `connexion device (${email}) échouée : ${signErr.message}`);
    return;
  }
  // Garde-fou : un device global_admin bypasserait la RLS → test invalide.
  const who = await client.from("users").select("is_global_admin").limit(1);
  assert(!who.data?.[0]?.is_global_admin, `le compte borne n'est PAS global_admin (sinon bypass RLS)`);

  // Lecture : le device ne voit QUE le catalogue de SON org. On déduit son org des lignes lues.
  const media = await client.from("media").select("organization_id");
  assert(!media.error, `device : lecture catalogue sans erreur (${media.error?.message ?? "ok"})`);
  const rows = media.data ?? [];
  const orgs = [...new Set(rows.map((r) => r.organization_id))];
  assert(orgs.length <= 1, `device : catalogue d'UNE SEULE org (${orgs.length} org(s) vue(s))`);
  const deviceOrg = orgs[0] ?? ORG_A; // repli si catalogue vide
  const adverseOrg = deviceOrg === ORG_A ? ORG_B : ORG_A;

  // Aucune fuite d'une AUTRE org (sonde directe).
  const probeMedia = await client.from("media").select("id").eq("organization_id", adverseOrg);
  assert((probeMedia.data ?? []).length === 0, `device : sonde catalogue org adverse → 0 ligne`);
  const probeStyle = await client.from("org_styles").select("organization_id").eq("organization_id", adverseOrg);
  assert(((probeStyle.data ?? []).length === 0), `device : sonde org_styles org adverse → 0 ligne`);
  const probeOp = await client.from("operator_access").select("id").eq("organization_id", adverseOrg);
  assert((probeOp.data ?? []).length === 0, `device : sonde operator_access org adverse → 0 ligne`);

  // Écriture : le device ne peut pas fabriquer une séance rattachée à l'org adverse (RLS with-check
  // booth_id = current_device_booth() + org scoping). booth_id inexistant → refusé de toute façon.
  const fakeBooth = "00000000-0000-0000-0000-0000dead0000";
  const ins = await client.from("sessions").insert({
    organization_id: adverseOrg,
    booth_id: fakeBooth,
    share_token: `ISO-DEV-${Date.now()}`,
    unlock_method: "free",
  }).select();
  const inserted = (ins.data ?? []).length;
  assert(ins.error != null || inserted === 0, `device : INSERT séance dans l'org adverse → refusé (${ins.error ? "refusé" : inserted + " inséré(s)"})`);
  if (inserted > 0) await client.from("sessions").delete().eq("id", ins.data[0].id);
}

main().catch((e) => {
  console.error("✖ Erreur inattendue :", e);
  process.exit(3);
});
