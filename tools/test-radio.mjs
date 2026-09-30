/* Test de l'antenne partagée (server/radio.js).
   Vérifie ce qui fait qu'une radio est une radio : tout le monde
   entend la même chose, on arrive au milieu du morceau, et le studio
   garde la main dessus.

   Lancement : npm test                                              */
import { syncProgram, skipTrack, emptyProgram } from '../server/radio.js';

const pl = Array.from({ length: 60 }, (_, i) => ({
  id: 'vid' + String(i).padStart(8, '0'),
  title: 'Titre ' + i,
  author: 'Artiste ' + i,
  duration: 200,
}));
const T0 = 1_700_000_000_000;

let ok = 0, ko = 0;
const vérifier = (nom, condition, détail = '') => {
  if (condition){ ok++; console.log('  ok    ' + nom); }
  else { ko++; console.log('  ÉCHEC ' + nom + (détail ? '  → ' + détail : '')); }
};

function antenne(now = T0, studio = null, paused = false){
  const st = emptyProgram();
  return { st, j: syncProgram(st, pl, studio, now, paused) };
}

/* ---- 1. tout le monde tombe sur la même antenne ---- */
console.log('\nAntenne partagée');
const a = antenne();
const b = antenne();
vérifier('deux visiteurs indépendants entendent le même titre', a.j.videoId === b.j.videoId);
vérifier('et le même ordre de rotation', a.st.q.slice(0, 10).join() === b.st.q.slice(0, 10).join());

/* ---- 2. on arrive au milieu du morceau, pas à zéro ---- */
console.log('\nArrivée en cours de morceau');
const st = emptyProgram();
syncProgram(st, pl, null, T0);
const a100 = syncProgram(st, pl, null, T0 + 100_000);
vérifier('le même morceau est lu 100 s plus tard', a100.videoId === st.q[0]);
vérifier('et l’auditeur est placé à 100 s', a100.elapsed === 100, 'elapsed=' + a100.elapsed);
const a250 = syncProgram(st, pl, null, T0 + 250_000);
vérifier('passé la durée, on enchaîne', a250.videoId !== st.q[0]);
vérifier('et on démarre le suivant à sa seconde 0', a250.elapsed === 50, 'elapsed=' + a250.elapsed);

/* ---- 3. rattraper une absence ---- */
console.log('\nAbsence prolongée');
const st3 = emptyProgram();
syncProgram(st3, pl, null, T0);
const tard = syncProgram(st3, pl, null, T0 + 3 * 3600_000);
vérifier('après 3 h sans appel, l’antenne est à jour', tard.elapsed < tard.duration, 'elapsed=' + tard.elapsed);
const st3b = emptyProgram();
syncProgram(st3b, pl, null, T0);
const tresTard = syncProgram(st3b, pl, null, T0 + 30 * 3600_000);
vérifier('après 30 h, elle repart proprement', tresTard.elapsed >= 0 && tresTard.elapsed < tresTard.duration);

/* La mémoire reste bornée, même sur une vraie banque de plusieurs
   centaines de titres : on ne garde que 20 diffusés et 24 à venir. */
const gros = Array.from({ length: 340 }, (_, i) => ({ id: 'g' + String(i).padStart(10, '0'), title: 'T' + i, author: 'A', duration: 200 }));
const stMem = emptyProgram();
syncProgram(stMem, gros, null, T0);
for (let i = 1; i <= 100; i++) syncProgram(stMem, gros, null, T0 + 200_000 * i);   // 5 h 33, avant renouvellement
vérifier('sur 340 titres, la file reste bornée', stMem.q.length <= 21 + 24, 'q=' + stMem.q.length);
vérifier('et l’index ne grossit pas', stMem.i <= 20, 'i=' + stMem.i);

/* ---- 4. pas deux fois le même titre à la suite ---- */
console.log('\nRotation');
const st4 = emptyProgram();
syncProgram(st4, pl, null, T0);
const vus = [];
for (let i = 0; i < 12; i++) vus.push(syncProgram(st4, pl, null, T0 + 200_000 * (i + 1)).videoId);
vérifier('douze titres de suite sans doublon', new Set(vus).size === 12, new Set(vus).size + ' distincts');

