/* Directives d antenne — public, lecture seule.
   C est cette route que la page publique interroge toutes les 3 secondes. */
import { handle, ok, readStudio, studioDirectives } from "../_lib.js";

export default handle(async (req, res) => {
  const st = await readStudio();
  ok(res, studioDirectives(st));
});
