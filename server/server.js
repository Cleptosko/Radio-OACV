/* ============================================================
   RADIO OACV — serveur
   * sert le site public tel quel (aucun fichier du site n'est modifié)
   * expose /admin (connexion + panneau) réservé aux deux comptes
   * gère les annonces enregistrées et leur programmation
   * tient la file d'insertion que le moteur d'antenne consommera
   Lancement :  node server/server.js   (ou « npm start »)
   ============================================================ */
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';

import { ROOT, config, configProblems, isForbiddenPath, ALL_PERMS } from './config.js';
import { JsonStore } from './store.js';
import { Auth } from './auth.js';
import {
  HttpError, fail, sendJson, sendText, sendFile, readJson, readMultipart,
  securityHeaders, sameOrigin, clientIp,
} from './http.js';
import { Library } from './library.js';
import { syncProgram, skipTrack, emptyProgram } from './radio.js';
import { Announcements, cleanTitle } from './announcements.js';
import * as sched from './schedule.js';
import { formatInZone } from './zoned.js';

/* ---------- magasins ---------- */
const dataDir = config.dataDir;
const storeAnnouncements = new JsonStore(path.join(dataDir, 'announcements.json'), { items: [] });
const storeSchedules = new JsonStore(path.join(dataDir, 'schedules.json'), { items: [] });
const storeQueue = new JsonStore(path.join(dataDir, 'queue.json'), { items: [] });
const storeStudio = new JsonStore(path.join(dataDir, 'studio.json'), { playNow: null, playNext: null, interrupt: null });
const storeLibrary = new JsonStore(path.join(dataDir, 'library.json'), {});
const storeRadio = new JsonStore(path.join(dataDir, 'radio.json'), emptyProgram());

await storeAnnouncements.load();
await storeSchedules.load();
await storeQueue.load();
await storeStudio.load();
await storeLibrary.load();
await storeRadio.load();

const auth = new Auth();
const announcements = new Announcements(storeAnnouncements, {
  dir: path.join(dataDir, 'announcements'),
  maxBytes: config.uploadMaxMb * 1024 * 1024,
});
const library = new Library(storeLibrary, { log: m => console.log(m) });
await announcements.init();
await library.init();
await storeSchedules.update(d => { if (!Array.isArray(d.items)) d.items = []; });
await storeQueue.update(d => { if (!Array.isArray(d.items)) d.items = []; });

/* ============================================================
   File d'insertion : ce qui doit passer à l'antenne
   ============================================================ */
const queue = () => storeQueue.data.items;

function targetOf(schedule){
  if (schedule.target?.type === 'asset'){
    return { type: 'asset', file: schedule.target.file, label: schedule.target.label || 'Élément antenne' };
  }
  const ann = announcements.get(schedule.announcementId);
  if (!ann) return null;
  return { type: 'announcement', id: ann.id, label: ann.title, file: path.join('announcements', ann.file) };
}

async function enqueue(schedule, { reason = 'programmation', author = null } = {}){
  const target = targetOf(schedule);
  if (!target) return null;
  const already = queue().find(q => q.scheduleId === schedule.id && q.status === 'queued');
  if (already) return already;
  const item = {
    id: 'q_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
    scheduleId: schedule.id,
    target,
    mode: schedule.mode,
    /* « after_music » ne doit pas couper un morceau en cours */
    insert: schedule.mode === 'after_music' ? 'after_music' : 'next_break',
    status: 'queued',
    reason,
    requestedBy: author || schedule.createdBy || 'système',
    createdAt: new Date().toISOString(),
  };
  queue().push(item);
  await storeQueue.save();
  console.log(`[file] + « ${target.label} » (${item.insert})`);
  broadcast();
  return item;
}

const queuePublic = () => queue()
  .filter(q => q.status === 'queued' || q.status === 'playing')
  .map(q => ({
    id: q.id,
    scheduleId: q.scheduleId,
    label: q.target.label,
    mode: q.mode,
    insert: q.insert,
    status: q.status,
    requestedBy: q.requestedBy || null,
    reason: q.reason || null,
    createdAt: q.createdAt,
  }));

