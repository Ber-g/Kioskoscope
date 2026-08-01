-- Kioskoscope — Plafond de taille du bucket `media` (CIN-101).
--
-- ── CE QUI A ÉTÉ MESURÉ AVANT D'ÉCRIRE CE FICHIER ──────────────────────────────────────────
-- Le bucket créé en `0003_storage.sql` ne fixe AUCUN `file_size_limit`. C'est donc le plafond
-- global du projet qui s'applique, et il a été mesuré en conditions réelles, sans transférer un
-- octet (le protocole d'envoi reprenable déclare la taille à la création, le serveur refuse
-- d'emblée si elle dépasse) :
--
--     52 428 800 octets, soit EXACTEMENT 50 Mio — le défaut d'un projet Supabase.
--
-- Autrement dit, avant cette migration, un film de 6 Go était refusé en HTTP 413 quoi que fasse
-- le navigateur. Aucun travail côté client — empreinte en flux, envoi reprenable, barre de
-- progression — ne déplace ce plafond d'un seul octet.
--
-- ⚠️ CETTE MIGRATION NE SUFFIT PAS, ET C'EST LE POINT IMPORTANT.
-- `storage.buckets.file_size_limit` ne peut pas DÉPASSER le plafond global du projet. Celui-ci
-- n'est pas une donnée SQL : c'est un réglage de plateforme (Dashboard → Storage → Settings),
-- et sa valeur maximale dépend du forfait. Tant qu'il reste à 50 Mio, la valeur posée ici est
-- inerte — juste, mais sans effet.
--
-- L'ordre d'application n'a en revanche AUCUNE importance : cette valeur devient effective
-- d'elle-même dès que le plafond global est relevé. On peut donc l'appliquer maintenant.
--
-- ⚠️ `allowed_mime_types` reste DÉLIBÉRÉMENT non restreint. Le bucket `media` ne contient pas
-- que des vidéos : il porte aussi les pistes de sous-titres `text/vtt` (cf. `saveSubtitle`).
-- Une liste blanche trop courte casserait les sous-titres en silence, à l'envoi, sans que rien
-- à l'écran n'explique pourquoi. Le durcissement mérite son propre ticket et ses propres tests.

update storage.buckets
   set file_size_limit = 6 * 1024 * 1024 * 1024   -- 6 Gio, la cible annoncée de CIN-101
 where id = 'media';
