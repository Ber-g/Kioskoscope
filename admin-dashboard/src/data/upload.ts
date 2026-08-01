// ADAPTATEUR NAVIGATEUR DE L'ENVOI REPRENABLE (CIN-101).
//
// Le protocole vit dans `@kioskoscope/domain` (testable sans réseau) ; ce fichier fournit les
// trois choses que seul le navigateur peut donner : le transport `fetch`, le jeton de session
// courant, et un endroit où survivre à la fermeture de l'onglet.
//
// ── CE QUI A ÉTÉ MESURÉ SUR LE PROJET (et non supposé) ───────────────────────────────────────
// · Le endpoint reprenable `/storage/v1/upload/resumable` accepte le JWT d'un simple membre et
//   applique les policies de `0003_storage.sql` : un chemin d'une autre org est refusé en 403.
//   Le canal reprenable n'ouvre donc AUCUNE brèche d'isolation.
// · Un envoi déclaré au-delà du plafond est refusé À LA CRÉATION, en 413, avant tout octet.
// · Les octets d'un envoi abandonné sont INVISIBLES dans le bucket (`storage.list()` ne les voit
//   pas) : le back-office ne peut ni les compter ni les supprimer par les voies normales.
// · En revanche le `DELETE` TUS sur l'URL d'envoi est honoré (204, puis 404 en HEAD).
//
// ⇒ CONSÉQUENCE DE CONCEPTION. Le registre local ci-dessous n'est pas seulement un confort de
// reprise : c'est **le seul inventaire des octets orphelins**. Qui perd l'URL perd la capacité
// de les révoquer — ils ne sont alors récupérables que par l'expiration interne du service.
// C'est pourquoi on l'écrit AVANT le premier octet et qu'on le balaie à chaque ouverture.

import {
  resumableUpload,
  TUS_VERSION,
  type UploadOutcome,
  type UploadProgress,
  type UploadTransport,
} from "@kioskoscope/domain";
import { supabase, supabaseUrl } from "./supabase";
import { fileByteReader } from "./hash";

const REGISTRY_KEY = "kioskoscope.uploads.v1";

/** Les envois TUS de Supabase expirent côté serveur ; au-delà, l'URL retenue ne vaut plus rien
 *  et la garder ne ferait que promettre une reprise impossible. */
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

interface RegistryEntry {
  readonly uploadUrl: string;
  /** Identité BON MARCHÉ du fichier : reprendre un envoi avec un AUTRE fichier produirait un
   *  objet mi-chair mi-poisson sous un nom qui promet le contraire. On ne re-hache pas pour
   *  vérifier (ce serait payer le hachage deux fois) — nom + taille + date suffisent à détecter
   *  qu'on n'a plus affaire au même fichier. */
  readonly fingerprint: string;
  readonly createdAt: number;
}

function readRegistry(): Record<string, RegistryEntry> {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, RegistryEntry>) : {};
  } catch {
    // Un registre illisible ne doit jamais empêcher un envoi : on repart d'un registre vide.
    return {};
  }
}

function writeRegistry(reg: Record<string, RegistryEntry>): void {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
  } catch {
    // Quota plein ou stockage refusé : l'envoi reste possible, seule la reprise est perdue.
  }
}

export function fileFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/** Jeton d'accès courant, tenu à jour pour être lisible de façon SYNCHRONE à chaque requête :
 *  un envoi de vingt minutes traverse une rotation de session, et un jeton figé à la création
 *  ferait échouer l'envoi à 90 % avec un message d'autorisation incompréhensible. */
let currentToken = "";
supabase?.auth.onAuthStateChange((_evt, session) => {
  currentToken = session?.access_token ?? "";
});
void supabase?.auth.getSession().then(({ data }) => {
  if (data.session) currentToken = data.session.access_token;
});

const browserTransport: UploadTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    // `fetch` veut un ArrayBuffer/Blob : la vue typée est convertie sans recopier le fichier.
    ...(req.body ? { body: req.body as BodyInit } : {}),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: res.status >= 400 ? await res.text() : "" };
};

/** Révoque un envoi côté serveur (verbe TUS `DELETE`) et l'oublie localement.
 *  C'est la SEULE façon de rendre les octets déjà poussés — il n'existe aucune autre prise. */
export async function discardUpload(objectName: string): Promise<void> {
  const reg = readRegistry();
  const entry = reg[objectName];
  delete reg[objectName];
  writeRegistry(reg);
  if (!entry) return;
  try {
    await fetch(entry.uploadUrl, {
      method: "DELETE",
      headers: { authorization: `Bearer ${currentToken}`, "tus-resumable": TUS_VERSION },
    });
  } catch {
    // Hors ligne au moment de l'abandon : les octets restent en attente de l'expiration serveur.
    // On a délibérément retiré l'entrée locale — la garder promettrait une reprise qu'on ne
    // proposera plus, et le seul recours restant est de toute façon l'expiration.
  }
}