/* ============================================================
   Programmation — vérifiée toutes les 5 secondes
   ============================================================ */
const FIVE_SECONDS = 5000;

async function schedulerTick(){
  const now = new Date();
  const items = storeSchedules.data.items;
  let changed = false;

  for (const item of items){
    if (item.enabled && item.nextRunAt && new Date(item.nextRunAt) <= now){
      console.log(`[programmation] « ${item.title || item.mode} » arrive à échéance (${sched.describe(item, config.tz)})`);
      await enqueue(item, { reason: 'heure programmée' });
      sched.markFired(item, now, config.tz);
      changed = true;
    }
  }

  /* recalcule les prochaines échéances (changement d'heure, édition manuelle…) */
  for (const item of items){
    const before = item.nextRunAt;
    sched.refresh([item], { tz: config.tz, from: now });
    if (item.nextRunAt !== before) changed = true;
  }

  /* une entrée en attente dont la source a disparu ne doit pas rester dans la file */
  const before = queue().length;
  storeQueue.data.items = queue().filter(q => {
    if (q.status !== 'queued') return true;
    if (q.target?.type === 'asset') return existsSync(path.join(config.publicDir, q.target.file));
    return !!announcements.get(q.target?.id);
  });
  if (storeQueue.data.items.length !== before){
    console.warn(`[file] ${before - storeQueue.data.items.length} entrée(s) retirée(s) (source disparue)`);
    changed = true;
  }

  if (changed){
    await storeSchedules.save();
    await storeQueue.save();
  }
  broadcast();
}

/* ============================================================
   Diffusion d'événements (panneau admin en direct)
   ============================================================ */
const clients = new Set();

function statusPayload(){
  const next = storeSchedules.data.items
    .filter(s => s.enabled && s.nextRunAt)
    .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))
    .slice(0, 6)
    .map(s => ({ id: s.id, title: s.title, when: s.nextRunAt, human: sched.describe(s, config.tz), mode: s.mode }));

  return {
    heureLocale: formatInZone(new Date(), config.tz, { dateStyle: 'full', timeStyle: 'medium' }),
    fuseau: config.tz,
    diffusion: {
      fluxPret: false,
      raison: 'Le moteur d\'antenne côté serveur (phase 2) n\'est pas encore installé',
      montee: config.stream.mount,
      adressePublique: config.stream.publicUrl || null,
    },
    banque: library.counts(),
    annonces: announcements.usage(),
    file: queuePublic(),
    prochaines: next,
    moteur: { version: 'phase 1 — administration et programmation', demarreLe: startedAt.toISOString() },
  };
}

function broadcast(){
  if (!clients.size) return;
  const payload = JSON.stringify({ type: 'status', data: statusPayload() });
  for (const res of clients){
    try { res.write(`data: ${payload}\n\n`); } catch { clients.delete(res); }
  }
}

/* ============================================================
   Routage
   ============================================================ */
