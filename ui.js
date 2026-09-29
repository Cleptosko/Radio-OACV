/* ============================================================
   RADIO OACV — couche visuelle v2
   ------------------------------------------------------------
   LECTURE SEULE sur le moteur : cette couche ne modifie jamais
   S / planner / players, ne change aucune sélection de contenu
   et ne touche à aucun flux audio. Elle habille l'antenne,
   extrait la palette de la pochette et anime les transitions.

   Règle absolue : on ne fait qu'observer le moteur.
   ============================================================ */
'use strict';

const U = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const REDUCED  = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const FINE_PTR = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/* ---------- état moteur (lecture seule, tolérant aux erreurs) ---------- */
function eng(){
  try { return (typeof S !== 'undefined' && S) ? S : null; } catch(e){ return null; }
}
function engSeg(){
  const s = eng();
  return (s && s.currentSeg) ? s.currentSeg : null;
}
function engState(){
  const s = eng();
  return (s && s.state) ? s.state : 'idle';
}
/* position de lecture réelle — uniquement pour une musique (canal YouTube) */
function engTime(){
  const s = eng();
  if (!s || !s.active) return null;
  const ch = s.active;
  if (ch.type === 'yt' && ch.player){
    try { const t = ch.player.yt.getCurrentTime(); return (typeof t === 'number') ? t : null; } catch(e){ return null; }
  }
  return null; // publicités & jingles : pas de position mesurable
}

/* ---------- éléments ---------- */
const el = {
  body: document.body,
  layout: U('layout'),
  brandLogin: U('brand-login'),
  authOverlay: U('auth-overlay'),
  authClose: U('auth-close'),
  authForm: U('auth-form'),
  authEmail: U('auth-email'),
  authNote: U('auth-note'),
  onairLabel: U('onair-label'),
  onairTag: U('onair-tag'),
  onair: U('onair'),
  cover: U('cover'),
  cover3d: U('cover-3d'),
  coverFrame: document.querySelector('.cover-frame'),
  coverMain: U('cover-main'),
  coverPrev: U('cover-prev'),
  coverSpot: U('cover-spot'),
  coverSpotEmoji: U('cover-spot-emoji'),
  coverSpotLabel: U('cover-spot-label'),
  np: document.querySelector('.np'),
  npTitle: U('np-title'),
  npSub: U('np-sub'),
  vizWrap: document.querySelector('.viz-wrap'),
  bgLive: U('bg-live'),
  dust: U('dust'),
  viz: U('viz'),
};

const META = {
  music:  { tag: 'MUSIQUE',     onair: 'OACV — EN DIRECT' },
  ad:     { tag: 'PUBLICITÉ',   onair: 'OACV — PUBLICITÉ' },
  jingle: { tag: 'JINGLE OACV', onair: 'OACV — JINGLE' },
  idle:   { tag: 'MUSIQUE',     onair: 'OACV — EN DIRECT' },
};
const AD_EMOJI = ['📢','🚗','🍔','📱','🎧','💪','✈️','🍕','🏥','🛒','🔊'];
let spotEmoji = '📢';   // émoji du badge posé sur la pochette pendant une pub / un jingle

/* ============================================================
   1. PALETTE DYNAMIQUE
   ------------------------------------------------------------
   Trois couleurs de fond + deux accents, interpolées image par
   image. On garantit la lisibilité : les fonds restent très
   sombres, les accents restent clairs et saturés, le texte
   (blanc cassé) garde un contraste élevé.
   ============================================================ */