/** Purge les envois trop vieux pour être repris, et rend les octets au passage. */
export async function sweepStaleUploads(): Promise<void> {
  const reg = readRegistry();
  const now = Date.now();
  const stale = Object.keys(reg).filter((k) => now - (reg[k]?.createdAt ?? 0) > REGISTRY_TTL_MS);
  for (const key of stale) await discardUpload(key);
}

/** Un envoi déjà entamé pour ce fichier, s'il est repris avec le MÊME fichier. */
export function pendingUploadFor(objectName: string, file: File): boolean {
  const entry = readRegistry()[objectName];
  return entry !== undefined && entry.fingerprint === fileFingerprint(file) && Date.now() - entry.createdAt <= REGISTRY_TTL_MS;
}

export interface ResumableFileUploadOptions {
  readonly contentType?: string;
  readonly upsert?: boolean;
  readonly onProgress?: (p: UploadProgress) => void;
  readonly signal?: { readonly aborted: boolean };
}

/** Envois en cours, par chemin — un même fichier ne peut pas partir deux fois en parallèle.
 *  C'est la réponse au double-clic : le second appel rejoint le premier au lieu d'ouvrir un
 *  second envoi qui se disputerait le même offset. */
const inFlight = new Map<string, Promise<UploadOutcome>>();

/**
 * Téléverse un `File` de façon reprenable. Reprend automatiquement un envoi antérieur portant
 * le même chemin ET le même fichier ; sinon en ouvre un nouveau.
 */
export function uploadFileResumable(
  file: File,
  objectName: string,
  options: ResumableFileUploadOptions = {},
): Promise<UploadOutcome> {
  const running = inFlight.get(objectName);
  if (running) return running;

  const task = (async (): Promise<UploadOutcome> => {
    if (!supabaseUrl) {
      return { ok: false, reason: "server", message: "Backend non configuré.", uploadUrl: null, confirmedBytes: 0 };
    }

    const reg = readRegistry();
    const known = reg[objectName];
    const fingerprint = fileFingerprint(file);
    // Une entrée qui ne décrit pas CE fichier est un piège, pas une aide : on la révoque.
    if (known && (known.fingerprint !== fingerprint || Date.now() - known.createdAt > REGISTRY_TTL_MS)) {
      await discardUpload(objectName);
    }
    const resumeUrl = known && known.fingerprint === fingerprint && Date.now() - known.createdAt <= REGISTRY_TTL_MS
      ? known.uploadUrl
      : null;

    const outcome = await resumableUpload(
      fileByteReader(file),
      {
        createUrl: `${supabaseUrl}/storage/v1/upload/resumable`,
        bucket: "media",
        objectName,
        contentType: options.contentType ?? file.type ?? "application/octet-stream",
        authToken: () => currentToken,
        upsert: options.upsert ?? false,
      },
      browserTransport,
      {
        resumeUrl,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onUploadUrl: (url) => {
          // Écrit AVANT le premier octet : si l'onglet meurt à la tranche suivante, l'URL est
          // déjà connue — donc l'envoi reprenable, et les octets révocables.
          const now = readRegistry();
          now[objectName] = { uploadUrl: url, fingerprint, createdAt: Date.now() };
          writeRegistry(now);
        },
      },
    );

    if (outcome.ok || outcome.reason === "expired") {
      // Terminé, ou définitivement irrécupérable : dans les deux cas l'entrée ne sert plus.
      const now = readRegistry();
      delete now[objectName];
      writeRegistry(now);
    }
    return outcome;
  })();

  inFlight.set(objectName, task);
  return task.finally(() => inFlight.delete(objectName));
}

/** Message destiné à l'exploitant : dire ce qui s'est passé ET quoi faire, jamais un code HTTP. */
export function uploadFailureMessage(outcome: Extract<UploadOutcome, { ok: false }>, file: File): string {
  const mo = (n: number): string => `${(n / 1024 ** 2).toFixed(0)} Mo`;
  switch (outcome.reason) {
    case "too-large":
      return (
        `Le serveur refuse ce fichier de ${mo(file.size)} : le plafond de téléversement du projet ` +
        `est actuellement de 50 Mio. Il se relève dans les réglages Storage de Supabase (et peut ` +
        `dépendre du forfait) — aucun réglage de cette page ne peut le contourner.`
      );
    case "forbidden":
      return "Vous n'avez pas le droit d'envoyer un fichier pour cette organisation, ou votre session a expiré. Reconnectez-vous et réessayez.";
    case "source-changed":
      return "Le fichier a changé sur le disque pendant l'envoi. Resélectionnez-le pour repartir.";
    case "expired":
      return "L'envoi interrompu a expiré sur le serveur : il faut le recommencer depuis le début.";
    case "network":
      return `Réseau interrompu. ${mo(outcome.confirmedBytes)} sur ${mo(file.size)} sont déjà arrivés : relancez l'envoi, il reprendra là.`;
    case "aborted":
      return `Envoi annulé à ${mo(outcome.confirmedBytes)} sur ${mo(file.size)}.`;
    case "server":
      return `Le serveur a refusé l'envoi. ${outcome.message}`;
  }
}
