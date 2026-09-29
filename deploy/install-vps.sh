#!/usr/bin/env bash
# ============================================================
#  RADIO OACV — installation sur un VPS Linux
#
#  À exécuter en root, sur un serveur Debian/Ubuntu/Raspberry Pi OS :
#     curl -O https://raw.githubusercontent.com/Firtoks/radio-oacv/.../install-vps.sh
#     sudo bash install-vps.sh
#
#  Le script est rejouable : il ne détruit jamais un .env existant.
# ============================================================
set -euo pipefail

# ---------- paramètres ----------
APP_DIR="${APP_DIR:-/srv/radio-oacv}"
APP_USER="${APP_USER:-radio}"
DOMAIN="${DOMAIN:-}"            # radio.exemple.fr — laisse vide pour ne pas mettre Caddy
REPO="${REPO:-}"               # dépôt PRIVÉ du serveur ; vide = copier à la main
NODE_MAJOR="20"

say()  { printf '\n\033[1;36m  %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Ce script doit être lancé en root : sudo bash install-vps.sh"

say "RADIO OACV — installation du serveur"
echo "     dossier  : $APP_DIR"
echo "     utilisateur : $APP_USER"
echo "     domaine   : ${DOMAIN:-(non configuré)}"

# ---------- 1. Node.js ----------
say "1. Node.js $NODE_MAJOR"
if command -v node >/dev/null 2>&1 && [ "$(node -v | cut -c2-3 | cut -d. -f1)" -ge "$NODE_MAJOR" ]; then
  echo "   déjà installé : $(node -v)"
else
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg >/dev/null
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  echo "   installé : $(node -v)"
fi

# ---------- 2. utilisateur dédié ----------
say "2. Utilisateur « $APP_USER »"
if id -u "$APP_USER" >/dev/null 2>&1; then
  echo "   existe déjà"
else
  useradd --system --create-home --home-dir "/home/$APP_USER" \
          --shell /usr/sbin/nologin "$APP_USER"
  echo "   créé (sans mot de passe : il ne se connecte jamais)"
fi

# ---------- 3. pare-feu ----------
say "3. Pare-feu"
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  # le port du serveur reste fermé : seul Caddy y accède
  ufw --force enable >/dev/null 2>&1 || true
  echo "   22, 80 et 443 autorisés ; 8123 fermé"
else
  warn "ufw absent : pense à fermer le port du serveur à l'extérieur"
fi

# ---------- 4. code ----------
say "4. Code de la radio"
if [ -d "$APP_DIR/server" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    echo "   mise à jour (git pull)"
    git -C "$APP_DIR" pull --ff-only || warn "git pull a échoué : le service redémarre quand même"
  fi
elif [ -n "$REPO" ]; then
  echo "   clonage depuis $REPO"
  git clone "$REPO" "$APP_DIR"
else
  die "pas de code dans $APP_DIR et aucune variable REPO fournie.
   Deux solutions :
     • copier le dossier 'radio' de ton ordinateur vers $APP_DIR (par exemple avec scp) ;
     • ou créer un dépôt privé du serveur sur GitHub, puis relancer avec :
         REPO=git@github.com:<ton-compte>/radio-oacv-serveur.git bash install-vps.sh"
fi
[ -f "$APP_DIR/server/server.js" ] || die "server/server.js introuvable : ce n'est pas le bon dépôt (le dépôt du SITE PUBLIC ne contient pas le serveur)."

mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------- 5. configuration ----------
say "5. Configuration"
if [ -f "$APP_DIR/.env" ]; then
  echo "   .env déjà présent : conservé tel quel"
else
  # On prépare .env.example avec des valeurs correctes pour un serveur
  # public derrière un proxy.
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i 's/^HOST=.*/HOST=127.0.0.1/'           "$APP_DIR/.env"   # seul Caddy parle au serveur
  sed -i 's/^TRUST_PROXY=.*/TRUST_PROXY=1/'    "$APP_DIR/.env"
  sed -i 's/^SECURE_COOKIES=.*/SECURE_COOKIES=1/' "$APP_DIR/.env" # HTTPS : cookie de session sécurisé
  # Le port 8123 n'est pas exposé : on en choisit un au hasard pour
  # éviter les scanners qui cherchent les ports connus.
  PORT=$(shuf -i 20000-60000 -n 1)
  sed -i "s/^PORT=.*/PORT=$PORT/" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "   .env créé sur le modèle (à compléter : voir étape 6)"
fi

# ---------- 6. secrets et comptes ----------
say "6. Secret de session et comptes d'administration"
if grep -qE '^SESSION_SECRET=..' "$APP_DIR/.env" && grep -qE '^ADMIN1_PASSWORD_HASH=scrypt\$' "$APP_DIR/.env"; then
  echo "   .env complet : conservé tel quel"
else
  warn "le .env n'a pas encore de secret ni de compte."
  echo
  echo "   La façon la plus simple : fabriquer le .env sur TON ORDINATEUR"
  echo "   (là où tu peux taper ton mot de passe discrètement), puis"
  echo "   l'envoyer au serveur :"
  echo
  echo "       cd radio && npm run setup      # crée .env avec les deux comptes"
  echo "       scp .env root@ton-serveur:/tmp/radio.env"
  echo "       ssh root@ton-serveur"
  echo "       install -o radio -g radio -m 600 /tmp/radio.env $APP_DIR/.env"
  echo "       rm /tmp/radio.env"
  echo "       systemctl restart radio-oacv"
  echo
  echo "   Le .env contient des secrets : ne l'envoyez jamais par e-mail"
  echo "   ni dans une discussion. En mode SSH, le copier-coller est sûr."
  echo
  # Un secret de session est tout de même généré si possible, pour que
  # le serveur démarre ; il sera remplacé quand le vrai .env arrivera.
  if ! grep -qE '^SESSION_SECRET=..' "$APP_DIR/.env"; then
    NEW_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n' | tr '/+' '_-')"
    sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$NEW_SECRET|" "$APP_DIR/.env"
    chown "$APP_USER:$APP_USER" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
    echo "   un secret de session provisoire a été généré (sera remplacé)"
  fi
  if ! grep -qE '^ADMIN1_PASSWORD_HASH=scrypt\$' "$APP_DIR/.env"; then
    warn "aucun compte administrateur : le serveur refusera de démarrer."
    echo "   Suivez les étapes ci-dessus avant de continuer."
  fi
fi

# ---------- 7. service ----------
say "7. Service systemd"
if ! grep -qE '^ADMIN1_PASSWORD_HASH=scrypt\$' "$APP_DIR/.env"; then
  warn "pas encore de compte administrateur : le service ne démarrera pas."
  warn "Une fois le .env transmis (étape 6) : systemctl start radio-oacv"
else
  install -m 644 "$APP_DIR/deploy/radio-oacv.service" /etc/systemd/system/radio-oacv.service
  systemctl daemon-reload
  systemctl enable radio-oacv >/dev/null 2>&1
  systemctl restart radio-oacv
  sleep 2
  if systemctl is-active --quiet radio-oacv; then
    echo "   service actif"
  else
    echo "   le service n'a pas démarré :"
    journalctl -u radio-oacv -n 25 --no-pager
    die "voir les logs ci-dessus"
  fi
fi

# ---------- 8. HTTPS ----------
say "8. HTTPS (Caddy)"
# le port réel est toujours celui du .env, même s'il existait avant
SERVER_PORT="$(grep -oE '^PORT=[0-9]+' "$APP_DIR/.env" | cut -d= -f2 | head -1)"
SERVER_PORT="${SERVER_PORT:-8123}"

if [ -z "$DOMAIN" ]; then
  warn "pas de domaine indiqué : HTTPS non configuré."
  echo "   Relance avec DOMAIN=radio.exemple.fr pour l'activer."
  echo "   Sans HTTPS, le micro et /admin ne fonctionnent pas depuis l'extérieur."
else
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
    echo "   Caddy installé"
  else
    echo "   Caddy déjà installé"
  fi

  mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy 2>/dev/null || true
  sed -e "s/radio\.exemple\.fr/$DOMAIN/g" \
      -e "s/127\.0\.0\.1:8123/127.0.0.1:$SERVER_PORT/g" \
      "$APP_DIR/deploy/caddy/radio-oacv.caddy" > /etc/caddy/Caddyfile
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  echo "   https://$DOMAIN configuré (le certificat s'obtient tout seul)"
fi

# ---------- terminé ----------
say "C'est prêt."
cat <<EOF

  Site public   : https://firtoks.github.io/radio-oacv/   (déjà en ligne)
  Administration : https://${DOMAIN:-<ton-domaine>}/admin

  Commandes utiles :

    systemctl status radio-oacv          l'état du service
    journalctl -u radio-oacv -f          les logs en direct
    systemctl restart radio-oacv         redémarrer
    journalctl -u radio-oacv -n 50       les 50 dernières lignes

  Pour mettre à jour la radio plus tard :

    cd $APP_DIR && git pull && systemctl restart radio-oacv

  Les annonces enregistrées sont dans $APP_DIR/data :
  ne le supprime pas, c'est le seul endroit où elles vivent.

EOF
