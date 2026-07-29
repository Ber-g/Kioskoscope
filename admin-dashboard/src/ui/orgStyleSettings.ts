// Onglet « Mes styles » (F19, volet dashboard) — une org (super_user) définit le style de ses
// cabines : 7 couleurs, 3 fontes, 1 titre. Aperçu live d'un écran cabine + contrôle de contraste
// automatique (WCAG). Réinitialisation au style maître Kioskoscope (super_user de l'org ou
// global_admin). Le type `OrgStyle` et les helpers de contraste viennent de @kioskoscope/domain
// (source UNIQUE cabine + dashboard — on ne les redéfinit jamais ici).
//
// Précédence de rendu côté cabine (rappel) : maître Kioskoscope < style d'org (défini ici) <
// humeur runtime. Un slot laissé vide retombe sur le maître. La mention « propulsé par
// Kioskoscope » est NON supprimable dans l'aperçu — elle l'est aussi côté cabine.

import { contrastRatio, parseHexColor, readableInk } from "@kioskoscope/domain";
import type { OrgStyle, OrgStyleAssets, OrgStyleFonts, OrgStylePalette } from "@kioskoscope/domain";
import type { FleetStore, OrgAssetKind, OrgSummary } from "../data/store";
import { el, formatBytes, icon } from "./dom";

/** Brouillons éditables (mutables, cordes) alignés sur la forme figée du domaine. */
type PaletteDraft = { -readonly [K in keyof OrgStylePalette]?: string };
type FontsDraft = { -readonly [K in keyof OrgStyleFonts]?: string };
type AssetsDraft = { -readonly [K in keyof OrgStyleAssets]?: string };

/** Brouillon d'édition NON ENREGISTRÉ (couleurs, fontes, titre en cours de saisie). */
export interface StyleDraft {
  readonly palette: PaletteDraft;
  readonly fonts: FontsDraft;
  title: string;
}

/** Message posé DANS l'écran — pas un toast : un geste destructif se relit, il ne s'attrape pas. */
type Message = { tone: "info" | "ok" | "error"; text: string };

/** Opération en cours sur UN emplacement d'image. */
interface AssetOp {
  phase: "idle" | "preparing" | "uploading" | "saving" | "removing";
  /** Aperçu optimiste du fichier choisi (objet URL). Doit être révoqué sur TOUS les chemins. */
  previewUrl: string | null;
  message: Message | null;
}

/** Tout ce que l'écran « Mes styles » d'UNE org doit savoir, et que le rendu ne doit pas porter. */
interface StyleUi {
  draft: StyleDraft | null;
  write: "idle" | "saving" | "resetting";
  message: Message | null;
  assets: Map<OrgAssetKind, AssetOp>;
}

/**
 * État d'écran conservé HORS du cycle de rendu, par organisation (BUG-006, étendu).
 *
 * Pourquoi le brouillon : écrire en base → `emit()` → l'App se re-rend entièrement et reconstruit
 * cet éditeur. Tant que les couleurs en cours de saisie vivaient dans la closure de `editor()`,
 * ce re-render les effaçait — l'opérateur perdait ses modifs sans le moindre avertissement.
 * N'IMPORTE quel `emit()` du store (autre onglet, action concurrente) avait cet effet.
 *
 * Pourquoi l'état d'OPÉRATION (`write`, `assets`) vit ici AUSSI : un envoi ou une réinitialisation
 * dure ; pendant ce temps un rafraîchissement (CIN-117, retour d'onglet) peut reconstruire la
 * page. Si le témoin « envoi en cours » vivait dans le rendu, il disparaîtrait en plein vol et
 * l'opérateur croirait le geste perdu — exactement le même bug, une porte plus loin.
 *
 * La règle qui gouverne tout ce fichier : **ce qui doit survivre à un rendu est écrit ici, AVANT
 * de céder la main**. Une continuation d'`await` ne touche JAMAIS un nœud DOM qu'elle a capturé
 * (il est détaché depuis longtemps) : elle mute cet état, puis redemande un rendu depuis le haut.
 *
 * Clé = id d'organisation : changer d'org n'hérite jamais de l'état d'une autre.
 * Les `assets` enregistrés, eux, viennent toujours du store — ici on ne garde que l'opération.
 */
const UI = new Map<string, StyleUi>();

function uiFor(orgId: string): StyleUi {
  let ui = UI.get(orgId);
  if (!ui) {
    ui = { draft: null, write: "idle", message: null, assets: new Map() };
    UI.set(orgId, ui);
  }
  return ui;
}

function assetOpFor(ui: StyleUi, kind: OrgAssetKind): AssetOp {
  let op = ui.assets.get(kind);
  if (!op) {
    op = { phase: "idle", previewUrl: null, message: null };
    ui.assets.set(kind, op);
  }
  return op;
}

