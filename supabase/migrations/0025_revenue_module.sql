-- Kioskoscope — module « revenue » : gating du menu Revenus (CIN-099, F18).
--
-- CONTEXTE. Jusqu'ici seul « Droits » était gaté par un module ; « Revenus » était visible par
-- TOUTE organisation. Or une org forfaitaire (le lieu paie un forfait, la séance est gratuite
-- pour le spectateur) ou un festival ne facture rien : lui afficher un menu Revenus à 0 € en
-- permanence est un contresens produit. On introduit donc le module `revenue`.
--
-- POURQUOI UN MODULE ET PAS UNE RÈGLE SUR `subscription_type` : le contenu des paliers n'est
-- PAS figé (décision exploitant, cf. `SUBSCRIPTION_TYPES` côté dashboard). Coder en dur
-- « free_flat ⇒ pas de revenus » figerait une politique commerciale non arrêtée. Le module
-- laisse le super-admin trancher org par org, avec l'UI d'attribution qui existe déjà.
--
-- ⚠️ MIGRATION NON NEUTRE SANS BACKFILL. Rappel de 0011 : « pas de ligne = tous les modules
-- actifs ». Les orgs SANS ligne ne sont donc pas concernées (elles gardent Revenus). Mais toute
-- org AYANT une ligne verrait son menu Revenus disparaître du jour au lendemain, puisque son
-- `enabled_modules` a été écrit avant l'existence de cette clé. D'où le backfill ci-dessous.
--
-- RÈGLE DE BACKFILL (par défaut prudent — révisable par le super-admin dans l'UI Organisations) :
--   • `free_flat` (Forfaitaire Libre) → PAS de module revenue : c'est précisément le cas d'usage
--     « on ne tire 0 € des séances » remonté en session de test (2026-07-25).
--   • `demo`, `subscription`, `per_screening` → module revenue accordé. Pour `subscription`,
--     l'abonnement lie l'org à Kioskoscope mais n'implique pas la gratuité côté spectateur ;
--     on ne masque donc pas (masquer à tort cache de l'argent réel — l'erreur coûteuse).
--
-- ⚠️ À appliquer sur Supabase (après 0001-0024). Idempotent.

-- 1) Nouveau défaut pour les lignes CRÉÉES ensuite (aligné sur la règle ci-dessus, cas courant).
alter table public.org_entitlements
  alter column enabled_modules set default array['rights', 'personalization', 'revenue'];

-- 2) Backfill des lignes EXISTANTES. `array_append` seulement si la clé est absente, pour que
--    rejouer la migration ne duplique jamais l'entrée (idempotence).
update public.org_entitlements
   set enabled_modules = array_append(enabled_modules, 'revenue'),
       updated_at      = now()
 where subscription_type <> 'free_flat'
   and not ('revenue' = any (enabled_modules));

-- Volontairement PAS de retrait symétrique pour les orgs `free_flat` : la clé ne pouvait pas
-- exister avant cette migration, donc un tel retrait ne se déclencherait qu'au REJEU — et
-- écraserait alors une décision explicite du super-admin (accorder Revenus à une org
-- forfaitaire, cas parfaitement légitime). Une migration se rejoue sans rien casser ; elle
-- n'arbitre pas à la place de l'exploitant.
