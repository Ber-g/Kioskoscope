-- Kioskoscope — F21 : instrumentation des statistiques d'exploitation (CIN-105 + CIN-106).
--
-- POURQUOI CETTE MIGRATION EXISTE. Deux des métriques attendues du tableau de bord statistiques
-- ne sont PAS mesurables aujourd'hui, et aucune requête ne pourra les inventer a posteriori :
--   1. le **% d'écoute** d'un film — `plays` ne porte qu'un booléen `completed` ;
--   2. les **ouvertures de la page QR** — l'Edge Function `/s/{token}` ne journalise rien.
-- Chaque jour sans cette instrumentation est de la donnée DÉFINITIVEMENT perdue : on ne rejoue
-- pas une séance passée. D'où la règle posée en spec : instrumenter AVANT de dessiner la vue.
--
-- CES CHIFFRES SONT DESTINÉS À DES AYANTS DROIT. Ils ne sont pas décoratifs : ils serviront de
-- base déclarative auprès de distributeurs. L'exactitude et la NON-DUPLICATION priment sur la
-- finesse — d'où la contrainte d'idempotence ci-dessous, qui corrige un trou préexistant.
--
-- ⚠️ À appliquer sur Supabase (SQL editor), après 0001-0025. Idempotent.

-- ── 1. Taux d'écoute (CIN-105) ───────────────────────────────────────────────
-- La borne écrit ses lectures en FIN DE SÉANCE, en un seul INSERT (`saveSession`) : ces colonnes
-- partent donc avec ce même INSERT. Aucune policy UPDATE device n'est requise — le compte device
-- reste strictement INSERT-only sur `plays`, comme posé en 0023. C'est aussi ce qui fait que la
-- mesure survit au hors-ligne : elle voyage dans le snapshot déjà bufferisé par `sessionJournal`.

alter table public.plays add column if not exists ended_at       timestamptz;
alter table public.plays add column if not exists watched_seconds int not null default 0;

-- Courbe de rétention : 10 booléens « le spectateur a-t-il atteint ce décile du film ? ».
-- CHOIX DE CONCEPTION : des déciles plutôt qu'une table d'événements de progression. Une table
-- d'événements coûterait des milliers de lignes par séance pour une précision dont personne n'a
-- l'usage ; 10 booléens donnent le taux d'écoute ET une courbe exploitable, à coût constant.
alter table public.plays add column if not exists deciles_reached boolean[]
  not null default array[false,false,false,false,false,false,false,false,false,false];

-- Garde-fou de forme : exactement 10 déciles, sinon les agrégats deviennent silencieusement faux.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plays_deciles_len') then
    alter table public.plays
      add constraint plays_deciles_len check (array_length(deciles_reached, 1) = 10);
  end if;
end $$;

-- Cohérence : une durée vue ne peut pas être négative.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plays_watched_seconds_positive') then
    alter table public.plays
      add constraint plays_watched_seconds_positive check (watched_seconds >= 0);
  end if;
end $$;

-- ── 2. Idempotence des lectures — CORRECTIF D'UN TROU PRÉEXISTANT ────────────
-- `saveSession` réinsère TOUTES les lectures d'une séance quand la remontée a échoué (buffer
-- hors-ligne + rejeu). Or `plays` n'a aucune contrainte d'unicité : si l'INSERT a réussi côté
-- base mais que la RÉPONSE s'est perdue (réseau coupé au mauvais moment), le rejeu DUPLIQUE les
-- lectures. Jusqu'ici c'était un défaut cosmétique ; à partir du moment où ces lignes comptent
-- des redevances, c'est une erreur de déclaration. Une séance ne peut avoir qu'une lecture à une
-- position donnée → la clé naturelle est (session_id, position).

-- Dédoublonnage préalable : sans lui, la création de l'index échouerait sur une base déjà
-- polluée. On conserve la ligne la plus complète (la plus avancée), puis la plus ancienne.
delete from public.plays p
 using public.plays q
 where p.session_id = q.session_id
   and p.position   = q.position
   and (p.watched_seconds, p.ctid) < (q.watched_seconds, q.ctid);

create unique index if not exists plays_session_position_uniq
  on public.plays (session_id, "position");

-- ── 3. Ouvertures de la page de partage (CIN-106) ────────────────────────────
-- ⚠️ ZÉRO DONNÉE PERSONNELLE, PAR CONSTRUCTION. Pas d'IP, pas de user-agent, pas de cookie, pas
-- d'identifiant d'appareil. La page publique est `noindex` et ne divulgue que des films (F5) :
-- la mesurer ne doit pas transformer un QR anonyme en traceur de téléphone. On ne stocke QUE
-- « telle séance a vu sa page ouverte à tel instant ». C'est suffisant pour le chiffre attendu,
-- et c'est un argument commercial (RGPD-clean), pas une contrainte subie.

create table if not exists public.share_opens (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  session_id      uuid not null references public.sessions (id) on delete cascade,
  opened_at       timestamptz not null default now()
);

create index if not exists share_opens_org_time_idx on public.share_opens (organization_id, opened_at desc);
create index if not exists share_opens_session_idx  on public.share_opens (session_id);

alter table public.share_opens enable row level security;

-- Lecture : membre de l'org (ses propres stats) ou global_admin. Aucune écriture par un humain
-- ni par un device : la seule voie d'écriture est la fonction ci-dessous, en service_role.
drop policy if exists share_opens_select on public.share_opens;
create policy share_opens_select on public.share_opens for select
  using (public.is_global_admin() or organization_id in (select public.current_org_ids()));

-- Enregistre une ouverture à partir du TOKEN (jamais d'un id d'org/séance fourni par l'appelant).
-- Même patron défensif que `session_recap` : le token est un secret de capacité, sa résolution
-- reste encapsulée en base. Token inconnu ⇒ aucune ligne, aucun signal d'énumération.
create or replace function public.record_share_open(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_org_id     uuid;
begin
  select s.id, s.organization_id into v_session_id, v_org_id
    from public.sessions s
   where s.share_token = p_token;
  if v_session_id is null then
    return; -- token inconnu : on ne distingue jamais « inexistant » de « rien à faire »
  end if;
  insert into public.share_opens (organization_id, session_id) values (v_org_id, v_session_id);
end;
$$;

revoke all on function public.record_share_open(text) from public;
revoke all on function public.record_share_open(text) from anon;
revoke all on function public.record_share_open(text) from authenticated;
grant execute on function public.record_share_open(text) to service_role;
