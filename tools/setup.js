#!/usr/bin/env node
/* ============================================================
   RADIO OACV — assistant de configuration
   Crée le fichier .env : secret de session aléatoire et les deux
   comptes d'administration (mots de passe hachés en scrypt).

   Utilisation :
     npm run setup                     (interactif)
     ADMIN1_EMAIL=… ADMIN1_PASSWORD=… node tools/setup.js   (automatique)

   Pour ajouter ou modifier le compte d'un collègue plus tard, sans
   toucher à celui du propriétaire :
     npm run add-account

   Pour changer un mot de passe :
     npm run password

   Si le mot de passe a été oublié (la porte de secours quand on ne peut
   plus se connecter) :
     node tools/setup.js --only=1
   qui ne réécrit que l'empreinte ADMIN1_PASSWORD_HASH et laisse tout
   le reste — y compris le compte du collègue — intact.

   Le fichier .env n'est jamais versionné.
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
const FORCE = process.argv.includes('--force');

/* --only=N : ne réécrit que l'empreinte d'un compte, sans demander
   ni port, ni fuseau, ni l'autre compte. C'est la porte de secours
   quand on a oublié son mot de passe. */
const onlyArg = process.argv.find(a => a.startsWith('--only'));
const ONLY = onlyArg ? parseInt(onlyArg.split('=')[1], 10) : 0;

const args = new Map(process.argv.slice(2).filter(a => a.includes('=')).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const fromEnv = k => process.env[k] || args.get(k) || '';

/* ---------- assistant ---------- */
const tzGuess = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris'; }
  catch { return 'Europe/Paris'; }
})();

async function askAccount(which, label){
  const email = fromEnv(`ADMIN${which}_EMAIL`);
  const password = fromEnv(`ADMIN${which}_PASSWORD`);
  const name = fromEnv(`ADMIN${which}_NAME`);

  if (email && password) return { email, password, name: name || email };

  console.log(`\n  ${label} (ADMIN${which})`);
  const mail = email || await line('    identifiant (email) : ');
  const nom = name || await line(`    nom affiché [${mail}] : `) || mail;
  let pass = password;
  while (!pass || pass.length < 8){
    pass = await askHidden('    mot de passe (8 caractères minimum, saisie masquée) : ');
    if (pass.length < 8) console.log('    ↳ trop court, recommencez.');
  }
  return { email: mail, password: pass, name: nom };
}

/* ---------- mode secours : réécrit une seule empreinte ---------- */
async function onlyOne(){
  console.log('');
  console.log('  ==========================================================');
  console.log('     RADIO OACV — réinitialisation d\'un mot de passe');
  console.log('  ==========================================================');

  if (![1, 2].includes(ONLY)) throw new Error('--only doit valoir 1 ou 2');
  if (!existsSync(ENV_PATH)) throw new Error('aucun fichier .env : lancez d\'abord « npm run setup »');

  const text = readFileSync(ENV_PATH, 'utf8');
  const email = readEnvValue(text, `ADMIN${ONLY}_EMAIL`);
  if (!email) throw new Error(`ADMIN${ONLY}_EMAIL est vide : ce compte n'existe pas`);

  console.log(`\n  Compte ${ONLY} : ${email}`);
  console.log('  Seul le mot de passe sera remplacé : ni le port, ni le');
  console.log('  fuseau, ni le compte de l\u2019autre personne, ni les sessions.');
  if (!/^(oui|o|yes|y)$/i.test(await line('\n  Continuer ? (oui/non) : '))){
    console.log('\n  Rien n\'a été modifié.\n');
    return;
  }

  let pass = fromEnv(`ADMIN${ONLY}_PASSWORD`);
  while (!pass || pass.length < 8){
    pass = await askHidden('    nouveau mot de passe (8 caractères mini) : ');
    if (pass.length < 8) console.log('    ↳ trop court, recommencez.');
  }
  const twice = fromEnv('ADMIN_PASSWORD') ? pass : await askHidden('    le recopier : ');
  if (twice !== pass) throw new Error('les deux mots de passe ne correspondent pas');

  const hash = await hashPassword(pass);
  const updated = patchEnvKeys(text, { [`ADMIN${ONLY}_PASSWORD_HASH`]: hash },
    `Mot de passe de ${email} réinitialisé le ${new Date().toLocaleString('fr-FR')}`);
  writeFileSync(ENV_PATH, updated, { encoding: 'utf8', mode: 0o600 });

  console.log(`\n  Mot de passe de ${email} réinitialisé.`);
  console.log('  Redémarrez le serveur, puis connectez-vous.\n');
}

