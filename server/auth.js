/* ============================================================
   Accès administrateur — deux comptes seulement.
   * mots de passe : empreintes scrypt, jamais en clair
   * sessions      : cookie signé (HMAC-SHA256), HttpOnly, SameSite=Lax
   * CSRF          : jeton double (cookie + en-tête)
   * force brute   : blocage progressif par IP + identifiant
   ============================================================ */
import crypto from 'node:crypto';
import { adminAccounts, config } from './config.js';
import { verifyPassword } from './hash.js';
import { clientIp, fail, parseCookies, setCookie, clearCookie } from './http.js';

export const SESSION_COOKIE = 'oacv_session';
export const CSRF_COOKIE = 'oacv_csrf';

const b64u = v => Buffer.from(v).toString('base64url');

/* empreinte factice : permet de calculer un scrypt même sur un compte
   inexistant, pour ne pas révéler l'existence d'un compte par le temps de réponse */
const DUMMY_HASH = 'scrypt$16384$8$1$' + Buffer.alloc(16).toString('base64') + '$' + Buffer.alloc(64).toString('base64');

export class Auth {
  constructor(accounts = adminAccounts()){
    this.accounts = accounts;
    this.attempts = new Map();
  }

  reload(){ this.accounts = adminAccounts(); }

  account(email){
    const e = String(email || '').trim().toLowerCase();
    return this.accounts.find(a => a.email === e) || null;
  }

  /* ---------- anti-force brute ----------
     On compte à la fois par compte et par adresse : sans le compteur par IP,
     il suffirait de changer d'identifiant à chaque essai pour ne jamais
     être bloqué. */
  key(req, email){ return `${clientIp(req, config)}|${String(email || '').trim().toLowerCase()}`; }
  ipKey(req){ return 'ip|' + clientIp(req, config); }

  blockedFor(req, email){
    let worst = 0;
    for (const k of [this.key(req, email), this.ipKey(req)]){
      const e = this.attempts.get(k);
      const left = e && e.until ? e.until - Date.now() : 0;
      if (left > worst) worst = left;
    }
    return worst > 0 ? Math.ceil(worst / 1000) : 0;
  }

  noteFail(req, email){
    for (const [k, threshold] of [[this.key(req, email), 5], [this.ipKey(req), 12]]){
      const e = this.attempts.get(k) || { n: 0, until: 0 };
      e.n += 1;
      if (e.n >= threshold) e.until = Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(5, e.n - threshold));
      this.attempts.set(k, e);
    }
    this.sweep();
  }

  noteSuccess(req, email){ this.attempts.delete(this.key(req, email)); }

  sweep(){
    const now = Date.now();
    for (const [k, e] of this.attempts) if (e.until && e.until < now - 3600_000) this.attempts.delete(k);
  }

  /* ---------- sessions ---------- */
  sign(payload){
    const body = b64u(JSON.stringify(payload));
    const mac = b64u(crypto.createHmac('sha256', config.sessionSecret).update(body).digest());
    return `${body}.${mac}`;
  }

  verify(token){
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = b64u(crypto.createHmac('sha256', config.sessionSecret).update(body).digest());
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { return null; }
    if (!p || !p.exp || p.exp < Date.now()) return null;
    return p;
  }

  session(req){
    const payload = this.verify(parseCookies(req)[SESSION_COOKIE]);
    if (!payload) return null;
    const acc = this.account(payload.sub);
    if (!acc || !acc.enabled) return null;            // compte désactivé → session morte
    return payload;
  }

  publicUser(p){
    if (!p) return null;
    return { email: p.sub, name: p.name, role: p.role, perms: p.perms || [] };
  }

  async login(req, res, email, password){
    const wait = this.blockedFor(req, email);
    if (wait) fail(429, `trop de tentatives — réessayez dans ${Math.ceil(wait / 60)} min`);

    const acc = this.account(email);
    const ok = await verifyPassword(String(password || ''), acc ? acc.hash : DUMMY_HASH);
    if (!acc || !acc.enabled || !ok){
      this.noteFail(req, email);
      console.warn(`[auth] connexion refusée (${clientIp(req, config)}) : ${String(email || '').slice(0, 60)}`);
      fail(401, 'identifiants invalides', 'bad_credentials');
    }
    this.noteSuccess(req, email);

    const payload = {
      sub: acc.email,
      name: acc.name,
      role: acc.role,
      perms: acc.perms,
      sid: crypto.randomBytes(12).toString('hex'),
      iat: Date.now(),
      exp: Date.now() + config.sessionHours * 3600_000,
    };
    setCookie(res, SESSION_COOKIE, this.sign(payload), {
      maxAge: config.sessionHours * 3600,
      secure: config.secureCookies,
      sameSite: 'Lax',
    });
    console.info(`[auth] ${acc.role === 'owner' ? 'propriétaire' : 'collaborateur'} connecté : ${acc.email}`);
    return payload;
  }

  logout(req, res){
    const p = this.session(req);
    if (p) console.info('[auth] déconnexion :', p.sub);
    clearCookie(res, SESSION_COOKIE, { secure: config.secureCookies });
  }

  /* ---------- CSRF ---------- */
  csrf(req, res){
    const existing = parseCookies(req)[CSRF_COOKIE];
    if (existing) return existing;
    const token = crypto.randomBytes(24).toString('base64url');
    setCookie(res, CSRF_COOKIE, token, { maxAge: 7 * 86400, secure: config.secureCookies });
    return token;
  }

  checkCsrf(req){
    const cookie = parseCookies(req)[CSRF_COOKIE] || '';
    const header = String(req.headers['x-csrf-token'] || '');
    if (!cookie || !header) fail(403, 'jeton de sécurité manquant — rechargez la page', 'csrf');
    const a = Buffer.from(cookie);
    const b = Buffer.from(header);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(403, 'jeton de sécurité invalide — rechargez la page', 'csrf');
  }

  /* ---------- contrôle d'accès ---------- */
  require(req, perm = null){
    const p = this.session(req);
    if (!p) fail(401, 'connexion requise', 'auth');
    if (perm && p.role !== 'owner' && !(p.perms || []).includes(perm)){
      fail(403, `permission « ${perm} » non accordée à ce compte`, 'perm');
    }
    return p;
  }
}
