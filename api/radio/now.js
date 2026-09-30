/* Antenne partagée — « ce qui passe en ce moment ».
   C'est ce point qui fait la radio : le serveur détient la rotation et
   l'instant de départ du titre en cours, le navigateur se cale dessus.
   Tous les auditeurs entendent donc la meme chose, et celui qui ouvre
   la page arrive au milieu du morceau plutot qu'a zero.

   Deux gestes, une seule fonction :

     GET  /api/radio/now              ce qui passe, et a quel point
     POST /api/radio/now  { videoId } ce titre est illisible, passe au suivant

   (Le plan gratuit de Vercel limite le nombre de fonctions par
   deploiement : on regroupe donc ici ce qui concerne l'antenne.) */
import { syncProgram, skipTrack, emptyProgram } from "../../server/radio.js";
import { body, fail, handle, ok, redisGet, redisSet, readStudio } from "../_lib.js";
import { musicTitles, withDeadline } from "../_titles.js";

const KEY = "radio-oacv:radio";
/* L'etat d'antenne survit a une longue absence d'auditeurs : pas de TTL court. */
const TTL = 60 * 60 * 24 * 30;

export default handle(async (req, res) => {
  const titles = await bank();
  if (!titles) return ok(res, { live: false });
  const items = titles.items;

  /* ---------- un titre que YouTube refuse ---------- */
  if (req.method === "POST"){
    const videoId = String(body(req).videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return fail(400, "identifiant YouTube invalide");
    const st = readProgram(await redisGet(KEY));
    if (!skipTrack(st, items, videoId, Date.now())) return ok(res, { ok: true, skipped: false });
    await redisSet(KEY, JSON.stringify(st), TTL);
    console.log("[radio] titre saute (illisible pour un auditeur) :", videoId);
    const dir = await readStudio();
    const now = syncProgram(st, items, dir, Date.now(), !!(dir.interrupt && dir.interrupt.active));
    return ok(res, { ok: true, skipped: true, now: now || null });
  }
  if (req.method !== "GET") return fail(405, "méthode non autorisée");

  /* ---------- ce qui passe en ce moment ---------- */
  const st = readProgram(await redisGet(KEY));
  const dir = await readStudio();
  const before = sig(st);
  const now = syncProgram(st, items, dir, Date.now(), !!(dir.interrupt && dir.interrupt.active));
  if (sig(st) !== before) await redisSet(KEY, JSON.stringify(st), TTL);
  if (!now) return ok(res, { live: false });
  ok(res, now);
});

/* La banque de titres est partagee avec la recherche du studio. On lit
   d'abord le cache ; si la playlist n'a jamais ete telechargee, on
   tente de la construire sans bloquer plus de 25 s. Au pire, le site
   retombe sur sa rotation autonome. */
async function bank(){
  return (await musicTitles({ allowBuild: false })) || await withDeadline(musicTitles());
}

function readProgram(raw){
  if (!raw) return emptyProgram();
  try {
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.q)) return { ...emptyProgram(), ...d };
  } catch { /* etat abime : on repart d'une antenne neuve */ }
  return emptyProgram();
}

/* Ce qui merite d'etre ecrit : un changement de titre, un gel, une
   directive du studio. Juste consulter ne coute rien. */
const sig = st => [st.i, st.startedAt, st.pausedAt, st.override && st.override.videoId].join("|");
