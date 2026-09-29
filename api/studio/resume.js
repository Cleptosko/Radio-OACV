/* Reprendre l antenne apres une interruption (POST) */
import { auth, body, fail, handle, isVideoId, newId, ok, readStudio, writeStudio } from "../_lib.js";

export default handle(async (req, res) => {
  if (req.method !== "POST") return ok(res, {});
  const a = auth();
  const session = a.require(req);
  a.checkCsrf(req);
  const st = await readStudio();
  if (!st.interrupt) return ok(res, st);
  st.interrupt.active = false;
  st.interrupt.resumedBy = session.sub;
  st.interrupt.resumedAt = new Date().toISOString();
  await writeStudio(st);
  console.log("[studio] reprise par " + session.sub);
  ok(res, st);
});
