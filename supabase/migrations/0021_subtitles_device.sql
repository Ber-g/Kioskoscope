-- Kioskoscope — la borne (device) lit les sous-titres de son org (F12, consommation cabine).
--
-- Les `subtitles` (0001) n'avaient pas de policy DEVICE → la borne ne pouvait pas les charger.
-- On ajoute une lecture device scopée à l'org (helper device_org() de CIN-002), symétrique de
-- `media_device_select` (0009). La borne n'affiche que les sous-titres VÉRIFIÉS + format VTT
-- (filtrage APPLICATIF côté booth-client) ; la RLS, elle, borne juste à l'org.
--
-- ⚠️ À appliquer sur Supabase (après 0020). Idempotent.

drop policy if exists subtitles_device_select on public.subtitles;
create policy subtitles_device_select on public.subtitles for select
  using (organization_id = public.device_org());
