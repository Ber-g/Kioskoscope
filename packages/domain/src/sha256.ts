// SHA-256 INCRÉMENTAL — empreinte d'un fichier de plusieurs gigaoctets sans le charger en RAM.
//
// POURQUOI CE MODULE EXISTE. `crypto.subtle.digest()` est une API **en un seul coup** : elle prend
// un `ArrayBuffer` complet et rend l'empreinte. Il n'existe AUCUNE variante incrémentale dans la
// Web Crypto — pas de `update()`, pas de flux. Hacher un fichier de 6 Go avec elle impose donc
// `file.arrayBuffer()`, c'est-à-dire 6 Go dans le tas de l'onglet : l'onglet meurt AVANT que le
// moindre octet ne parte sur le réseau. C'est le verrou n°1 de CIN-101, et aucune astuce d'appel
// ne le contourne : il fallait une implémentation qui accepte la matière par morceaux.
//
// POURQUOI PAS UNE DÉPENDANCE. L'alternative était `hash-wasm` (SHA-256 en WebAssembly, ~1 Go/s).
// Elle achète de la vitesse contre une dépendance de plus dans le chemin d'un calcul dont TOUT
// dépend : l'empreinte est la clé de dedup (`unique(organization_id, content_hash)`), la preuve
// d'intégrité de bout en bout, ET le nom du fichier sur le disque des bornes (`<sha256>.<ext>`,
// CIN-112). Un octet faux ici et une borne ne trouve plus son film. SHA-256 est un algorithme
// FIGÉ depuis 2001, spécifié en trois pages (FIPS 180-4), et vérifiable contre des vecteurs de
// test publiés : c'est exactement le genre de code qu'on écrit une fois et qu'on ne touche plus.
// Le prix payé est la vitesse (~2 à 5× plus lent que le WASM), et il se paie sur une opération
// qui reste marginale devant le temps de réseau — voir la note de coût plus bas.
//
// COÛT RÉEL. Le hachage est borné par le CPU, l'envoi par le réseau. Sur un fichier de 6 Go :
// hachage de l'ordre de la minute, envoi de l'ordre de la dizaine de minutes sur une fibre
// domestique en émission. Le hachage est donc quelques pour cent du temps total — le remplacer
// par du WASM optimiserait la mauvaise moitié.
//
// RESPONSIVITÉ. Le calcul reste sur le fil principal, découpé en tranches entre lesquelles on
// rend la main (chaque lecture de plage est asynchrone). L'onglet reste vivant mais l'animation
// n'est pas lisse — c'est assumé pour cette version. Un Web Worker est la suite si ça gêne.

import type { ByteRangeReader } from "./mp4";

/** Constantes de ronde FIPS 180-4 : 32 premiers bits des parties fractionnaires des racines
 *  cubiques des 64 premiers nombres premiers. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Taille de bloc SHA-256, en octets. Non négociable : elle vient de la spécification. */
const BLOCK_BYTES = 64;

/**
 * État d'un SHA-256 en cours. On l'alimente par `update()` autant de fois qu'on veut, puis on
 * lit `digestHex()` **une seule fois** — après quoi l'objet est scellé.
 */
export class Sha256Stream {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  /** Reliquat : les octets reçus qui ne complètent pas encore un bloc de 64. */
  private readonly tail = new Uint8Array(BLOCK_BYTES);
  private tailLen = 0;
  /** Total d'octets absorbés. Un `number` suffit : exact jusqu'à 2^53 octets (8 Pio). */
  private totalBytes = 0;
  private sealed = false;
  /** Tampon d'expansion réutilisé à chaque bloc — évite 64 allocations par bloc. */
  private readonly w = new Uint32Array(64);

  /** Absorbe une tranche. Peut être appelée avec n'importe quelle taille, y compris 0. */
  update(bytes: Uint8Array): void {
    if (this.sealed) throw new Error("Sha256Stream : update() après digestHex()");
    this.totalBytes += bytes.length;
    let offset = 0;

    // 1. Compléter le reliquat s'il y en a un.
    if (this.tailLen > 0) {
      const need = BLOCK_BYTES - this.tailLen;
      if (bytes.length < need) {
        this.tail.set(bytes, this.tailLen);
        this.tailLen += bytes.length;
        return;
      }
      this.tail.set(bytes.subarray(0, need), this.tailLen);
      this.compress(this.tail, 0);
      this.tailLen = 0;
      offset = need;
    }

    // 2. Consommer les blocs pleins directement dans la tranche reçue (aucune copie).
    while (offset + BLOCK_BYTES <= bytes.length) {
      this.compress(bytes, offset);
      offset += BLOCK_BYTES;
    }

    // 3. Garder ce qui reste pour la prochaine fois.
    if (offset < bytes.length) {
      this.tail.set(bytes.subarray(offset), 0);
      this.tailLen = bytes.length - offset;
    }
  }

