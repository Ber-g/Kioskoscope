-- Kioskoscope — versions vidéo par langue (CIN-095) + traçabilité du fichier (CIN-104).
--
-- CONTEXTE. Un média n'a aujourd'hui qu'UN seul fichier (`media.storage_url`), et le nom du
-- fichier d'origine est perdu à l'upload (le chemin de stockage est `{org}/{content_hash}`).
-- Deux manques en découlent : impossible de proposer une version linguistique du film, et
-- impossible de dire QUEL fichier est en ligne, depuis quand, envoyé par qui.
--
-- ⚠️ LA BORNE N'EST PAS TOUCHÉE. Elle continue de lire `media.storage_url` exactement comme
-- avant : aucune requête nouvelle, aucun risque sur le parcours hors ligne, aucune régression
-- possible sur l'expérience public. `media.storage_url` reflète simplement la version PRIMAIRE.
-- C'est une dénormalisation ASSUMÉE et temporaire ; elle disparaîtra le jour où la cabine saura
-- choisir une version — pas avant, et pas pour le confort du back-office.
--
-- UNE VERSION = UNE LANGUE, même règle que les pistes de sous-titres : c'est ce qui rend
-- l'ajout d'une 2ᵉ version sans ambiguïté (elle n'écrase jamais la 1ʳᵉ).
--
-- ⚠️ À appliquer sur Supabase, après 0001-0026. Idempotent.

create table if not exists public.media_videos (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  media_id          uuid not null references public.media (id) on delete cascade,
  lang              text not null,
  storage_url       text not null,
  -- Traçabilité (CIN-104) : ce que le back-office ne savait pas dire jusqu'ici.
  -- ⚠️ Non rétroactif : pour les fichiers déjà en ligne, ces colonnes restent nulles —
  -- l'information n'a jamais été capturée. L'UI doit afficher « inconnu (envoyé avant le
  -- suivi) » plutôt qu'un blanc, qui laisserait croire à une donnée manquante par erreur.
  original_filename text,
  size_bytes        bigint,
  created_at        timestamptz not null default now(),
  created_by        uuid references public.users (id) on delete set null,
  -- La version servie aux cabines (miroir de `media.storage_url`).
  is_primary        boolean not null default false,
  -- Une seule version par langue et par média : c'est la règle qui lève l'ambiguïté.
  unique (media_id, lang)
);

-- Une seule version primaire par média (index PARTIEL : plusieurs `false` restent permis).
create unique index if not exists media_videos_one_primary
  on public.media_videos (media_id) where is_primary;

create index if not exists media_videos_media_idx on public.media_videos (media_id);

alter table public.media_videos enable row level security;

-- Lecture : membres de l'org, ou global_admin. Le compte DEVICE n'est volontairement PAS
-- autorisé : la borne lit `media.storage_url` et n'a aucun besoin du catalogue des versions.
-- On n'ouvre pas une surface « au cas où » — elle s'ajoutera le jour où la cabine en aura l'usage.
drop policy if exists media_videos_select on public.media_videos;
create policy media_videos_select on public.media_videos for select
  using (public.is_global_admin() or organization_id in (select public.current_org_ids()));

-- Écriture : membres de l'org (mêmes droits que sur `media`, dont ces lignes sont un détail).
drop policy if exists media_videos_write on public.media_videos;
create policy media_videos_write on public.media_videos for all
  using (public.is_global_admin() or organization_id in (select public.current_org_ids()))
  with check (public.is_global_admin() or organization_id in (select public.current_org_ids()));

-- Backfill : chaque média possédant déjà un fichier devient sa propre version primaire, dans la
-- langue déclarée du média. Sans cela le tableau des versions s'ouvrirait vide sur un catalogue
-- existant — l'opérateur croirait avoir perdu ses fichiers.
insert into public.media_videos (organization_id, media_id, lang, storage_url, is_primary)
select m.organization_id, m.id, coalesce(nullif(m.language, ''), 'fr'), m.storage_url, true
  from public.media m
 where m.storage_url is not null
   and not exists (select 1 from public.media_videos v where v.media_id = m.id)
on conflict (media_id, lang) do nothing;
