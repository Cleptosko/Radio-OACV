/* Connexion d administration (POST) — Vercel */
import { auth, body, handle, ok } from "./_lib.js";

export default handle(async (req, res) => {
  if (req.method !== "POST") return ok(res, { ok: false });
  const b = body(req);
  const payload = await auth().login(req, res, b.email, b.password);
  const csrf = auth().csrf(req, res);
  ok(res, { user: auth().publicUser(payload), csrf });
});
