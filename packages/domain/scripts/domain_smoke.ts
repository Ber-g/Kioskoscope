// Suite de tests DOM-free du domaine — logique PURE et CRITIQUE, sans réseau ni WebCrypto externe
// (crypto.subtle est natif Node 20+). Deux volets :
//   1. Contraste WCAG (F19) : parseHexColor / relativeLuminance / contrastRatio / readableInk.
//   2. Auth opérateur (CIN-073) : verifyOperator (PBKDF2) — bons/mauvais PIN, révoqué, expiré,
//      normalisation d'identifiant, ANTI-ÉNUMÉRATION (l'état n'est révélé qu'après un PIN correct).
// Lancé par `npm run -w @kioskoscope/domain test` et en CI. Sortie non nulle si un invariant casse.

import {
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  readableInk,
  hashPin,
  verifyOperator,
  normalizeIdentifier,
  PBKDF2_ITERATIONS,
  type AccessEntry,
  type AccessTable,
} from "../src/index";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;

async function main(): Promise<void> {
  // ── 1. Contraste WCAG ────────────────────────────────────────────────────────
  console.log("1. Contraste (WCAG)");
  assert(JSON.stringify(parseHexColor("#ffffff")) === JSON.stringify([255, 255, 255]), "parseHexColor #ffffff");
  assert(JSON.stringify(parseHexColor("#000")) === JSON.stringify([0, 0, 0]), "parseHexColor #000 (court)");
  assert(JSON.stringify(parseHexColor("abc")) === JSON.stringify([170, 187, 204]), "parseHexColor abc (sans #, court)");
  assert(parseHexColor("xyz") === null, "parseHexColor invalide (xyz) → null");
  assert(parseHexColor("#12") === null, "parseHexColor invalide (#12) → null");

  assert(near(relativeLuminance("#000000"), 0, 0.001), "luminance noir ≈ 0");
  assert(near(relativeLuminance("#ffffff"), 1, 0.001), "luminance blanc ≈ 1");
  assert(relativeLuminance("#000000") < relativeLuminance("#808080"), "noir < gris moyen");

  assert(near(contrastRatio("#000000", "#ffffff"), 21, 0.1), "contraste noir/blanc ≈ 21");
  assert(near(contrastRatio("#123456", "#123456"), 1, 0.001), "contraste couleur identique = 1");
  assert(contrastRatio("#000000", "#ffffff") >= 4.5, "noir/blanc passe AA (≥ 4.5)");
  assert(contrastRatio("#777777", "#888888") < 4.5, "gris proches échouent AA");

  assert(readableInk("#0a0a0c") === "#f4f2ee", "encre sur fond sombre = claire");
  assert(readableInk("#ffffff") === "#1a1206", "encre sur fond clair = foncée");
  assert(readableInk("#000000", "#111", "#eee") === "#eee", "readableInk respecte les encres fournies");

  // ── 2. Auth opérateur (PBKDF2) ───────────────────────────────────────────────
  console.log("2. Auth opérateur (verifyOperator / PBKDF2)");
  const salt = "00112233445566778899aabbccddeeff";
  const PIN = "246810";
  const goodHash = await hashPin(PIN, salt, PBKDF2_ITERATIONS);
  const mk = (over: Partial<AccessEntry>): AccessEntry => ({
    identifier: "PERCHOIR-CAB001-OP",
    pinHash: goodHash,
    salt,
    iterations: PBKDF2_ITERATIONS,
    role: "operator",
    expiresAt: null,
    revoked: false,
    ...over,
  });
  const table: AccessTable = {
    orgId: "org-a",
    boothId: "booth-1",
    updatedAt: new Date().toISOString(),
    entries: [
      mk({}),
      mk({ identifier: "PERCHOIR-CAB001-REV", revoked: true }),
      mk({ identifier: "PERCHOIR-CAB001-EXP", expiresAt: "2000-01-01T00:00:00.000Z" }),
    ],
  };

  const ok = await verifyOperator(table, "PERCHOIR-CAB001-OP", PIN);
  assert(ok.ok === true && ok.role === "operator" && ok.identifier === "PERCHOIR-CAB001-OP", "PIN correct → ok + rôle");

  const wrong = await verifyOperator(table, "PERCHOIR-CAB001-OP", "000000");
  assert(wrong.ok === false && wrong.reason === "invalid", "PIN faux → invalid");

  const unknown = await verifyOperator(table, "INCONNU", PIN);
  assert(unknown.ok === false && unknown.reason === "invalid", "identifiant inconnu → invalid");

  const revoked = await verifyOperator(table, "PERCHOIR-CAB001-REV", PIN);
  assert(revoked.ok === false && revoked.reason === "revoked", "révoqué + PIN correct → revoked");

  const expired = await verifyOperator(table, "PERCHOIR-CAB001-EXP", PIN);
  assert(expired.ok === false && expired.reason === "expired", "expiré + PIN correct → expired");

  const normalized = await verifyOperator(table, "  perchoir-cab001-op  ", PIN);
  assert(normalized.ok === true, "identifiant normalisé (espaces + minuscules) → match");
  assert(normalizeIdentifier("  x-y  ") === "X-Y", "normalizeIdentifier trim + majuscules");

  // ANTI-ÉNUMÉRATION : sur un compte RÉVOQUÉ avec un PIN FAUX, on ne révèle PAS « revoked »
  // (l'état n'est divulgué qu'après un PIN correct) → doit répondre « invalid ».
  const revokedWrongPin = await verifyOperator(table, "PERCHOIR-CAB001-REV", "000000");
  assert(revokedWrongPin.ok === false && revokedWrongPin.reason === "invalid", "révoqué + PIN faux → invalid (anti-énumération)");

  console.log(`\n—— ${passed}/${passed + failed} assertions OK ——`);
  if (failed > 0) {
    console.error(`✗ ${failed} test(s) du domaine en échec.`);
    process.exit(1);
  }
  console.log("✅ domain_smoke : contraste WCAG + auth opérateur vérifiés.");
}

main().catch((e) => {
  console.error("✗ Erreur inattendue :", e);
  process.exit(2);
});
