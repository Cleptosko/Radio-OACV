/* ============================================================
   RADIO OACV — configuration
   Toute la configuration vient de l'environnement (.env en local,
   variables d'environnement sur un serveur). Aucun secret ici.
   ============================================================ */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const ENV_PATH = path.join(ROOT, '.env');

/* ---------- lecture du .env (format simple, sans dépendance) ---------- */
function parseEnvFile(text){
  const out = {};
  for (const raw of text.split(/\r?\n/)){
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))){
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

let FILE_ENV = {};
if (existsSync(ENV_PATH)){
  try { FILE_ENV = parseEnvFile(readFileSync(ENV_PATH, 'utf8')); }
  catch (e){ console.error('[config] .env illisible :', e.message); }
}

/* l'environnement réel est prioritaire sur le fichier (utile en production) */
export function env(key, fallback = ''){
  const v = process.env[key];
  if (v !== undefined && v !== '') return v;
  const f = FILE_ENV[key];
  if (f !== undefined && f !== '') return f;
  return fallback;
}
export const envInt = (k, d) => { const n = parseInt(env(k, ''), 10); return Number.isFinite(n) ? n : d; };
export const envBool = (k, d = false) => { const v = env(k, ''); return v ? !/^(0|false|non|no|off)$/i.test(v) : d; };
export const envList = (k, d = []) => { const v = env(k, ''); return v ? v.split(',').map(s => s.trim()).filter(Boolean) : d; };

/* Le port mérite un traitement à part : certaines plateformes imposent
   PORT=0 (« prends un port au hasard »). Pour une radio, l'adresse doit être
   connue : une valeur nulle ou invalide est donc ignorée au profit du .env. */
function resolvePort(){
  const looksValid = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 && n < 65536 ? n : null; };
  const fromReal = looksValid(process.env.PORT);
  if (fromReal) return fromReal;
  const fromFile = looksValid(FILE_ENV.PORT);
  if (fromFile){
    if (process.env.PORT !== undefined && process.env.PORT !== ''){
      console.warn(`[config] PORT=${process.env.PORT} dans l'environnement ignoré (invalide) — le .env impose ${fromFile}`);
    }
    return fromFile;
  }
  return 8123;
}

/* ---------- configuration ---------- */
export const config = {
  root: ROOT,
  envPath: ENV_PATH,
  port: resolvePort(),
  host: env('HOST', '0.0.0.0'),
  tz: env('TZ_NAME', 'Europe/Paris'),

  /* le site public est servi depuis la racine du projet radio */
  publicDir: path.resolve(ROOT, env('PUBLIC_DIR', '.')),
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),

  sessionSecret: env('SESSION_SECRET', ''),
  sessionHours: envInt('SESSION_HOURS', 12),
  uploadMaxMb: envInt('UPLOAD_MAX_MB', 25),
  trustProxy: envBool('TRUST_PROXY', false),
  secureCookies: envBool('SECURE_COOKIES', false),

  playlists: {
    music: env('MUSIC_PLAYLIST_ID', 'PLuwwO2tW6rWqsDdYv16-YJyDrtDF3tRan'),
    ads: env('ADS_PLAYLIST_ID', 'PLTvT8EdA3MszcV7CoKdtCIgiHV_6lrgxg'),
  },
  puboacvWeight: envInt('PUBOACV_WEIGHT', 4),
  musicsBeforeBreak: [envInt('MUSICS_BEFORE_BREAK_MIN', 5), envInt('MUSICS_BEFORE_BREAK_MAX', 7)],
  libraryTtlHours: envInt('LIBRARY_CACHE_HOURS', 12),

  stream: {
    mount: env('STREAM_MOUNT', '/stream'),
    bitrate: env('STREAM_BITRATE', '160k'),
    publicUrl: env('STREAM_PUBLIC_URL', ''),
  },
};

/* ---------- les deux administrateurs ---------- */
export const ALL_PERMS = ['announcements', 'schedule', 'library', 'ads'];

export function adminAccounts(){
  const out = [];
  for (const n of [1, 2]){
    const email = env(`ADMIN${n}_EMAIL`, '').trim().toLowerCase();
    const hash = env(`ADMIN${n}_PASSWORD_HASH`, '').trim();
    if (!email || !hash) continue;
    const owner = n === 1;
    out.push({
      email,
      name: env(`ADMIN${n}_NAME`, '') || (owner ? 'Propriétaire' : 'Collaborateur'),
      role: owner ? 'owner' : 'editor',
      hash,
      /* le propriétaire a tout ; le second compte n'a que ce qu'on lui ouvre */
      perms: owner ? [...ALL_PERMS] : envList(`ADMIN${n}_PERMS`, ALL_PERMS).filter(p => ALL_PERMS.includes(p)),
      enabled: envBool(`ADMIN${n}_ENABLED`, true),
    });
  }
  return out;
}

export function configProblems(){
  const p = [];
  if (!config.sessionSecret || config.sessionSecret.length < 24) p.push('SESSION_SECRET manquant ou trop court (utilisez « npm run setup »)');
  const a = adminAccounts();
  if (!a.length) p.push('aucun compte administrateur : renseignez ADMIN1_EMAIL et ADMIN1_PASSWORD_HASH (utilisez « npm run setup »)');
  for (const acc of a){
    if (!/^scrypt\$/.test(acc.hash)) p.push(`empreinte de mot de passe invalide pour ${acc.email} (utilisez « npm run setup »)`);
  }
  return p;
}

/* Ce que le site public n'a JAMAIS le droit de servir :
   .env, dossier data/, le code du serveur, les outils, les fichiers cachés.
   Le chemin est normalisé ici : c'est le seul endroit qui décide, donc il
   doit être insensible aux « / », « \ », « ./ » et aux remontées « .. ». */
export function isForbiddenPath(rel){
  let clean = String(rel || '').replace(/\\/g, '/');
  clean = clean.replace(/^\/+/, '').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
  if (!clean || clean === '.') return false;                       // racine → index.html
  const segs = clean.split('/');
  if (segs.some(s => s === '..' || (s.startsWith('.') && s !== '.'))) return true;   // .env, .git, ..
  const first = segs[0];
  if (['server', 'data', 'tools', 'node_modules'].includes(first)) return true;
  if (['package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml'].includes(clean)) return true;
  if (clean.endsWith('.md')) return true;
  return false;
}
