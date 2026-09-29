/* ============================================================
   Mots de passe — scrypt (inclus dans Node, aucune dépendance)
   Format stocké : scrypt$N$r$p$sel$empreinte  (tout en base64)
   ============================================================ */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

const N = 16384;          // coût CPU/mémoire
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 96 * 1024 * 1024;

export async function hashPassword(password){
  if (typeof password !== 'string' || password.length < 8) throw new Error('mot de passe trop court (8 caractères minimum)');
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored){
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  let salt, expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(keyB64, 'base64');
  } catch { return false; }
  if (!salt.length || !expected.length) return false;
  let got;
  try {
    got = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: parseInt(n, 10) || N, r: parseInt(r, 10) || R, p: parseInt(p, 10) || P, maxmem: MAXMEM,
    });
  } catch { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
