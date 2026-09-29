# 📻 Radio OACV

Radio internet **pilotée par un serveur**, avec une interface de diffusion spectaculaire
et un espace d'administration privé pour deux personnes.

```text
                        RADIO OACV
                            │
                   Flux audio 24h/24
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
         Site public                 Bot Discord
    (écoute, pochette,                (salon vocal)
     paroles, animations)
```

---

## 1. Où en est le projet

| Élément | État |
|---|---|
| Site public (design OACV, pochette, couleurs dynamiques, paroles, visualiseur) | ✅ en place, **fichiers inchangés** (`index.html`, `style.css`, `ui.js`, `app.js`) |
| Site public **hébergé 24h/24, 7j/7** | ✅ **en ligne** sur firtoks.github.io/radio-oacv (§7) |
| Serveur (site + API privée) | ✅ en place — `server/` |
| Connexion privée `/admin` pour deux comptes | ✅ en place |
| Enregistrement d'annonces au micro | ✅ en place |
| Programmation (maintenant / après une musique / date-heure / quotidien / hebdomadaire) | ✅ en place |
| Banque de musiques et de publicités (338 titres + 144 pubs) | ✅ en place |
| Serveur déployable sur un **VPS** (systemd, HTTPS, redémarrage auto) | ✅ prêt — voir `deploy/README-vps.md` |
| Moteur d'antenne **côté serveur** (jouer la playlist sans navigateur ouvert) | ⏳ phase 2 |
| Flux audio continu (`/stream`) pour le bot Discord | ⏳ phase 2 |

