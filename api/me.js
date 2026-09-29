/* Session courante + jeton CSRF (GET) — Vercel */
import { auth, handle, ok } from "./_lib.js";

export default handle(async (req, res) => {
  if (req.method !== "GET") return ok(res, { user: null });
  const csrf = auth().csrf(req, res);
  const session = auth().session(req);
  ok(res, { user: auth().publicUser(session), csrf });
});
