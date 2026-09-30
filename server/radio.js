/* ============================================================
   ANTENNE PARTAGÉE — « ce qui passe en ce moment »
   Le navigateur ne tire plus sa propre rotation : il demande
   au serveur quel titre est en cours et à quel point, puis il
   se cale dessus. C'est ce qui transforme le site en radio :
   tous les auditeurs entendent la même chose, au même endroit.

   L'état est minuscule et sérialisable, ce qui permet de le
   garder soit dans un fichier JSON (serveur Node), soit dans
   Redis (fonctions Vercel), sans changer une ligne de logique.

     { v, seed, seededAt, renewAt, q, i, startedAt, override }

   * seed / seededAt  graine de la rotation en cours (melange reproductible)
   * q / i            file de titres déjà diffusés puis à venir ; q[i] joue
   * startedAt        instant de départ du titre q[i] dans l'antenne
   * override         titre imposé par le studio en cours de diffusion
   * renewAt          moment où l'antenne tire une nouvelle graine
   ============================================================ */

/* Durée de repli quand la playlist ne dit rien (3 min 30). */
export const FALLBACK_TRACK_SEC = 210;

/* L'antenne se renouvelle toutes les 6 h : au morceau suivant, jamais
   au milieu d'un titre, pour ne pas couper l'auditeur en plein milieu. */
const ROTATION_MS = 6 * 60 * 60 * 1000;

/* Combien de titres on garde en mémoire de part et d'autre du titre en cours. */
const Q_PLAYED = 20;
const Q_AHEAD = 24;

/* ---------- graine reproductible (mêmes algorithmes que le moteur client) ---------- */
export function hashSeed(str){
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++){
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- helpers sur la playlist ---------- */
const isUsable = v => v && typeof v.id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v.id);

export function trackOf(playlist, id){
  return playlist.find(v => v.id === id) || null;
}

/* Durée en millisecondes, avec repli si la playlist l'ignore. */
export function durationMs(v){
  const s = Number(v && v.duration);
  return (s > 20 ? s : FALLBACK_TRACK_SEC) * 1000;
}

/* ---------- construction / renouvellement de la rotation ---------- */

function newProgram(st, playlist, now){
  /* La graine dépend du jour : un serveur redémarré retrouve la même
     antenne, et le lendemain seulement elle change. */
  const day = Math.floor(now / 86400000);
  st.v = 1;
  st.seed = hashSeed('oacv-antenne:' + day);
  st.seededAt = now;
  st.renewAt = now + ROTATION_MS;
  st.q = [];
  st.i = 0;
  st.draw = 0;                  // curseur de tirage, pour rester reproductible
  st.startedAt = now;
  st.pausedAt = 0;
  st.override = null;
  st.seen = st.seen || {};
  fill(st, playlist);
  return st;
}

/* Un tirage par titre, toujours le même pour une graine donnée :
   deux serveurs, ou deux visiteurs, obtiennent donc la même antenne. */
function draw(st){
  /* st.draw peut manquer sur un état écrit par une version antérieure */
  const n = st.draw || 0;
  st.draw = n + 1;
  return mulberry32((st.seed + n * 2654435761) >>> 0);
}

/* On ne garde en mémoire qu'une petite fenêtre : 20 titres déjà diffusés
   (pour ne pas les repasser tout de suite) et 24 à venir. Sur une banque
   de plusieurs centaines de titres, inutile d'en promener 340 dans le
   fichier d'état. */
function fill(st, playlist){
  const bas = Math.max(0, st.i - Q_PLAYED);
  if (bas > 0){ st.q = st.q.slice(bas); st.i -= bas; }
  const pris = new Set(st.q);
  while (st.q.length < st.i + 1 + Q_AHEAD){
    const libres = playlist.filter(v => isUsable(v) && !pris.has(v.id));
    if (!libres.length) break;                  // banque épuisée : on repasse
    const id = libres[Math.floor(draw(st)() * libres.length)].id;
    st.q.push(id);
    pris.add(id);
  }
}

/* ---------- état courant ---------- */
function currentEntry(st, playlist){
  if (st.override && st.override.videoId) return trackOf(playlist, st.override.videoId);
  return trackOf(playlist, st.q[st.i]);
}

/* ---------- directives du studio ----------
   Le studio n'écrit jamais dans l'état de l'antenne : il écrit ses
   intentions, et c'est /api/radio/now qui les consomme au fil de l'eau.
   Comme ça Node et Vercel se comportent pareil, et il n'y a jamais
   deux endroits qui décident de ce qui passe. */
function consumeStudio(st, studio, playlist, now){
  if (!studio) return;
  if (studio.playNow && studio.playNow.id && st.seen.playNow !== studio.playNow.id){
    st.seen.playNow = studio.playNow.id;
    const v = trackOf(playlist, studio.playNow.videoId);
    if (v){
      st.override = { videoId: v.id, startedAt: now };
      return;                                  // on saute le titre en cours
    }
  }
  if (studio.playNext && studio.playNext.id && st.seen.playNext !== studio.playNext.id){
    st.seen.playNext = studio.playNext.id;
    if (isVideoIdOk(studio.playNext.videoId) && st.q[st.i] !== studio.playNext.videoId){
      st.q.splice(st.i + 1, 0, studio.playNext.videoId);
    }
  }
}

const isVideoIdOk = v => typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v);

