#!/usr/bin/env node
/* ============================================================
   RADIO OACV — ajouter ou modifier un compte d'administration
   Écrit uniquement les clés ADMIN2_* du .env existant : le compte du
   propriétaire, le secret de session, le port et les playlists ne sont
   jamais touchés. Il faut redémarrer le serveur après.

   Utilisation :
     npm run add-account
     ADMIN2_EMAIL=… ADMIN2_PASSWORD=… npm run add-account   (automatique)

   Le fichier .env n'est jamais versionné.
   ============================================================ */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../server/hash.js';
import { line, askHidden, endPrompts, patchEnvKeys } from './prompt.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_PATH = path.join(ROOT, '.env');

const args = new Map(process.argv.slice(2).filter(a => a.includes('=')).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const fromEnv = k => process.env[k] || args.get(k) || '';

const PERM_LABELS = [
  ['announcements', 'enregistrer et programmer des annonces'],
  ['schedule',       'programmer les passages'],
  ['library',        'gérer la banque de musiques'],
  ['ads',            'gérer les publicités'],
];

function readEnvValue(text, key){
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

async function main(){
  console.log('');
  console.log('  ==========================================================');
  console.log('     RADIO OACV — compte d\'administration');
  console.log('  ==========================================================');

  if (!existsSync(ENV_PATH)){
    console.error('\n  Aucun fichier .env : lancez d\'abord « npm run setup ».\n');
    process.exitCode = 1;
    return;
  }
  const text = readFileSync(ENV_PATH, 'utf8');

  /* ---------- identité ---------- */
  const existingMail = readEnvValue(text, 'ADMIN2_EMAIL');
  if (existingMail) console.log(`\n  Un compte collaborateur existe déjà : ${existingMail}. Il va être remplacé.`);
  console.log('\n  Collaborateur (ADMIN2) — accès limité, jamais propriétaire');

  let mail = fromEnv('ADMIN2_EMAIL');
  if (!mail){
    while (true){
      mail = await line('    identifiant (email) : ');
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) break;
      console.log('    ↳ adresse invalide, recommencez.');
    }
  }
  mail = mail.toLowerCase();

  const ownerMail = readEnvValue(text, 'ADMIN1_EMAIL').toLowerCase();
  if (mail === ownerMail){
    console.error('\n  Cet identifiant est déjà celui du propriétaire. Choisissez-en un autre.\n');
    process.exitCode = 1;
    return;
  }

  const name = fromEnv('ADMIN2_NAME') || (await line(`    nom affiché [${mail}] : `) || mail);

  let pass = fromEnv('ADMIN2_PASSWORD');
  while (!pass || pass.length < 8){
    pass = await askHidden('    mot de passe (8 caractères minimum, saisie masquée) : ');
    if (pass.length < 8) console.log('    ↳ trop court, recommencez.');
  }
  const pass2 = await askHidden('    mot de passe (confirmation) : ');
  if (pass2 !== pass){
    console.error('\n  Les deux mots de passe ne correspondent pas. Rien n\'a été modifié.\n');
    process.exitCode = 1;
    return;
  }

  /* ---------- permissions ---------- */
  const ALL = PERM_LABELS.map(([k]) => k);
  let perms = fromEnv('ADMIN2_PERMS');
  if (!perms){
    console.log('\n  Permissions accordées (Entrée = toutes, "aucune" = lecture seule) :');
    for (const [i, [key, label]] of PERM_LABELS.entries()){
      console.log(`    ${i + 1}. ${key.padEnd(13)} ${label}`);
    }
    const answer = await line('    Choix (ex : 1,2,3 — ou "aucune") : ');
    if (/^(aucune|aucun|none)$/i.test(answer)) perms = '';
    else {
      const picked = answer.split(/[,; ]+/).map(s => s.trim()).filter(Boolean)
        .map(s => (/^\d+$/.test(s) ? ALL[Number(s) - 1] : s))
        .filter(p => ALL.includes(p));
      perms = [...new Set(picked)].join(',');
    }
    if (!perms) console.log('    ↳ aucune permission : le collègue pourra se connecter mais pas agir.');
  } else {
    perms = perms.split(',').map(s => s.trim()).filter(s => ALL.includes(s)).join(',');
  }

  console.log('\n  Calcul de l\'empreinte du mot de passe…');
  const hash = await hashPassword(pass);

  const updated = patchEnvKeys(text, {
    ADMIN2_NAME: name,
    ADMIN2_EMAIL: mail,
    ADMIN2_PASSWORD_HASH: hash,
    ADMIN2_PERMS: perms,
    ADMIN2_ENABLED: '1',
  });
  writeFileSync(ENV_PATH, updated, { encoding: 'utf8', mode: 0o600 });

  console.log('');
  console.log('  ==========================================================');
  console.log('   Compte enregistré dans .env');
  console.log('  ==========================================================');
  console.log(`   Collaborateur : ${name} <${mail}>`);
  console.log(`   Permissions   : ${perms || 'aucune'}`);
  console.log('');
  console.log('   Redémarrez le serveur pour que le compte soit pris en compte.');
  console.log('');
}

main()
  .then(() => { endPrompts(); process.exit(process.exitCode || 0); })
  .catch(e => {
    console.error('\n  Erreur :', e.message, '\n');
    endPrompts();
    process.exit(1);
  });