/**
 * Oublie l'état d'écran d'organisations dont le style vient d'être réinitialisé AILLEURS
 * (réinitialisation par lot depuis le roster). Sans cet oubli, un brouillon laissé sur une de ces
 * orgs ressusciterait à la réouverture de son onglet « Mes styles » et ré-appliquerait des
 * couleurs que l'on vient justement d'effacer — même bug, autre porte.
 */
export function forgetOrgStyleUi(orgIds: readonly string[]): void {
  for (const id of orgIds) {
    const ui = UI.get(id);
    if (!ui) continue;
    // Les aperçus optimistes sont des objets URL : les abandonner sans les révoquer fuit.
    for (const op of ui.assets.values()) if (op.previewUrl) URL.revokeObjectURL(op.previewUrl);
    UI.delete(id);
  }
}

/**
 * D'où viennent les valeurs AFFICHÉES : le brouillon s'il existe, sinon la vérité du store.
 *
 * Un seul endroit décide, et c'est une fonction pure — cet arbitrage est la charnière de
 * BUG-006 (le brouillon doit gagner) ET de la réinitialisation (le brouillon purgé doit rendre
 * la main au store). Le laisser en ligne dans le rendu, c'est le laisser diverger.
 */
export function seedDraft(existing: OrgStyle | null, ui: { readonly draft: StyleDraft | null }): StyleDraft {
  if (ui.draft) return ui.draft;
  return {
    palette: { ...(existing?.palette ?? {}) },
    fonts: { ...(existing?.fonts ?? {}) },
    title: existing?.title ?? "",
  };
}

