-- Kioskoscope — 0023 : (re)assertion des policies device pour l'écriture des séances/lectures.
--
-- SYMPTÔME : compte device « nu » (sans membership) → INSERT sessions/plays refusé par RLS
--   « new row violates row-level security policy for table "sessions" »
-- alors que current_device_booth() renvoie bien le booth de la borne et device_org() son org.
--
-- CAUSE : les policies device sessions_device_insert / plays_device_insert (prévues par 0009)
-- ne sont PAS présentes dans la base. media_device_select (lecture) y est — le catalogue charge —
-- donc 0009 a été appliqué AVANT que ces policies d'écriture soient ajoutées au fichier 0009
-- (dérive « fichier de migration édité après application »). L'ancien compte device était membre
-- (super_user) et passait par sessions_write (0002) → le trou ne s'était jamais vu.
-- Analogue exact au trou média fermé par 0022 (media_read_device).
--
-- CORRECTIF : (re)poser ces policies de façon IDEMPOTENTE. Additives (OR avec les policies
-- humaines sessions_write/plays_write de 0002) → aucun impact sur les comptes membres.
-- Isolation préservée : le device ne peut écrire QUE des séances de SA borne (booth_id =
-- current_device_booth()) et des lectures de SON org (organization_id = device_org()).
--
-- ⚠️ À appliquer sur Supabase (SQL editor). Idempotent (drop if exists + create).

drop policy if exists sessions_device_insert on public.sessions;
create policy sessions_device_insert on public.sessions for insert
  with check (booth_id = public.current_device_booth());

drop policy if exists plays_device_insert on public.plays;
create policy plays_device_insert on public.plays for insert
  with check (organization_id = public.device_org());