const hsl = (c, l2, a) => {
  const L = (l2 === undefined) ? c.l : l2;
  return 'hsl(' + c.h.toFixed(1) + ' ' + (c.s * 100).toFixed(1) + '% ' + (L * 100).toFixed(1) + '%'
       + (a === undefined ? '' : ' / ' + a) + ')';
};
const hueDist = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };
const lerpHue = (a, b, t) => {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return ((a + d * t) % 360 + 360) % 360;
};
function rgb2hsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d > 0){
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

/* palettes de repos (identité OACV) et palettes thématiques */
const PAL = {
  idle: { c1:{h:252,s:.70,l:.155}, c2:{h:288,s:.62,l:.145}, c3:{h:206,s:.66,l:.125},
          a1:{h:256,s:.86,l:.685}, a2:{h:288,s:.84,l:.655}, glow:{h:260,s:.85,l:.60} },
  ad:   { c1:{h:26,s:.62,l:.155},  c2:{h:12,s:.62,l:.135},  c3:{h:40,s:.50,l:.115},
          a1:{h:30,s:.92,l:.675},  a2:{h:13,s:.90,l:.635},  glow:{h:24,s:.90,l:.58} },
  jingle:{ c1:{h:176,s:.52,l:.125}, c2:{h:258,s:.55,l:.145}, c3:{h:198,s:.60,l:.115},
          a1:{h:174,s:.74,l:.655},  a2:{h:258,s:.86,l:.680}, glow:{h:178,s:.80,l:.575} },
  dark: { c1:{h:252,s:.28,l:.115}, c2:{h:286,s:.24,l:.10},  c3:{h:210,s:.26,l:.095},
          a1:{h:256,s:.62,l:.625},  a2:{h:290,s:.60,l:.585}, glow:{h:262,s:.60,l:.54} },
};
const clonePal = p => ({ c1:{...p.c1}, c2:{...p.c2}, c3:{...p.c3}, a1:{...p.a1}, a2:{...p.a2}, glow:{...p.glow} });

const Palette = {
  live: null,
  from: null,
  target: null,
  t: 0,
  dur: 1,
  keys: ['c1', 'c2', 'c3', 'a1', 'a2', 'glow'],
  last: {},          // cache des chaînes déjà écrites (évite de repeindre pour rien)

  init(){
    this.live = clonePal(PAL.idle);
    this.apply();
  },

  /* changement progressif : c'est le cœur de « l'interface se transforme » */
  set(pal, dur){
    if (!pal || this.live === null) { this.live = clonePal(pal || PAL.idle); this.apply(); return; }
    this.from = clonePal(this.live);
    this.target = clonePal(pal);
    this.t = 0;
    this.dur = Math.max(0.6, dur || 4);
  },

  is(other){ // la palette déjà appliquée correspond-elle à celle-ci ?
    if (!this.live || !other) return false;
    return this.keys.every(k => Math.abs(this.live[k].h - other[k].h) < 2
      && Math.abs(this.live[k].s - other[k].s) < 0.03
      && Math.abs(this.live[k].l - other[k].l) < 0.03);
  },

  frame(dt){
    if (!this.target) return;
    if (REDUCED) this.t = 1; else this.t = Math.min(1, this.t + dt / this.dur);
    const k = easeInOut(this.t);
    for (const key of this.keys){
      const a = this.from[key], b = this.target[key];
      this.live[key] = {
        h: lerpHue(a.h, b.h, k),
        s: lerp(a.s, b.s, k),
        l: lerp(a.l, b.l, k),
      };
    }
    this.apply();
    if (this.t >= 1) this.target = null;
  },

  apply(){
    const L = this.live;
    if (!L) return;
    const st = document.body.style;
    const vals = {
      '--c1': hsl(L.c1), '--c2': hsl(L.c2), '--c3': hsl(L.c3),
      '--c-a1': hsl(L.a1), '--c-a2': hsl(L.a2), '--c-glow': hsl(L.glow, Math.max(0.5, L.glow.l)),
      '--c-deep': hsl(L.c1, Math.max(0.028, L.c1.l * 0.30)),
    };
    for (const k in vals){
      if (this.last[k] !== vals[k]){ this.last[k] = vals[k]; st.setProperty(k, vals[k]); }
    }
  },

  /* couleurs prêtes pour le canvas */
  rgb(key, l2, a){
    const c = (this.live && this.live[key]) || PAL.idle[key];
    return hsl(c, l2, a);
  },
};

/* ---------- extraction des couleurs de la pochette ---------- */
function paletteFromPixels(d){
  const sectors = new Map();
  let total = 0, sumL = 0, colorful = 0;

  for (let i = 0; i < d.length; i += 4){
    if (d[i + 3] < 200) continue;
    total++; sumL += (d[i] + d[i+1] + d[i+2]) / 765;
    const c = rgb2hsl(d[i], d[i+1], d[i+2]);
    if (c.l < 0.07 || c.s < 0.13) continue;         // très sombre ou gris → ignoré
    const k = Math.min(19, Math.floor(c.h / 18));
    const w = c.s * (1 - Math.abs(c.l - 0.5) * 1.05);
    const b = sectors.get(k) || { h: k * 18 + 9, s: 0, l: 0, w: 0 };
    b.s += c.s * w; b.l += c.l * w; b.w += w;
    sectors.set(k, b);
    colorful += w;
  }

  const avgL = total ? sumL / total : 0.2;
  const list = [...sectors.values()].filter(b => b.w > 0.15)
    .map(b => ({ h: b.h, s: b.s / b.w, l: b.l / b.w, w: b.w }))
    .sort((a, b) => b.w - a.w);

  /* pochette sombre / monochrome → ambiance sombre adaptée (jamais de fond clair) */
  const poor = list.length === 0 || colorful < total * 0.045 || (list[0] && list[0].s < 0.2);
  if (poor){
    const base = list.length ? list[0] : { h: 252, s: 0.3, l: 0.2 };
    const p = clonePal(PAL.dark);
    const h = base.h;
    p.c1 = { h,                 s: clamp(base.s * 0.7, .18, .34), l: clamp(avgL * 0.42, .075, .14) };
    p.c2 = { h: (h + 28) % 360, s: clamp(base.s * 0.6, .16, .30), l: clamp(avgL * 0.36, .065, .125) };
    p.c3 = { h: (h + 200) % 360,s: clamp(base.s * 0.6, .16, .32), l: clamp(avgL * 0.33, .06, .115) };
    p.a1 = { h: (h + 6) % 360,  s: clamp(base.s + .28, .5, .78),  l: .665 };
    p.a2 = { h: (h + 44) % 360, s: clamp(base.s + .26, .48, .76), l: .625 };
    p.glow = { h: h, s: clamp(base.s + .2, .45, .7), l: .56 };
    return p;
  }

  /* 3 teintes bien distinctes */
  const picks = [];
  for (const b of list){
    if (picks.every(p => hueDist(p.h, b.h) > 42)) picks.push(b);
    if (picks.length === 3) break;
  }
  while (picks.length < 3){
    const last = picks[picks.length - 1] || list[0];
    picks.push({ h: (last.h + (picks.length === 1 ? 52 : 150)) % 360, s: Math.max(.25, last.s * 0.8), l: last.l, w: 1 });
  }

  const P = (h, s, l) => ({ h: ((h % 360) + 360) % 360, s: clamp(s, 0, 1), l: clamp(l, 0, 1) });
  const p = {
    c1: P(picks[0].h, clamp(picks[0].s * 0.95, .42, .84), clamp(picks[0].l * 0.34, .095, .185)),
    c2: P(picks[1].h, clamp(picks[1].s * 0.92, .38, .80), clamp(picks[1].l * 0.30, .085, .170)),
    c3: P(picks[2].h, clamp(picks[2].s * 0.92, .38, .82), clamp(picks[2].l * 0.28, .080, .160)),
    /* accents : toujours clairs et saturés pour rester lisibles sur fond sombre */
    a1: P(picks[0].h + 6, clamp(picks[0].s + .26, .66, .96), .685),
    a2: P(picks[1].h + 4, clamp(picks[1].s + .24, .62, .94), .645),
    glow: P(picks[0].h, clamp(picks[0].s + .18, .55, .92), .585),
  };
  /* deux accents trop proches → on écarte le second pour garder du relief */
  if (hueDist(p.a1.h, p.a2.h) < 34) p.a2.h = (p.a1.h + 46) % 360;
  return p;
}

/* repli déterministe : chaque morceau a son ambiance, même pochette inaccessible */
function hashPalette(seed){
  let h = 2166136261;
  const s = String(seed || 'oacv');
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const hue = ((h >>> 0) % 360);
  const P = (hh, s2, l) => ({ h: (hh % 360 + 360) % 360, s: s2, l });
  return {
    c1: P(hue, .64, .150),
    c2: P(hue + 40, .58, .135),
    c3: P(hue + 190, .60, .120),
    a1: P(hue + 6, .84, .685),
    a2: P(hue + 46, .82, .645),
    glow: P(hue, .80, .585),
  };
}

function sampleImage(url){
  return new Promise(resolve => {
    if (!url) return resolve(null);
    let done = false;
    const finish = p => { if (!done){ done = true; resolve(p); } };
    const to = setTimeout(() => finish(null), 7000);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      clearTimeout(to);
      try {
        const n = 30;
        const cv = document.createElement('canvas');
        cv.width = n; cv.height = n;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, n, n);
        finish(paletteFromPixels(cx.getImageData(0, 0, n, n).data));
      } catch(e){ finish(null); }   // canvas « teinté » (CORS) → repli déterministe
    };
    img.onerror = () => { clearTimeout(to); finish(null); };
    img.src = url;
  });
}