const routes = [];
function route(method, pattern, handler){
  const keys = [];
  const src = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  routes.push({ method, re: new RegExp('^' + src + '/?$'), keys, handler });
}
function match(method, pathname){
  for (const r of routes){
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function guard(req, res, method, pathname){
  if (!MUTATING.has(method)) return;
  if (!sameOrigin(req)) fail(403, 'origine non autorisée');
  if (pathname === '/api/login') return;            // protégé par le limiteur de tentatives
  /* Signalement de titre illisible : vient d'un auditeur anonyme, donc
     pas de jeton — mais la même origine reste exigée, et skipTrack()
     n'accepte que le titre en cours. */
  if (pathname === '/api/radio/now') return;
  auth.checkCsrf(req);
}

/* une erreur de saisie doit répondre 400, pas 500 */
function check(fn){
  try { return fn(); }
  catch (e){ fail(400, e.message); }
}

/* ============================================================
   Studio — pilotage de l'antenne en temps réel
   Le site public interroge /api/studio/directives (public, lecture
   seule). Les commandes viennent du tableau de bord /studio,
   protégé par les comptes d'administration.
   ============================================================ */
function newId(p){ return p + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'); }

function studioDirectives(){
  const st = storeStudio.data;
  /* un lancement immédiat n'est valable que 10 minutes : un auditeur
     qui arrive après ne doit pas rejouer un vieux titre forcé */
  if (st.playNow && Date.now() - new Date(st.playNow.createdAt).getTime() > 10 * 60 * 1000) st.playNow = null;
  const d = { playNow: null, playNext: null, interrupt: null };
  if (st.playNow) d.playNow = { id: st.playNow.id, videoId: st.playNow.videoId, title: st.playNow.title || null };
  if (st.playNext) d.playNext = { id: st.playNext.id, videoId: st.playNext.videoId, title: st.playNext.title || null };
  if (st.interrupt) d.interrupt = { id: st.interrupt.id, active: !!st.interrupt.active, when: st.interrupt.when };
  return d;
}

function studioState(){
  return {
    playNow: storeStudio.data.playNow,
    playNext: storeStudio.data.playNext,
    interrupt: storeStudio.data.interrupt,
    file: queuePublic(),
  };
}

route('GET', '/api/studio/directives', (req, res) => sendJson(res, 200, studioDirectives()));

/* ============================================================
   Antenne partagée — « ce qui passe en ce moment »
   C'est cette route qui fait la radio : le serveur détient la
   rotation, l'heure de début du titre en cours et sa durée. Le
   navigateur se cale dessus, donc tous les auditeurs entendent la
   même chose, et celui qui ouvre la page arrive au milieu du
   morceau plutôt qu'à zéro.

     GET  /api/radio/now              ce qui passe, et à quel point
     POST /api/radio/now  { videoId } ce titre est illisible, passe au suivant
   ============================================================ */
route('GET', '/api/radio/now', async (req, res) => {
  const pool = library.list('music');
  if (!pool.length) return sendJson(res, 200, { live: false });
  const st = storeRadio.data;
  const before = sigRadio(st);
  const dir = studioDirectives();
  const nowPlaying = syncProgram(st, pool, dir, Date.now(), !!(dir.interrupt && dir.interrupt.active));
  if (sigRadio(st) !== before) await storeRadio.save();
  if (!nowPlaying) return sendJson(res, 200, { live: false });
  sendJson(res, 200, nowPlaying);
});

/* Un titre que YouTube refuse est signalé par les auditeurs : on le
   saute pour tout le monde plutôt que de rester muet dessus.
   skipTrack() n'accepte que le titre en cours, et jamais un titre
   imposé par le studio. Ce point reste volontairement borné. */
route('POST', '/api/radio/now', async (req, res) => {
  const body = await readJson(req, 2 * 1024);
  const vid = String(body.videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return fail(400, 'identifiant YouTube invalide');
  const skipped = skipTrack(storeRadio.data, library.list('music'), vid, Date.now());
  if (skipped){
    await storeRadio.save();
    console.log('[radio] titre sauté (illisible pour un auditeur) : ' + vid);
  }
  sendJson(res, 200, { ok: true, skipped });
});

/* Ce qui mérite d'être écrit : un changement de titre, un gel, une
   directive du studio. Juste consulter ne coûte rien. */
const sigRadio = st => [st.i, st.startedAt, st.pausedAt, st.override && st.override.videoId].join('|');

route('GET', '/api/studio/state', (req, res) => {
  auth.require(req);
  sendJson(res, 200, studioState());
});

route('POST', '/api/studio/next', async (req, res) => {
  const session = auth.require(req);
  const body = await readJson(req);
  const vid = String(body.videoId || '').trim();
  if (vid && !/^[A-Za-z0-9_-]{11}$/.test(vid)) fail(400, 'identifiant YouTube invalide');
  const item = vid ? {
    id: newId('pn'),
    videoId: vid,
    title: String(body.title || '').slice(0, 200) || null,
    author: String(body.author || '').slice(0, 200) || null,
    requestedBy: session.sub,
    createdAt: new Date().toISOString(),
  } : null;
  storeStudio.data.playNext = item;
  await storeStudio.save();
  console.log('[studio] prochain morceau par ' + session.sub + ' : ' + (vid || '(annulé)'));
  broadcast();
  sendJson(res, 200, studioState());
});

route('POST', '/api/studio/play-now', async (req, res) => {
  const session = auth.require(req);
  const body = await readJson(req);
  const vid = String(body.videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) fail(400, 'identifiant YouTube invalide');
  const item = {
    id: newId('pnow'),
    videoId: vid,
    title: String(body.title || '').slice(0, 200) || null,
    author: String(body.author || '').slice(0, 200) || null,
    requestedBy: session.sub,
    createdAt: new Date().toISOString(),
  };
  storeStudio.data.playNow = item;
  await storeStudio.save();
  console.log('[studio] lancement immédiat par ' + session.sub + ' : ' + vid);
  broadcast();
  sendJson(res, 200, studioState());
});

route('POST', '/api/studio/interrupt', async (req, res) => {
  const session = auth.require(req);
  const body = await readJson(req);
  const when = body.when === 'after' ? 'after' : 'now';
  const item = { id: newId('it'), active: true, when, requestedBy: session.sub, createdAt: new Date().toISOString() };
  storeStudio.data.interrupt = item;
  await storeStudio.save();
  console.log('[studio] interruption (' + when + ') par ' + session.sub);
  broadcast();
  sendJson(res, 200, studioState());
});

route('POST', '/api/studio/resume', async (req, res) => {
  const session = auth.require(req);
  const it = storeStudio.data.interrupt;
  if (!it) return sendJson(res, 200, studioState());
  it.active = false;
  it.resumedBy = session.sub;
  it.resumedAt = new Date().toISOString();
  await storeStudio.save();
  console.log('[studio] reprise par ' + session.sub);
  broadcast();
  sendJson(res, 200, studioState());
});

route('POST', '/api/studio/clear', async (req, res) => {
  const session = auth.require(req);
  storeStudio.data.playNow = null;
  storeStudio.data.playNext = null;
  await storeStudio.save();
  console.log('[studio] directives effacées par ' + session.sub);
  broadcast();
  sendJson(res, 200, studioState());
});
/* ---------- santé ---------- */
route('GET', '/api/health', (req, res) => sendJson(res, 200, {
  ok: true,
  service: 'radio-oacv',
  heure: new Date().toISOString(),
  fuseau: config.tz,
}));

/* ---------- session ---------- */
route('GET', '/api/me', (req, res) => {
  const csrf = auth.csrf(req, res);
  const session = auth.session(req);
  sendJson(res, 200, {
    user: auth.publicUser(session),
    csrf,
    permissions: session ? (session.role === 'owner' ? ALL_PERMS : session.perms) : [],
    fuseau: config.tz,
  });
});

route('POST', '/api/login', async (req, res) => {
  const body = await readJson(req, 64 * 1024);
  const session = await auth.login(req, res, body.email, body.password);
  const csrf = auth.csrf(req, res);
  sendJson(res, 200, { user: auth.publicUser(session), csrf });
});

route('POST', '/api/logout', (req, res) => {
  auth.require(req);
  auth.logout(req, res);
  sendJson(res, 200, { ok: true });
});

/* ---------- état (panneau admin) ---------- */
route('GET', '/api/status', (req, res) => {
  auth.require(req);
  sendJson(res, 200, statusPayload());
});

/* ---------- annonces ---------- */
route('GET', '/api/announcements', (req, res) => {
  auth.require(req, 'announcements');
  sendJson(res, 200, {
    items: announcements.list().map(a => ({
      ...a,
      audioUrl: `/api/announcements/${a.id}/audio`,
    })),
    usage: announcements.usage(),
    maxBytes: config.uploadMaxMb * 1024 * 1024,
  });
});

route('POST', '/api/announcements', async (req, res) => {
  const session = auth.require(req, 'announcements');
  const { fields, files } = await readMultipart(req, config.uploadMaxMb * 1024 * 1024 + 1024 * 1024);
  const file = files.find(f => f.field === 'audio') || files[0];
  if (!file) fail(400, 'aucun fichier audio reçu');
  const item = await announcements.create({
    title: fields.title,
    mime: fields.mime || file.mime,
    filename: file.filename,
    data: file.data,
    durationMs: fields.durationMs,
    author: session.sub,
    source: fields.source || 'micro',
  });
  broadcast();
  sendJson(res, 201, { item: { ...item, audioUrl: `/api/announcements/${item.id}/audio` } });
});

route('GET', '/api/announcements/:id/audio', async (req, res, params) => {
  auth.require(req, 'announcements');
  const item = announcements.get(params.id);
  if (!item) fail(404, 'annonce introuvable');
  return sendFile(req, res, announcements.filePath(item), { type: item.mime });
});

route('PATCH', '/api/announcements/:id', async (req, res, params) => {
  const session = auth.require(req, 'announcements');
  const body = await readJson(req);
  const item = await announcements.updateTitle(params.id, cleanTitle(body.title, ''));
  console.log(`[annonces] renommée par ${session.sub} : ${item.title}`);
  broadcast();
  sendJson(res, 200, { item });
});

route('DELETE', '/api/announcements/:id', async (req, res, params) => {
  const session = auth.require(req, 'announcements');
  const item = await announcements.remove(params.id);
  /* les programmations qui la visaient n'ont plus de source : on les met en pause */
  let paused = 0;
  for (const s of storeSchedules.data.items){
    if (s.announcementId === params.id){
      s.enabled = false;
      s.nextRunAt = null;
      s.note = 'annonce supprimée';
      paused++;
    }
  }
  storeQueue.data.items = storeQueue.data.items.filter(q => q.target?.id !== params.id || q.status !== 'queued');
  if (paused) await storeSchedules.save();
  await storeQueue.save();
  console.log(`[annonces] supprimée par ${session.sub} : ${item.title}${paused ? ` (${paused} programmation(s) mise(s) en pause)` : ''}`);
  broadcast();
  sendJson(res, 200, { ok: true, paused });
});

/* ---------- programmation ---------- */
route('GET', '/api/schedules', (req, res) => {
  auth.require(req, 'schedule');
  sched.refresh(storeSchedules.data.items, { tz: config.tz });
  sendJson(res, 200, {
    items: storeSchedules.data.items
      .map(s => ({
        ...s,
        human: sched.describe(s, config.tz),
        nextRunLabel: s.nextRunAt ? formatInZone(new Date(s.nextRunAt), config.tz, { dateStyle: 'full', timeStyle: 'short' }) : null,
      }))
      .sort((a, b) => String(a.nextRunAt || '9').localeCompare(String(b.nextRunAt || '9'))),
    queue: queuePublic(),
    fuseau: config.tz,
  });
});

route('POST', '/api/schedules', async (req, res) => {
  const session = auth.require(req, 'schedule');
  const body = await readJson(req);
  const mode = String(body.mode || '').trim();
  check(() => sched.validate({ mode, at: body.at, time: body.time, days: body.days }, config.tz));

  let target = null;
  let announcementId = null;
  if (body.asset){                                        // jingle / pub maison programmables
    const allowed = { jingle: 'audio/jingle.mp3', puboacv: 'audio/PubOACV.mp3' };
    const file = allowed[body.asset];
    if (!file) fail(400, 'élément d\'antenne inconnu');
    target = { type: 'asset', file, label: body.asset === 'jingle' ? 'Jingle Radio OACV' : 'Publicité OACV (maison)' };
  } else {
    const ann = announcements.get(body.announcementId);
    if (!ann) fail(400, 'annonce introuvable');
    announcementId = ann.id;
  }

  const item = {
    id: 'sch_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
    title: cleanTitle(body.title || (announcementId ? announcements.get(announcementId).title : target.label), 'Programmation'),
    mode,
    at: mode === 'once' ? sched.instantFromLocal(body.at, config.tz)?.toISOString() || null : null,
    time: (mode === 'daily' || mode === 'weekly') ? sched.parseHHMM(body.time)?.text : null,
    days: mode === 'weekly' ? sched.normaliseDays(body.days) : [],
    announcementId,
    target,
    enabled: body.enabled === false ? false : true,
    createdBy: session.sub,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    nextRunAt: null,
  };
  sched.refresh([item], { tz: config.tz });
  storeSchedules.data.items.push(item);
  await storeSchedules.save();

  /* « maintenant » et « après une musique » partent directement dans la file */
  if (item.enabled && (mode === 'now' || mode === 'after_music')){
    await enqueue(item, { reason: mode === 'now' ? 'demandée immédiatement' : 'fin de musique', author: session.sub });
  }

  console.log(`[programmation] créée par ${session.sub} : « ${item.title} » — ${sched.describe(item, config.tz)}`);
  broadcast();
  sendJson(res, 201, { item: { ...item, human: sched.describe(item, config.tz) } });
});

route('PATCH', '/api/schedules/:id', async (req, res, params) => {
  const session = auth.require(req, 'schedule');
  const item = storeSchedules.data.items.find(s => s.id === params.id);
  if (!item) fail(404, 'programmation introuvable');
  const body = await readJson(req);

  if (body.enabled != null) item.enabled = !!body.enabled;
  if (body.title != null) item.title = cleanTitle(body.title, item.title);
  if (body.time != null && (item.mode === 'daily' || item.mode === 'weekly')){
    const hm = sched.parseHHMM(body.time);
    if (!hm) fail(400, 'heure invalide (format attendu 12:00)');
    item.time = hm.text;
  }
  if (body.days != null && item.mode === 'weekly'){
    const days = sched.normaliseDays(body.days);
    if (!days.length) fail(400, 'choisissez au moins un jour');
    item.days = days;
  }
  if (body.at != null && item.mode === 'once'){
    const at = sched.instantFromLocal(body.at, config.tz);
    if (!at) fail(400, 'date invalide');
    item.at = at.toISOString();
  }
  item.updatedAt = new Date().toISOString();
  sched.refresh([item], { tz: config.tz });
  await storeSchedules.save();
  console.log(`[programmation] modifiée par ${session.sub} : « ${item.title} » (${item.enabled ? 'active' : 'en pause'})`);
  broadcast();
  sendJson(res, 200, { item: { ...item, human: sched.describe(item, config.tz) } });
});

route('DELETE', '/api/schedules/:id', async (req, res, params) => {
  const session = auth.require(req, 'schedule');
  const item = storeSchedules.data.items.find(s => s.id === params.id);
  if (!item) fail(404, 'programmation introuvable');
  storeSchedules.data.items = storeSchedules.data.items.filter(s => s.id !== params.id);
  storeQueue.data.items = storeQueue.data.items.filter(q => q.scheduleId !== params.id || q.status === 'played');
  await storeSchedules.save();
  await storeQueue.save();
  console.log(`[programmation] supprimée par ${session.sub} : « ${item.title} »`);
  broadcast();
  sendJson(res, 200, { ok: true });
});

/* ---------- file d'insertion ---------- */
route('GET', '/api/queue', (req, res) => {
  auth.require(req, 'schedule');
  sendJson(res, 200, { items: queuePublic(), historique: queue().filter(q => q.status === 'played').slice(-20).reverse() });
});

route('POST', '/api/queue/:id/cancel', async (req, res, params) => {
  const session = auth.require(req, 'schedule');
  const before = queue().length;
  storeQueue.data.items = queue().filter(q => !(q.id === params.id && q.status === 'queued'));
  await storeQueue.save();
  console.log(`[file] annulation par ${session.sub} : ${params.id}`);
  broadcast();
  sendJson(res, 200, { ok: before !== queue().length });
});

/* ---------- banque : musiques, publicités, réglages ---------- */
route('GET', '/api/library/:kind', (req, res, params, url) => {
  const kind = params.kind === 'ads' ? 'ads' : 'music';
  auth.require(req, kind === 'ads' ? 'ads' : 'library');
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  let items = library.list(kind);
  if (q){
    items = items.filter(v => (v.title + ' ' + v.author).toLowerCase().includes(q));
  }
  const limit = Math.min(2000, parseInt(url.searchParams.get('limit') || '400', 10) || 400);
  sendJson(res, 200, {
    kind,
    counts: library.counts()[kind],
    total: items.length,
    items: items.slice(0, limit),
    settings: library.settings,
    cachedAt: library.cachedAt[kind],
    stale: library.stale(kind),
  });
});

route('POST', '/api/library/:kind/refresh', async (req, res, params) => {
  const session = auth.require(req, params.kind === 'ads' ? 'ads' : 'library');
  try {
    const n = await library.refresh(params.kind === 'ads' ? 'ads' : 'music', { force: true });
    console.log(`[banque] rafraîchie par ${session.sub} : ${n} titres`);
    broadcast();
    sendJson(res, 200, { ok: true, count: n, counts: library.counts() });
  } catch (e){
    fail(502, 'impossible de joindre les sources de playlist : ' + e.message);
  }
});

route('PATCH', '/api/library/:kind', async (req, res, params) => {
  const session = auth.require(req, params.kind === 'ads' ? 'ads' : 'library');
  const body = await readJson(req);
  const kind = params.kind === 'ads' ? 'ads' : 'music';
  if (!body.id) fail(400, 'identifiant manquant');
  const item = await library.setEnabled(kind, body.id, !!body.enabled);
  console.log(`[banque] ${kind} — « ${item?.title || body.id} » ${body.enabled ? 'activé' : 'désactivé'} par ${session.sub}`);
  broadcast();
  sendJson(res, 200, { item });
});

route('POST', '/api/library/:kind/add', async (req, res, params) => {
  const session = auth.require(req, params.kind === 'ads' ? 'ads' : 'library');
  const body = await readJson(req);
  const kind = params.kind === 'ads' ? 'ads' : 'music';
  const item = await library.add(kind, body.url);
  console.log(`[banque] ajout par ${session.sub} (${kind}) : ${item.title || item.id}`);
  broadcast();
  sendJson(res, 201, { item });
});

route('DELETE', '/api/library/:kind/:id', async (req, res, params) => {
  const session = auth.require(req, params.kind === 'ads' ? 'ads' : 'library');
  const kind = params.kind === 'ads' ? 'ads' : 'music';
  const removed = await library.remove(kind, params.id);
  console.log(`[banque] retrait par ${session.sub} (${kind}) : ${params.id}`);
  broadcast();
  sendJson(res, 200, { ok: removed });
});

route('PATCH', '/api/settings', async (req, res) => {
  const session = auth.require(req, 'ads');
  const body = await readJson(req);
  const settings = await library.setSettings(body);
  console.log('[réglages] modifiés par', session.sub, JSON.stringify(settings));
  broadcast();
  sendJson(res, 200, { settings });
});

/* ---------- état public (lecture seule, aucune donnée d'administration) ---------- */
route('GET', '/api/now', (req, res) => sendJson(res, 200, {
  live: false,
  kind: null,
  title: null,
  artist: null,
  cover: null,
  source: 'moteur d\'antenne serveur en préparation',
}));

/* ---------- flux d'événements ---------- */
route('GET', '/api/events', (req, res) => {
  auth.require(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'status', data: statusPayload() })}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignoré */ } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

/* ============================================================
   Fichiers statiques
   ============================================================ */
const ADMIN_DIR = path.join(ROOT, 'server', 'admin');

function safeJoin(base, rel){
  const clean = path.posix.normalize(String(rel || '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (clean.split('/').some(s => s === '..' || (s.startsWith('.') && s !== '.'))) fail(403, 'accès refusé');
  const target = (!clean || clean === '.') ? 'index.html' : clean;
  const file = path.join(base, target);
  if (!path.resolve(file).startsWith(path.resolve(base))) fail(403, 'accès refusé');
  return file;
}

async function serveAdminAsset(req, res, rel, base){
  const file = safeJoin(base || ADMIN_DIR, rel);
  if (!existsSync(file)) return sendText(res, 404, 'Page introuvable', 'text/plain; charset=utf-8');
  securityHeaders(res, {
    frameDeny: true,
    csp: "default-src 'self'; img-src 'self' data: https://i.ytimg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'",
  });
  return sendFile(req, res, file, { cache: 'no-cache' });
}

async function servePublicAsset(req, res, rel){
  let decoded = String(rel || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* on garde tel quel */ }
  const clean = path.posix.normalize(decoded.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (isForbiddenPath(clean)) fail(403, 'accès refusé');
  const file = safeJoin(config.publicDir, clean);
  if (!existsSync(file)) return sendText(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
  const cache = /\.(png|jpg|jpeg|gif|svg|woff2?|ttf|ico)$/i.test(file) ? 'public, max-age=86400' : 'no-cache';
  return sendFile(req, res, file, { cache });
}

/* ============================================================
   Requête HTTP
   ============================================================ */
const startedAt = new Date();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  try {
    if (pathname === '/admin' || pathname.startsWith('/admin/')){
      return await serveAdminAsset(req, res, pathname.replace(/^\/admin\/?/, ''));
    }
    if (pathname === '/studio' || pathname.startsWith('/studio/')){
      return await serveAdminAsset(req, res, pathname.slice('/studio'.length), path.join(ROOT, 'studio'));
    }


    if (pathname.startsWith('/api/')){
      guard(req, res, method, pathname);
      const hit = match(method === 'HEAD' ? 'GET' : method, pathname);
      if (!hit) fail(404, 'route inconnue');
      return await hit.route.handler(req, res, hit.params, url);
    }

    return await servePublicAsset(req, res, pathname);
  } catch (e){
    if (e instanceof HttpError){
      if (pathname.startsWith('/api/')){
        if (e.status === 401) res.setHeader('WWW-Authenticate', 'Cookie realm="Radio OACV"');
        return sendJson(res, e.status, { error: e.message, code: e.code });
      }
      return sendText(res, e.status, e.message);
    }
    console.error('[serveur] erreur inattendue', req.method, pathname, e);
    return sendJson(res, 500, { error: 'erreur interne du serveur' });
  }
});

/* ============================================================
   Démarrage
   ============================================================ */
const problems = configProblems();
if (problems.length){
  console.error('\n  Le serveur ne peut pas démarrer :');
  for (const p of problems) console.error('   • ' + p);
  console.error('\n  Lancez « npm run setup » pour créer le fichier .env.\n');
  process.exit(1);
}

server.listen(config.port, config.host, async () => {
  const who = auth.accounts.map(a => `${a.name} <${a.email}> [${a.role === 'owner' ? 'propriétaire' : a.perms.join(', ') || 'aucune permission'}]`);
  console.log('');
  console.log('  ==========================================================');
  console.log('        RADIO OACV — serveur démarré');
  console.log('  ==========================================================');
  console.log(`   Site public  : http://localhost:${config.port}/`);
  console.log(`   Espace admin : http://localhost:${config.port}/admin`);
  console.log(`   Fuseau       : ${config.tz}`);
  console.log(`   Données      : ${dataDir}`);
  for (const w of who) console.log('   Compte       : ' + w);
  console.log('  ----------------------------------------------------------');
  console.log('   Prochaine étape : le moteur d\'antenne serveur (phase 2)');
  console.log('   et le flux audio pour le bot Discord.');
  console.log('  ==========================================================');
  console.log('');

  try {
    await schedulerTick();
    setInterval(() => { schedulerTick().catch(e => console.error('[programmation]', e.message)); }, FIVE_SECONDS);
    console.log('[programmation] vérification toutes les 5 secondes');
  } catch (e){
    console.error('[programmation] démarrage impossible :', e.message);
  }

  /* la banque se rafraîchit en tâche de fond si elle est périmée */
  setTimeout(async () => {
    try {
      for (const kind of ['music', 'ads']){
        if (library.stale(kind)){
          const n = await library.refresh(kind);
          console.log(`[banque] ${kind} : ${n} titres disponibles`);
          broadcast();
        }
      }
    } catch (e){
      console.warn('[banque] rafraîchissement automatique impossible :', e.message);
    }
  }, 1500);
});

for (const sig of ['SIGINT', 'SIGTERM']){
  process.on(sig, () => {
    console.log('\n[serveur] arrêt demandé, sauvegarde des données…');
    Promise.all([storeAnnouncements.save(), storeSchedules.save(), storeQueue.save(), storeLibrary.save()])
      .then(() => server.close(() => process.exit(0)))
      .catch(() => process.exit(0));
  });
}

process.on('unhandledRejection', e => console.error('[serveur] promesse non gérée :', e));
