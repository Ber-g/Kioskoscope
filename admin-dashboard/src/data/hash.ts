import { sha256HexOfRanges, type ByteRangeReader, type HashProgress } from "@kioskoscope/domain";

// Empreinte SHA-256 d'un fichier, calculée côté client. Sert au dedup (unique par org, imposé
// par la base), de base d'intégrité, ET de nom de fichier sur le disque des bornes (CIN-112).
// Le calcul se fait dans le navigateur avant tout envoi — le doublon est détecté d'emblée.
//
// ⚠️ CE FICHIER A CHANGÉ DE NATURE (CIN-101). Il faisait `file.arrayBuffer()` puis
// `crypto.subtle.digest()`. C'était juste, et fatal au-delà de quelques centaines de Mo : le
// fichier ENTIER passait dans le tas de l'onglet, qui mourait avant le moindre octet envoyé.
// La Web Crypto n'ayant aucune API incrémentale, le calcul passe par `sha256HexOfRanges`, qui
// avance par tranches via le MÊME `ByteRangeReader` que le probe de codec.
//
// ⚠️ NE JAMAIS revenir à `file.arrayBuffer()` ici, même « juste pour les petits fichiers » : la
// taille n'est pas connue au moment où on écrit le code, elle l'est au moment où l'exploitant
// choisit son film.

export async function sha256Hex(
  file: File,
  onProgress?: (p: HashProgress) => void,
): Promise<string> {
  return sha256HexOfRanges(fileByteReader(file), onProgress ? { onProgress } : {});
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
