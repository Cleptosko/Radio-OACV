/* Banque de titres partagée entre la recherche du studio et l'antenne
   publique. Une fonction Vercel est sans état : on met donc la playlist
   complète en cache dans Redis, et les deux appelants se resservent du
   même cache plutôt que de retélécharger 338 titres à chaque appel.

   L'antenne est publique : si la banque est injoignable, on rend la main
   tout de suite pour que le site bascule sur sa rotation autonome. */
import { config } from "../server/config.js";
import { fetchPlaylist } from "../server/library.js";
import { redisGet, redisSet } from "./_lib.js";

const KEY = "radio-oacv:lib:music";
const TTL = Math.max(3600, config.libraryTtlHours * 3600);

/* durée maximale de construction de la banque, pour ne pas laisser un
   appelant attendre indéfiniment un monde de Piped qui ne répond pas */
const BUILD_MS = 25000;

export async function musicTitles({ allowBuild = true } = {}){
  const raw = await redisGet(KEY);
  if (raw){
    try {
      const d = JSON.parse(raw);
      if (Array.isArray(d.items) && d.items.length) return d;
    } catch { /* cache abímé : on le refait */ }
  }
  if (!allowBuild) return null;

  let items;
  try {
    items = await fetchPlaylist(config.playlists.music, m => console.log("[banque]", m));
  } catch (e){
    console.error("[banque] playlist injoignable :", e.message);
    return null;
  }
  const slim = items.map(v => ({ id: v.id, title: v.title || "", author: v.author || "", thumb: v.thumb || "", duration: v.duration || 0 }));
  const data = { at: new Date().toISOString(), items: slim };
  await redisSet(KEY, JSON.stringify(data), TTL);
  return data;
}

/* avec un garde-fou : une construction trop lente vaut mieux un échec que
   de faire tomber la requête qui attend le direct */
export function withDeadline(promise){
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done){ done = true; resolve(v); } };
    const t = setTimeout(() => finish(null), BUILD_MS);
    promise.then(v => { clearTimeout(t); finish(v); }, () => { clearTimeout(t); finish(null); });
  });
}
