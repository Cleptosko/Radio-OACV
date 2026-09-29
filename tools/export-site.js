#!/usr/bin/env node
/* ============================================================
   RADIO OACV — export du site public pour l'hébergement

   Copie vers ../radio-site/ exactement ce que voit un visiteur :
   la page, sa feuille de style, ses deux scripts, le logo et les
   deux pistes audio (jingle et pub maison, utilisées par app.js).

   Le code du serveur n'est JAMAIS copié. Le dossier exporté est
   autonome : c'est le dépôt GitHub du site public, publié par
   GitHub Pages sur https://firtoks.github.io/radio-oacv/
   Le dépôt git déjà présent dans le dossier de destination est conservé.

   Utilisation :
     npm run export                              (vers ../radio-site)
     node tools/export-site.js --out <dossier>   (ailleurs)
   ============================================================ */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/* Les seuls fichiers publics. Tout le reste — serveur, outils, .env,
   annonces enregistrées — reste sur la machine. */
const PUBLIC_FILES = ['index.html', 'style.css', 'app.js', 'ui.js'];
const PUBLIC_DIRS  = ['assets', 'audio'];

/* Garde-fou : si cette liste était étendue par mégarde à un fichier
   sensible, l'export s'arrête ici. */
const FORBIDDEN = /^(\.|\.env|data|server|tools|node_modules)/;

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, '..', 'radio-site'));

function check(name){
  if (FORBIDDEN.test(name)) throw new Error(`refus d'exporter « ${name} » : ce n'est pas un fichier public`);
}

function human(bytes){
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function sizeOf(target){
  const st = statSync(target);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })){
    total += sizeOf(path.join(target, entry.name));
  }
  return total;
}

/* Vide le dossier de sortie SANS toucher au dépôt git qu'il contient.
   Supprimer tout le dossier reviendrait à effacer l'historique et le
   dépôt distant serait perdu ; on ne nettoie donc que le contenu
   réellement exporté. */
function cleanOutput(dir, keep = new Set(['.git'])){
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })){
    if (keep.has(entry.name)) continue;
    rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function main(){
  console.log('');
  console.log('  ==========================================================');
  console.log('     RADIO OACV — export du site public');
  console.log('  ==========================================================');

  const wanted = [...PUBLIC_FILES, ...PUBLIC_DIRS];
  for (const name of wanted){
    if (!existsSync(path.join(ROOT, name))) throw new Error(`fichier manquant dans le projet : ${name}`);
    check(name);
  }

  console.log(`\n  Destination : ${OUT}`);
  cleanOutput(OUT);
  mkdirSync(OUT, { recursive: true });

  for (const name of wanted){
    cpSync(path.join(ROOT, name), path.join(OUT, name), { recursive: true });
  }

  /* Configuration d'hébergement, recopiée à chaque export pour rester
     cohérente avec ce qui est réellement déployé. */
  for (const name of ['netlify.toml', '_headers', '.gitattributes', 'README.md']){
    const from = path.join(ROOT, 'deploy', name);
    if (existsSync(from)) cpSync(from, path.join(OUT, name));
  }
  writeFileSync(path.join(OUT, '.gitignore'), '.DS_Store\nThumbs.db\n', 'utf8');

  console.log(`  ${wanted.length} entrées copiées (${human(sizeOf(OUT))})`);
  console.log('  Aucun secret, aucune donnée, aucun code serveur.');
  console.log('');
  console.log('  Pour mettre en ligne :');
  console.log('    cd "' + path.relative(process.cwd(), OUT) + '"');
  console.log('    git add -A && git commit -m "Mise à jour du site" && git push');
  console.log('');
  console.log('  GitHub Pages republie le site automatiquement à chaque push.');
  console.log('  https://firtoks.github.io/radio-oacv/');
  console.log('');
}

main();
