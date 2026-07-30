# Kiosk — base système de la borne

Runtime et administration d'une borne Kioskoscope physique. Cible : **Debian/Linux +
Chromium en mode kiosk**. Couvre CIN-071 (services locaux) et CIN-077 (MAJ OS pilotée
back-office). Volet A opérateur = `booth-client` ; ici = la couche **système** sous lui.

## Architecture

```
┌─────────────────────────── Borne (Debian) ───────────────────────────┐
│                                                                        │
│  Chromium --kiosk  ──►  booth-client (web app)                         │
│        │                     │  menu opérateur (PIN offline)           │
│        │                     ▼                                         │
│        │            HTTP 127.0.0.1:4599  (jeton Bearer)                │
│        │                     │                                         │
│        │                     ▼                                         │
│  agent local (node)  ──►  nmcli / systemctl / apt / backlight         │
│   (systemd, user `kiosk`)      via sudoers LISTE BLANCHE               │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
        ▲                                   ▲
        │ watchdog (Restart=always)         │ commandes MAJ OS (CIN-077)
        └── kioskoscope-kiosk.service       └── back-office (dashboard)
```

- **`agent/agent.mjs`** — service local (Node natif, zéro dépendance). Expose au menu
  les actions système réelles et applique les MAJ OS. Écoute **127.0.0.1 seulement**.