const ArtPalette = {
  cache: new Map(),
  async refine(video){
    const id = video && video.id;
    if (!id) return null;
    if (this.cache.has(id)) return this.cache.get(id);
    const url = video.thumb || ('https://i.ytimg.com/vi/' + id + '/mqdefault.jpg');
    const pal = await sampleImage(url);
    this.cache.set(id, pal);                       // null mémorisé : pas de nouvel essai
    if (this.cache.size > 90) this.cache.delete(this.cache.keys().next().value);
    return pal;
  },
};

/* ============================================================
   2. SOURIS — PARALLAXE ET INCLINAISON 3D
   ============================================================ */
const Pointer = {
  tx: 0, ty: 0, x: 0, y: 0,      // -1 → 1
  gx: .5, gy: .24,               // reflet sur la pochette
  enabled: FINE_PTR && !REDUCED,

  init(){
    if (!this.enabled) return;
    window.addEventListener('pointermove', e => {
      this.tx = (e.clientX / window.innerWidth) * 2 - 1;
      this.ty = (e.clientY / window.innerHeight) * 2 - 1;
      const r = el.cover ? el.cover.getBoundingClientRect() : null;
      if (r && r.width){
        this.gx = clamp((e.clientX - r.left) / r.width, 0, 1);
        this.gy = clamp((e.clientY - r.top) / r.height, 0, 1);
      }
    }, { passive: true });
  },

  frame(dt){
    if (!this.enabled) return;
    const k = Math.min(1, dt * 2.4);
    this.x = lerp(this.x, this.tx, k);
    this.y = lerp(this.y, this.ty, k);
    const st = document.body.style;
    st.setProperty('--mx', this.x.toFixed(3));
    st.setProperty('--my', this.y.toFixed(3));
    st.setProperty('--tx', (-this.y * 5.4).toFixed(2) + 'deg');
    st.setProperty('--ty', (this.x * 7.4).toFixed(2) + 'deg');
    st.setProperty('--gx', (48 + this.x * 26).toFixed(1) + '%');
    st.setProperty('--gy', (26 + this.y * 22).toFixed(1) + '%');
  },
};

