/* ============================================================
   Annonces enregistrées au micro.
   Le navigateur envoie le son (multipart) → le serveur valide,
   range le fichier dans data/announcements/ et l'inscrit au registre.
   Le fichier n'est jamais accessible publiquement : il n'est servi
   qu'aux comptes administrateurs connectés.
   ============================================================ */
import crypto from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './http.js';

const MIME_EXT = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
};
const EXT_MIME = {
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac',
};

const MAX_DURATION_MS = 60 * 60 * 1000;

export function cleanTitle(title, fallback = 'Annonce sans titre'){
  const t = String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (t || fallback).slice(0, 90);
}

export class Announcements {
  constructor(store, { dir, maxBytes, log = console.log }){
    this.store = store;
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.log = log;
  }

  async init(){
    await mkdir(this.dir, { recursive: true });
    const d = this.store.data;
    if (!Array.isArray(d.items)) d.items = [];
    /* on retire du registre les fichiers disparus du disque */
    const kept = [];
    for (const item of d.items){
      try {
        await readFile(this.filePath(item), { encoding: null, flag: 'r' });
        kept.push(item);
      } catch {
        this.log(`[annonces] fichier manquant, entrée retirée : ${item.id}`);
      }
    }
    if (kept.length !== d.items.length){ d.items = kept; await this.store.save(); }
    return d.items;
  }

  list(){
    return [...this.store.data.items].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  get(id){ return this.store.data.items.find(a => a.id === id) || null; }

  filePath(item){ return path.join(this.dir, item.file); }

  extFor(mime, filename){
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (MIME_EXT[m]) return MIME_EXT[m];
    const ext = path.extname(String(filename || '')).toLowerCase();
    if (EXT_MIME[ext]) return ext;
    return null;
  }

  mimeForExt(ext){ return EXT_MIME[ext] || 'application/octet-stream'; }

  async create({ title, mime, filename, data, durationMs, author, source = 'micro' }){
    if (!data || !data.length) fail(400, 'enregistrement vide');
    if (data.length > this.maxBytes) fail(413, `enregistrement trop volumineux (maximum ${Math.round(this.maxBytes / 1048576)} Mo)`);
    const ext = this.extFor(mime, filename);
    if (!ext) fail(415, 'format audio non pris en charge (webm, ogg, mp3, m4a, wav, flac)');

    const id = 'ann_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
    const file = id + ext;

    /* on vérifie la signature du fichier : un .webm doit vraiment être un conteneur multimédia */
    if (!looksLikeAudio(data)){
      fail(415, 'le fichier reçu ne ressemble pas à un fichier audio');
    }

    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, file), data);

    const item = {
      id,
      title: cleanTitle(title, 'Annonce du ' + new Date().toLocaleString('fr-FR')),
      file,
      mime: this.mimeForExt(ext),
      bytes: data.length,
      durationMs: clampDuration(durationMs),
      sha256: crypto.createHash('sha256').update(data).digest('hex').slice(0, 16),
      source,
      createdBy: author || 'inconnu',
      createdAt: new Date().toISOString(),
    };
    this.store.data.items.push(item);
    await this.store.save();
    this.log(`[annonces] « ${item.title} » enregistrée (${(item.bytes / 1024).toFixed(0)} Ko) par ${item.createdBy}`);
    return item;
  }

  async updateTitle(id, title){
    const item = this.get(id);
    if (!item) fail(404, 'annonce introuvable');
    item.title = cleanTitle(title, item.title);
    item.updatedAt = new Date().toISOString();
    await this.store.save();
    return item;
  }

  async remove(id){
    const item = this.get(id);
    if (!item) fail(404, 'annonce introuvable');
    try { await unlink(this.filePath(item)); } catch { /* déjà absente */ }
    this.store.data.items = this.store.data.items.filter(a => a.id !== id);
    await this.store.save();
    this.log(`[annonces] « ${item.title} » supprimée`);
    return item;
  }

  usage(){
    const items = this.store.data.items;
    return { count: items.length, bytes: items.reduce((n, a) => n + (a.bytes || 0), 0) };
  }
}

function clampDuration(v){
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_DURATION_MS);
}

/* quelques signatures de conteneurs audio/ vidéo acceptées */
function looksLikeAudio(buf){
  const b = buf;
  if (b.length < 12) return false;
  const ascii = (i, s) => b.toString('latin1', i, i + s.length) === s;
  if (ascii(0, 'ID3')) return true;                       // mp3 avec étiquette
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // mp3 brut
  if (ascii(0, 'OggS')) return true;                      // ogg / opus
  if (ascii(0, 'RIFF')) return true;                      // wav / webm-parent
  if (ascii(0, 'fLaC')) return true;                      // flac
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true; // ....ftyp (mp4/m4a)
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // matroska/webm
  return false;
}