/* ============================================================
   syncProgram — remet l'état à jour et renvoie ce qui passe.
   * st       état stocké (muté sur place)
   * playlist titres disponibles [{ id, title, author, thumb, duration }]
   * studio   directives du studio (playNow / playNext / interrupt), ou null
   * now      Date.now()
   * paused   true pendant une interruption : l'antenne est gelée
   ============================================================ */
export function syncProgram(st, playlist, studio, now = Date.now(), paused = false){
  if (!st || !Array.isArray(playlist) || !playlist.length) return null;

  if (!st.q || !st.q.length || typeof st.i !== 'number' || st.i < 0 || st.i >= st.q.length){
    newProgram(st, playlist, now);
  }
  st.seen = st.seen || {};

  /* Antenne déjà gelée par une interruption : on rend exactement la
     même image qu'au moment du gel. Rien ne doit avancer tant que le
     studio n'a pas repris la main. */
  if (paused && st.pausedAt){
    const fige = currentEntry(st, playlist);
    if (!fige) return null;
    return describe(st, playlist, fige, st.pausedAt, true);
  }

  /* Fin d'interruption : le morceau repart d'exactement où il s'était
     arrêté — comme le lecteur de l'auditeur, qui était en pause sur
     la même image. Sans ce recalage, l'antenne sauterait tous les
     titres passés pendant l'interruption. */
  if (!paused && st.pausedAt){
    const ecart = st.pausedAt - (st.override ? st.override.startedAt : st.startedAt);
    const depart = now - Math.max(0, ecart);
    if (st.override) st.override.startedAt = depart; else st.startedAt = depart;
    st.pausedAt = 0;
  }

  /* un titre imposé par le studio a une durée de vie : on ne le garde pas
     plus de 10 minutes, quoi qu'il arrive. */
  if (st.override && now - st.override.startedAt > 10 * 60 * 1000) st.override = null;
  if (st.override && !currentEntry(st, playlist)) st.override = null;

  consumeStudio(st, studio, playlist, now);

  /* le titre imposé s'est épuisé → on revient dans la rotation */
  if (st.override && !trackOf(playlist, st.override.videoId)) st.override = null;
  if (st.override){
    const v = trackOf(playlist, st.override.videoId);
    const el = now - st.override.startedAt;
    if (v && el >= durationMs(v)){
      /* on recale le départ de la rotation pour que le titre suivant
         parte à la fin exacte de celui-ci */
      st.startedAt = st.override.startedAt + el;
      st.override = null;
    }
  }

  if (!st.override){
    /* On rattrape le temps écoulé depuis le dernier appel : au lieu de
       repartir de zéro, on décale le départ du titre suivant. */
    let guard = 0;
    while (guard++ < 200){
      const cur = currentEntry(st, playlist);
      if (!cur){ newProgram(st, playlist, now); break; }
      const d = durationMs(cur);
      const el = now - st.startedAt;
      if (el < d) break;
      if (now >= st.renewAt){ newProgram(st, playlist, now); break; }
      st.startedAt += d;
      st.i++;
    }
    /* absence de toute demande pendant des heures : on repart d'une
       antenne neuve plutôt que de traverser toute la file. */
    if (guard >= 200) newProgram(st, playlist, now);
  }

  fill(st, playlist);

  let cur = currentEntry(st, playlist);
  if (!cur){ newProgram(st, playlist, now); cur = currentEntry(st, playlist); }
  if (!cur) return null;

  /* l'interruption gèle l'antenne : le morceau reprendra exactement où il
     en était. On note l'instant du gel, et l'horloge s'y arrête. */
  if (paused){
    st.pausedAt = now;
    return describe(st, playlist, cur, now, true);
  }
  st.pausedAt = 0;
  return describe(st, playlist, cur, now, false);
}

function describe(st, playlist, v, at, paused){
  const startedAt = st.override ? st.override.startedAt : st.startedAt;
  const duration = Math.round(durationMs(v) / 1000);
  const elapsed = Math.max(0, Math.min(duration, Math.round((at - startedAt) / 1000)));
  /* le titre d'après est annoncé avec : l'auditeur peut le préparer et
     enchaîner sans trou, exactement comme une vraie radio */
  const nxt = st.override ? null : trackOf(playlist, st.q[st.i + 1]);
  return {
    live: true,
    videoId: v.id,
    title: v.title || '',
    author: v.author || '',
    /* On impose l'URL YouTube directe : la playlist contient des
       proxys Piped, lents et qui tombent souvent. */
    thumb: 'https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg',
    duration,
    startedAt,
    elapsed,
    remaining: Math.max(0, duration - elapsed),
    paused: !!paused,
    next: nxt ? { videoId: nxt.id, title: nxt.title || '', author: nxt.author || '' } : null,
  };
}

/* ---------- titre illisible ---------- */
export function skipTrack(st, playlist, videoId, now = Date.now()){
  /* YouTube refuse certains titres (erreur 150). Quand un auditeur
     s'en aperçoit, il le signale et toute l'antenne passe au suivant :
     sans cela la station resterait bloquée sur un titre muet.
     On ne saute que le titre en cours, jamais un titre imposé par le
     studio, et jamais un titre qui n'est pas celui-là. */
  if (!st || !videoId || !Array.isArray(playlist) || !playlist.length) return false;
  if (st.override) return false;
  if (st.q[st.i] !== videoId) return false;
  st.i++;
  st.startedAt = now;
  st.pausedAt = 0;
  return true;
}

/* ---------- état vierge ---------- */
export function emptyProgram(){
  return { v: 1, seed: 0, seededAt: 0, renewAt: 0, q: [], i: 0, draw: 0, startedAt: 0, pausedAt: 0, override: null, seen: {} };
}
