/* Banque de titres (GET) — reservee aux comptes connectes.
   La playlist est telechargee une fois puis mise en cache dans le stockage
   partage : une fonction Vercel est sans etat, on ne peut pas la recharger
   a chaque appel (et le delai de 10 secondes du plan gratuit ne le permettrait pas). */
import { config } from "../../server/config.js";
import { fetchPlaylist } from "../../server/library.js";
import { auth, fail, handle, ok, redisGet, redisSet } from "../_lib.js";

const KEY = "radio-oacv:lib:music";
const TTL = Math.max(3600, config.libraryTtlHours * 3600);

async function titles(){
  const raw = await redisGet(KEY);
  if (raw){
    try { const d = JSON.parse(raw); if (Array.isArray(d.items) && d.items.length) return d; } catch {}
  }
  let items;
  try { items = await fetchPlaylist(config.playlists.music, m => console.log("[banque]", m)); }
  catch (e){ fail(502, "impossible de joindre la playlist : " + e.message); }
  const slim = items.map(v => ({ id: v.id, title: v.title || "", author: v.author || "", thumb: v.thumb || "", duration: v.duration || 0 }));
  const data = { at: new Date().toISOString(), items: slim };
  await redisSet(KEY, JSON.stringify(data), TTL);
  return data;
}

export default handle(async (req, res) => {
  if (req.method !== "GET") return ok(res, { items: [] });
  auth().require(req, "library");
  const url = new URL(req.url || "/", "http://x");
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(2000, parseInt(url.searchParams.get("limit") || "400", 10) || 400);
  const data = await titles();
  let items = data.items;
  if (q) items = items.filter(v => (v.title + " " + v.author).toLowerCase().includes(q));
  ok(res, { kind: "music", total: items.length, items: items.slice(0, limit), cachedAt: data.at });
});