/* ============================================================
   3. ÉNERGIE / RESPIRATION (pilotée par l'état réel du moteur)
   ============================================================ */
const Pulse = {
  e: 0,          // énergie lissée 0 → 1
  beat: 0,       // intensité du dernier « temps »
  next: 0.4,
  playing: false,

  frame(dt, state){
    this.playing = ['playing', 'starting', 'local'].includes(state);
    const k = Math.min(1, dt * 2.2);

    if (this.playing){
      /* battement procédural : le tempo n'est pas accessible (flux tiers),
         on garde donc une respiration crédible et variée */
      this.next -= dt;
      if (this.next <= 0){
        this.beat = 1;
        this.next = 0.82 + Math.random() * 1.5;
      }
      this.beat = Math.max(0, this.beat - dt * 2.6);
      const base = state === 'starting' ? 0.42 : state === 'local' ? 0.62 : 0.66;
      const target = clamp(base + this.beat * 0.34, 0, 1);
      this.e = lerp(this.e, target, Math.min(1, dt * 5));
    } else {
      this.beat = Math.max(0, this.beat - dt * 2.6);
      this.e = lerp(this.e, engState() === 'paused' ? 0.06 : 0.12, k);
    }

    const st = document.body.style;
    st.setProperty('--energy', this.e.toFixed(3));
  },
};




/* ---------- récupération réseau ---------- */
async function fetchJson(url, ms){
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms || 9000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    if (!txt) return null;
    return JSON.parse(txt);
  } finally { clearTimeout(to); }
}

/* ============================================================
   6. TRANSITIONS VISUELLES (règles strictes conservées)
   musique → musique : séquence complète et étagée
   musique → publicité : transition dédiée
   publicité → musique / publicité → publicité / jingle → … : aucune
   ============================================================ */
let coverTimer = null;
let seqTimers = [];

function clearSeq(){
  seqTimers.forEach(clearTimeout);
  seqTimers = [];
}
function at(ms, fn){ seqTimers.push(setTimeout(fn, ms)); }

function coverSwap(src, animate){
  if (!src) return;
  const current = el.coverMain.getAttribute('src');
  el.coverMain.classList.remove('swap-in');
  el.coverPrev.classList.remove('swap-out');

  el.body.dataset.hasart = '1';
  if (!animate || !current){
    el.coverMain.src = src;
    el.coverPrev.removeAttribute('src');
    return;
  }
  el.coverPrev.src = current;
  el.coverMain.src = src;

  const run = () => {
    el.coverPrev.classList.add('swap-out');
    el.coverMain.classList.add('swap-in');
    if (el.coverFrame){ el.coverFrame.classList.remove('sweep'); void el.coverFrame.offsetWidth; el.coverFrame.classList.add('sweep'); }
    clearTimeout(coverTimer);
    coverTimer = setTimeout(() => {
      el.coverPrev.classList.remove('swap-out');
      el.coverMain.classList.remove('swap-in');
      if (el.coverFrame) el.coverFrame.classList.remove('sweep');
    }, 1000);
  };
  if (el.coverMain.complete) run();
  else {
    el.coverMain.addEventListener('load', run, { once: true });
    setTimeout(() => { if (!el.coverMain.classList.contains('swap-in')) run(); }, 260);
  }
}

function showSpotCard(show, emoji, label){
  if (show){
    el.coverSpotEmoji.textContent = emoji || '📢';
    el.coverSpotLabel.textContent = label || 'PUBLICITÉ';
    el.coverSpot.classList.remove('hidden');
  } else {
    el.coverSpot.classList.add('hidden');
  }
}

function pulseCover(){
  el.cover.classList.remove('pulse');
  void el.cover.offsetWidth;
  el.cover.classList.add('pulse');
  setTimeout(() => el.cover.classList.remove('pulse'), 1100);
}

function restartAnim(node, cls, ms){
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
  setTimeout(() => node.classList.remove(cls), ms || 1200);
}

/* le visualiseur adopte la nouvelle palette : simple montée d'intensité,
   aucune nappe lumineuse (il reste un élément secondaire de la page) */
function recolorViz(){
  Viz.flash = 1;
}

