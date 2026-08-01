// ENVOI REPRENABLE (protocole TUS 1.0.0) — téléverser plusieurs gigaoctets sans tout reperdre.
//
// POURQUOI PAS `tus-js-client`. Le protocole tient en TROIS verbes, tous vérifiés en conditions
// réelles contre le Storage du projet avant d'écrire une ligne de ce fichier :
//   POST   /storage/v1/upload/resumable   → 201 + en-tête `Location` (l'URL de CET envoi)
//   HEAD   <Location>                     → 200 + `Upload-Offset` (ce que le serveur a VRAIMENT)
//   PATCH  <Location>                     → 204 + `Upload-Offset` (nouvel offset après la tranche)
// Une dépendance qui enveloppe trois `fetch` coûterait un paquet de plus dans le chemin critique
// du téléversement, avec sa propre gestion de stockage, ses réglages parallèles et sa surface de
// mise à jour — pour une valeur que ce fichier rend en une page. Le protocole, lui, est figé.
//
// CE QUE LE SERVEUR A RÉPONDU (mesuré, pas supposé) :
//   · un envoi déclaré au-delà du plafond est refusé À LA CRÉATION, en HTTP 413, avant tout octet ;
//   · un chemin d'une autre organisation est refusé en HTTP 403 par la RLS storage : le canal
//     reprenable ne contourne PAS les policies de `0003_storage.sql` ;
//   · couper après la moitié puis relire `Upload-Offset` rend l'offset exact, et la seconde
//     moitié complète l'objet.
//
// L'INVARIANT QUI REND LA REPRISE SÛRE. Après toute coupure on RELIT l'offset auprès du serveur
// au lieu de faire confiance au nôtre. Une tranche peut très bien avoir été écrite alors que sa
// réponse s'est perdue : le compteur local serait alors en retard, et reprendre là où on croit
// en être dupliquerait des octets au milieu du fichier. Le serveur est seul juge de ce qu'il a.

/** Accès en lecture par plage — même contrat que `ByteRangeReader` (cf. `mp4.ts`). */
import type { ByteRangeReader } from "./mp4";

export const TUS_VERSION = "1.0.0";

/** Taille de tranche envoyée par PATCH. 6 Mio : assez grand pour ne pas multiplier les
 *  allers-retours sur un fichier de plusieurs Go, assez petit pour qu'une coupure ne fasse
 *  jamais reperdre plus de quelques secondes d'émission. */
export const UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

/** Attentes entre tentatives, en millisecondes. La dernière est répétée si besoin. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 6000, 12000, 20000];

export interface UploadResponse {
  readonly status: number;
  /** En-têtes en minuscules. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Transport HTTP injectable : `fetch` en production, un double en test. */
export type UploadTransport = (req: {
  readonly method: "POST" | "HEAD" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}) => Promise<UploadResponse>;

export interface UploadTarget {
  /** Racine du endpoint reprenable, ex. `https://<projet>.supabase.co/storage/v1/upload/resumable`. */
  readonly createUrl: string;
  readonly bucket: string;
  /** Chemin dans le bucket, ex. `{org}/{hash}`. Son 1er segment porte l'isolation. */
  readonly objectName: string;
  readonly contentType: string;
  /** Jeton d'accès de la session. Relu à CHAQUE tentative via `authToken()` : un envoi de
   *  vingt minutes survit à une rotation de jeton, qu'un jeton figé ferait échouer à 90 %. */
  readonly authToken: () => string;
  /** `true` pour écraser un objet existant. */
  readonly upsert: boolean;
}

export interface UploadProgress {
  readonly sentBytes: number;
  readonly totalBytes: number;
}

export type UploadFailure =
  /** Le serveur refuse la taille déclarée — aucun octet n'est parti. */
  | "too-large"
  /** La RLS storage refuse ce chemin pour cette session, ou le jeton n'est plus valable. */
  | "forbidden"
  /** L'appelant a annulé. */
  | "aborted"
  /** Le fichier a changé ou disparu du disque pendant l'envoi. */
  | "source-changed"
  /** L'URL de reprise n'existe plus côté serveur : il faut repartir de zéro. */
  | "expired"
  /** Réseau injoignable après toutes les tentatives. */
  | "network"
  /** Le serveur a répondu une erreur qu'on ne sait pas interpréter. */
  | "server";

export type UploadOutcome =
  | { readonly ok: true; readonly sentBytes: number; readonly resumed: boolean }
  | {
      readonly ok: false;
      readonly reason: UploadFailure;
      readonly message: string;
      /** URL de reprise, si un envoi a bien été créé — à persister pour reprendre plus tard. */
      readonly uploadUrl: string | null;
      /** Ce que le SERVEUR a confirmé détenir. C'est ce chiffre, et lui seul, qu'on a le droit
       *  d'annoncer à l'exploitant après une interruption. */
      readonly confirmedBytes: number;
    };

