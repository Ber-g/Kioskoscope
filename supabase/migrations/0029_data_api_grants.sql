-- Kioskoscope — Droits d'accès explicites à l'API de données (échéance Supabase, 30/10/2026).
--
-- ── CE QUI CHANGE LE 30 OCTOBRE 2026 ──────────────────────────────────────────────────────
-- Supabase arrête d'accorder automatiquement l'accès API aux tables créées dans le schéma
-- `public`. Les tables DÉJÀ EN LIGNE gardent leurs droits : la production n'est pas touchée,
-- et ce fichier n'est pas un correctif d'urgence.
--
-- Ce qui casse, c'est tout ce qui RECONSTRUIT le schéma à partir de ces migrations :
--   • un nouveau projet Supabase (reprise après sinistre, second environnement) ;
--   • une branche de prévisualisation ;
--   • `supabase db reset` en local ;
--   • toute table créée par une migration 0030+ sur le projet existant.
-- Dans ces cas-là, les 29 tables de `public` deviennent injoignables par supabase-js :
-- « permission denied for table X ». Le dashboard et la cabine ne voient plus RIEN — et le
-- message ne ressemble à rien d'un problème de RLS, ce qui coûte des heures de diagnostic.
--
-- Le garde-fou local disparaît aussi : `supabase/config.toml` documente le champ
-- `auto_expose_new_tables`, déjà déprécié, et annonce sa suppression à cette même date.
--
-- ── CE QUI EST ACCORDÉ, ET À QUI ──────────────────────────────────────────────────────────
-- `authenticated` : lecture + écriture sur toutes les tables. L'isolation ne vient PAS des
--   grants, elle vient de la RLS (0002 et suivantes) : un grant ouvre la porte de l'API, la
--   policy décide quelles LIGNES passent. Restreindre ici ne sécuriserait rien de plus et
--   créerait un SECOND endroit où chercher le jour où une écriture est refusée — exactement
--   le piège déjà rencontré avec `RETURNING` sans policy SELECT.
-- `service_role` : idem, pour les Edge Functions. Il contourne la RLS mais a quand même
--   besoin du grant : sans lui, la page publique /s/{token} tombe.
-- `anon` : RIEN. Aucune policy du projet ne cible `anon` ni le rôle `public` — vérifié sur
--   les 29 migrations. Une requête non authentifiée ne ramène donc déjà aucune ligne
--   aujourd'hui, et la page publique passe par une Edge Function en `service_role`, jamais
--   par la clé anon. Conséquence assumée : sur un projet reconstruit, une requête anonyme
--   reçoit « permission denied » au lieu d'une liste vide. C'est un durcissement, pas une
--   régression.
--
-- Aucune séquence à accorder : toutes les clés primaires sont des uuid.
--
-- ── FONCTIONS : LE PIÈGE LE MOINS VISIBLE ─────────────────────────────────────────────────
-- Postgres accorde EXECUTE au rôle `public` par défaut ; la même bascule le retire pour les
-- fonctions créées dans `public`. Or les aides `security definer` sont appelées DANS les
-- policies : sans EXECUTE, ce n'est pas une fonction qui échoue, c'est la policy elle-même,
-- et plus une seule ligne ne se lit nulle part. Elles sont donc accordées explicitement.
--
-- Deux fonctions gardent leur verrou `service_role` posé en 0014 et 0026 (`session_recap`,
-- `record_share_open`) : elles ne sont pas reprises ici. Deux autres portent déjà leur grant
-- `authenticated` dans leur propre migration (`accept_invitation` en 0006,
-- `blocked_media_for_booth` en 0010) : inutile de les répéter.
-- Les fonctions de trigger (`handle_new_user`, `guard_last_super_user`, `set_updated_at`)
-- n'ont besoin d'aucun grant : le droit est vérifié à la CRÉATION du trigger, pas à chaque
-- déclenchement.
--
-- ── RÈGLE POUR LA SUITE ───────────────────────────────────────────────────────────────────
-- Toute migration 0030+ qui crée une table ou une fonction porte ses grants dans le MÊME
-- fichier, juste après le `create`. Voir `supabase/README.md`, § « Droits d'accès à l'API ».
--
-- ⚠️ À appliquer sur Supabase, après 0001-0028. Idempotent : `grant` réappliqué sur un droit
-- déjà présent n'a aucun effet observable.

-- ── Tables (ordre alphabétique ; une ligne par table, greppable) ──────────────────────────
grant select, insert, update, delete on public.alerts                 to authenticated, service_role;
grant select, insert, update, delete on public.booth_updates          to authenticated, service_role;
grant select, insert, update, delete on public.booths                 to authenticated, service_role;
grant select, insert, update, delete on public.daily_stats            to authenticated, service_role;
grant select, insert, update, delete on public.distributors           to authenticated, service_role;
grant select, insert, update, delete on public.invitations            to authenticated, service_role;
grant select, insert, update, delete on public.license_booths         to authenticated, service_role;
grant select, insert, update, delete on public.media                  to authenticated, service_role;
grant select, insert, update, delete on public.media_instances        to authenticated, service_role;
grant select, insert, update, delete on public.media_licenses         to authenticated, service_role;
grant select, insert, update, delete on public.media_videos           to authenticated, service_role;
grant select, insert, update, delete on public.memberships            to authenticated, service_role;
grant select, insert, update, delete on public.notification_preferences to authenticated, service_role;
grant select, insert, update, delete on public.notifications          to authenticated, service_role;
grant select, insert, update, delete on public.operator_access        to authenticated, service_role;
grant select, insert, update, delete on public.operator_access_log    to authenticated, service_role;
grant select, insert, update, delete on public.org_entitlements       to authenticated, service_role;
grant select, insert, update, delete on public.org_styles             to authenticated, service_role;
grant select, insert, update, delete on public.organizations          to authenticated, service_role;
grant select, insert, update, delete on public.os_update_commands     to authenticated, service_role;
grant select, insert, update, delete on public.payment_integrations   to authenticated, service_role;
grant select, insert, update, delete on public.plays                  to authenticated, service_role;
grant select, insert, update, delete on public.releases               to authenticated, service_role;
grant select, insert, update, delete on public.sessions               to authenticated, service_role;
grant select, insert, update, delete on public.share_opens            to authenticated, service_role;
grant select, insert, update, delete on public.storage_locations      to authenticated, service_role;
grant select, insert, update, delete on public.subtitles              to authenticated, service_role;
grant select, insert, update, delete on public.transactions           to authenticated, service_role;
grant select, insert, update, delete on public.users                  to authenticated, service_role;

-- ── Aides `security definer` appelées dans les policies ───────────────────────────────────
grant execute on function public.is_global_admin()          to authenticated, service_role;
grant execute on function public.current_org_ids()          to authenticated, service_role;
grant execute on function public.can_write_org(uuid)        to authenticated, service_role;
grant execute on function public.is_org_super_user(uuid)    to authenticated, service_role;
grant execute on function public.shares_org(uuid)           to authenticated, service_role;
grant execute on function public.current_device_booth()     to authenticated, service_role;
grant execute on function public.device_org()               to authenticated, service_role;