/* ============================================================
   5 bis. MÉTADONNÉES AUTHENTIQUES DU MORCEAU
   ------------------------------------------------------------
   Les sources de playlist (Piped/Invidious) renvoient parfois le titre
   dans une AUTRE LANGUE que celle de la vidéo — constaté en direct :
   « TEMPLAR ASSASSIN (Assassin's Creed Music Video) » au lieu du vrai
   « NORMAN - ASSASSIN DES TEMPLIERS (ft Squeezie) 4K ». On interroge
   donc l'oEmbed YouTube pour le titre d'origine, et on ne reformule
   jamais rien : le texte affiché est exactement celui de la vidéo.
   ============================================================ */
const Meta = {
  cache: new Map(),
  inflight: new Map(),

  known(video){ return (video && this.cache.get(video.id)) || null; },

  async fetch(video){
    const id = video && video.id;
    if (!id) return null;
    if (this.cache.has(id)) return this.cache.get(id);
    if (this.inflight.has(id)) return this.inflight.get(id);

    const p = (async () => {
      try {
        const j = await fetchJson('https://noembed.com/embed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D' + id, 8000);
        const title = (j && typeof j.title === 'string') ? j.title.trim() : '';
        if (!title) return null;
        const info = { title, author: String(j.author_name || '').trim() };
        this.cache.set(id, info);
        if (this.cache.size > 220) this.cache.delete(this.cache.keys().next().value);
        return info;
      } catch(e){ return null; }
      finally { this.inflight.delete(id); }
    })();

    this.inflight.set(id, p);
    return p;
  },
};

/* « Artiste - Titre » → deux champs distincts. Aucune traduction,
   aucune invention : si aucun séparateur crédible n'existe, on garde
   le titre entier et le nom de la chaîne. */
function splitArtistTrack(full, fallbackArtist){
  const t = String(full || '').trim();
  for (const sep of [' - ', ' – ', ' — ', ' | ']){
    const i = t.indexOf(sep);
    if (i > 1 && i < t.length - 2){
      const a = t.slice(0, i).trim();
      const b = t.slice(i + sep.length).trim();
      if (b && a.length <= 42 && !/^(feat|ft)\.?\s/i.test(b)) return { artist: a, track: b };
    }
  }
  return { artist: String(fallbackArtist || '').trim(), track: t };
}

/* nom de canal → nom d'artiste (« X - Topic » désigne un canal automatique) */
const cleanAuthor = a => String(a || '').replace(/\s*-\s*Topic$/i, '').trim();

function displayMeta(video){
  const known = Meta.known(video) || {};
  const raw = known.title || (video && video.title) || '';
  const chaine = cleanAuthor(known.author || (video && video.author));
  const { artist, track } = splitArtistTrack(raw, chaine);
  return {
    title: clean(track) || clean(raw) || 'Titre en cours de chargement…',
    artist: artist || chaine || 'Playlist OACV',
    raw,
  };
}

function paintMeta(video){
  const info = displayMeta(video);
  el.npTitle.textContent = info.title;
  el.npSub.textContent = info.artist;
  if (el.body.dataset.kind === 'music') document.title = '▶ ' + info.title + ' — Radio OACV';
}

/* --- contenus --- */
function renderMusic(seg){
  const v = seg.video || {};
  // affichage immédiat avec les données de la playlist…
  paintMeta(v);
  // …puis corrigé dès que le titre d'origine de la vidéo est connu
  if (!Meta.known(v)){
    Meta.fetch(v).then(info => {
      if (!info) return;
      const cur = engSeg();
      if (!cur || cur.kind !== 'music' || !cur.video || cur.video.id !== v.id) return;
      paintMeta(v);
    });
  }
  // la pochette est gérée par la séquence de transition (pour ne pas la charger deux fois)
}

function renderAd(seg){
  const isOacv = seg.ad && seg.ad.type === 'oacv';
  const v = !isOacv ? (seg.ad && seg.ad.video) : null;
  const title = isOacv ? 'Pub OACV' : displayMeta(v).title;
  spotEmoji = isOacv ? '📻' : AD_EMOJI[Math.floor(Math.random() * AD_EMOJI.length)];
  el.npTitle.textContent = title || 'Publicité';
  el.npSub.textContent = 'Publicité — l\u2019antenne reprend dans un instant';
  document.title = '▶ Publicité — Radio OACV';

  if (v && !Meta.known(v)){
    Meta.fetch(v).then(info => {
      if (!info) return;
      const cur = engSeg();
      if (!cur || cur.kind !== 'ad' || !cur.ad || !cur.ad.video || cur.ad.video.id !== v.id) return;
      el.npTitle.textContent = displayMeta(v).title;
    });
  }
}

function renderJingle(){
  spotEmoji = '🎙️';
  el.npTitle.textContent = 'Jingle Radio OACV';
  el.npSub.textContent = 'Votre antenne, votre son';
  document.title = '▶ Jingle OACV — Radio OACV';
}

const clean = t => {
  try { return (typeof cleanTitle === 'function') ? cleanTitle(t) : String(t || ''); }
  catch(e){ return String(t || ''); }
};

