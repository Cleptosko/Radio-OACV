/* ============================================================
   Fonctions Vercel — couche commune
   Le serveur Node (server/) et ces fonctions partagent la meme
   authentification (server/auth.js). Seul le stockage change : sur
   Vercel le disque est ephemere, donc les directives du studio
   vivent dans Upstash Redis, interroge en HTTP par fetch()
   (aucune dependance npm).
   ============================================================ */
import crypto from "node:crypto";
import { Auth } from "../server/auth.js";
import { fail, HttpError } from "../server/http.js";

export { fail, HttpError };

/* ---------- enveloppement des reponses ---------- */
function sendJson(res, status, obj){
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}
export function ok(res, obj){ sendJson(res, 200, obj); }

let authSingleton = null;
export function auth(){ if (!authSingleton) authSingleton = new Auth(); return authSingleton; }

/* Vercel analyse deja le corps JSON : on ne relit pas le flux. */
export function body(req){
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string"){ try { return JSON.parse(b); } catch { return {}; } }
  return b;
}

/* Une fonction = un fichier. Les erreurs de l’Auth (fail) deviennent
   des reponses JSON propres au lieu de 500 opaques. */
export function handle(fn){
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e){
      if (e instanceof HttpError || (e && typeof e.status === "number")){
        return sendJson(res, e.status, { error: e.message, code: e.code || null });
      }
      console.error("[api]", e);
      sendJson(res, 500, { error: "erreur interne du serveur", code: "internal" });
    }
  };
}

/* ---------- Upstash Redis, en HTTP brut ---------- */
const STUDIO_KEY = "radio-oacv:studio";

function redisCfg(){
  const url = process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) fail(503, "stockage non configure (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)", "no_storage");
  return { url: url.replace(new RegExp("[/]+$"), ""), token };
}

async function redis(cmds){
  const { url, token } = redisCfg();
  const r = await fetch(url + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) fail(502, "stockage indisponible (" + r.status + ")", "storage_down");
  const j = await r.json();
  return Array.isArray(j) ? j.map(x => (x && typeof x === "object" && "result" in x ? x.result : x)) : [];
}

const EMPTY = () => ({ playNow: null, playNext: null, interrupt: null });

export async function redisGet(key){
  const [raw] = await redis([["GET", key]]);
  return raw || null;
}
export async function redisSet(key, value, ttl){ await redis([["SET", key, value, "EX", ttl]]); }

export async function readStudio(){
  const [raw] = await redis([["GET", STUDIO_KEY]]);
  if (!raw) return EMPTY();
  try { return { ...EMPTY(), ...JSON.parse(raw) }; }
  catch { return EMPTY(); }
}
export async function writeStudio(st, ttl = 60 * 60 * 24 * 30){
  await redis([["SET", STUDIO_KEY, JSON.stringify(st), "EX", ttl]]);
}

/* ---------- logique du studio (identique a server/server.js) ---------- */
export function newId(p){ return p + "_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex"); }

export function studioDirectives(st){
  /* un lancement immediat ne vaut que 10 minutes */
  if (st.playNow && Date.now() - new Date(st.playNow.createdAt).getTime() > 10 * 60 * 1000) st.playNow = null;
  const d = { playNow: null, playNext: null, interrupt: null };
  if (st.playNow) d.playNow = { id: st.playNow.id, videoId: st.playNow.videoId, title: st.playNow.title || null };
  if (st.playNext) d.playNext = { id: st.playNext.id, videoId: st.playNext.videoId, title: st.playNext.title || null };
  if (st.interrupt) d.interrupt = { id: st.interrupt.id, active: !!st.interrupt.active, when: st.interrupt.when };
  return d;
}

export const isVideoId = v => /^[A-Za-z0-9_-]{11}$/.test(v);

export async function studioState(){ return await readStudio(); }

export async function requireUser(req, res, perm = null){
  return auth().require(req, perm);
}