// Valeurs du style MAÎTRE Kioskoscope (miroir des tokens cabine, thème sombre). Servent de
// repli pour l'aperçu et de placeholder « héritée » des champs. Une modification du maître
// côté cabine devra être reflétée ici (constante volontairement locale au dashboard).
const MASTER_PALETTE: OrgStylePalette = {
  bg: "#0a0a0c",
  surface: "#17171b",
  surfaceRaised: "#202027",
  accent: "#e8b45a",
  accent2: "#8ecbff",
  text: "#f4f2ee",
  textEmphasis: "#ffffff",
};
const MASTER_FONTS: OrgStyleFonts = {
  display: '"Georgia", "Iowan Old Style", "Times New Roman", serif',
  body: '"Georgia", "Iowan Old Style", "Times New Roman", serif',
  ui: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
const MASTER_TITLE = "Kioskoscope";

const COLOR_SLOTS: ReadonlyArray<{ key: keyof OrgStylePalette; label: string; hint: string }> = [
  { key: "bg", label: "Fond", hint: "Fond profond de la salle (dominante 1)." },
  { key: "surface", label: "Surface", hint: "Cartes et panneaux (dominante 2)." },
  { key: "surfaceRaised", label: "Surface surélevée", hint: "Boutons neutres, éléments actifs (dominante 3)." },
  { key: "accent", label: "Accent chaud", hint: "Actions et sélection (ambre projecteur par défaut)." },
  { key: "accent2", label: "Accent froid", hint: "Focus et lueur d'écran (cyan CRT par défaut)." },
  { key: "text", label: "Texte", hint: "Corps de texte courant." },
  { key: "textEmphasis", label: "Texte accentué", hint: "Titres et chiffres mis en valeur." },
];

const FONT_ROLES: ReadonlyArray<{ key: keyof OrgStyleFonts; label: string; hint: string }> = [
  { key: "display", label: "Titrage", hint: "Pile CSS font-family des titres." },
  { key: "body", label: "Corps", hint: "Pile CSS du texte courant." },
  { key: "ui", label: "Interface", hint: "Pile CSS des boutons et données." },
];

// Couples encre/fond contrôlés par l'opérateur, testés au seuil AA (4.5:1). L'encre de
// l'accent est calculée automatiquement (readableInk) → jamais dans cette liste.
const CONTRAST_PAIRS: ReadonlyArray<{ ink: keyof OrgStylePalette; bg: keyof OrgStylePalette; label: string }> = [
  { ink: "text", bg: "bg", label: "le texte courant sur le fond" },
  { ink: "textEmphasis", bg: "bg", label: "le texte accentué sur le fond" },
  { ink: "text", bg: "surface", label: "le texte sur les surfaces" },
  { ink: "text", bg: "surfaceRaised", label: "le texte sur les surfaces surélevées" },
];

const AA_THRESHOLD = 4.5;

// ── Assets de marque (F19 v2) ─────────────────────────────────────────────────
// 4 visuels : logo clair, logo sombre, image d'attente, bandeau. Chacun est recadré au ratio
// cible (center-crop canvas natif — aucune dépendance externe) puis compressé en WebP avant
// upload. `ratio` null = pas de recadrage (logo), seulement un plafond de hauteur.
type AssetSlot = {
  readonly kind: OrgAssetKind;
  readonly field: keyof OrgStyleAssets;
  readonly label: string;
  readonly hint: string;
  readonly ratio: number | null; // largeur/hauteur cible ; null = ratio libre (logos)
  readonly maxH: number; // hauteur de sortie maximale (px) — borne le poids et évite l'upscale abusif
  readonly darkPreview: boolean; // aperçu sur fond sombre (logo destiné aux fonds sombres)
};

const ASSET_SLOTS: ReadonlyArray<AssetSlot> = [
  { kind: "logo-light", field: "logoLight", label: "Logo — version claire", hint: "Logo posé sur fonds clairs (PNG/SVG transparent conseillé). Ratio libre, hauteur normalisée.", ratio: null, maxH: 240, darkPreview: false },
  { kind: "logo-dark", field: "logoDark", label: "Logo — version sombre", hint: "Logo posé sur fonds sombres (les cabines sont sombres par défaut). Ratio libre, hauteur normalisée.", ratio: null, maxH: 240, darkPreview: true },
  { kind: "idle", field: "idleImage", label: "Image d'attente", hint: "Visuel plein écran de l'écran de veille. Recadré au format 16:9.", ratio: 16 / 9, maxH: 1080, darkPreview: true },
  { kind: "banner", field: "banner", label: "Bandeau", hint: "Bandeau large (en-tête). Recadré au format ~4:1.", ratio: 4 / 1, maxH: 400, darkPreview: true },
];

const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 20 Mo — garde-fou avant décodage
const WEBP_RECOMPRESS_THRESHOLD = 500 * 1024; // au-delà : ré-encodage plus agressif (q 0.85)

/**
 * Recadre (center-crop au ratio cible) puis compresse une image en WebP via canvas natif.
 * Encodage haute qualité (0.92) par défaut ; ré-encodage à 0.85 UNIQUEMENT si le résultat
 * dépasse 500 Ko. Lève une erreur au message humain si l'image est illisible/non supportée.
 */
async function toWebpAsset(file: File, ratio: number | null, maxH: number): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Image illisible ou format non pris en charge.");
  }
  try {
    const sw = bitmap.width;
    const sh = bitmap.height;
    if (!sw || !sh) throw new Error("Image aux dimensions invalides.");

    // Zone source (recadrage centré) — pleine image si ratio libre.
    let sx = 0;
    let sy = 0;
    let cropW = sw;
    let cropH = sh;
    if (ratio !== null) {
      if (sw / sh > ratio) {
        cropW = Math.round(sh * ratio);
        sx = Math.round((sw - cropW) / 2);
      } else {
        cropH = Math.round(sw / ratio);
        sy = Math.round((sh - cropH) / 2);
      }
    }

    const outH = Math.min(maxH, cropH);
    const outW = ratio !== null ? Math.round(outH * ratio) : Math.round((cropW * outH) / cropH);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, outW);
    canvas.height = Math.max(1, outH);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas indisponible sur ce navigateur.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);

    const encode = (q: number): Promise<Blob | null> =>
      new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/webp", q));
    let blob = await encode(0.92);
    if (!blob) throw new Error("Encodage WebP non pris en charge par ce navigateur.");
    if (blob.size > WEBP_RECOMPRESS_THRESHOLD) {
      const smaller = await encode(0.85);
      if (smaller) blob = smaller;
    }
    return blob;
  } finally {
    bitmap.close();
  }
}