/* purge : aucune transition ne doit hériter d'un effet résiduel */
function clearAnim(){
  clearSeq();
  if (el.coverFrame) el.coverFrame.classList.remove('leaving', 'sweep');
  if (el.cover3d) el.cover3d.classList.remove('leaving', 'arriving');
  if (el.np) el.np.classList.remove('anim-in');
  el.coverSpot.classList.remove('enter');
  el.cover.classList.remove('pulse');
  el.coverMain.classList.remove('swap-in');
  el.coverPrev.classList.remove('swap-out');
  clearTimeout(coverTimer);
}

/* --- palette du contenu en cours --- */
function applyContentPalette(kind, seg){
  if (kind === 'ad'){ Palette.set(PAL.ad, 3.6); return; }
  if (kind === 'jingle'){ Palette.set(PAL.jingle, 3.6); return; }
  const v = seg && seg.video;
  if (!v || !v.id){ Palette.set(PAL.idle, 4); return; }

  /* 1) teinte provisoire, déduite de la vidéo (immédiate, jamais de trou visuel) */
  Palette.set(hashPalette(v.id), 4.4);
  /* 2) palette réelle, extraite de la pochette — le fond se transforme en douceur */
  ArtPalette.refine(v).then(pal => {
    if (!pal) return;
    const cur = engSeg();
    if (!cur || cur.kind !== 'music' || !cur.video || cur.video.id !== v.id) return;
    Palette.set(pal, 5.2);
  });
}

/* --- cœur : appelé à chaque nouveau contenu --- */
function onSegment(seg, before){
  const kind = seg.kind;
  const prevKind = before.kind;
  const meta = META[kind] || META.idle;

  clearAnim();

  el.body.dataset.kind = kind;
  el.onairLabel.textContent = meta.onair;
  el.onairTag.textContent = meta.tag;

  if (kind === 'music'){
    renderMusic(seg);
  } else {
    if (kind === 'ad') renderAd(seg); else renderJingle();
    document.title = kind === 'ad' ? '▶ Publicité — Radio OACV' : '▶ Jingle OACV — Radio OACV';
  }

  /* ---- séquences visuelles ---- */
  if (prevKind === 'music' && kind === 'music'){
    /* 1 ancienne pochette sort → 2 nouvelles couleurs → 3 nouvelle pochette
       → 4 titre → 5 visualiseur */
    el.body.dataset.stage = 'changing';
    if (el.cover3d) el.cover3d.classList.add('leaving');
    showSpotCard(false);
    applyContentPalette('music', seg);

    at(600, () => {
      if (el.cover3d) el.cover3d.classList.remove('leaving');
      coverSwap(seg.video && seg.video.thumb, true);
      if (el.cover3d){
        el.cover3d.classList.remove('arriving');
        void el.cover3d.offsetWidth;
        el.cover3d.classList.add('arriving');
      }
      el.body.dataset.stage = 'arriving';
      pulseCover();
    });
    at(760, () => restartAnim(el.np, 'anim-in', 1100));
    at(900, () => recolorViz());
    at(1500, () => { el.body.dataset.stage = 'ready'; });
    /* les classes d'animation sont retirées une fois la séquence terminée :
       aucune transition résiduelle ne reste accrochée à la scène 3D */
    at(1900, () => {
      if (el.cover3d) el.cover3d.classList.remove('leaving', 'arriving');
      if (el.coverFrame) el.coverFrame.classList.remove('sweep');
    });
  } else if (prevKind === 'music' && kind === 'ad'){
    showSpotCard(false);
    if (el.coverFrame){
      el.coverFrame.classList.remove('leaving');
      void el.coverFrame.offsetWidth;
      el.coverFrame.classList.add('leaving');
      setTimeout(() => el.coverFrame.classList.remove('leaving'), 760);
    }
    at(360, () => {
      showSpotCard(true, spotEmoji, 'PUBLICITÉ');
      restartAnim(el.coverSpot, 'enter', 900);
      pulseCover();
    });
    applyContentPalette('ad', seg);
    el.body.dataset.stage = 'ad';
  } else {
    /* publicité → musique, publicité → publicité, jingle → … :
       apparition normale, sans effet de transition */
    if (kind === 'music'){
      coverSwap(seg.video && seg.video.thumb, false);
      showSpotCard(false);
      applyContentPalette('music', seg);
      restartAnim(el.np, 'anim-in', 1100);
      el.body.dataset.stage = 'arriving';
      at(140, () => { el.body.dataset.stage = 'ready'; });
    } else {
      showSpotCard(true, spotEmoji, kind === 'ad' ? 'PUBLICITÉ' : 'JINGLE');
      if (prevKind === 'music' && kind === 'jingle'){ /* jingle : apparition simple */ }
      applyContentPalette(kind, seg);
      el.body.dataset.stage = kind;
    }
  }
}