export interface UploadOptions {
  readonly chunkBytes?: number;
  readonly onProgress?: (p: UploadProgress) => void;
  /** Appelé dès que l'URL de reprise est connue — c'est le moment de la persister. */
  readonly onUploadUrl?: (url: string) => void;
  /** URL d'un envoi précédent à reprendre. Si elle est périmée, l'échec est `expired`. */
  readonly resumeUrl?: string | null;
  readonly signal?: { readonly aborted: boolean };
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** base64 d'une chaîne UTF-8, sans dépendre de `btoa` (qui casse hors Latin-1). */
export function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2]!;
    out += alphabet[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    out += b1 === undefined ? "=" : alphabet[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
    out += b2 === undefined ? "=" : alphabet[b2 & 63]!;
  }
  return out;
}

function isAborted(signal: { readonly aborted: boolean } | undefined): boolean {
  return signal?.aborted === true;
}

function aborted(uploadUrl: string | null, confirmedBytes: number): UploadOutcome {
  return { ok: false, reason: "aborted", message: "Envoi annulé.", uploadUrl, confirmedBytes };
}

/**
 * Téléverse `reader` en entier vers `target`, en reprenant si `resumeUrl` est fourni.
 *
 * La fonction ne persiste rien elle-même : elle SIGNALE l'URL de reprise (`onUploadUrl`) et
 * laisse l'appelant décider où la garder. C'est ce qui permet à la couche applicative de choisir
 * la durée de vie de la reprise sans que ce module connaisse le navigateur.
 */
