/* ============================================================
   Stockage JSON — écritures atomiques (fichier temporaire + rename)
   et sérialisées : deux requêtes simultanées ne peuvent pas
   corrompre un fichier.
   ============================================================ */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  constructor(file, initial = {}){
    this.file = file;
    this.initial = initial;
    this._data = null;
    this._chain = Promise.resolve();
  }

  async load(){
    if (this._data) return this._data;
    try {
      this._data = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this._data = structuredClone(this.initial);
    }
    return this._data;
  }

  get data(){
    if (!this._data) throw new Error('store non chargé : ' + this.file);
    return this._data;
  }

  async save(){
    this._chain = this._chain
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, JSON.stringify(this._data, null, 2), 'utf8');
        await rename(tmp, this.file);
      })
      .catch(e => console.error('[store] écriture impossible', this.file, e.message));
    return this._chain;
  }

  async update(fn){
    const res = await fn(this.data);
    await this.save();
    return res;
  }
}