/* ---- 5. une interruption gèle le morceau ---- */
console.log('\nPilotage studio');
const st5 = emptyProgram();
syncProgram(st5, pl, null, T0);
syncProgram(st5, pl, null, T0 + 100_000);
const g1 = syncProgram(st5, pl, null, T0 + 110_000, true);
const g2 = syncProgram(st5, pl, null, T0 + 500_000, true);
vérifier('l’interruption gèle le morceau', g1.elapsed === g2.elapsed, g1.elapsed + ' puis ' + g2.elapsed);
vérifier('et le signale comme tel', g2.paused === true);
const r1 = syncProgram(st5, pl, null, T0 + 501_000);
vérifier('la reprise repart d’exactement où le gel s’est arrêté', r1.elapsed === g2.elapsed, r1.elapsed + ' au lieu de ' + g2.elapsed);
const r2 = syncProgram(st5, pl, null, T0 + 502_000);
vérifier('et l’antenne repart normalement ensuite', r2.elapsed === g2.elapsed + 1, r2.elapsed + ' au lieu de ' + (g2.elapsed + 1));

const st6 = emptyProgram();
syncProgram(st6, pl, null, T0);
const imp = syncProgram(st6, pl, { playNow: { id: 'pn1', videoId: pl[3].id } }, T0 + 1000);
vérifier('le studio peut imposer un titre', imp.videoId === pl[3].id);
const imp2 = syncProgram(st6, pl, { playNow: { id: 'pn1', videoId: pl[3].id } }, T0 + 2000);
vérifier('le même ordre n’est pas rejoué', imp2.elapsed > imp.elapsed, imp.elapsed + ' puis ' + imp2.elapsed);

const st7 = emptyProgram();
syncProgram(st7, pl, null, T0);
syncProgram(st7, pl, { playNext: { id: 'nx1', videoId: pl[7].id } }, T0 + 1000);
syncProgram(st7, pl, { playNext: { id: 'nx1', videoId: pl[7].id } }, T0 + 2000);
vérifier('le prochain titre est programmé une seule fois', st7.q[st7.i + 1] === pl[7].id && st7.q[st7.i + 2] !== pl[7].id);
const apres = syncProgram(st7, pl, null, T0 + 200_000);
vérifier('et il passe bien après le titre en cours', apres.videoId === pl[7].id, apres.videoId);

/* ---- 6. un titre illisible est sauté pour tout le monde ---- */
console.log('\nTitre illisible');
const st8 = emptyProgram();
const départ = syncProgram(st8, pl, null, T0);
vérifier('on ne saute que le titre en cours', skipTrack(st8, pl, pl[9].id, T0 + 1000) === false);
vérifier('le titre en cours est sauté', skipTrack(st8, pl, départ.videoId, T0 + 1000) === true);
const apres8 = syncProgram(st8, pl, null, T0 + 1000);
vérifier('et l’antenne passe au suivant', apres8.videoId !== départ.videoId);
vérifier('sans deux titres identiques à la suite', st8.q[st8.i] !== st8.q[st8.i - 1]);

const st9 = emptyProgram();
syncProgram(st9, pl, { playNow: { id: 'pn1', videoId: pl[3].id } }, T0);
vérifier('on ne saute jamais un titre imposé par le studio', skipTrack(st9, pl, pl[3].id, T0 + 1000) === false);

/* ---- 7. sans playlist, pas de radio — mais pas de plantage non plus ---- */
console.log('\nCas dégradés');
vérifier('playlist vide : pas de plantage', syncProgram(emptyProgram(), [], null, T0) === null);
vérifier('état corrompu : on repart d’une antenne neuve', syncProgram({ q: 'n’importe quoi' }, pl, null, T0).live === true);

console.log('\n' + ok + ' vérifications, ' + ko + ' échecs\n');
process.exit(ko ? 1 : 0);
