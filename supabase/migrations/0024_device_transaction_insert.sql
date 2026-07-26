-- Kioskoscope — 0024 : la borne peut enregistrer le REVENU de ses propres séances.
--
-- SYMPTÔME : les séances et les lectures remontent bien, mais le menu **Revenus** reste vide /
-- les stats semblent figées. Cause : le dashboard lit la table `transactions` (pas
-- `sessions.amount_cents`), or `booth-client` n'y écrivait jamais — et le compte device n'a
-- de toute façon aucune policy d'écriture sur `transactions` (seules les policies humaines
-- `transactions_write` = can_write_org existent, 0002).
--
-- La boucle de valeur « un visiteur paie → le revenu remonte » n'était donc jamais prouvée.
--
-- CORRECTIF (3 volets, celui-ci = la base) :
--   1. code borne : `MockUnlockAdapter` porte un montant sur un déverrouillage réussi ;
--   2. code borne : `saveSession` insère la transaction (id = id de séance → rejeu idempotent) ;
--   3. **cette migration** : policy device INSERT sur `transactions`, scopée à SA borne.
--
-- Isolation : le device ne peut créer une transaction que pour la borne à laquelle il est lié
-- (`booth_id = current_device_booth()`) — il ne peut donc pas gonfler le CA d'une autre borne
-- ni d'une autre org. Additive (OR avec les policies humaines) → aucun impact sur les comptes
-- membres. Écriture seule : pas de SELECT/UPDATE/DELETE device sur `transactions` (append-only).
--
-- ⚠️ À appliquer sur Supabase (SQL editor). Idempotent.

drop policy if exists transactions_device_insert on public.transactions;
create policy transactions_device_insert on public.transactions for insert
  with check (booth_id = public.current_device_booth());
