import type { ByteRangeReader } from "@kioskoscope/domain";

// Empreinte SHA-256 d'un fichier, calculée côté client (Web Crypto). Sert au
// dedup (unique par org, imposé par la base) ET de base d'intégrité. Le calcul
// se fait dans le navigateur avant tout upload — le doublon est détecté d'emblée.

export async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Lecture par plages d'un `File`, pour le probe de codec (CIN-103).
 *
 * ⚠️ NE JAMAIS remplacer par `file.arrayBuffer()` : `probeMp4` ne lit que quelques centaines
 * d'octets d'un fichier qui peut peser 6 Go. `slice()` est ce qui rend l'inspection gratuite —
 * le navigateur ne charge que la plage demandée.
 */
export function fileByteReader(file: File): ByteRangeReader {
  return {
    size: file.size,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const slice = file.slice(offset, Math.min(offset + length, file.size));
      return new Uint8Array(await slice.arrayBuffer());
    },
  };
}