Pourquoi une phase 2 ? Le moteur actuel joue les vidéos YouTube **dans le navigateur**
(API iframe YouTube). Un serveur ne peut pas jouer un lecteur YouTube : pour diffuser en
permanence sans navigateur ouvert, il faut décoder l'audio côté serveur avec
**`yt-dlp` + `ffmpeg`** (absents de cette machine pour l'instant), puis publier un flux
audio continu que le bot Discord peut consommer. Tout ce qui ne dépend pas de cela
(administration, annonces, programmation, banque) est déjà opérationnel.

---

## 2. Installation

Prérequis : **Node.js 18 ou plus** (aucune dépendance npm n'est nécessaire).

```bash
cd radio
npm run setup     # crée .env : secret de session + vos deux comptes
npm start         # démarre le serveur
```

* Site public : `http://localhost:8123/`
* Espace privé : `http://localhost:8123/admin`

Sur Windows, le plus simple : double-cliquez sur **`Lancer-Radio-OACV.bat`**
(il propose la configuration à la première utilisation, démarre le serveur et ouvre le site).

`npm run setup` vous demande :

1. votre identifiant et votre mot de passe (propriétaire, accès complet) ;
2. l'identifiant de votre collègue — **appuyez juste sur Entrée pour le créer plus tard** ;
3. le fuseau horaire (utilisé par la programmation) et le port.

Si le compte du collègue n'existe pas encore, ajoutez-le quand vous voulez avec
`npm run add-account` (voir §3).

Les mots de passe ne sont **jamais** enregistrés en clair : seules leurs empreintes
**scrypt** sont écrites dans `.env`. Ce fichier n'est jamais versionné.

---

## 3. Les deux comptes

| Compte | Rôle | Accès |
|---|---|---|
| `ADMIN1_*` | **propriétaire** | tout : annonces, programmation, musiques, publicités, réglages |
| `ADMIN2_*` | **collaborateur** | uniquement les permissions listées dans `ADMIN2_PERMS` |

Permissions possibles : `announcements`, `schedule`, `library`, `ads`.
Exemple pour n'autoriser que les annonces et la programmation :

```env
ADMIN2_PERMS=announcements,schedule
```

Pour désactiver un compte sans supprimer ses accès : `ADMIN2_ENABLED=0`.
Modifier `.env` puis redémarrer le serveur suffit.

### Ajouter le compte du collègue plus tard

Le compte du collègue est facultatif : la radio fonctionne parfaitement à une seule
personne. Quand vous pourrez le créer :

```bash
npm run add-account      # puis redémarrer le serveur
```

L'assistant demande l'identifiant, le nom, le mot de passe (avec confirmation) et les
permissions accordées (`1,2,3` ou `aucune`). **Il ne réécrit que les lignes `ADMIN2_*`** :
votre compte, le secret de session, le port et les playlists restent intacts. Relancer
l'assistant remplace le compte existant du collègue sans le dupliquer.

---

## 4. Espace d'administration (`/admin`)

* **🎙️ Annonces** — enregistrement au micro (le navigateur demande l'autorisation),
  vumètre, chronomètre, écoute avant validation, recommencer, envoi à la radio.
  La liste permet d'écouter, de programmer ou de supprimer chaque annonce.
* **📅 Programmation** — cinq modes :
  * **Maintenant** → part à la prochaine insertion ;
  * **Après une musique** → ne coupe pas le titre en cours ;
  * **Date et heure** → une seule fois ;
  * **Tous les jours à 12h00** ;
  * **Chaque semaine** (jours au choix, ex. lundi 08h30).

  On peut aussi programmer les éléments de l'antenne : **Jingle OACV** et **Pub OACV**.
  La page affiche la liste des passages à venir, la **file d'insertion** et l'historique.
* **🎵 Musiques** — la bibliothèque complète (chargée depuis YouTube), la recherche,
  activer/désactiver un titre, retirer un ajout, ajouter un titre par lien ou identifiant.
* **📢 Publicités** — même principe, plus les réglages : jingle OACV, pub OACV et son
  **poids** (1 = même probabilité qu'une publicité ordinaire).
* **⚙️ Réglages** — état du serveur, fuseau, file d'insertion et rappels de sécurité.

Tout est vérifié **côté serveur** : masquer un bouton ne suffit pas, chaque route de
l'API privée contrôle la session et la permission.

---

## 5. Sécurité

* mots de passe : **scrypt** (`N=16384, r=8, p=1`), comparaison à temps constant ;
* sessions : cookie **signé HMAC-SHA256**, `HttpOnly`, `SameSite=Lax`, expiration (12 h par défaut) ;
* **CSRF** : jeton double (cookie + en-tête `X-CSRF-Token`) exigé sur toute action ;
* contrôle d'`Origin` sur les requêtes qui modifient quelque chose ;
* **blocage progressif** après 5 tentatives de connexion échouées (par IP + identifiant) ;
* téléversements limités en taille et vérifiés (type MIME vrai + signature du fichier) ;
* les annonces ne sont servies qu'aux comptes connectés (`/api/announcements/:id/audio`) ;
* le serveur ne sert pas `.env`, `data/`, `server/`, `tools/`, `node_modules/` ni les fichiers cachés ;
* en-têtes de sécurité et politique de contenu sur `/admin`.

Les secrets vivent dans `.env` en local et dans les **variables d'environnement** sur un
serveur. Aucun secret ne doit apparaître dans le code ou dans le site public.

> Rotation d'un mot de passe : `npm run add-account` remplace celui du collègue sans
> toucher au vôtre ; pour le vôtre, relancez `npm run setup --force` (attention : cela
> régénère aussi le compte du collègue) ou modifiez `ADMIN1_PASSWORD_HASH` à la main.
> Dans les deux cas, redémarrez le serveur. Changer `SESSION_SECRET` déconnecte
> immédiatement toutes les sessions ouvertes.

---

## 6. Structure

```text
radio/
├─ index.html, style.css, ui.js, app.js   # site public (inchangé)
├─ audio/                                 # jingle, pub maison
├─ assets/                                # logo
├─ server/
│  ├─ server.js        # serveur HTTP, API, file d'insertion, boucle de programmation
│  ├─ config.js        # lecture de .env, comptes et permissions, chemins interdits
│  ├─ auth.js          # scrypt, sessions signées, CSRF, anti-force brute
│  ├─ hash.js          # empreintes de mots de passe
│  ├─ store.js         # stockage JSON atomique
│  ├─ schedule.js      # les 5 modes de programmation
│  ├─ zoned.js         # calculs de dates dans le fuseau de la radio
│  ├─ library.js       # playlists complètes (Piped paginé + Invidious), activer/désactiver
│  ├─ announcements.js # réception, stockage et suppression des annonces
│  ├─ http.js          # multipart, cookies, fichiers avec Range, en-têtes
│  └─ admin/           # l'interface /admin (HTML/CSS/JS)
├─ tools/
│  ├─ setup.js        # assistant de configuration initiale (.env)
│  ├─ add-account.js  # ajoute ou remplace le compte du collègue
│  ├─ export-site.js  # copie le site public vers ../radio-site (dépôt Netlify)
│  └─ prompt.js       # saisie clavier partagée par les deux outils
├─ deploy/            # configuration d'hébergement
│  ├─ netlify.toml       # cache, en-têtes, redirections (hébergeur Netlify)
│  ├─ install-vps.sh     # installation complète sur un VPS Linux
│  ├─ radio-oacv.service # service systemd, redémarrage automatique
│  ├─ caddy/             # HTTPS automatique derrière le serveur
│  ├─ .gitattributes     # fins de ligne du dépôt public
│  ├─ README.md          # présentation du dépôt public
│  └─ README-vps.md      # marche à suivre pour le serveur distant
├─ data/               # annonces, programmation, file, cache — jamais versionné
└─ .env                # secrets — jamais versionné
```

---

## 7. Site public en ligne

### 🌐 **https://firtoks.github.io/radio-oacv/**

Le site public est **100 % statique** : YouTube en iframe, Piped pour la liste des
titres, aucun serveur. Il est donc hébergé sur **GitHub Pages**, depuis le dépôt
public **https://github.com/Firtoks/radio-oacv** — gratuit, 24h/24, 7j/7, en HTTPS,
sans aucune maintenance. Chacun peut écouter, n'importe quand.

### Mettre le site à jour

Le dépôt GitHub ne contient **que** les fichiers publics ; il est **généré** depuis ce
projet, on ne le modifie jamais à la main :

```bash
cd radio
npm run export          # recrée ../radio-site depuis les fichiers d'ici
cd ../radio-site
git add . && git commit -m "Mise à jour du site" && git push
```

GitHub Pages republie automatiquement à chaque push : compte environ une minute.

### Ce que contient le dépôt public

`index.html`, `style.css`, `app.js`, `ui.js`, `assets/`, `audio/`, `netlify.toml`.
Rien d'autre — **jamais** de `.env`, de `data/`, ni de code serveur.
`npm run export` refuse explicitement de copier un fichier sensible.

### Ce qui reste sur cette machine

L'administration (annonces, programmation, banque) et le serveur Node : ils doivent
tourner en permanence pour que les annonces programmées passent, et aucun hébergeur
gratuit ne le fait de façon fiable. Voir §8 pour un vrai VPS.

### Brancher Netlify (facultatif)

Le site est déjà en ligne sur GitHub Pages, sans rien devoir configurer. Si tu
préfères Netlify (domaine personnalisé, statistiques détaillées), c'est possible aussi :
sur **app.netlify.com**, *Add new site* → *Import an existing project* → choisir
`Firtoks/radio-oacv`. Aucun build n'est nécessaire ; si Netlify demande une
commande de build, laisse le champ **vide**. Le fichier `netlify.toml` est déjà
en place avec le cache et les en-têtes de sécurité.

> GitHub Pages ne permet pas de poser d'en-têtes HTTP personnalisés ; la CSP et
> les en-têtes anti-clickjacking sont donc uniquement appliqués dans la version
> Netlify. Le dépôt est de toute façon public sans le moindre secret.

### Le dépôt du serveur (privé)

Ce dossier `radio/`, lui, mérite son dépôt **privat**, car il contient le code
d'administration :

```bash
cd radio
git init -b main
git add .
git commit -m "Radio OACV : serveur et administration privée"

# créez d'abord un dépôt privé vide sur GitHub, puis :
git remote add origin git@github.com:<votre-compte>/radio-oacv-serveur.git
git push -u origin main
```

Règles à respecter :

* le dépôt du serveur doit rester **privé** ; celui du site est **public** ;
* `.env` et `data/` sont ignorés par `.gitignore` — ne les forcez jamais :
  `git status --short` doit rester propre après un `npm start` ;
* pour collaborer : *Settings → Collaborators* sur GitHub, puis donnez-lui le compte
  administrateur `ADMIN2` de la radio. Ce sont **deux choses différentes** : l'accès au
  code GitHub n'a rien à voir avec l'accès à l'administration de la radio ;
* pour déployer une mise à jour sur un serveur : `git pull` puis redémarrage du service.

---

## 8. Fonctionnement 24h/24

Le site public n'est qu'une fenêtre : la diffusion tourne dès que le serveur tourne.
Avec `Lancer-Radio-OACV.bat`, le serveur vit dans sa propre fenêtre (réduite) ; sur un
serveur dédié, faites-en un service qui redémarre tout seul :

**VPS Linux (systemd + Caddy)**

Une marche à suivre complète se trouve dans **[deploy/README-vps.md](deploy/README-vps.md)**.
En résumé :

```bash
# sur le serveur, en root
bash /srv/radio-oacv/deploy/install-vps.sh DOMAIN=radio.exemple.fr
```

Le script installe Node.js, crée un utilisateur dédié, configure le pare-feu,
installe le service systemd et met Caddy devant pour le HTTPS. Tout est dans
`deploy/` :

| Fichier | Rôle |
|---|---|
| `deploy/install-vps.sh` | installation complète, rejouable sans rien casser |
| `deploy/radio-oacv.service` | service systemd (redémarrage auto, durcissement) |
| `deploy/caddy/radio-oacv.caddy` | HTTPS et proxy vers le serveur |

Points de sécurité mis en place : le serveur n'écoute que sur `127.0.0.1`
(le port n'est **jamais** exposé), l'utilisateur du service n'a pas de mot de
passe, et le système de fichiers est en lecture seule sauf `data/`.

**Docker**

```bash
docker compose up -d --build     # .env récupéré automatiquement, data/ conservé
```

---

## 9. Bot Discord (phase 2)

Le bot ne fait que **consommer le flux** : dès que la phase 2 est en place, le serveur
expose `STREAM_MOUNT` (par défaut `/stream`) en continu, et le bot diffuse cette adresse
dans un salon vocal.

```env
STREAM_PUBLIC_URL=https://radio.exemple.fr/stream
```

Côté bot (Node + `discord.js` + `@discordjs/voice`), l'idée est :

```js
const connection = joinVoiceChannel({ channelId, guildId, adapterCreator });
connection.subscribe(createAudioPlayer());   // alimenté par ffmpeg sur STREAM_PUBLIC_URL
```

Les annonces programmées, les jingles et les publicités seront insérés **par le serveur**
dans le flux : ni le bot ni le site n'ont besoin d'être ouverts pour qu'elles passent.

---

## 10. Ce qu'il reste à faire (phase 2)

1. installer **`ffmpeg`** et **`yt-dlp`** sur la machine qui fait tourner la radio ;
2. écrire le moteur d'antenne serveur : rotation aléatoire sur toute la bibliothèque,
   crossfades, jingles, publicités (avec le poids de la pub OACV), annonces programmées,
   en réutilisant `server/library.js` et la file d'insertion déjà en place ;
3. publier le flux continu sur `/stream` (MP3 ou Opus) avec les métadonnées du direct ;
4. faire consommer ce flux par le site public (les animations, la pochette et les paroles
   restent identiques — les paroles pourront même être synchronisées sur le flux réel) ;
5. écrire le bot Discord.

---

## 11. En cas de problème

| Symptôme | Solution |
|---|---|
| `SESSION_SECRET manquant` au démarrage | lancez `npm run setup` (ou transmettez le `.env` sur le VPS, voir deploy/README-vps.md) |
| `identifiants invalides` | vérifiez `ADMIN*_EMAIL`, ou `npm run add-account` pour le collègue |
| l'assistant s'arrête après le mot de passe | c'est corrigé ; sinon fermez la fenêtre et relancez. Le mot de passe ne s'affiche pas (des points le remplacent), c'est normal |
| l'invite du terminal ne revient pas après une erreur | le terminal est rétabli automatiquement ; sinon fermez l'onglet et rouvrez-le |
| « trop de tentatives » | attendez quelques minutes (blocage progressif) ou redémarrez le serveur |
| la liste des musiques est vide | onglet Musiques → « Mettre à jour depuis YouTube » |
| le micro est refusé | autorisez le micro pour l'adresse du site (icône dans la barre d'adresse) |
| le site affiche une ancienne version | rechargez avec `Ctrl+F5` |
