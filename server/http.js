/* ============================================================
   Outils HTTP — tout est écrit à la main : aucune dépendance npm,
   donc rien à installer sur le serveur.
   ============================================================ */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, code = null){
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function fail(status, message, code = null){ throw new HttpError(status, message, code); }

export function clientIp(req, { trustProxy = false } = {}){
  if (trustProxy){
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return req.socket?.remoteAddress || 'inconnu';
}

export async function readBody(req, maxBytes){
  const chunks = [];
  let size = 0;
  for await (const c of req){
    size += c.length;
    if (size > maxBytes) fail(413, 'contenu trop volumineux');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes = 2 * 1024 * 1024){
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { fail(400, 'JSON invalide'); }
}

export function sendJson(res, status, obj, headers = {}){
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}){
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/* ---------- multipart/form-data (découpage par frontières) ---------- */
export function parseMultipart(buffer, contentType){
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) fail(400, 'en-tête multipart manquant');
  const delim = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {};
  const files = [];
  let pos = buffer.indexOf(delim);
  if (pos < 0) fail(400, 'corps multipart illisible');
  pos += delim.length;

  while (pos < buffer.length){
    if (buffer[pos] === 45 && buffer[pos + 1] === 45) break;            // « -- » final
    if (buffer[pos] === 13 && buffer[pos + 1] === 10) pos += 2;
    const next = buffer.indexOf(delim, pos);
    if (next < 0) break;
    let end = next;
    if (buffer[end - 2] === 13 && buffer[end - 1] === 10) end -= 2;
    const part = buffer.subarray(pos, end);
    const sep = part.indexOf('\r\n\r\n');
    if (sep > 0){
      const head = part.subarray(0, sep).toString('utf8');
      const body = part.subarray(sep + 4);
      const nameM = /name="([^"]*)"/i.exec(head);
      const fileM = /filename="([^"]*)"/i.exec(head);
      const typeM = /content-type:\s*([^\r\n]+)/i.exec(head);
      const name = nameM ? nameM[1] : '';
      if (fileM && name){
        files.push({ field: name, filename: fileM[1], mime: (typeM ? typeM[1] : 'application/octet-stream').trim(), data: body });
      } else if (name){
        fields[name] = body.toString('utf8');
      }
    }
    pos = next + delim.length;
  }
  return { fields, files };
}

export async function readMultipart(req, maxBytes){
  if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) fail(400, 'requête multipart attendue');
  const buf = await readBody(req, maxBytes);
  return parseMultipart(buf, req.headers['content-type']);
}

/* ---------- cookies ---------- */
export function parseCookies(req){
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')){
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function setCookie(res, name, value, opts = {}){
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push('Path=' + (opts.path || '/'));
  if (opts.maxAge != null) bits.push('Max-Age=' + Math.max(0, Math.floor(opts.maxAge)));
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  bits.push('SameSite=' + (opts.sameSite || 'Lax'));
  if (opts.secure) bits.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function clearCookie(res, name, opts = {}){
  setCookie(res, name, '', { ...opts, maxAge: 0 });
}

/* ---------- fichiers statiques ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};
export const mimeFor = file => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

export async function sendFile(req, res, file, { download = false, cache = 'no-cache', type = null } = {}){
  let st;
  try { st = await stat(file); }
  catch { return fail(404, 'fichier introuvable'); }
  if (!st.isFile()) fail(404, 'fichier introuvable');

  const filename = path.basename(file).replace(/"/g, '');
  const headers = {
    'Content-Type': type || mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
  };

  const range = req.headers.range;
  if (range){
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m){
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
      if (start > end){
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return createReadStream(file, { start, end }).pipe(res);
    }
  }

  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  return createReadStream(file).pipe(res);
}

/* ---------- en-têtes de sécurité ---------- */
export function securityHeaders(res, { csp = null, frameDeny = false } = {}){
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (frameDeny) res.setHeader('X-Frame-Options', 'DENY');
  if (csp) res.setHeader('Content-Security-Policy', csp);
}

/* lecture d'un en-tête « Origin » et comparaison avec l'hôte */
export function sameOrigin(req){
  const origin = req.headers.origin;
  if (!origin) return true;                       // requêtes internes / curl
  try {
    const u = new URL(origin);
    const host = req.headers.host || '';
    return u.host === host;
  } catch { return false; }
}
