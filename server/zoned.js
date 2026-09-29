/* ============================================================
   Temps et fuseaux horaires — sans dépendance externe.
   Sert à la programmation : « tous les jours à 12h00 » doit sonner
   à 12h00 heure locale, y compris après un changement d'heure.
   ============================================================ */

const DOW = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const FORMATTERS = new Map();

function formatter(tz){
  let f = FORMATTERS.get(tz);
  if (!f){
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/* décompose un instant dans le fuseau demandé */
export function zonedParts(date, tz){
  const raw = {};
  for (const p of formatter(tz).formatToParts(new Date(date))) raw[p.type] = p.value;
  return {
    y: +raw.year, mo: +raw.month, d: +raw.day,
    h: (+raw.hour) % 24, mi: +raw.minute, s: +raw.second,
    dow: DOW[raw.weekday] || 1,
  };
}

export function zonedDateString(date, tz){
  const p = zonedParts(date, tz);
  return `${String(p.d).padStart(2, '0')}/${String(p.mo).padStart(2, '0')}/${p.y}`;
}

/* instant UTC correspondant à une heure « murale » du fuseau */
export function utcFromZoned(y, mo, d, h, mi, tz){
  const target = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  let ts = target;
  for (let i = 0; i < 4; i++){
    const p = zonedParts(new Date(ts), tz);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0, 0);
    const diff = target - seen;
    if (diff === 0) break;
    ts += diff;
  }
  return new Date(ts);
}

const DAY_MS = 86400000;
const addDays = (y, mo, d, n) => {
  const t = new Date(Date.UTC(y, mo - 1, d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() || 7 };
};

/* prochaine occurrence d'une heure quotidienne */
export function nextDailyAt(h, mi, tz, from = new Date()){
  const p = zonedParts(from, tz);
  let day = { y: p.y, mo: p.mo, d: p.d };
  for (let i = 0; i < 3; i++){
    const cand = utcFromZoned(day.y, day.mo, day.d, h, mi, tz);
    if (cand.getTime() > from.getTime() + 500) return cand;
    day = addDays(day.y, day.mo, day.d, 1);
  }
  return null;
}

/* prochaine occurrence hebdomadaire ; days = [1..7], 1 = lundi */
export function nextWeeklyAt(days, h, mi, tz, from = new Date()){
  const wanted = (days && days.length ? days : [1]).filter(d => d >= 1 && d <= 7);
  if (!wanted.length) return null;
  const p = zonedParts(from, tz);
  for (let i = 0; i <= 7; i++){
    const day = addDays(p.y, p.mo, p.d, i);
    if (!wanted.includes(day.dow)) continue;
    const cand = utcFromZoned(day.y, day.mo, day.d, h, mi, tz);
    if (cand.getTime() > from.getTime() + 500) return cand;
  }
  return null;
}

export function formatInZone(date, tz, opts = {}){
  return new Intl.DateTimeFormat('fr-FR', { timeZone: tz, ...opts }).format(new Date(date));
}
