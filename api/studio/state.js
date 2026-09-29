/* Etat complet du studio (GET) — reserve aux comptes connectes */
import { auth, handle, ok, readStudio } from "../_lib.js";

export default handle(async (req, res) => {
  if (req.method !== "GET") return ok(res, { error: "methode non autorisee" });
  auth().require(req);
  ok(res, await readStudio());
});
