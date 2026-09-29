/* Choisir le prochain morceau, ou l annuler (POST) */
import { auth, body, fail, handle, isVideoId, newId, ok, readStudio, writeStudio } from "../_lib.js";

export default handle(async (req, res) => {
  if (req.method !== "POST") return ok(res, {});
  const a = auth();
  const session = a.require(req);
  a.checkCsrf(req);
  const b = body(req);
  const vid = String(b.videoId || "").trim();
  if (vid && !isVideoId(vid)) fail(400, "identifiant YouTube invalide");
  const st = await readStudio();
  st.playNext = vid ? {
    id: newId("pn"),
    videoId: vid,
    title: String(b.title || "").slice(0, 200) || null,
    author: String(b.author || "").slice(0, 200) || null,
    requestedBy: session.sub,
    createdAt: new Date().toISOString(),
  } : null;
  await writeStudio(st);
  console.log("[studio] prochain morceau par " + session.sub + " : " + (vid || "(annule)"));
  ok(res, st);
});