- **`systemd/`** — `kioskoscope-agent.service` (l'agent) + `kioskoscope-kiosk.service`
  (Chromium plein écran, `Restart=always` = watchdog anti-écran-figé, F4).
- **`provisioning/`** — `setup.sh` (install idempotente), `sudoers-kioskoscope` (liste
  blanche), `kiosk-brightness` (seul écrivain du backlight).
- **`server/server.mjs`** — sert le front à Chromium, `/kiosk-config.json` (jeton + creds
  device au runtime) et **les médias locaux** (voir ci-dessous).
- **`lib/media.mjs`** — inventaire + service des médias locaux, **partagé** par l'agent et le
  serveur : une seule liste blanche d'extensions pour les deux.
- **`tests/media_smoke.mjs`** — `npm run test:kiosk` (49 assertions, aucune borne requise).

### Médias locaux — lire un film sans réseau (CIN-112)

Un média posé dans **`/var/lib/kioskoscope/media/<sha256>.<mp4|webm>`** est servi par le serveur
local en **streaming HTTP Range** sur `/media/<sha256>`, et le booth-client le **préfère** à
l'URL signée. La lecture ne dépend alors plus du réseau : débrancher le câble en pleine séance
n'interrompt plus le film.

- `<sha256>` = **`media.content_hash`**, l'empreinte calculée à l'upload back-office. C'est le seul
  contrat entre le catalogue et le disque : mauvais nom ⇒ média invisible pour la borne.
- Le dossier est **`0755 root:root`** : les deux services LISENT, seul l'approvisionnement écrit.
  Une web-app compromise ne doit pas pouvoir y déposer un fichier qui sera servi à Chromium.
- Seuls `.mp4` et `.webm` sont servis (liste fermée), et l'agent n'inventorie qu'eux.
- Un fichier de **0 octet est ignoré** (téléchargement interrompu ⇒ jamais proposé comme jouable).
- L'inventaire **constate une présence, il ne vérifie pas l'empreinte** (re-hacher 6 Go à chaque
  écran d'attente tuerait la borne). La vérification sha256 se fera **une fois, à l'ingestion**,
  quand l'approvisionnement automatique existera (lot 3 du ticket).

### Démarrer sans réseau — le catalogue de secours (CIN-112 lot 2)

À chaque catalogue chargé en ligne, le booth-client le fait **enregistrer par l'agent** dans
`/var/lib/kioskoscope/state/catalog.json` (`0700 kiosk:kiosk`, écriture atomique). Au démarrage
sans réseau, la borne relit cet instantané et le **croise avec les médias présents sur le disque** :
ce qui reste est jouable, le reste n'est pas proposé.

Deux gardes, parce que hors ligne la borne **ne peut pas réévaluer les droits** :
- **7 jours** de fenêtre de confiance (au-delà : catalogue vide) ;
- **horloge qui recule** de plus d'1 h : catalogue vide.

Règle assumée : **dans le doute, on ne joue pas.** Une séance de moins est un manque à gagner ; une
séance jouée hors droits est une redevance impayée. Un bandeau « Hors ligne » l'annonce à
l'exploitant ; quand rien n'est restaurable, le bandeau dit POURQUOI (instantané absent, trop
ancien, horloge, autre org, aucun média sur le disque).

⚠️ **Résiduel connu** : un plafond de séances peut être franchi hors ligne — la borne ignore son
allocation restante. Exposition bornée par les 7 jours, compte serveur recalé au rejeu des séances.

⚠️ **L'agent n'est joignable depuis la page que via une liste blanche d'origines** (`KIOSK_WEB_ORIGINS`,
défaut `http://127.0.0.1:8080,http://localhost:8080`). Si le front est servi sur un autre port ou un
autre nom d'hôte, **il faut l'y ajouter**, sinon tous les appels agent échouent (cf. BUG-020).

## Modèle de sécurité (@qa — non négociable)

Principe F17 : **une compromission de la web-app ne doit JAMAIS donner root.**

1. **Isolation app ↔ système.** L'agent n'est pilotable qu'avec un **jeton Bearer**
   (`/etc/kioskoscope/agent.token`, 0600) que seule la borne de confiance porte — pas
   un contenu web arbitraire. Écoute **loopback only** : inatteignable du réseau.
2. **Aucun shell.** Toutes les commandes passent par `execFile` (arguments = tableau),
   entrées validées → pas d'injection (SSID/mot de passe passés en argv à `nmcli`).
3. **Privilège minimal.** L'utilisateur `kiosk` n'a de `sudo` que sur une **liste
   blanche exhaustive** (`apt-get update/upgrade`, `systemctl restart kiosk`/`reboot`,
   `kiosk-brightness <int>`). `rm`, `bash`, éditeurs, etc. = refusés.
4. **Traçabilité.** Chaque action est journalisée (`/var/log/kioskoscope-agent.log`,
   qui/quoi/quand ; jamais le mot de passe Wi-Fi) — destinée à remonter au back-office.

## Verrouillage kiosque (CIN-072) — le public reste dans l'app

Principe : **un visiteur ne peut pas sortir du booth-client vers l'OS.** Défense en couches,
la ligne de front étant l'OS (non contournable par le contenu web) :

1. **Xorg** (`provisioning/xorg-kiosk-lockdown.conf` → `/etc/X11/xorg.conf.d/`) :
   `DontVTSwitch` (bloque Ctrl+Alt+Fn → aucun TTY de login), `DontZap` (bloque le kill X),
   et blanking/veille désactivés (la borne reste allumée). **C'est le contrôle critique** —
   sans lui, un Ctrl+Alt+F2 donne un shell.
2. **Politique Chromium managée** (`provisioning/chromium-policy.json` →
   `/etc/chromium/policies/managed/kiosk-lockdown.json`, fusionnée avec `kiosk-mtls.json`) :
   devtools désactivés, `URLBlocklist` sur `file://`/`chrome://`/`view-source:`/`ftp://`
   (schémas qui atteindraient l'OS), téléchargements/impression/popups/traduction coupés,
   gestionnaire de mots de passe & autofill off. **Managée = ni le web ni l'opérateur ne
   peuvent l'annuler.**
3. **VT sans login** : `getty@tty2..tty6` masqués (défense en profondeur ; récupération par
   **SSH** ou reboot maintenance, `DontVTSwitch` bloquant déjà l'accès depuis X).
4. **Chromium** lancé `--kiosk --incognito` + flags de durcissement (pas de first-run, pas de
   bulle de crash, composants/traduction/réseau de fond coupés) ; watchdog `Restart=always`.
5. **Couche app** (`booth-client/setup/kioskLockdown.ts`, active seulement si agent détecté) :
   menu contextuel / sélection / glisser neutralisés, raccourcis d'évasion annulables avalés.
   Corollaire UX : « En savoir plus » d'un film devient un **QR** (le visiteur ouvre le lien
   sur SON téléphone) au lieu d'un onglet externe — la borne ne navigue jamais hors de l'app.

> ⚠️ **Résiduel (hors logiciel)** : l'accès physique au **boot** (menu GRUB / BIOS) reste un
> vecteur — à couvrir par **mot de passe BIOS + GRUB** au déploiement matériel (@qa).

## MAJ OS depuis le back-office (CIN-077) — sécurité des patchs

Objectif : **pas de faille locale qui traîne** — le parc reste patché sans intervention
physique. L'agent expose `POST /system/os-update` (apt update && upgrade, liste blanche →
renvoie la queue de sortie + paquets restants) et `GET /system/os-update/status`.

Câblage livré (CIN-077) :
- **Canal de commande** `os_update_commands` (migration `0017`) — une commande par borne,
  statut `pending`/`running`/`done`/`failed`, journal apt, horodatage. RLS : lecture org,
  **écriture humaine réservée `global_admin`** (la plateforme décide des patchs), device
  lit + met à jour SA borne. Index partiel unique = une seule commande active par borne.
  ⇒ **migration `0017` à appliquer sur Supabase.**
- Le `booth-client` (authentifié device) **relaie** (`backend.relayOsUpdates` + poll 5 min) :
  lit les commandes `pending` de sa borne, appelle l'agent local, remonte `running` →
  `done`/`failed` + le journal apt.
- Dashboard (page Maintenance → « État des Kiosks ») : bouton **« MAJ OS »** par borne et
  **« Mettre à jour l'OS du parc »** (global_admin), colonne d'état des patchs.

⚠️ **À trancher** : politique d'auto-patch sécurité (ex. `unattended-upgrades` pour les
MAJ critiques automatiques) vs 100 % piloté back-office. Recommandation @cto : **les deux**
— `unattended-upgrades` pour les CVE critiques (filet), pilotage back-office pour le reste.

