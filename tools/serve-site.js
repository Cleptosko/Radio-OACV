#!/usr/bin/env node
/* ============================================================
   RADIO OACV — écoute locale du site public (sans administration)

   Pourquoi ce fichier existe : ouvert en « file:// » (double-clic sur
   index.html), le navigateur bloque les playlists (origine nulle) et la
   radio reste sans musique. Il faut passer par HTTP.

   Ce serveur ne sert QUE les fichiers publics — index.html, style.css,
   app.js, ui.js, assets/, audio/ — et refuse .env, data/, server/ et
   tools/ (même règle que le serveur complet). Aucune dépendance npm.

   Utilisation :
     npm run site                 → http://127.0.0.1:8123
     PORT=9000 npm run site       → un autre port
   ============================================================ */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFile, sendText, fail, HttpError } from '../server/http.js';
import { isForbiddenPath } from '../server/config.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number.parseInt(process.env.PORT || '8123', 10) || 8123;
const HOST = process.env.HOST || '127.0.0.1';

function publicFile(rel){
  let decoded = String(rel || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* on garde tel quel */ }
  const clean = path.posix.normalize(decoded.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (isForbiddenPath(clean)) fail(403, 'accès refusé');
  const target = (!clean || clean === '.') ? 'index.html' : clean;
  const file = path.join(ROOT, target);
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) fail(403, 'accès refusé');
  return file;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    const file = publicFile(url.pathname);
    const cache = /\.(png|jpe?g|gif|svg|webp|ico|mp3|m4a|woff2?|ttf)$/i.test(file)
      ? 'public, max-age=3600'
      : 'no-cache';
    return await sendFile(req, res, file, { cache });
  } catch (e){
    if (e instanceof HttpError) return sendText(res, e.status, e.message, 'text/plain; charset=utf-8');
    console.error('[site] erreur inattendue', req.method, url.pathname, e);
    return sendText(res, 500, 'erreur interne du serveur');
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE'){
    console.error(`\n  Le port ${PORT} est déjà utilisé.`);
    console.error(`  Arrêtez l'autre programme, ou lancez :  PORT=9000 npm run site\n`);
  } else {
    console.error('\n  Le site n\'a pas pu démarrer :', e.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ==========================================================');
  console.log('    RADIO OACV — site public (écoute locale)');
  console.log('  ==========================================================');
  console.log(`    Adresse : http://${HOST}:${PORT}/`);
  console.log('');
  console.log('    Mode écoute seule : les annonces, la banque de musiques');
  console.log('    et la programmation demandent un .env (« npm run setup »)');
  console.log('    puis « npm start » ou Lancer-Radio-OACV.bat.');
  console.log('');
  console.log('    Arrêt : Ctrl+C');
  console.log('');
});
