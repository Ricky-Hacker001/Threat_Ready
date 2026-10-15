// JSON-file persistence, written atomically. Cases survive a server
// restart; their log streams are regenerated from the stored seed. All
// routes reach storage through server/repo.js, so moving to a database is a
// change to that module and this one only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES_FILE = process.env.SOC_SIM_DATA || path.join(here, '..', 'data', 'cases.json');
export const DATA_DIR = path.dirname(CASES_FILE);

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows refuses to rename over a file another process (an editor,
    // an antivirus scan) has open. Fall back to copy-then-delete.
    if (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY') throw err;
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

// One JSON document on disk with a debounced, atomic writer.
export class JsonFile {
  constructor(file, empty) {
    this.file = file;
    this.empty = empty;
    this.db = empty();
    this.timer = null;
    try {
      if (fs.existsSync(file)) this.db = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      console.error(`Could not read ${file}: ${err.message}. Starting empty.`);
    }
    FILES.push(this);
  }

  flush() {
    this.timer = null;
    try {
      atomicWrite(this.file, JSON.stringify(this.db));
    } catch (err) {
      console.error(`Could not write ${this.file}: ${err.message}`);
    }
  }

  save() { if (!this.timer) this.timer = setTimeout(() => this.flush(), 250); }
  flushNow() { if (this.timer) clearTimeout(this.timer); this.flush(); }
  reset() { this.db = this.empty(); this.flushNow(); }
}

const FILES = [];

const cases = new JsonFile(CASES_FILE, () => ({ seq: 1000, cases: {} }));

export const store = {
  // Demo tickets draw from their own counter so they never consume or
  // reorder assessment ticket numbers.
  nextSeq(kind) {
    const db = cases.db;
    if (kind === 'demo') { db.demoSeq = (db.demoSeq || 0) + 1; return db.demoSeq; }
    db.seq += 1;
    return db.seq;
  },
  all() { return Object.values(cases.db.cases); },
  get(id) { return cases.db.cases[id]; },
  put(c) { cases.db.cases[c.id] = c; this.save(); },
  remove(id) { delete cases.db.cases[id]; this.save(); },
  save() { cases.save(); },
  flushNow() { cases.flushNow(); },
  reset() { cases.reset(); },
};

export const flushAll = () => FILES.forEach((f) => f.flushNow());

process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });
