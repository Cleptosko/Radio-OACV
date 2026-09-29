# Déployer le serveur de la radio sur un VPS

Le site public est déjà en ligne sur **https://firtoks.github.io/radio-oacv/**,
gratuitement et sans entretien.

Ce document concerne **le serveur** : l'administration, les annonces au micro,
la programmation. Lui doit tourner **en permanence**, sinon les annonces
programmées ne passent pas. Sur ton ordinateur, il ne tourne que quand ton PC
est allumé — un petit serveur loué règle ça.

## Ce qu'il faut

* un VPS Linux (Debian, Ubuntu ou Raspberry Pi OS) — Hetzner, OVH, DigitalOcean
  ou Scaleway. Un C1GXO suffit largement, quelques euros par mois ;
* **un nom de domaine** pointant vers l'IP du serveur. Sans domaine, pas de
  HTTPS, et donc pas de micro utilisable ;
* Node.js 18+ (le script l'installe tout seul).

## Marche à suivre

### 1. Copier le code du serveur sur le VPS

Le dépôt GitHub **public** ne contient que le site. Le serveur doit venir de
ta machine :

```bash
scp -r radio root@ton-serveur:/srv/radio-oacv
```

ou, si tu as créé un dépôt **privé** pour le serveur :

```bash
ssh root@ton-serveur "git clone git@github.com:<ton-compte>/radio-oacv-serveur.git /srv/radio-oacv"
```

### 2. Lancer l'installation

```bash
ssh root@ton-serveur
bash /srv/radio-oacv/deploy/install-vps.sh DOMAIN=radio.exemple.fr
```

Le script installe Node.js, crée un utilisateur dédié, ferme le pare-feu sauf
80 et 443, installe le service systemd et configure Caddy pour le HTTPS.

### 3. Transmettre la configuration et les deux comptes

Le `.env` contient des secrets : on le fabrique **sur ton ordinateur**, où tu
peux taper tes mots de passe discrètement.

```bash
# sur ton ordinateur
cd radio
npm run setup                 # tes deux comptes, le port, le fuseau
```

Puis, en reprenant le terminal du serveur :

```bash
install -o radio -g radio -m 600 /tmp/radio.env /srv/radio-oacv/.env
rm /tmp/radio.env
systemctl restart radio-oacv
```

Copie-coller dans le terminal SSH, c'est sûr : le contenu ne quitte jamais le
chiffré du tunnel. **Jamais par e-mail ni en message.**

### 4. Vérifier

```bash
systemctl status radio-oacv          # doit écrire « active (running) »
curl -I https://radio.exemple.fr/api/health
```

Puis ouvre `https://radio.exemple.fr/admin` et connecte-toi.

## Le jour où le serveur redémarre

Rien à faire : le service systemd relance la radio automatiquement. C'est tout
l'intérêt du fichier [radio-oacv.service](radio-oacv.service) — il redémarre
le service après un crash, et au démarrage de la machine.

## Mettre à jour la radio

```bash
cd /srv/radio-oacv
git pull
systemctl restart radio-oacv
journalctl -u radio-oacv -n 30      # vérifier que tout est reparti
```

Les annonces déjà enregistrées restent dans `/srv/radio-oacv/data` : ne
supprime jamais ce dossier.

## En cas de problème

| Symptôme | Cause probable |
|---|---|
| `service inactive (failed)` | `.env` absent ou sans compte : `journalctl -u radio-oacv -n 30` |
| `/admin` s'ouvre mais le micro est refusé | pas de HTTPS : le domaine ne pointe pas vers le serveur, ou Caddy n'a pas obtenu le certificat (`journalctl -u caddy -n 30`) |
| le site ne répond pas | le pare-feu : `ufw status`, les ports 80 et 443 doivent être ouverts |
| « trop de tentatives de connexion » | l'anti-force brute s'est déclenché : attends quelques minutes, le blocage est temporaire |
| Caddy ne démarre pas | `caddy validate --config /etc/caddy/Caddyfile` pour voir la raison exacte |

## Sécurité en place

* le serveur n'écoute que sur `127.0.0.1` : **le port n'est jamais accessible
  depuis Internet**, seul Caddy y entre ;
* `HOST=127.0.0.1`, `TRUST_PROXY=1` (Caddy est le seul proxy de confiance),
  `SECURE_COOKIES=1` (cookies de session réservés à HTTPS) ;
* l'utilisateur du service n'a pas de mot de passe et son shell est désactivé ;
* le système de fichiers est en lecture seule : le service ne peut écrire que
  dans `data/`, nulle part ailleurs ;
* le `.env` est en `600`, lisible seulement par le compte du service ;
* HTTPS géré par Caddy, certificat renouvelé automatiquement.

## Note sur la limitation de débit

Le serveur bloque lui-même les tentatives de connexion (5 échecs par compte,
12 par adresse IP). La directive `rate_limit` de Caddy est volontairement
absente : elle n'existe que depuis Caddy 2.10, et une directive inconnue
empêche Caddy de démarrer. Si un jour tu as besoin de plus, mets à jour Caddy
et suis les indications dans [caddy/radio-oacv.caddy](caddy/radio-oacv.caddy).