export async function resumableUpload(
  reader: ByteRangeReader,
  target: UploadTarget,
  transport: UploadTransport,
  options: UploadOptions = {},
): Promise<UploadOutcome> {
  const chunkBytes = options.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const total = reader.size;

  let uploadUrl: string | null = options.resumeUrl ?? null;
  let resumed = uploadUrl !== null;
  let confirmed = 0;
  let attempt = 0;

  const tusHeaders = (): Record<string, string> => ({
    authorization: `Bearer ${target.authToken()}`,
    "tus-resumable": TUS_VERSION,
  });

  /** Crée l'envoi côté serveur. Le plafond est appliqué ICI, avant tout octet. */
  const create = async (): Promise<UploadOutcome | string> => {
    const res = await transport({
      method: "POST",
      url: target.createUrl,
      headers: {
        ...tusHeaders(),
        "upload-length": String(total),
        "upload-metadata": [
          `bucketName ${base64Utf8(target.bucket)}`,
          `objectName ${base64Utf8(target.objectName)}`,
          `contentType ${base64Utf8(target.contentType)}`,
        ].join(","),
        "x-upsert": target.upsert ? "true" : "false",
      },
    });
    if (res.status === 413) {
      return {
        ok: false,
        reason: "too-large",
        message: "Le serveur refuse un fichier de cette taille : le plafond du bucket est trop bas.",
        uploadUrl: null,
        confirmedBytes: 0,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: "forbidden",
        message: "Le serveur a refusé l'envoi sur ce chemin (droits insuffisants ou session expirée).",
        uploadUrl: null,
        confirmedBytes: 0,
      };
    }
    const loc = res.headers["location"];
    if (res.status !== 201 || !loc) {
      return {
        ok: false,
        reason: "server",
        message: `Création de l'envoi refusée (HTTP ${res.status}). ${res.body.slice(0, 200)}`,
        uploadUrl: null,
        confirmedBytes: 0,
      };
    }
    return loc;
  };

  /** Relit l'offset détenu par le serveur. `null` = l'envoi n'existe plus. */
  const serverOffset = async (url: string): Promise<number | null> => {
    const res = await transport({ method: "HEAD", url, headers: tusHeaders() });
    if (res.status === 404 || res.status === 410) return null;
    if (res.status !== 200 && res.status !== 204) return null;
    const raw = res.headers["upload-offset"];
    const n = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  while (true) {
    if (isAborted(options.signal)) return aborted(uploadUrl, confirmed);

    try {
      // ── 1. Avoir une URL d'envoi ────────────────────────────────────────────
      if (uploadUrl === null) {
        const created = await create();
        if (typeof created !== "string") return created;
        uploadUrl = created;
        resumed = false;
        confirmed = 0;
        options.onUploadUrl?.(uploadUrl);
      }

      // ── 2. Demander au serveur où il en est — jamais présumer ───────────────
      const offset = await serverOffset(uploadUrl);
      if (offset === null) {
        // L'envoi a expiré côté serveur. Si on nous l'avait donné en reprise, on le dit :
        // recréer en silence ferait repartir de zéro un envoi que l'exploitant croyait à 80 %.
        if (resumed) {
          return {
            ok: false,
            reason: "expired",
            message: "L'envoi interrompu n'existe plus sur le serveur : il faut le recommencer.",
            uploadUrl: null,
            confirmedBytes: 0,
          };
        }
        uploadUrl = null;
        throw new Error("URL d'envoi perdue juste après sa création.");
      }
      confirmed = offset;
      options.onProgress?.({ sentBytes: confirmed, totalBytes: total });

      // Le serveur en a plus que le fichier n'en contient : les deux ne parlent pas du même
      // fichier. Poursuivre écrirait un objet corrompu sous un nom qui promet le contraire.
      if (confirmed > total) {
        return {
          ok: false,
          reason: "server",
          message: "Le serveur détient plus d'octets que le fichier n'en compte : envoi incohérent, recommencez.",
          uploadUrl,
          confirmedBytes: confirmed,
        };
      }

      // ── 3. Pousser les tranches ─────────────────────────────────────────────
      while (confirmed < total) {
        if (isAborted(options.signal)) return aborted(uploadUrl, confirmed);

        const want = Math.min(chunkBytes, total - confirmed);
        let slice: Uint8Array;
        try {
          slice = await reader.read(confirmed, want);
        } catch {
          // Le `File` a été invalidé : fichier modifié, renommé ou déplacé depuis sa sélection.
          return {
            ok: false,
            reason: "source-changed",
            message: "Le fichier a changé sur le disque pendant l'envoi. Resélectionnez-le pour reprendre.",
            uploadUrl,
            confirmedBytes: confirmed,
          };
        }
        if (slice.length === 0) {
          return {
            ok: false,
            reason: "source-changed",
            message: "Le fichier s'est raccourci pendant l'envoi : il ne correspond plus à ce qui a été annoncé.",
            uploadUrl,
            confirmedBytes: confirmed,
          };
        }

        const res = await transport({
          method: "PATCH",
          url: uploadUrl,
          headers: {
            ...tusHeaders(),
            "upload-offset": String(confirmed),
            "content-type": "application/offset+octet-stream",
          },
          body: slice,
        });

        if (res.status === 409 || res.status === 412) {
          // Désaccord d'offset : on ressort de la boucle pour re-demander au serveur.
          break;
        }
        if (res.status === 404 || res.status === 410) {
          return {
            ok: false,
            reason: "expired",
            message: "L'envoi a expiré côté serveur avant la fin : il faut le recommencer.",
            uploadUrl: null,
            confirmedBytes: confirmed,
          };
        }
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            reason: "forbidden",
            message: "Le serveur a refusé la suite de l'envoi (droits insuffisants ou session expirée).",
            uploadUrl,
            confirmedBytes: confirmed,
          };
        }
        if (res.status === 413) {
          return {
            ok: false,
            reason: "too-large",
            message: "Le serveur a refusé la suite de l'envoi : plafond de taille atteint.",
            uploadUrl,
            confirmedBytes: confirmed,
          };
        }
        if (res.status !== 204 && res.status !== 200) {
          throw new Error(`PATCH refusé (HTTP ${res.status}). ${res.body.slice(0, 200)}`);
        }

        const raw = res.headers["upload-offset"];
        const next = raw === undefined ? confirmed + slice.length : Number(raw);
        if (!Number.isFinite(next) || next <= confirmed) {
          // Le serveur n'a pas avancé : réessayer à l'identique tournerait en rond.
          throw new Error("Le serveur n'a pas confirmé de progression sur cette tranche.");
        }
        confirmed = next;
        attempt = 0; // toute tranche confirmée remet le compteur de tentatives à zéro
        options.onProgress?.({ sentBytes: confirmed, totalBytes: total });
      }

      if (confirmed >= total) return { ok: true, sentBytes: confirmed, resumed };
      // Sinon : sortie par désaccord d'offset → on reboucle et on re-interroge le serveur.
    } catch (err) {
      if (isAborted(options.signal)) return aborted(uploadUrl, confirmed);
      attempt += 1;
      if (attempt > delays.length) {
        return {
          ok: false,
          reason: "network",
          message:
            `Le réseau n'a pas répondu après ${delays.length} tentatives. ` +
            `${confirmed} octets sur ${total} sont déjà chez le serveur : l'envoi peut reprendre là.`,
          uploadUrl,
          confirmedBytes: confirmed,
        };
      }
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)]!);
    }
  }
}
