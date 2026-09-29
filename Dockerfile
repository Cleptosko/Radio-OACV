# ============================================================
#  RADIO OACV — image du serveur
#  ffmpeg et yt-dlp sont inclus dès maintenant : ils serviront au
#  moteur d'antenne côté serveur et au flux pour le bot Discord.
# ============================================================
FROM node:20-alpine

# outils du moteur d'antenne (phase 2)
RUN apk add --no-cache ffmpeg python3 py3-pip \
 && pip install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

# aucune dépendance npm : on copie simplement le projet
COPY . .

# les données d'exécution vivent dans un volume
RUN mkdir -p /app/data

ENV NODE_ENV=production \
    PORT=8123 \
    HOST=0.0.0.0 \
    TZ_NAME=Europe/Paris

EXPOSE 8123
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8123)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
