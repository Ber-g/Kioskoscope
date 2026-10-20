-- Kioskoscope — Constat de l'état réel des migrations appliquées.
--
-- ⚠️ CE FICHIER N'EST PAS UNE MIGRATION. Il vit dans `tests/`, jamais dans `migrations/`,
-- et le CLI Supabase ne l'applique donc jamais. C'est voulu, pour trois raisons :
--   1. une migration change un état ; un diagnostic le CONSTATE. Mélanger les deux produit
--      un fichier qu'on n'ose plus rejouer ;
--   2. une migration ne s'exécute qu'une fois, et sa sortie n'est lue par personne. Un
--      diagnostic doit être relançable à volonté, et son résultat LU ;
--   3. on ne modifie jamais une migration déjà appliquée. Y glisser un `select` obligerait
--      à l'éditer à chaque fois que le diagnostic évolue.
--
-- ── À QUOI ÇA SERT ────────────────────────────────────────────────────────────────────────
-- Tout le SQL du projet a longtemps été appliqué à la main dans le SQL Editor. Résultat :
-- `supabase_migrations.schema_migrations` est vide, et `supabase migration list` ne sait donc
-- rien de ce qui tourne réellement. Ce fichier comble ce trou : une ligne par migration, un
-- objet-signature par ligne.
--
-- ── MODE D'EMPLOI ─────────────────────────────────────────────────────────────────────────
-- 1. Coller ce fichier dans le SQL Editor de Supabase → Run. Lecture seule, aucun risque.
-- 2. Noter les numéros à `true`.
-- 3. Pour CES NUMÉROS SEULEMENT :
--      supabase migration repair --status applied 0001 0002 …
-- 4. Puis `supabase db push` applique le reste. Ensuite, le SQL Editor ne sert plus qu'à lire.
--
-- ⚠️ Marquer `applied` une migration qui ne l'est PAS l'exclut définitivement de `db push`.
-- C'est un trou permanent, silencieux, qui se révèle par une colonne manquante des semaines
-- plus tard. D'où la règle : on ne répare que ce qui sort `true` ici.
--
-- ── POURQUOI 0028 ET 0029 SONT ABSENTES ───────────────────────────────────────────────────
-- Elles sont purement idempotentes et additives, donc INSONDABLES par construction : aucune
-- requête ne peut distinguer « l'objet existe » de « cette migration l'a créé ».
--   • 0029 n'accorde que des droits API. Avant la bascule Supabase du 30/10/2026, les tables
--     de `public` les reçoivent AUTOMATIQUEMENT — un `has_table_privilege` répondrait `true`
--     même si 0029 n'avait jamais tourné. Faux positif garanti.
--   • 0028 est inerte : le plafond de téléversement est un réglage de projet, pas de bucket.
-- Règle générale : une migration idempotente ne se répare jamais, elle se LAISSE APPLIQUER
-- par `db push`. La rejouer ne coûte rien ; la marquer à tort coûte un trou permanent.
--
-- Même angle mort, à ne pas oublier : la requête de contrôle des grants dans
-- `supabase/README.md` conclut « Zéro ligne = rien à faire », alors qu'elle sort vide même
-- sans 0029, pour la raison ci-dessus. Elle ne vérifiera vraiment quelque chose qu'après la
-- bascule du 30/10/2026, ou sur un projet reconstruit.

select *
from (values
  ('0001', to_regclass('public.organizations')          is not null),
  ('0002', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='is_global_admin')),
  ('0003', exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='media_read')),
  ('0004', exists (select 1 from information_schema.columns where table_schema='public' and table_name='media' and column_name='reviewed_at')),
  ('0005', to_regclass('public.payment_integrations')    is not null),
  ('0006', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='is_org_super_user')),
  ('0007', to_regclass('public.distributors')            is not null),
  ('0008', to_regclass('public.releases')                is not null),
  ('0009', exists (select 1 from pg_indexes where schemaname='public' and indexname='booths_device_user_idx')),
  ('0010', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='blocked_media_for_booth')),
  ('0011', to_regclass('public.org_entitlements')        is not null),
  ('0012', exists (select 1 from information_schema.columns where table_schema='public' and table_name='booths' and column_name='venue_type')),
  ('0013', to_regclass('public.notifications')           is not null),
  ('0014', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='session_recap')),
  ('0015', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='set_updated_at')),
  ('0016', exists (select 1 from pg_policies where schemaname='public' and tablename='releases'     and policyname='releases_write')),
  ('0017', to_regclass('public.os_update_commands')      is not null),
  ('0018', to_regclass('public.org_styles')              is not null),
  ('0019', exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'     and policyname='org_assets_read')),
  ('0020', exists (select 1 from information_schema.columns where table_schema='public' and table_name='booths' and column_name='serial')),
  ('0021', exists (select 1 from pg_policies where schemaname='public' and tablename='subtitles'    and policyname='subtitles_device_select')),
  ('0022', exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'     and policyname='media_read_device')),
  ('0023', exists (select 1 from pg_policies where schemaname='public' and tablename='sessions'     and policyname='sessions_device_insert')),
  ('0024', exists (select 1 from pg_policies where schemaname='public' and tablename='transactions' and policyname='transactions_device_insert')),
  -- 0025 : sonde par motif de texte sur un `default`. Si elle sort `false` alors que le menu
  -- Revenus fonctionne au dashboard, vérifier à la main avant de conclure.
  ('0025', coalesce((select column_default like '%revenue%' from information_schema.columns
             where table_schema='public' and table_name='org_entitlements' and column_name='enabled_modules'), false)),
  ('0026', to_regclass('public.share_opens')             is not null),
  ('0027', to_regclass('public.media_videos')            is not null)
  -- 0028 et 0029 : volontairement absentes (idempotentes, insondables — voir l'en-tête).
) as t(migration, applique)
order by 1;