/** #rgb / #rrggbb → #rrggbb minuscule (format exigé par <input type=color>). Vide si invalide. */
function normHex(hex: string): string {
  const rgb = parseHexColor(hex);
  if (!rgb) return "";
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

// ── Anneau d'envoi à 3 crans (BUG-013) ────────────────────────────────────────
// Pourquoi PAS de pourcentage : `supabase-js` v2 téléverse en `fetch`, qui n'expose aucune
// progression d'envoi (ni `onUploadProgress`, ni XHR). Un pourcentage serait donc une animation
// qui MENT — une barre qui avance sans rien mesurer est pire que pas de barre du tout.
// Ce qu'on sait vraiment, ce sont les trois étapes franchies. On montre exactement ça : les
// crans acquis sont pleins, et l'attente DANS le cran courant tourne, sans prétendre la mesurer.
const RING_STEP_LABELS = ["Préparation", "Envoi", "Enregistrement"] as const;
const RING_STYLE_ID = "kioskoscope-upload-ring";

function ensureRingStyle(): void {
  if (document.getElementById(RING_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = RING_STYLE_ID;
  style.textContent =
    "@keyframes ks-ring-spin{to{transform:rotate(360deg)}}" +
    ".ks-ring-spin{transform-origin:50% 50%;animation:ks-ring-spin 1.1s linear infinite}" +
    "@media (prefers-reduced-motion:reduce){.ks-ring-spin{animation-duration:3s}}";
  document.head.append(style);
}

function svgNode(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** `done` = nombre de crans franchis (0 à 3). */
function uploadRing(done: number): SVGElement {
  ensureRingStyle();
  const r = 16;
  const circumference = 2 * Math.PI * r;
  const arc = circumference / 3 - 4; // 4px de respiration entre deux crans
  const base = { cx: "22", cy: "22", r: String(r), fill: "none", "stroke-width": "3", "stroke-linecap": "round" };
  const svg = svgNode("svg", { viewBox: "0 0 44 44", width: "44", height: "44", role: "img", "aria-hidden": "true" });
  for (let i = 0; i < 3; i++) {
    svg.append(
      svgNode("circle", {
        ...base,
        stroke: i < done ? "var(--tblr-primary)" : "var(--tblr-border-color)",
        "stroke-dasharray": `${arc} ${circumference - arc}`,
        "stroke-dashoffset": String(-i * (circumference / 3)),
        transform: "rotate(-90 22 22)",
      }),
    );
  }
  svg.append(
    svgNode("circle", {
      ...base,
      class: "ks-ring-spin",
      stroke: "var(--tblr-primary)",
      "stroke-dasharray": `6 ${circumference - 6}`,
    }),
  );
  return svg;
}

/** Nombre de crans franchis pour une phase d'opération. */
function ringSteps(phase: AssetOp["phase"]): number {
  return phase === "preparing" ? 1 : phase === "uploading" ? 2 : phase === "saving" ? 3 : 0;
}

/** Message en place — persistant, parce qu'il vit dans l'état d'écran et non dans le rendu. */
function messageLine(m: Message | null, extraClass = ""): HTMLElement {
  if (!m) return el("span", {}, []);
  const tone = m.tone === "error" ? "text-danger" : m.tone === "ok" ? "text-green" : "text-secondary";
  return el("div", { class: `small ${tone} ${extraClass}`, role: "status", "aria-live": "polite" }, [m.text]);
}

/**
 * Onglet « Mes styles ».
 *
 * `onChanged` = « redemande un rendu depuis le haut » (`App.render()`). C'est le SEUL moyen de
 * réafficher cet écran : il n'y a plus de reconstruction locale. L'ancienne version gardait un
 * conteneur et un `rebuild()` maison — mais entre la décision et le `rebuild()`, le store avait
 * déjà réémis : on nettoyait un arbre DÉTACHÉ pendant que l'arbre visible, lui, se ré-ensemençait
 * depuis un brouillon périmé. On ne conserve donc plus rien : on rend l'écran RECONSTRUCTIBLE.
 */
export function orgStyleSettingsTab(store: FleetStore, org: OrgSummary | null, canManage: boolean, onChanged: () => void): HTMLElement {
  if (!org) return el("span", {}, []);

  // Gating (CIN-080/F18) : module « personalization » requis. Le global_admin (super-admin)
  // garde l'accès pour piloter/réinitialiser le style de n'importe quelle org (F20).
  if (!store.hasModule(org.id, "personalization") && !store.isGlobalAdmin) {
    return upsellCard();
  }

  return editor(store, org, canManage, onChanged);
}

/** Carte d'upsell (module non accordé). Style « grisé » cohérent avec les autres modules gatés. */
function upsellCard(): HTMLElement {
  const lockPath = "M6 11V7a4 4 0 0 1 8 0v4M5 11h10a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1H5a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z";
  return el("div", { class: "card" }, [
    el("div", { class: "card-body text-center py-5" }, [
      el("div", { class: "text-secondary mb-3" }, [icon(lockPath, 40)]),
      el("h3", { class: "card-title" }, ["Personnalisation non incluse"]),
      el("p", { class: "text-secondary mb-0" }, [
        "Le module « Mes styles » n'est pas activé pour cette organisation. Il permet de définir les couleurs, les fontes et le titre affichés sur vos cabines. Contactez Kioskoscope pour l'ajouter à votre offre.",
      ]),
    ]),
  ]);
}

function editor(store: FleetStore, org: OrgSummary, canManage: boolean, onChanged: () => void): HTMLElement {
  const existing = store.orgStyleFor(org.id);
  const ui = uiFor(org.id);
  const draft = seedDraft(existing, ui);
  ui.draft = draft;
  const { palette, fonts } = draft;
  // Les assets sont écrits en base dès l'upload → la source de vérité est le store.
  const assets: AssetsDraft = { ...(existing?.assets ?? {}) };
  // Une écriture en vol fige le formulaire : ce qu'on y taperait porterait sur des valeurs déjà
  // parties (ou sur le point d'être effacées). L'état gelé se lit comme « en cours ».
  const busy = ui.write !== "idle";
  const dis = canManage && !busy ? {} : { disabled: "true" };

  const effColor = (k: keyof OrgStylePalette): string => (palette[k] || MASTER_PALETTE[k]);
  const effFont = (k: keyof OrgStyleFonts): string => (fonts[k] || MASTER_FONTS[k]);

  // ── Aperçu live (mini écran cabine) ─────────────────────────────────────────
  const pvTitle = el("div", { style: "font-size:1.5rem;font-weight:700;line-height:1.1" }, [MASTER_TITLE]);
  const pvSubtitle = el("div", { style: "font-size:.85rem;margin-top:.25rem" }, ["Choisissez votre séance"]);
  const pvItemA = el("div", { style: "padding:.4rem .6rem;border-radius:.4rem;font-size:.8rem" }, ["Court métrage — 12 min"]);
  const pvItemB = el("div", { style: "padding:.4rem .6rem;border-radius:.4rem;font-size:.8rem;margin-top:.35rem" }, ["Documentaire — 24 min"]);
  const pvCard = el("div", { style: "padding:.6rem;border-radius:.6rem;margin-top:.9rem" }, [pvItemA, pvItemB]);
  const pvButton = el("div", { style: "display:inline-block;margin-top:.9rem;padding:.5rem 1.1rem;border-radius:.5rem;font-size:.85rem;font-weight:600" }, ["Regarder"]);
  // Mention NON supprimable — pas de contrôle pour la retirer, ici comme côté cabine.
  const pvFooter = el("div", { style: "font-size:.7rem;margin-top:1rem;opacity:.6" }, ["propulsé par Kioskoscope"]);
  const pvScreen = el("div", { style: "border-radius:.9rem;padding:1.25rem;min-height:15rem;transition:background .15s" }, [pvTitle, pvSubtitle, pvCard, pvButton, pvFooter]);
  const contrastBox = el("div", { class: "mt-3" }, []);

  const update = (): void => {
    pvScreen.style.background = effColor("bg");
    pvTitle.style.color = effColor("textEmphasis");
    pvTitle.style.fontFamily = effFont("display");
    pvTitle.textContent = draft.title.trim() || MASTER_TITLE;
    pvSubtitle.style.color = effColor("text");
    pvSubtitle.style.fontFamily = effFont("body");
    pvCard.style.background = effColor("surface");
    for (const it of [pvItemA, pvItemB]) {
      it.style.color = effColor("text");
      it.style.fontFamily = effFont("body");
    }
    pvItemB.style.background = effColor("surfaceRaised");
    pvButton.style.background = effColor("accent");
    pvButton.style.color = readableInk(effColor("accent"));
    pvButton.style.fontFamily = effFont("ui");
    pvFooter.style.color = effColor("text");
    // Contraste automatique : on prévient (jamais on ne bloque) sous le seuil AA.
    const failing = CONTRAST_PAIRS.map((p) => ({ p, ratio: contrastRatio(effColor(p.ink), effColor(p.bg)) })).filter((r) => r.ratio < AA_THRESHOLD);
    if (failing.length === 0) {
      contrastBox.replaceChildren(el("div", { class: "text-green small d-flex align-items-center gap-1" }, ["✓ Contrastes lisibles (AA respecté)."]));
    } else {
      contrastBox.replaceChildren(
        el("div", { class: "alert alert-warning mb-0" }, [
          // Enfant unique en bloc : `.alert` de Tabler est en flex → sans ce wrapper, les
          // messages s'aligneraient en colonnes. Ici ils s'empilent proprement.
          el("div", {}, [
            el("div", { class: "fw-bold mb-1" }, ["Lisibilité à vérifier"]),
            ...failing.map((r) => el("div", { class: "small" }, [`${r.p.label.charAt(0).toUpperCase() + r.p.label.slice(1)} risque d'être peu lisible (contraste ${r.ratio.toFixed(1)}:1, en dessous du seuil recommandé de ${AA_THRESHOLD}:1).`])),
          ]),
        ]),
      );
    }
  };

  // ── Champs couleur (input type=color + hex synchronisés) ────────────────────
  const colorField = (slot: (typeof COLOR_SLOTS)[number]): HTMLElement => {
    const current = palette[slot.key] ?? "";
    const swatch = el("input", { type: "color", class: "form-control form-control-color", value: normHex(current) || MASTER_PALETTE[slot.key], title: slot.label, ...dis }) as HTMLInputElement;
    const hex = el("input", { type: "text", class: "form-control", value: current, placeholder: `${MASTER_PALETTE[slot.key]} (maître)`, maxlength: "7", spellcheck: "false", autocomplete: "off", ...dis }) as HTMLInputElement;
    swatch.addEventListener("input", () => {
      palette[slot.key] = swatch.value;
      hex.value = swatch.value;
      hex.classList.remove("is-invalid");
      update();
    });
    hex.addEventListener("input", () => {
      const v = hex.value.trim();
      if (v === "") {
        delete palette[slot.key];
        swatch.value = MASTER_PALETTE[slot.key];
        hex.classList.remove("is-invalid");
      } else if (parseHexColor(v)) {
        palette[slot.key] = v;
        swatch.value = normHex(v);
        hex.classList.remove("is-invalid");
      } else {
        hex.classList.add("is-invalid"); // saisie invalide : on n'écrit pas le brouillon
        return;
      }
      update();
    });
    return el("div", { class: "col-md-6 mb-3" }, [
      el("label", { class: "form-label" }, [slot.label]),
      el("div", { class: "input-group" }, [swatch, hex]),
      el("div", { class: "form-hint" }, [slot.hint]),
    ]);
  };

  // ── Champs fonte ────────────────────────────────────────────────────────────
  const fontField = (role: (typeof FONT_ROLES)[number]): HTMLElement => {
    const input = el("input", { type: "text", class: "form-control", value: fonts[role.key] ?? "", placeholder: MASTER_FONTS[role.key], spellcheck: "false", autocomplete: "off", ...dis }) as HTMLInputElement;
    input.addEventListener("input", () => {
      const v = input.value.trim();
      if (v === "") delete fonts[role.key];
      else fonts[role.key] = v;
      update();
    });
    return el("div", { class: "col-md-4 mb-3" }, [
      el("label", { class: "form-label" }, [role.label]),
      input,
      el("div", { class: "form-hint" }, [role.hint]),
    ]);
  };

  // ── Champs asset (upload : recadrage + WebP → storage) ──────────────────────
  const assetField = (slot: AssetSlot): HTMLElement => {
    const op = assetOpFor(ui, slot.kind);
    const running = op.phase !== "idle";
    const stored = assets[slot.field] ?? null;
    const locked = !canManage || running || busy;
    const fieldDis = locked ? { disabled: "true" } : {};

    const previewBg = slot.darkPreview ? "#17171b" : "#f4f2ee";
    const preview = el("div", {
      style: `position:relative;display:flex;align-items:center;justify-content:center;min-height:5.5rem;max-height:9rem;padding:.5rem;border-radius:.5rem;border:1px solid var(--tblr-border-color);background:${previewBg};overflow:hidden`,
    }, []);

    // Aperçu OPTIMISTE : dès le choix du fichier on montre ce qu'on envoie, en retrait, l'anneau
    // par-dessus. C'est l'autre moitié de BUG-013 — l'ancien logo restait affiché pendant tout
    // l'envoi, on ne savait pas lequel des deux visuels on regardait.
    const shown = op.previewUrl ?? stored;
    if (shown) {
      preview.append(
        el("img", {
          src: shown,
          alt: slot.label,
          style: `max-height:8rem;max-width:100%;object-fit:contain${op.previewUrl ? ";opacity:.45" : ""}`,
        }),
      );
    } else {
      preview.append(el("div", { class: "text-secondary small fst-italic text-center" }, ["Aucun visuel — l'écran cabine utilise le visuel maître Kioskoscope."]));
    }
    if (running) {
      preview.append(
        el("div", { style: "position:absolute;inset:0;display:flex;align-items:center;justify-content:center" }, [uploadRing(ringSteps(op.phase))]),
      );
    }

    const fileInput = el("input", { type: "file", class: "form-control", accept: "image/*", ...fieldDis }) as HTMLInputElement;
    const removeBtn = el("button", { class: "btn btn-outline-danger btn-sm", type: "button", ...fieldDis }, ["Retirer"]);

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      // Refus immédiats : on écrit le verdict dans l'état d'écran, jamais dans ce nœud — il est
      // remplacé par le rendu qui suit. L'aperçu précédent, lui, n'a pas bougé.
      if (!file.type.startsWith("image/")) {
        op.message = { tone: "error", text: "Fichier refusé : choisissez une image." };
        onChanged();
        return;
      }
      if (file.size > MAX_INPUT_BYTES) {
        op.message = { tone: "error", text: "Image trop lourde (20 Mo maximum avant traitement)." };
        onChanged();
        return;
      }
      // Écrit AVANT de céder la main : c'est ce qui doit survivre au rendu qui suit.
      const previewUrl = URL.createObjectURL(file);
      op.previewUrl = previewUrl;
      op.phase = "preparing";
      op.message = { tone: "info", text: `${RING_STEP_LABELS[0]}… (1/3)` };
      onChanged();
      void (async () => {
        try {
          // Souvent l'étape la plus longue sur une photo de 15 Mo : décodage + recadrage + WebP.
          const blob = await toWebpAsset(file, slot.ratio, slot.maxH);
          const weight = formatBytes(blob.size);
          op.phase = "uploading";
          op.message = { tone: "info", text: `${RING_STEP_LABELS[1]}… (2/3) — ${weight} après compression` };
          onChanged();
          const res = await store.uploadOrgAsset(org.id, slot.kind, blob, () => {
            op.phase = "saving";
            op.message = { tone: "info", text: `${RING_STEP_LABELS[2]}… (3/3)` };
            onChanged();
          });
          op.message = res.ok
            ? { tone: "ok", text: `Visuel enregistré ✓ — ${weight}` }
            : { tone: "error", text: res.error ?? "Échec du téléversement." };
        } catch (e) {
          op.message = { tone: "error", text: e instanceof Error ? e.message : "Traitement de l'image impossible." };
        } finally {
          // `finally` et non pas « à la fin » : sur le chemin d'exception aussi, sinon chaque
          // envoi raté retient son fichier en mémoire jusqu'au rechargement de la page.
          URL.revokeObjectURL(previewUrl);
          op.previewUrl = null;
          op.phase = "idle";
          onChanged();
        }
      })();
    });

    removeBtn.addEventListener("click", () => {
      if (!confirm(`Retirer « ${slot.label} » ? Vos cabines reviendront au visuel maître Kioskoscope.`)) return;
      op.phase = "removing";
      op.message = { tone: "info", text: "Suppression…" };
      onChanged();
      void store.removeOrgAsset(org.id, slot.kind).then((res) => {
        op.phase = "idle";
        op.message = res.ok
          ? { tone: "ok", text: "Visuel retiré — vos cabines reviennent au visuel maître." }
          : { tone: "error", text: res.error ?? "Échec de la suppression." };
        onChanged();
      });
    });

    return el("div", { class: "col-md-6 mb-3" }, [
      el("label", { class: "form-label" }, [slot.label]),
      preview,
      canManage
        ? el("div", { class: "d-flex align-items-start gap-2 mt-2" }, [
            el("div", { class: "flex-fill" }, [fileInput]),
            stored ? removeBtn : el("span", {}, []),
          ])
        : el("span", {}, []),
      el("div", { class: "form-hint" }, [slot.hint]),
      messageLine(op.message, "mt-1"),
    ]);
  };

  // ── Titre ───────────────────────────────────────────────────────────────────
  const titleInput = el("input", { type: "text", class: "form-control", value: draft.title, placeholder: `${MASTER_TITLE} (maître)`, maxlength: "60", autocomplete: "off", ...dis }) as HTMLInputElement;
  titleInput.addEventListener("input", () => {
    draft.title = titleInput.value;
    update();
  });

  // ── Actions ─────────────────────────────────────────────────────────────────
  const save = el("button", { class: "btn btn-primary", type: "button", ...dis }, ["Enregistrer"]);
  save.addEventListener("click", () => {
    // Le style à écrire est ARRÊTÉ ici, avant tout `await` : la suite ne lira plus ces champs,
    // ils auront été remplacés par un rendu.
    const payload = buildStyle(palette, fonts, draft.title);
    // Le brouillon est CONSERVÉ pendant le vol : c'est ce qu'on est en train d'écrire. Le purger
    // maintenant ferait clignoter le formulaire vers les anciennes valeurs de la base.
    ui.write = "saving";
    ui.message = { tone: "info", text: "Enregistrement…" };
    onChanged();
    void store.upsertOrgStyle(org.id, payload).then((res) => {
      ui.write = "idle";
      if (res.ok) {
        // La vérité est en base : le brouillon n'a plus de raison d'exister, l'éditeur repart
        // du store au prochain rendu.
        ui.draft = null;
        ui.message = { tone: "ok", text: "Style enregistré ✓" };
      } else {
        ui.message = { tone: "error", text: res.error ?? "Échec de l'enregistrement." };
      }
      onChanged();
    });
  });

  const reset = el("button", { class: "btn btn-outline-danger", type: "button", ...dis }, ["Réinitialiser au style maître"]);
  reset.addEventListener("click", () => {
    if (!confirm("Réinitialiser au style maître Kioskoscope ? Les couleurs, fontes et titre de votre organisation seront supprimés — vos cabines reviendront à l'apparence par défaut.")) return;
    // TOUT est décidé AVANT de céder la main. C'est le cœur du bug : la purge du brouillon
    // arrivait APRÈS l'appel réseau, donc après que le store eut réémis — l'éditeur visible
    // avait déjà été ré-ensemencé depuis le brouillon périmé, avec les couleurs qu'on venait
    // justement de demander à effacer, et la réinitialisation paraissait sans effet.
    const kept = ui.draft;
    ui.draft = null;
    ui.write = "resetting";
    ui.message = { tone: "info", text: "Réinitialisation…" };
    onChanged();
    void store.resetOrgStyle(org.id).then((res) => {
      ui.write = "idle";
      if (res.ok) {
        ui.message = { tone: "ok", text: "Style réinitialisé au maître Kioskoscope ✓" };
      } else {
        // Rien n'a été écrit : le chemin d'échec sort AVANT toute projection, donc aucun rendu
        // n'a eu lieu entre-temps et la saisie est restituée au caractère près.
        ui.draft = kept;
        ui.message = { tone: "error", text: res.error ?? "Échec de la réinitialisation." };
      }
      onChanged();
    });
  });

  const emptyBanner = existing
    ? el("span", {}, [])
    : el("div", { class: "alert alert-info" }, ["Style maître Kioskoscope actif. Définissez vos couleurs, fontes ou titre ci-dessous pour personnaliser vos cabines ; un champ laissé vide conserve le style maître."]);

  update();

  const form = el("div", { class: "card" }, [
    el("div", { class: "card-body" }, [
      el("h3", { class: "card-title" }, ["Couleurs"]),
      el("div", { class: "row" }, COLOR_SLOTS.map(colorField)),
      el("hr", {}, []),
      el("h3", { class: "card-title" }, ["Fontes"]),
      el("p", { class: "text-secondary small" }, ["Piles CSS font-family. Utilisez des polices web-safe (disponibles sur les cabines) ou des piles de repli. L'import de polices de marque arrivera dans une version ultérieure."]),
      el("div", { class: "row" }, FONT_ROLES.map(fontField)),
      el("hr", {}, []),
      el("h3", { class: "card-title" }, ["Titre de marque"]),
      el("div", { class: "mb-2" }, [titleInput, el("div", { class: "form-hint" }, ["Affiché sur l'écran d'attente des cabines."])]),
      el("hr", {}, []),
      el("h3", { class: "card-title" }, ["Logos & images"]),
      el("p", { class: "text-secondary small" }, ["Vos visuels de marque. Chaque image est recadrée et compressée automatiquement (WebP) avant envoi. Un emplacement laissé vide conserve le visuel maître Kioskoscope. La mention « propulsé par Kioskoscope » reste affichée."]),
      el("div", { class: "row" }, ASSET_SLOTS.map(assetField)),
      canManage
        ? el("div", { class: "mt-3" }, [
            el("div", { class: "d-flex align-items-center gap-3 flex-wrap" }, [save, reset]),
            // Message EN PLACE et persistant (il vit dans l'état d'écran) : réinitialiser est un
            // geste destructif, l'opérateur doit voir son état final sans avoir à le déduire —
            // et sans qu'un toast le lui reprenne au bout de trois secondes.
            messageLine(ui.message, "mt-2"),
          ])
        : el("div", { class: "alert alert-secondary mt-3 mb-0" }, ["Lecture seule — seul un super-utilisateur de l'organisation peut modifier le style."]),
    ]),
  ]);

  const previewCol = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, [el("h3", { class: "card-title m-0" }, ["Aperçu"]), el("div", { class: "card-subtitle" }, ["Rendu approché d'un écran cabine."])]),
    el("div", { class: "card-body" }, [pvScreen, contrastBox]),
  ]);

  return el("div", {}, [
    emptyBanner,
    el("div", { class: "row row-cards" }, [
      el("div", { class: "col-lg-7" }, [form]),
      el("div", { class: "col-lg-5" }, [previewCol]),
    ]),
  ]);
}

/**
 * Assemble un `OrgStyle` à partir des brouillons. Seuls les slots renseignés et VALIDES sont
 * inclus (un slot omis = maître). exactOptionalPropertyTypes → spreads conditionnels ; aucun
 * bloc vide n'est posé (palette/fonts/title absents plutôt que `{}`).
 */
export function buildStyle(palette: PaletteDraft, fonts: FontsDraft, title: string): OrgStyle {
  const pal: PaletteDraft = {};
  for (const s of COLOR_SLOTS) {
    const v = (palette[s.key] ?? "").trim();
    if (v && parseHexColor(v)) pal[s.key] = normHex(v);
  }
  const fnt: FontsDraft = {};
  for (const f of FONT_ROLES) {
    const v = (fonts[f.key] ?? "").trim();
    if (v) fnt[f.key] = v;
  }
  const t = title.trim();
  return {
    ...(Object.keys(pal).length ? { palette: pal } : {}),
    ...(Object.keys(fnt).length ? { fonts: fnt } : {}),
    ...(t ? { title: t } : {}),
  };
}