  /** Scelle l'état et rend l'empreinte en hexadécimal minuscule (64 caractères). */
  digestHex(): string {
    if (this.sealed) throw new Error("Sha256Stream : digestHex() appelé deux fois");
    this.sealed = true;

    // Rembourrage FIPS : un bit 1, des zéros, puis la longueur en BITS sur 64 bits big-endian.
    const bitLen = this.totalBytes * 8;
    const pad = new Uint8Array(this.tailLen < 56 ? BLOCK_BYTES : BLOCK_BYTES * 2);
    pad.set(this.tail.subarray(0, this.tailLen), 0);
    pad[this.tailLen] = 0x80;
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen % 0x100000000;
    const lenAt = pad.length - 8;
    pad[lenAt] = (hi >>> 24) & 0xff;
    pad[lenAt + 1] = (hi >>> 16) & 0xff;
    pad[lenAt + 2] = (hi >>> 8) & 0xff;
    pad[lenAt + 3] = hi & 0xff;
    pad[lenAt + 4] = (lo >>> 24) & 0xff;
    pad[lenAt + 5] = (lo >>> 16) & 0xff;
    pad[lenAt + 6] = (lo >>> 8) & 0xff;
    pad[lenAt + 7] = lo & 0xff;
    for (let o = 0; o < pad.length; o += BLOCK_BYTES) this.compress(pad, o);

    let out = "";
    for (let i = 0; i < 8; i++) out += (this.h[i]! >>> 0).toString(16).padStart(8, "0");
    return out;
  }

  /** Fonction de compression sur UN bloc de 64 octets pris à `offset` dans `data`. */
  private compress(data: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const o = offset + i * 4;
      w[i] = ((data[o]! << 24) | (data[o + 1]! << 16) | (data[o + 2]! << 8) | data[o + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = this.h[0]!, b = this.h[1]!, c = this.h[2]!, d = this.h[3]!;
    let e = this.h[4]!, f = this.h[5]!, g = this.h[6]!, hh = this.h[7]!;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    this.h[0] = (this.h[0]! + a) >>> 0;
    this.h[1] = (this.h[1]! + b) >>> 0;
    this.h[2] = (this.h[2]! + c) >>> 0;
    this.h[3] = (this.h[3]! + d) >>> 0;
    this.h[4] = (this.h[4]! + e) >>> 0;
    this.h[5] = (this.h[5]! + f) >>> 0;
    this.h[6] = (this.h[6]! + g) >>> 0;
    this.h[7] = (this.h[7]! + hh) >>> 0;
  }
}

/** Taille de tranche lue et hachée d'un coup. Compromis : assez grand pour que le coût par
 *  tranche soit négligeable, assez petit pour rendre la main souvent à l'onglet. */
export const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export interface HashProgress {
  readonly hashedBytes: number;
  readonly totalBytes: number;
}

export interface HashOptions {
  readonly chunkBytes?: number;
  readonly onProgress?: (p: HashProgress) => void;
  /** Interrompt le calcul. Le rejet porte `name === "AbortError"`. */
  readonly signal?: { readonly aborted: boolean };
}

/**
 * Empreinte SHA-256 d'une source lue PAR PLAGES — donc d'un `File` de 6 Go via `fileByteReader`,
 * sans jamais dépasser une tranche en mémoire.
 *
 * ⚠️ Le lecteur peut échouer en cours de route si le fichier a été modifié ou déplacé sur le
 * disque depuis sa sélection (le navigateur invalide le `File`). L'erreur remonte telle quelle :
 * une empreinte à moitié calculée sur un fichier qui a bougé ne vaut rien, et surtout ne doit
 * pas être présentée comme une empreinte valide.
 */
export async function sha256HexOfRanges(reader: ByteRangeReader, options: HashOptions = {}): Promise<string> {
  const chunk = options.chunkBytes ?? HASH_CHUNK_BYTES;
  const stream = new Sha256Stream();
  let offset = 0;

  options.onProgress?.({ hashedBytes: 0, totalBytes: reader.size });
  while (offset < reader.size) {
    if (options.signal?.aborted) {
      const err = new Error("Calcul d'empreinte interrompu.");
      err.name = "AbortError";
      throw err;
    }
    const want = Math.min(chunk, reader.size - offset);
    const bytes = await reader.read(offset, want);
    // Un lecteur qui rend moins que demandé sans être en fin de source ment sur la taille :
    // continuer produirait une empreinte fausse — donc juste, mais d'un AUTRE fichier.
    if (bytes.length === 0) throw new Error("Lecture vide avant la fin du fichier : source instable.");
    stream.update(bytes);
    offset += bytes.length;
    options.onProgress?.({ hashedBytes: offset, totalBytes: reader.size });
  }
  return stream.digestHex();
}