/* ---------- accroche du moteur (aucune logique modifiée) ---------- */
(function hookEngine(){
  const original = window.setStageUI;
  if (typeof original !== 'function') return;
  window.setStageUI = function(seg){
    const before = { kind: document.body.dataset.kind || 'idle' };
    original.apply(this, arguments);   // le moteur continue exactement comme avant
    try { onSegment(seg, before); } catch(e){ console.warn('[OACV ui]', e); }
  };
})();

/* ============================================================
   7. VISUALISEUR MULTI-COUCHES
   ------------------------------------------------------------
   1. halo de sol      2. barres miroir + reflet
   3. deux ondes        4. anneaux de battement
   5. poussières lumineuses
   Le tout teinté par la palette du morceau en cours.
   ============================================================ */
const Viz = {
  ctx: null, dpr: 1, w: 0, h: 0, contentW: 0,
  bars: [], count: 36,
  lastT: null, rate: 1, flash: 0,

  init(){
    const c = el.viz;
    if (!c) return;
    this.ctx = c.getContext('2d');
    this.count = window.innerWidth < 700 ? 24 : 36;
    this.bars = new Array(this.count).fill(0.08);
    this.resize();
    window.addEventListener('resize', () => {
      const n = window.innerWidth < 700 ? 24 : 36;
      if (n !== this.count){
        this.count = n;
        this.bars = new Array(n).fill(0.08);
      }
      this.resize();
    });
  },

  resize(){
    const c = el.viz;
    if (!c) return;
    const r = c.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(120, r.width);
    this.h = Math.max(18, r.height);
    c.width = Math.floor(this.w * this.dpr);
    c.height = Math.floor(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    /* la vague reste étroite et centrée : un trait, pas une bande pleine largeur */
    this.contentW = Math.min(this.w, window.innerWidth < 700 ? 210 : 272);
  },

  /* Réaction au son réellement disponible : on mesure la vitesse à laquelle
     la tête de lecture avance. Si le moteur n'avance plus (pause, blocage,
     démarrage), la vague retombe au lieu de faire semblant. */
  sense(dt, state){
    if (state === 'local'){                 // jingle / PubOACV : fichier local
      this.lastT = null;
      this.rate = lerp(this.rate, 0.85, Math.min(1, dt * 3));
      return;
    }
    const t = engTime();
    if (t == null){                         // aucun canal mesurable
      this.lastT = null;
      this.rate = lerp(this.rate, 0.35, Math.min(1, dt * 2.5));
      return;
    }
    if (this.lastT != null){
      const r = (t - this.lastT) / Math.max(dt, 0.001);
      if (r >= -0.05 && r <= 3) this.rate = lerp(this.rate, clamp(r, 0, 1.25), Math.min(1, dt * 2.5));
    }
    this.lastT = t;
  },

  draw(dt, time){
    const ctx = this.ctx;
    if (!ctx) return;
    const state = engState();
    this.sense(dt, state);
    this.flash = Math.max(0, this.flash - dt * 1.1);

    /* amplitude = énergie du moteur × vitesse réelle de lecture */
    const E = Pulse.e * clamp(this.rate, 0, 1.2);
    const W = this.w, H = this.h, mid = H / 2;
    const n = this.count;
    const slot = this.contentW / n;
    const bw = Math.max(1.3, slot * 0.4);            // barres très fines
    const maxH = Math.max(4, mid - 2.5);             // ~26 px de haut au total
    const x0 = (W - this.contentW) / 2;
    const t = time * (0.30 + 0.62 * this.rate);      // en pause, la vague se fige

    ctx.clearRect(0, 0, W, H);

    /* simple ligne d'axe, à peine perceptible */
    ctx.strokeStyle = Palette.rgb('a1', undefined, 0.06 + E * 0.10);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, mid + 0.5);
    ctx.lineTo(x0 + this.contentW, mid + 0.5);
    ctx.stroke();

    const grad = ctx.createLinearGradient(0, mid - maxH, 0, mid + maxH);
    grad.addColorStop(0, Palette.rgb('a2', undefined, 0.88));
    grad.addColorStop(0.5, Palette.rgb('a1', undefined, 0.98));
    grad.addColorStop(1, Palette.rgb('a2', undefined, 0.88));

    ctx.save();
    ctx.shadowColor = Palette.rgb('a1', undefined, 0.30 + this.flash * 0.35);
    ctx.shadowBlur = 4 + this.flash * 5;             // glow très léger
    ctx.fillStyle = grad;

    for (let i = 0; i < n; i++){
      const u = n > 1 ? i / (n - 1) : 0.5;
      const env = Math.pow(Math.sin(Math.PI * u), 0.72);   // ··▂▃▅▇▅▃▂··
      const s1 = Math.abs(Math.sin(t * 2.2 + i * 0.54));
      const s2 = Math.abs(Math.sin(t * 3.6 - i * 0.29 + 1.7));
      const s3 = Math.sin(t * 1.15 + i * 0.11) * 0.5 + 0.5;
      const shape = 0.42 * s1 + 0.32 * s2 + 0.26 * s3;
      const target = clamp(E * env * (0.16 + shape * 0.92), 0.035, 1);
      const prev = this.bars[i];
      this.bars[i] = prev + (target - prev) * Math.min(1, dt * (target > prev ? 12 : 6.5));

      const hh = Math.max(0.7, this.bars[i] * maxH);
      const x = x0 + i * slot + slot / 2;
      ctx.globalAlpha = 0.5 + this.bars[i] * 0.5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - bw / 2, mid - hh, bw, hh * 2, bw / 2);
      else ctx.rect(x - bw / 2, mid - hh, bw, hh * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },
};

/* ============================================================
   8. POUSSIÈRE DU FOND + BOUCLE D'ANIMATION
   ============================================================ */
function makeDust(){
  if (!el.dust) return;
  const n = window.innerWidth < 640 ? 12 : 22;
  let html = '';
  for (let i = 0; i < n; i++){
    const left = Math.round(Math.random() * 100);
    const top = Math.round(60 + Math.random() * 50);
    const dur = (22 + Math.random() * 28).toFixed(1);
    const delay = (-Math.random() * 30).toFixed(1);
    const size = (1 + Math.random() * 2.2).toFixed(1);
    html += '<i style="left:' + left + '%;top:' + top + '%;width:' + size + 'px;height:' + size + 'px;animation-duration:' + dur + 's;animation-delay:' + delay + 's"></i>';
  }
  el.dust.innerHTML = html;
}

let lastFrame = performance.now();
function frame(now){
  const dt = Math.min(0.06, (now - lastFrame) / 1000) || 0.016;
  lastFrame = now;
  const time = now / 1000;

  const state = engState();
  const playing = ['playing', 'starting', 'local'].includes(state) ? '1' : '0';
  if (el.body.dataset.playing !== playing) el.body.dataset.playing = playing;

  try { Palette.frame(dt); } catch(e){}
  try { Pointer.frame(dt); } catch(e){}
  try { Pulse.frame(dt, state); } catch(e){}
  try { Viz.draw(dt, time); } catch(e){}

  requestAnimationFrame(frame);
}

/* ============================================================
   8 bis. FENÊTRE DE CONNEXION (affichage seul)
   ------------------------------------------------------------
   Demandée pour l'instant en affichage pur : elle ne fait AUCUNE
   requête et ne crée aucun compte — le bouton le dit clairement.
   Elle s'ouvre au clic sur le logo, par-dessus la radio : la
   musique ne s'arrête pas.
   ============================================================ */
const Auth = {
  open(){
    if (!el.authOverlay || !el.authOverlay.classList.contains('hidden')) return;
    el.authOverlay.classList.remove('hidden');
    el.body.classList.add('auth-open');
    /* le curseur se pose directement dans le premier champ */
    if (el.authEmail) setTimeout(() => el.authEmail.focus(), 60);
  },

  close(){
    if (!el.authOverlay || el.authOverlay.classList.contains('hidden')) return;
    el.authOverlay.classList.add('hidden');
    el.body.classList.remove('auth-open');
    if (el.authNote) el.authNote.classList.remove('show');
    if (el.brandLogin) el.brandLogin.focus();
  },

  init(){
    if (!el.authOverlay) return;
    if (el.brandLogin) el.brandLogin.addEventListener('click', () => this.open());
    if (el.authClose) el.authClose.addEventListener('click', () => this.close());
    /* clic sur le fond sombre : on ferme */
    el.authOverlay.addEventListener('click', e => { if (e.target === el.authOverlay) this.close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
    if (el.authForm){
      el.authForm.addEventListener("submit", async e => {
        e.preventDefault();
        /* avec le serveur complet : vraie connexion puis bascule au studio ;
           sans serveur : simple information, aucune requête n'aboutit */
        const email = el.authEmail ? el.authEmail.value.trim() : "";
        const pass = document.getElementById("auth-password");
        try {
          const r = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ email, password: pass ? pass.value : "" }),
          });
          if (r.ok){ window.location.href = "/studio"; return; }
        } catch(err){ /* pas de serveur : on reste sur le message */ }
        if (el.authNote) el.authNote.classList.add("show");
        if (el.authEmail) el.authEmail.focus();
      });
    }
  },
};

/* ============================================================
   9. INITIALISATION
   ============================================================ */
function init(){
  Palette.init();
  Pointer.init();

  el.coverSpot.removeAttribute('hidden');
  showSpotCard(false);
  el.body.dataset.hasart = el.coverMain.getAttribute('src') ? '1' : '0';
  el.body.dataset.kind = 'idle';
  el.body.dataset.playing = '0';
  el.onairLabel.textContent = META.idle.onair;
  el.onairTag.textContent = META.idle.tag;

  Auth.init();
  makeDust();
  Viz.init();
  requestAnimationFrame(frame);

  /* si la radio tourne déjà quand la couche visuelle arrive */
  const seg = engSeg();
  if (seg) onSegment(seg, { kind: 'idle' });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
