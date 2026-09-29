/* ============================================================
   RADIO OACV — saisie au clavier, partagée par les outils
   (setup.js, add-account.js, change-password.js)

   Un seul mécanisme de lecture du clavier pour TOUTES les questions,
   visibles ou masquées. Melanger readline et le mode brut du terminal
   est piégeux : les deux écoutent stdin en même temps, et l'assistant
   se bloque après le premier mot de passe.
   ============================================================ */
import { stdin, stdout } from 'node:process';

/* Le mode brut n'existe que sur un vrai terminal. Sinon (script, pipe)
   on lit simplement les lignes de stdin, sans masquage possible —
   un mot de passe tapé dans un pipe n'est de toute façon pas secret. */
const CAN_RAW = Boolean(stdin.isTTY) && typeof stdin.setRawMode === 'function';

let started = false;
let cleaned = false;
let wasRaw = false;

/* état de la saisie en cours (mode terminal) */
let current = null;          // { hidden }
let value = '';
let lastWasCR = false;

/* file d'attente : une seule question à la fois */
let pending = null;          // resolveur en attente
const queue = [];            // questions en file

/* Démarre la question suivante dès que la précédente est répondue :
   sans cela, une question posée pendant une autre resterait bloquée. */
function pump(){
  if (!pending && queue.length) queue.shift()();
}

/* ---------- mode terminal ---------- */
function onData(chunk){
  for (const ch of chunk){
    if (ch === '\u0003'){                       // Ctrl+C
      stop();
      stdout.write('\n');
      process.exit(130);
    }
    if (ch === '\r' || ch === '\n'){
      if (lastWasCR && ch === '\n'){ lastWasCR = false; continue; }   // fin \r\n : une seule fois
      lastWasCR = ch === '\r';
      stdout.write('\n');
      const answer = value.trim();
      value = '';
      const done = pending; pending = null; current = null;
      done?.(answer);
      pump();
      continue;
    }
    if (ch === '\u007f' || ch === '\b'){        // retour arrière
      if (value){
        value = value.slice(0, -1);
        stdout.write('\b \b');
      }
      continue;
    }
    if (ch < ' ') continue;                     // autres touches de contrôle
    if (!pending) continue;                     // frappe en dehors d'une question : ignorée
    value += ch;
    stdout.write(current?.hidden ? '•' : ch);    // écho : point pour un mot de passe
  }
}

function start(){
  if (started) return;
  started = true;
  if (CAN_RAW){
    wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  } else {
    stdin.setEncoding('utf8');
    let buffer = '';
    stdin.on('data', chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0){
        queue.push(buffer.slice(0, i).replace(/\r$/, '').trim());
        buffer = buffer.slice(i + 1);
      }
      const done = pending; pending = null;
      if (done) done(queue.shift() ?? '');
      else pump();
    });
    stdin.resume();
  }
}

function stop(){
  if (cleaned) return;
  cleaned = true;
  stdin.removeListener('data', onData);
  try { if (CAN_RAW) stdin.setRawMode(wasRaw); } catch { /* terminal déjà fermé */ }
  stdin.pause();
}

/* Rétablit le terminal même en cas d'erreur ou de Ctrl+C : sans cela
   l'utilisateur se retrouve avec un invite de commandes muet. */
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']){
  process.on(sig, () => { stop(); process.exit(130); });
}
process.on('uncaughtException', e => { stop(); console.error(e); process.exit(1); });

export function endPrompts(){ stop(); }

/* Une question, une réponse. `hidden` masque la frappe. */
export function ask(question, { hidden = false } = {}){
  const text = question || '';
  start();
  return new Promise(resolve => {
    const run = () => {
      current = { hidden };
      value = '';
      pending = resolve;
      stdout.write(text);
      /* en mode pipe, les réponses peuvent être arrivées plus tôt */
      if (!CAN_RAW && queue.length){ pending = null; current = null; resolve(queue.shift()); }
    };
    if (pending) queue.push(run);           // une question est déjà posée
    else run();
    pump();
  });
}

export const line = q => ask(q);
export const askHidden = q => ask(q, { hidden: true });

/* Réécrit uniquement les clés fournies d'un .env existant, en gardant
   tout le reste (secret de session, port, playlists…) intact et en
   préservant l'ordre et les commentaires du fichier.
   `comment` sert à étiqueter les clés absentes, ajoutées à la fin. */
export function patchEnvKeys(envText, updates, comment = 'mis à jour'){
  const lines = envText.replace(/\r\n/g, '\n').split('\n');
  const done = new Set();
  for (let i = 0; i < lines.length; i++){
    const m = lines[i].match(/^([A-Z0-9_]+)=/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])){
      lines[i] = `${m[1]}=${updates[m[1]]}`;
      done.add(m[1]);
    }
  }
  /* clés absentes du fichier : on les ajoute à la fin */
  const missing = Object.keys(updates).filter(k => !done.has(k));
  if (missing.length){
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', `# ---- ${comment} ----`);
    for (const k of missing) lines.push(`${k}=${updates[k]}`);
  }
  lines.push('');
  return lines.join('\n');
}

/* Lit la valeur d'une clé dans le texte d'un .env. */
export function readEnvValue(text, key){
  const m = String(text).match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}
