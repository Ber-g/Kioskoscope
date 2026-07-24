-- Kioskoscope — 2ᵉ identifiant de borne : numéro physique éditable.
--
-- `booths.id` (UUID) = identité LOGIQUE stable qui ancre tout l'historique (séances/plays/télémétrie) :
-- on ne la change jamais. `booths.serial` = **numéro physique** de la borne, ÉDITABLE (le global_admin
-- peut le faire évoluer si le matériel change), texte libre, non unique. Purement descriptif : aucune
-- policy RLS ne s'y appuie (l'isolation reste sur organization_id / device_user_id).
--
-- ⚠️ À appliquer sur Supabase (après 0019). Idempotent.

alter table public.booths add column if not exists serial text;
comment on column public.booths.serial is
  '2e id éditable (numéro physique). Distinct de id (UUID stable). Éditable global_admin only (applicatif). Non unique.';
