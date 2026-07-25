-- Kioskoscope — la borne (device) peut LIRE les fichiers de son org dans le bucket privé `media`
-- (POC média : lecture réelle des vidéos + sous-titres depuis le backend).
--
-- Le bucket `media` est privé (0003). Ses policies `media_read/write/delete` reposent sur les
-- MEMBERSHIPS (`current_org_ids()`), or le compte-device est « nu » (aucun membership) → il n'a
-- aucun accès storage → il ne peut donc pas générer d'URL signée pour lire une vidéo ou un
-- sous-titre. On ajoute une lecture DEVICE scopée à l'org (helper `device_org()` de CIN-002),
-- symétrique de `subtitles_device_select` (0021). Écriture inchangée (la borne ne fait que LIRE :
-- l'upload reste réservé aux comptes humains à droits d'écriture).
--
-- ⚠️ À appliquer sur Supabase (après 0021). Idempotent (re-run sans erreur).

drop policy if exists "media_read_device" on storage.objects;
create policy "media_read_device" on storage.objects for select to authenticated
using (
  bucket_id = 'media'
  and (storage.foldername(name))[1]::uuid = public.device_org()
);
