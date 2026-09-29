/* Lancer une interruption : maintenant ou apres le morceau en cours */
import { auth, body, fail, handle, isVideoId, newId, ok, readStudio, writeStudio } from "../_lib.js";

export default handle(async (req, res) => {
  if (req.method !== "POST") return ok(res, {});
  const a = auth();
  const session = a.require(req);
  a.checkCsrf(req);
  const b = body(req);
  const when = b.when === "after" ? "after" : "now";
  const st = await readStudio();
  st.interrupt = { id: newId("it"), active: true, when, requestedBy: session.sub, createdAt: new Date().toISOString() };
  await writeStudio(st);
  console.log("[studio] interruption (" + when + ") par " + session.sub);
  ok(res, st);
});
