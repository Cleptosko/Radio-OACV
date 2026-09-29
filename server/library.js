/* ============================================================
   Banque de l'antenne (côté serveur).
   * récupère les playlists complètes (Piped paginé, puis Invidious)
   * conserve la totalité des titres dans un cache disque
   * permet d'activer/désactiver chaque titre et d'en ajouter
   C'est la même logique de chargement que le moteur du navigateur,
   mais exécutée sur le serveur : pas de CORS, et disponible même
   quand personne n'a le site ouvert.
   ============================================================ */
import { config } from './config.js';
import { fail } from './http.js';

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.drgns.space',
  'https://pipedapi.leptons.xyz',
];
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.privacyredirect.com',
];
const PLAYLIST_MAX_PAGES = 12;
const PLAYLIST_MIN_PLAUSIBLE = 40;

/* les fichiers locaux de l'antenne (jingle et pub maison) */
export const LOCAL_ASSETS = {
  ads: [
    { id: 'local:jingle', title: 'Jingle Radio OACV', file: 'audio/jingle.mp3', setting: 'jingleEnabled' },
    { id: 'local:puboacv', title: 'Publicité OACV (maison)', file: 'audio/PubOACV.mp3', setting: 'puboacvEnabled' },
  ],
};

async function fetchJSON(url, timeoutMs = 9000){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'RadioOACV/1.0 (+serveur radio)', Accept: 'application/json' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const vidFromUrl = url => {
  const m = /[?&]v=([\w-]{6,})/.exec(url || '');
  return m ? m[1] : null;
};

export function youtubeId(input){
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(s);
  if (m) return m[1];
  try {
    const u = new URL(s);
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
  } catch { /* pas une URL */ }
  return null;
}

export async function oembedMeta(id){
  try {
    const j = await fetchJSON('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), 8000);
    return { title: String(j.title || '').trim(), author: String(j.author_name || '').trim() };
  } catch { return null; }
}

async function fetchPipedPages(base, plId){
  const items = [];
  let nextpage = null;
  let complete = false;
  for (let page = 0; page < PLAYLIST_MAX_PAGES; page++){
    const url = nextpage
      ? `${base}/nextpage/playlists/${encodeURIComponent(plId)}?nextpage=${encodeURIComponent(nextpage)}`
      : `${base}/playlists/${encodeURIComponent(plId)}`;
    const j = await fetchJSON(url);
    const got = (j.relatedStreams || [])
      .map(s => ({
        id: vidFromUrl(s.url),
        title: s.title || '',
        author: s.uploaderName || '',
        thumb: s.thumbnail || '',
        duration: s.duration || 0,
      }))
      .filter(v => v.id);
    items.push(...got);
    nextpage = j.nextpage || null;
    if (!nextpage){ complete = true; break; }
    if (!got.length) break;
  }
  return { items, complete };
}

async function fetchViaPiped(plId){
  let best = { items: [], complete: false };
  for (const base of PIPED_INSTANCES){
    try {
      const got = await fetchPipedPages(base, plId);
      if (got.items.length > best.items.length) best = got;
      if (best.complete) break;
    } catch { /* instance suivante */ }
  }
  if (!best.items.length) throw new Error('piped : toutes les instances ont échoué');
  return best;
}

async function fetchViaInvidious(plId){
  for (const base of INVIDIOUS_INSTANCES){
    try {
      const j = await fetchJSON(`${base}/api/v1/playlists/${encodeURIComponent(plId)}`);
      const items = (j.videos || [])
        .map(v => ({
          id: v.videoId,
          title: v.title || '',
          author: v.author || '',
          thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
          duration: v.lengthSeconds || 0,
        }))
        .filter(v => v.id);
      if (items.length) return items;
    } catch { /* instance suivante */ }
  }
  throw new Error('invidious : toutes les instances ont échoué');
}

function unionVideos(a, b){
  const seen = new Set(a.map(v => v.id));
  for (const v of b) if (v.id && !seen.has(v.id)){ seen.add(v.id); a.push(v); }
  return a;
}

function dedupe(items){
  const seen = new Set();
  const out = [];
  for (const v of items){
    if (!v || !v.id || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

export async function fetchPlaylist(plId, log = () => {}){
  let items = [];
  let complete = false;
  try {
    const got = await fetchViaPiped(plId);
    items = got.items;
    complete = got.complete;
    log(`piped : ${items.length} titres${complete ? ' (playlist complète)' : ' (partiel)'}`);
  } catch (e){ log('piped indisponible : ' + e.message); }

  if (!complete || items.length < PLAYLIST_MIN_PLAUSIBLE){
    try {
      const alt = await fetchViaInvidious(plId);
      const before = items.length;
      items = unionVideos(items, alt);
      log(`invidious : +${items.length - before} titres`);
    } catch (e){ log('invidious indisponible : ' + e.message); }
  }

  items = dedupe(items);
  if (!items.length) throw new Error('playlist vide ou injoignable');
  log(`playlist ${plId} : ${items.length} titres retenus`);
  return items;
}

/* ============================================================ */

const EMPTY = () => ({
  cache: { music: { at: null, items: [] }, ads: { at: null, items: [] } },
  excluded: { music: [], ads: [] },
  added: { music: [], ads: [] },
  settings: { jingleEnabled: true, puboacvEnabled: true, puboacvWeight: config.puboacvWeight },
  updatedAt: null,
});

export class Library {
  constructor(store, { log = console.log } = {}){
    this.store = store;
    this.log = log;
  }

  async init(){
    const d = this.store.data;
    const base = EMPTY();
    d.cache = d.cache || base.cache;
    d.excluded = d.excluded || base.excluded;
    d.added = d.added || base.added;
    d.settings = { ...base.settings, ...(d.settings || {}) };
    for (const kind of ['music', 'ads']){
      d.cache[kind] = { at: d.cache[kind]?.at || null, items: Array.isArray(d.cache[kind]?.items) ? d.cache[kind].items : [] };
      if (!Array.isArray(d.excluded[kind])) d.excluded[kind] = [];
      if (!Array.isArray(d.added[kind])) d.added[kind] = [];
    }
    return d;
  }

  get settings(){ return this.store.data.settings; }
  get cachedAt(){ return { music: this.store.data.cache.music.at, ads: this.store.data.cache.ads.at }; }

  isExcluded(kind, id){ return (this.store.data.excluded[kind] || []).includes(id); }

  /* liste complète : cache + ajouts manuels + fichiers locaux, avec état activé */
  list(kind){
    const d = this.store.data;
    const items = [...d.cache[kind].items, ...d.added[kind]];
    if (kind === 'ads'){
      for (const a of LOCAL_ASSETS.ads){
        items.push({ id: a.id, title: a.title, author: 'Radio OACV', local: true, file: a.file, duration: 0 });
      }
    }
    return items.map(v => ({
      id: v.id,
      title: v.title || '',
      author: v.author || '',
      thumb: v.thumb || '',
      duration: v.duration || 0,
      local: !!v.local,
      file: v.file || null,
      source: v.local ? 'local' : (d.added[kind].some(a => a.id === v.id) ? 'manuel' : 'playlist'),
      enabled: kind === 'ads' && LOCAL_ASSETS.ads.some(a => a.id === v.id)
        ? !!d.settings[LOCAL_ASSETS.ads.find(a => a.id === v.id).setting]
        : !this.isExcluded(kind, v.id),
    }));
  }

  counts(){
    const music = this.list('music');
    const ads = this.list('ads');
    return {
      music: { total: music.length, enabled: music.filter(x => x.enabled).length },
      ads: { total: ads.length, enabled: ads.filter(x => x.enabled).length },
      cachedAt: this.cachedAt,
    };
  }

  stale(kind){
    const at = this.store.data.cache[kind].at;
    if (!at) return true;
    return Date.now() - new Date(at).getTime() > config.libraryTtlHours * 3600_000;
  }

  async refresh(kind, { force = false } = {}){
    if (!['music', 'ads'].includes(kind)) fail(400, 'type de banque inconnu');
    if (!force && !this.stale(kind)) return this.list(kind).length;
    const plId = config.playlists[kind];
    this.log(`[banque] chargement de la playlist ${kind}…`);
    const items = await fetchPlaylist(plId, m => this.log('[banque] ' + m));
    this.store.data.cache[kind] = { at: new Date().toISOString(), items };
    this.store.data.updatedAt = new Date().toISOString();
    await this.store.save();
    this.log(`[banque] ${kind} : ${items.length} titres en cache`);
    return items.length;
  }

  async refreshAll(){
    const out = {};
    for (const kind of ['music', 'ads']){
      try { out[kind] = await this.refresh(kind, { force: true }); }
      catch (e){ out[kind] = 0; this.log('[banque] échec ' + kind + ' : ' + e.message); }
    }
    return out;
  }

  async setEnabled(kind, id, enabled){
    if (!['music', 'ads'].includes(kind)) fail(400, 'type de banque inconnu');
    const local = LOCAL_ASSETS.ads.find(a => a.id === id);
    if (local && kind === 'ads'){
      this.store.data.settings[local.setting] = !!enabled;
    } else {
      const list = this.store.data.excluded[kind];
      const i = list.indexOf(id);
      if (enabled && i >= 0) list.splice(i, 1);
      if (!enabled && i < 0) list.push(id);
    }
    this.store.data.updatedAt = new Date().toISOString();
    await this.store.save();
    return this.list(kind).find(x => x.id === id) || null;
  }

  async add(kind, input){
    if (!['music', 'ads'].includes(kind)) fail(400, 'type de banque inconnu');
    const id = youtubeId(input);
    if (!id) fail(400, 'identifiant ou lien YouTube invalide');
    if (this.list(kind).some(v => v.id === id)) fail(409, 'ce titre est déjà dans la banque');
    const meta = await oembedMeta(id);
    const item = {
      id,
      title: meta?.title || '',
      author: meta?.author || '',
      thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      duration: 0,
      addedAt: new Date().toISOString(),
    };
    this.store.data.added[kind].push(item);
    /* si le titre était exclu, on le réactive */
    const ex = this.store.data.excluded[kind];
    const i = ex.indexOf(id);
    if (i >= 0) ex.splice(i, 1);
    this.store.data.updatedAt = new Date().toISOString();
    await this.store.save();
    return item;
  }

  async remove(kind, id){
    if (!['music', 'ads'].includes(kind)) fail(400, 'type de banque inconnu');
    const d = this.store.data;
    const before = d.added[kind].length;
    d.added[kind] = d.added[kind].filter(v => v.id !== id);
    d.excluded[kind] = d.excluded[kind].filter(x => x !== id);
    d.updatedAt = new Date().toISOString();
    await this.store.save();
    return d.added[kind].length !== before;
  }

  async setSettings(patch){
    const s = this.store.data.settings;
    if (patch.puboacvWeight != null){
      const w = parseInt(patch.puboacvWeight, 10);
      if (!Number.isFinite(w) || w < 1 || w > 100) fail(400, 'poids de la pub OACV invalide (1 à 100)');
      s.puboacvWeight = w;
    }
    if (patch.jingleEnabled != null) s.jingleEnabled = !!patch.jingleEnabled;
    if (patch.puboacvEnabled != null) s.puboacvEnabled = !!patch.puboacvEnabled;
    this.store.data.updatedAt = new Date().toISOString();
    await this.store.save();
    return s;
  }
}