async function main(){
  console.log('');
  console.log('  ==========================================================');
  console.log('     RADIO OACV — configuration du serveur');
  console.log('  ==========================================================');

  if (ONLY) return onlyOne();

  if (existsSync(ENV_PATH) && !FORCE){
    console.log('\n  Un fichier .env existe déjà.');
    const again = fromEnv('FORCE') ? 'oui' : await line('  Le remplacer ? (oui/non) : ');
    if (!/^(oui|o|yes|y)$/i.test(again)){
      console.log('\n  Rien n\'a été modifié.\n');
      return;
    }
  }

  const a1 = await askAccount(1, 'Votre compte (propriétaire — accès complet)');
  if (!a1.email || !a1.password) throw new Error('identifiant ou mot de passe manquant');

  const a2Email = fromEnv('ADMIN2_EMAIL') || await line('\n  Identifiant de votre collègue (laissez vide pour ne pas le créer maintenant) : ');
  let a2 = null;
  if (a2Email){
    a2 = await askAccount(2, 'Compte de votre collègue (permissions limitées)');
    if (!a2.email) a2 = null;
  }

  const tz = fromEnv('TZ_NAME') || await line(`\n  Fuseau horaire [${tzGuess}] : `) || tzGuess;

  /* PORT peut déjà venir de l'environnement (certaines plateformes imposent
     PORT=0). Une valeur inexploitable est ignorée pour ne jamais écrire
     un .env qui démarre sur un port aléatoire : on redemande. */
  const portOk = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 && n < 65536 ? String(n) : ''; };
  let port = portOk(fromEnv('PORT')) || portOk(await line('  Port du serveur [8123] : ')) || '8123';

  console.log('\n  Calcul des empreintes de mot de passe…');
  const h1 = await hashPassword(a1.password);
  const h2 = a2 ? await hashPassword(a2.password) : '';

  const secret = crypto.randomBytes(48).toString('base64url');
  const content = `# ============================================================
#  RADIO OACV — configuration locale
#  Généré le ${new Date().toLocaleString('fr-FR')}
#  Ce fichier contient des secrets : NE JAMAIS LE VERSIONNER.
# ============================================================

PORT=${port}
HOST=0.0.0.0
TZ_NAME=${tz}
TRUST_PROXY=0
SECURE_COOKIES=0

SESSION_SECRET=${secret}
SESSION_HOURS=12
UPLOAD_MAX_MB=25

ADMIN1_NAME=${a1.name}
ADMIN1_EMAIL=${a1.email.toLowerCase()}
ADMIN1_PASSWORD_HASH=${h1}

ADMIN2_NAME=${a2 ? a2.name : ''}
ADMIN2_EMAIL=${a2 ? a2.email.toLowerCase() : ''}
ADMIN2_PASSWORD_HASH=${h2}
ADMIN2_PERMS=announcements,schedule,library,ads
ADMIN2_ENABLED=${a2 ? '1' : '0'}

MUSIC_PLAYLIST_ID=PLuwwO2tW6rWqsDdYv16-YJyDrtDF3tRan
ADS_PLAYLIST_ID=PLTvT8EdA3MszcV7CoKdtCIgiHV_6lrgxg
PUBOACV_WEIGHT=4
MUSICS_BEFORE_BREAK_MIN=5
MUSICS_BEFORE_BREAK_MAX=7
LIBRARY_CACHE_HOURS=12

STREAM_MOUNT=/stream
STREAM_BITRATE=160k
STREAM_PUBLIC_URL=
`;

  writeFileSync(ENV_PATH, content, { encoding: 'utf8', mode: 0o600 });

  console.log('');
  console.log('  ==========================================================');
  console.log('   Configuration enregistrée dans .env');
  console.log('  ==========================================================');
  console.log(`   Propriétaire : ${a1.email}`);
  if (a2) console.log(`   Collaborateur : ${a2.email}  (permissions : annonces, programmation, musique, pubs)`);
  else console.log('   Collaborateur : non configuré.');
  if (!a2) console.log('   → plus tard : npm run add-account');
  console.log(`   Fuseau         : ${tz}`);
  console.log(`   Site public    : http://localhost:${port}/`);
  console.log(`   Espace admin   : http://localhost:${port}/admin`);
  console.log('');
  console.log('   Démarrage :  npm start     (ou double-clic sur Lancer-Radio-OACV.bat)');
  console.log('');
  console.log('   Rappel : .env ne doit jamais être envoyé sur GitHub.');
  console.log('  ==========================================================');
  console.log('');
}

main()
  .then(() => { endPrompts(); process.exit(0); })
  .catch(e => {
    console.error('\n  Erreur :', e.message, '\n');
    endPrompts();
    process.exit(1);
  });
