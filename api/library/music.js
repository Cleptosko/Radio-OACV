/* Banque de titres (GET) — reservee aux comptes connectes.
   La playlist est telechargee une fois puis mise en cache dans le stockage
   partage (voir api/_titles.js, utilise aussi par l'antenne publique). */
import { auth, handle, ok } from "../_lib.js";
import { musicTitles } from "../_titles.js";

export default handle(async (req, res) => {
  if (req.method !== "GET") return ok(res, { items: [] });
  auth().require(req, "library");
  const url = new URL(req.url || "/", "http://x");
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(2000, parseInt(url.searchParams.get("limit") || "400", 10) || 400);
  const data = await musicTitles();
  if (!data) return ok(res, { items: [], total: 0, cachedAt: null });
  let items = data.items;
  if (q) items = items.filter(v => (v.title + " " + v.author).toLowerCase().includes(q));
  ok(res, { kind: "music", total: items.length, items: items.slice(0, limit), cachedAt: data.at });
});
