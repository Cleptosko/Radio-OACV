/* ============================================================
   Programmation des interventions.
   Modes :
     now         → dès que possible (prochaine insertion)
     after_music → à la fin de la musique en cours
     once        → date et heure précises, une seule fois
     daily       → tous les jours à HH:MM
     weekly      → certains jours de la semaine à HH:MM
   ============================================================ */
import { nextDailyAt, nextWeeklyAt, utcFromZoned, formatInZone } from './zoned.js';

export const MODES = ['now', 'after_music', 'once', 'daily', 'weekly'];
const DAY_NAMES = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export function parseHHMM(v){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return { h, mi, text: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}

export function normaliseDays(v){
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [...new Set(arr.map(x => parseInt(x, 10)).filter(n => n >= 1 && n <= 7))];
  return out.sort((a, b) => a - b);
}

/* heure locale saisie (2026-09-30T13:00) → instant, dans le fuseau de la radio */
export function instantFromLocal(local, tz){
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(local || '').trim());
  if (m) return utcFromZoned(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
  const d = new Date(local);
  return isNaN(d) ? null : d;
}

export function computeNextRun(item, { tz, from = new Date() } = {}){
  const now = from instanceof Date ? from : new Date(from);
  switch (item.mode){
    case 'now':
    case 'after_music':
      return null;                               // pris en charge par la file d'insertion
    case 'once': {
      const at = item.at ? new Date(item.at) : null;
      if (!at || isNaN(at)) return null;
      return at.getTime() > now.getTime() ? at : null;
    }
    case 'daily': {
      const hm = parseHHMM(item.time);
      return hm ? nextDailyAt(hm.h, hm.mi, tz, now) : null;
    }
    case 'weekly': {
      const hm = parseHHMM(item.time);
      const days = normaliseDays(item.days);
      return hm && days.length ? nextWeeklyAt(days, hm.h, hm.mi, tz, now) : null;
    }
    default:
      return null;
  }
}

export function describe(item, tz){
  switch (item.mode){
    case 'now': return 'Dès que possible';
    case 'after_music': return 'À la fin de la musique en cours';
    case 'once': {
      const at = item.at ? new Date(item.at) : null;
      if (!at || isNaN(at)) return 'Date à préciser';
      return 'Le ' + formatInZone(at, tz, { dateStyle: 'full', timeStyle: 'short' });
    }
    case 'daily': {
      const hm = parseHHMM(item.time);
      return 'Tous les jours à ' + (hm ? hm.text : '??:??');
    }
    case 'weekly': {
      const hm = parseHHMM(item.time);
      const days = normaliseDays(item.days).map(d => DAY_NAMES[d]).join(', ');
      return (days ? days[0].toUpperCase() + days.slice(1) : 'Chaque semaine') + ' à ' + (hm ? hm.text : '??:??');
    }
    default: return '—';
  }
}

/* met à jour « prochaine diffusion » de toute la liste */
export function refresh(list, { tz, from = new Date() } = {}){
  for (const item of list){
    item.nextRunAt = item.enabled ? (computeNextRun(item, { tz, from })?.toISOString() ?? null) : null;
  }
  return list;
}

/* éléments dont l'heure est arrivée */
export function due(list, now = new Date()){
  const t = (now instanceof Date ? now : new Date(now)).getTime();
  return list.filter(it => it.enabled && it.nextRunAt && new Date(it.nextRunAt).getTime() <= t);
}

/* après un passage à l'antenne : les modes ponctuels se désactivent */
export function markFired(item, when = new Date(), tz = 'Europe/Paris'){
  item.lastRunAt = when.toISOString();
  if (item.mode === 'once' || item.mode === 'now' || item.mode === 'after_music') item.enabled = false;
  item.nextRunAt = item.enabled ? (computeNextRun(item, { tz, from: when })?.toISOString() ?? null) : null;
  return item;
}

export function validate(item, tz){
  if (!MODES.includes(item.mode)) throw new Error('mode de programmation inconnu');
  if (item.mode === 'once'){
    const at = item.at ? new Date(item.at) : null;
    if (!at || isNaN(at)) throw new Error('date invalide pour une diffusion ponctuelle');
  }
  if (item.mode === 'daily' && !parseHHMM(item.time)) throw new Error('heure invalide (format attendu 12:00)');
  if (item.mode === 'weekly'){
    if (!parseHHMM(item.time)) throw new Error('heure invalide (format attendu 08:30)');
    if (!normaliseDays(item.days).length) throw new Error('choisissez au moins un jour de la semaine');
  }
  return true;
}