## Déploiement (résumé)

```bash
# le repo déployé dans /opt/kioskoscope, en root :
sudo /opt/kioskoscope/kiosk/provisioning/setup.sh
# puis, quand l'affichage X + le front servi en local sont prêts :
sudo systemctl enable --now kioskoscope-kiosk.service
```

## Injection du jeton (hors bundle) — `/kiosk-config.json`

Le `booth-client` (dans Chromium) ne peut pas lire `/etc/kioskoscope/agent.token`, et le
jeton **ne doit pas** être compilé dans le bundle (sinon un contenu web compromis aurait le
privilège système). Solution : la **couche de service locale** qui sert le front à Chromium
sert aussi, au runtime, un `GET /kiosk-config.json` :

```json
{ "agentUrl": "http://127.0.0.1:4599", "agentToken": "<contenu de /etc/kioskoscope/agent.token>" }
```

`booth-client` le lit au démarrage (`loadKioskConfig`) : présent ⇒ Wi-Fi/réglages **réels**
via l'agent ; absent (dev navigateur) ⇒ stubs (mock). Ce petit serveur local est le seul à lire
les secrets sur disque — ils restent hors du bundle public.

**Creds device (Supabase) au runtime aussi (sécu 2026-07-08).** `/kiosk-config.json` inclut, si
provisionné, un objet `device` (`boothId`/`orgId`/`deviceEmail`/`devicePassword`) lu depuis
`/etc/kioskoscope/device.json` (0600). Le `booth-client` n'embarque donc PLUS ces creds dans le
bundle : un build public reste **inerte** (mode mock). En dev, repli sur `.env` (`import.meta.env.DEV`).

**Provisionnement manquant = dit explicitement (BUG-017).** La réponse porte **soit** `device`,
**soit** `deviceError` — jamais rien d'implicite. Le client ne doit pas avoir à déduire d'un champ
absent s'il tourne sur un poste de dev ou sur une borne cassée :

| `deviceError.kind` | Situation | Réaction borne |
|---|---|---|
| `absent` | `/etc/kioskoscope/device.json` inexistant | jamais provisionnée |
| `incomplete` | fichier présent, champ(s) vide(s) → `missing: ["orgId", …]` | **erreur de déploiement** |
| `unreadable` | droits (`EACCES`) ou JSON invalide → `reason` | **erreur de déploiement** |

Dans les trois cas, l'agent détecté + aucun identifiant ⇒ le `booth-client` **vide le catalogue**
(aucune séance, donc aucun paiement possible) et affiche un **bandeau de diagnostic plein écran** :
sur une machine sans clavier, un `console.info` n'est pas un signal. ⚠️ Ni le serveur ni le bandeau
ne journalisent la **valeur** de `devicePassword` — seulement le **nom** du champ manquant.

Le serveur **ne refuse pas de démarrer** dans ces cas, délibérément : sans lui, Chromium affiche
une page d'erreur réseau du navigateur et le **menu opérateur** (Wi-Fi, réglages, redémarrage)
disparaît — or c'est par lui qu'on rattrape une borne mal déployée sur place.

## État

- ✅ Agent local (Wi-Fi/power/display/volume/system-info + os-update) + systemd + provisioning + sécurité.
- ✅ **Câblage `booth-client`** : `setup/kioskAgent.ts` (client + `AgentWifiAdapter` + réglages
  réels), `main.ts` bascule agent vs stubs selon `/kiosk-config.json`. Build vert.
- ✅ **Serveur local** `server/server.mjs` (Node natif, 127.0.0.1) : sert le build `booth-client`
  à Chromium **et** `/kiosk-config.json` (jeton lu au runtime, hors bundle ; même origine, pas de
  CORS). Anti-traversal vérifié. Service `kioskoscope-web.service`. ⏳ Reste = **vérif sur borne réelle**
  (déployer le build dans `KIOSK_WEB_ROOT`).
- ✅ **CIN-077** : canal de commande MAJ OS livré (migration `0017` + relais `booth-client` +
  UI dashboard). ⏳ Reste = **appliquer `0017`** puis valider sur borne réelle (agent apt).
- ✅ **CIN-072** : verrouillage kiosque livré (politique Chromium managée + Xorg `DontVTSwitch` +
  gettys masqués + flags + guard app + « En savoir plus » → QR). ⏳ Reste = **valider sur borne
  réelle** (tests d'évasion @qa) + mot de passe BIOS/GRUB au montage matériel.
