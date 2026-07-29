# Preuve d'isolation multi-org (RLS)

Prouve que deux organisations ne peuvent **jamais** voir ni modifier les données
l'une de l'autre — l'exigence de premier rang F7. La preuve attaque la base avec
**deux sessions authentifiées réelles** (clé anon + JWT), pas en `service_role`.

> ⚠️ **Ne pas tester dans le SQL editor Supabase** : il tourne en `service_role` et
> **bypasse la RLS**. Il ne prouve donc rien sur l'isolation. Seul un JWT d'un vrai
> utilisateur scoping une org fait foi — c'est ce que fait `isolation.mjs`.

## 1. Prérequis côté Supabase (une fois)

1. **Seed appliqué** — les orgs `…a1` (Le Perchoir) et `…a2` (Le Comptoir Général)
   doivent exister (`supabase/seed.sql`). Vérifier : `select id, name from public.organizations;`
2. **Deux comptes Auth** — `Authentication → Add user` (coche *Auto Confirm User*) :
   - `iso-a@cinematon.test` + un mot de passe
   - `iso-b@cinematon.test` + un mot de passe
   Ne PAS réutiliser ton compte perso (il est `global_admin` → bypasse la RLS).
3. **Memberships** — exécuter `setup_isolation.sql` dans le SQL editor. Il attribue
   `super_user` : user A → org a1, user B → org a2, et garantit `is_global_admin = false`.
   La requête finale doit renvoyer **2 lignes**.

## 2. Lancer la preuve (local)

```bash
ISO_A_EMAIL=iso-a@cinematon.test ISO_A_PASSWORD='…' \
ISO_B_EMAIL=iso-b@cinematon.test ISO_B_PASSWORD='…' \
  node --experimental-websocket supabase/tests/isolation.mjs
```

> **Node 20** : le flag `--experimental-websocket` est nécessaire (supabase-js
> instancie un client Realtime qui exige un `WebSocket` global, natif seulement à
> partir de Node 22). Node 22+ : le flag est inutile.

L'URL et la clé anon sont lues automatiquement depuis `admin-dashboard/.env`
(ou via `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` dans l'environnement).

Orgs surchargées si besoin : `ISO_ORG_A` / `ISO_ORG_B`.

## 3. Ce qui est vérifié (par tenant, dans les deux sens)

| # | Test | Attendu |
|---|------|---------|
| 1 | `select booths` | aucune ligne d'une autre org |
| 2 | `select organizations` | uniquement la sienne ; l'org adverse invisible |
| 3 | `select media` | aucune fuite cross-org |
| 4 | sonde `booths`/`sessions where org = adverse` | 0 ligne |
| 5 | `INSERT booth` dans l'org adverse | refusé (RLS `with check`) |
| 6 | `UPDATE booths` de l'org adverse | 0 ligne affectée |
| 7 | **contrôle positif** : agir sur SA propre org | autorisé (puis cleanup) |

Le contrôle positif (#7) est essentiel : sans lui, une base « deny all » passerait
le test à tort. Il prouve que le test sait distinguer *refusé* de *autorisé*.

**Sortie** : `exit 0` = isolation prouvée ; `exit 1` = fuite détectée ;
`exit 2` = setup incomplet (compte/clé manquants) ; `exit 3` = erreur inattendue.

## 4. Contrôle visuel (bonus)

Se connecter au dashboard avec `iso-a@…` : ne doit afficher que Le Perchoir.
Se reconnecter avec `iso-b@…` : ne doit afficher que Le Comptoir Général.

## Lancer le bloc device SEUL (CIN-122)

Depuis le 2026-07-29, `isolation.mjs` contient **deux suites indépendantes**, chacune activée par
ses propres identifiants. Au moins une est requise ; les deux peuvent tourner ensemble.

```bash
# device seul — plus besoin de ISO_A_* / ISO_B_*
ISO_DEVICE_EMAIL='…' ISO_DEVICE_PASSWORD='…' node supabase/tests/isolation.mjs
```

Ce que la sortie garantit désormais :

- **Ce qui n'a pas tourné est annoncé** (`▸ Bloc org-vs-org NON EXÉCUTÉ`, `▸ Bloc device NON
  EXÉCUTÉ`). Un total partiel qui ne se déclare pas partiel se lit comme une preuve complète —
  c'est ce qui avait laissé le bloc device inexécuté pendant cinq jours sous un « 79/79 OK »
  exact et trompeur. **Un bloc sauté n'incrémente aucun compteur** : jusqu'au 2026-07-29 le saut
  du bloc device s'écrivait `assert(true, …)`, donc il gonflait le dénominateur en plus de se
  lire comme un succès. Le « 79/79 » historique valait en réalité 78.

### Totaux attendus — à comparer à chaque run

| Suites lancées | Total attendu |
|---|---|
| org-vs-org seule | **78** (39 vérifications × 2 sens) |
| device seule | **10** |
| les deux ensemble | **88** |

Un total qui ne figure pas dans ce tableau veut dire qu'un bloc a été sauté, ou qu'un bloc a été
ajouté sans mettre ce tableau à jour. Les deux méritent qu'on s'arrête.
- **Le compte de test doit appartenir à une org qui a du contenu.** Toutes les vérifications de
  la suite device sont des négations (« 0 ligne de l'org adverse », « écriture refusée ») : un
  compte qui ne lit RIEN les passe toutes, trivialement. Un **contrôle positif** échoue donc
  bruyamment si l'org du device est indéterminable — ce n'est pas une fuite, c'est une preuve non
  concluante, et le message le distingue.

Codes de sortie : `0` prouvé · `1` échec (fuite **ou** preuve non concluante) · `2` configuration
incomplète · `3` erreur inattendue.

## Compte device (CIN-002) — durcir l'auth Kiosk

Objectif : la borne n'utilise plus un compte super_user mais un **compte device dédié** aux
droits minimaux (migration `0009`). Étapes (une fois) :

1. **Appliquer `0009_device_auth.sql`** (SQL editor).
2. **Créer le compte device** : `Authentication → Add user` (Auto Confirm), ex.
   `device-perchoir@cinematon.device` + un mot de passe.
3. **Lier le device à sa Kiosk** (SQL editor) :
   ```sql
   update public.booths
   set device_user_id = (select id from public.users where email = 'device-perchoir@cinematon.device')
   where id = '62d91f6f-3370-4462-a445-9bd43df55bb9'; -- UUID de la Kiosk
   ```
4. **Pointer la Kiosk sur le device** : dans `booth-client/.env`, remplacer
   `VITE_DEVICE_EMAIL`/`VITE_DEVICE_PASSWORD` par le compte device (au lieu de `test@`).
5. **Vérifier** :
   ```bash
   ISO_DEVICE_EMAIL=device-perchoir@cinematon.device ISO_DEVICE_PASSWORD='…' \
   ISO_DEVICE_BOOTH_ID=62d91f6f-3370-4462-a445-9bd43df55bb9 \
   ISO_DEVICE_ORG_ID=00000000-0000-0000-0000-0000000000a1 \
     node --experimental-websocket supabase/tests/device_smoke.mjs
   ```
   Attendu : le device lit son catalogue + écrit ses séances/heartbeat, mais **ne voit ni
   membres ni revenus** et **ne peut ni altérer les médias ni toucher une autre Kiosk**.
