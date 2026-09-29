/* Effacer les directives en attente (POST) */
import { auth, body, fail, handle, isVideoId, newId, ok, readStudio, writeStudio } from "../_lib.js";

export default handle(async (req, res) => {
  if (req.method !== "POST") return ok(res, {});
  const a = auth();
  const session = a.require(req);
  a.checkCsrf(req);
  const st = await readStudio();
  st.playNow = null;
  st.playNext = null;
  await writeStudio(st);
  console.log("[studio] directives effacees par " + session.sub);
  ok(res, st);
});
