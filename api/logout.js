/* Deconnexion (POST) — Vercel */
import { auth, handle, ok } from "./_lib.js";

export default handle(async (req, res) => {
  if (req.method !== "POST") return ok(res, { ok: false });
  auth().logout(req, res);
  ok(res, { ok: true });
});
