#!/usr/bin/env node
/* ============================================================
   RADIO OACV — changer un mot de passe

   Ne réécrit QUE la ligne ADMINx_PASSWORD_HASH du .env :
   l'autre compte, le secret de session, le port et les playlists
   restent intacts. Le secret de session n'est volontairement pas
   touché, donc vos sessions ouvertes restent valides.

   Utilisation :
     npm run password                          (choisit le compte)
     npm run password -- --who=1               (votre compte)
     ADMIN1_PASSWORD=… node tools/change-password.js --who=1

   Il faut redémarrer le serveur ensuite.
   ============================================================ */
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../server/hash.js';
import { line, askHidden, endPrompts, patchEnvKeys, readEnvValue } from './prompt.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_PATH = path.join(ROOT, '.env');

const args = process.argv.slice(2);
const fromEnv = k => process.env[k] || (args.find(a => a.startsWith(`${k}=`)) || '').split('=').slice(1).join('=');

function fail(message){
  console.error(`\n  ${message}\n`);
  process.exitCode = 1;
}

/* Douceur : rejeter ce qui est évidemment faible vaut mieux que
   d'expliquer pourquoi après coup. Un mot de passe long et varié
   l'emporte toujours sur un mot de passe court compliqué. */
const COMMON = new Set([
  'motdepasse', 'password', 'azerty', 'qwerty', '12345678', '123456789',
  'administrateur', 'radio', 'oacv', 'radiooacv', 'azertyuiop', 'qwertyuiop',
  'bonjour', 'soleil', 'letmein', 'welcome', 'admin', 'iloveyou',
]);

function strength(pw){
  const problems = [];
  if (pw.length < 8) problems.push('il faut au moins 8 caractères');
  if (COMMON.has(pw.toLowerCase())) problems.push('ce mot de passe est trop courant');
  if (/^[0-9]+$/.test(pw)) problems.push('uniquement des chiffres est très facile à deviner');
  if (/(.)\1{3,}/.test(pw)) problems.push('beaucoup de caractères répétés');
  return problems;
}

async function main(){
  console.log('');
  console.log('  ==========================================================');
  console.log('     RADIO OACV — changer un mot de passe');
  console.log('  ==========================================================');

  if (!existsSync(ENV_PATH)){
    fail("Aucun fichier .env : lancez d'abord « npm run setup ».");
    return;
  }
  const text = readFileSync(ENV_PATH, 'utf8');

  /* ---------- quel compte ? ---------- */
  const accounts = [1, 2].map(n => ({
    n,
    email: readEnvValue(text, `ADMIN${n}_EMAIL`).toLowerCase(),
    name: readEnvValue(text, `ADMIN${n}_NAME`),
    hash: readEnvValue(text, `ADMIN${n}_PASSWORD_HASH`),
    role: n === 1 ? 'propriétaire' : 'collaborateur',
  })).filter(a => a.email && a.hash);

  if (!accounts.length){
    fail("Aucun compte administrateur dans le .env : lancez « npm run setup ».");
    return;
  }

  let which = parseInt(fromEnv('ADMIN_WHO') || fromEnv('WHO') || '', 10);
  if (!accounts.some(a => a.n === which)){
    console.log('\n  Quel compte voulez-vous modifier ?');
    for (const a of accounts){
      console.log(`    ${a.n}. ${a.name || a.email} <${a.email}>  (${a.role})`);
    }
    for (;;){
      const answer = (await line('    Numéro : ')).trim();
      const n = parseInt(answer, 10);
      if (accounts.some(a => a.n === n)){ which = n; break; }
      console.log('    ↳ ce numéro ne correspond à aucun compte.');
    }
  }
  const account = accounts.find(a => a.n === which);

  console.log(`\n  Compte : ${account.name || account.email} <${account.email}> (${account.role})`);

  /* ---------- vérification du mot de passe actuel ---------- */
  /* Le propriétaire peut être bloqué hors de /admin s'il oublie son
     mot de passe : on lui laisse la porte de secours du .env, qui
     est déjà sur sa machine. Sans cela, il faudrait tout réinstaller. */
  const { verifyPassword } = await import('../server/hash.js');
  let current = fromEnv(`ADMIN${account.n}_OLD_PASSWORD`);
  if (!current){
    console.log('  Par sécurité, donnez d\'abord le mot de passe ACTUEL.');
    current = await askHidden('    mot de passe actuel : ');
  }
  if (!(await verifyPassword(current, account.hash))){
    fail("Mot de passe actuel incorrect : rien n'a été modifié.");
    console.error('    Si tu l\'as oublié, porte de secours :');
    console.error(`        cd radio && node tools/setup.js --only=${account.n}`);
    console.error('    (ne demande que le nouveau mot de passe, tout le reste est conservé)');
    console.error(`    ou modifie directement ADMIN${account.n}_PASSWORD_HASH dans le .env.\n`);
    return;
  }

  /* ---------- nouveau mot de passe ---------- */
  let pass = fromEnv(`ADMIN${account.n}_PASSWORD`);
  if (!pass){
    console.log('');
    for (;;){
      const typed = await askHidden('    nouveau mot de passe (8 caractères mini) : ');
      const twice = await askHidden('    le recopier         : ');
      if (typed !== twice){
        console.log('    ↳ les deux ne correspondent pas, recommencez.');
        continue;
      }
      const problems = strength(typed);
      if (problems.length){
        for (const p of problems) console.log(`    ↳ ${p}.`);
        if (!/^(oui|o|yes|y)$/i.test(await line('    Utiliser quand même ? (oui/non) : '))){
          console.log('    ↳ recommencez.');
          continue;
        }
      }
      pass = typed;
      break;
    }
  } else {
    const problems = strength(pass);
    if (problems.length){
      fail(`Mot de passe trop faible : ${problems.join(', ')}.`);
      return;
    }
  }

  /* ---------- confirmation finale ---------- */
  if (!/^(oui|o|yes|y)$/i.test(await line(`\n  Confirmer le changement pour ${account.email} ? (oui/non) : `))){
    fail('Annulé : rien n\'a été modifié.');
    return;
  }

  console.log('\n  Calcul de la nouvelle empreinte…');
  const hash = await hashPassword(pass);

  const updated = patchEnvKeys(text, { [`ADMIN${account.n}_PASSWORD_HASH`]: hash },
    `Mot de passe de ${account.email} modifié le ${new Date().toLocaleString('fr-FR')}`);
  writeFileSync(ENV_PATH, updated, { encoding: 'utf8', mode: 0o600 });

  console.log('');
  console.log('  ==========================================================');
  console.log('   Mot de passe changé');
  console.log('  ==========================================================');
  console.log(`   Compte    : ${account.email}`);
  console.log('   Secret de session inchangé : vos sessions restent actives.');
  console.log('');
  console.log('   Redémarrez le serveur pour que le nouveau mot de passe');
  console.log('   soit pris en compte (Ctrl+C puis relancez le .bat).');
  if (account.n === 1 && accounts.some(a => a.n === 2)){
    console.log('');
    console.log('   Rappel : le compte de votre collègue est inchangé.');
  }
  console.log('');
}

main()
  .then(() => { endPrompts(); process.exit(process.exitCode || 0); })
  .catch(e => {
    console.error('\n  Erreur :', e.message, '\n');
    endPrompts();
    process.exit(1);
  });
