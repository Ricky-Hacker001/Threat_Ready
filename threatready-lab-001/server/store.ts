// Persistence boundary. The prototype uses an atomic JSON file; swap this class for a PostgreSQL repository in the platform.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface Session { id: string; userId: string; labId: string; run: number; status: 'active' | 'archived'; state: any; requests: Record<string, any>; createdAt: string; updatedAt: string }
// `tokens` held prototype display-name logins; sign-in now happens on onboard.threatready.io, so it is no longer written.
interface Data { users: Record<string, { id: string; name: string }>; tokens: Record<string, string>; sessions: Record<string, Session> }

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * Past this size the file is logged as large (every lab run of every learner lives in it). On Render the
 * launcher's database mirror skips a file over STATE_MIRROR_MAX_BYTES (8 MB by default), so a warning
 * comes well before that.
 */
const LARGE_FILE_BYTES = 6 * 1024 * 1024;
const LARGE_LOG_MS = 10 * 60_000;

/**
 * A data file that does not parse (or is not a store) is moved aside as `<file>.corrupt-<time>` before
 * the store starts empty, so the next save cannot overwrite what may still be recovered by hand.
 */
function load(file: string): Data | null {
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { parsed = e; }
  if (isObj(parsed) && isObj(parsed.sessions) && (parsed.users === undefined || isObj(parsed.users))) return { users: {}, tokens: {}, ...parsed } as Data;
  const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { fs.renameSync(file, aside); console.error(`store: ${file} is not a valid data file; kept it as ${aside} and started empty`); }
  catch (e) { console.error(`store: ${file} is not a valid data file and could not be moved aside (${(e as Error).message}); started empty`); }
  return null;
}

export class Store {
  private data: Data = { users: {}, tokens: {}, sessions: {} };
  private largeLoggedAt = 0;
  constructor(private file: string | null) {
    if (file) this.data = load(file) ?? this.data;
    // Archived runs refuse every action, so their replay records are never read (older files kept them).
    for (const s of Object.values(this.data.sessions)) if (s?.status === 'archived') s.requests = {};
  }
  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const json = JSON.stringify(this.data);
    fs.writeFileSync(tmp, json); fs.renameSync(tmp, this.file);
    if (json.length > LARGE_FILE_BYTES && Date.now() - this.largeLoggedAt > LARGE_LOG_MS) {
      this.largeLoggedAt = Date.now();
      console.warn(`store: ${this.file} is ${Math.round(json.length / 1024)} KB (${Object.keys(this.data.sessions).length} runs); lower LABS_MAX_RUNS_PER_LAB or raise the state mirror's size limit before it stops being saved`);
    }
  }
  /** Mirrors a platform user (id from onboard.threatready.io). Writes only when the name changed. */
  upsertUser(id: string, name: string) {
    const u = this.data.users[id];
    if (!u || u.name !== name) { this.data.users[id] = { id, name }; this.save(); }
    return this.data.users[id];
  }
  session(id: string) { return Object.prototype.hasOwnProperty.call(this.data.sessions, id) ? this.data.sessions[id] : null; }
  /** Every run of every lab for a user, newest activity first. */
  allSessionsOf(userId: string) { return Object.values(this.data.sessions).filter(s => s.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  sessionsOf(userId: string, labId: string) { return Object.values(this.data.sessions).filter(s => s.userId === userId && s.labId === labId).sort((a, b) => a.run - b.run); }
  createSession(userId: string, labId: string, state: any): Session {
    const prior = this.sessionsOf(userId, labId); const now = new Date().toISOString();
    // Archived runs are read-only: their replay records are never read again.
    for (const p of prior) if (p.status === 'active') { p.status = 'archived'; p.requests = {}; }
    // Run numbers keep counting after old runs are pruned.
    const run = prior.reduce((n, p) => Math.max(n, p.run), 0) + 1;
    const s: Session = { id: crypto.randomUUID(), userId, labId, run, status: 'active', state, requests: {}, createdAt: now, updatedAt: now };
    this.data.sessions[s.id] = s; this.save(); return s;
  }
  /** Keeps at most `max` runs of one lab for one user: the oldest archived runs go, never one in `keep` or an active run. */
  pruneRuns(userId: string, labId: string, max: number, keep: Set<string>) {
    const runs = this.sessionsOf(userId, labId);
    let excess = runs.length - max;
    if (excess <= 0) return 0;
    let n = 0;
    for (const r of runs) {
      if (excess <= 0) break;
      if (r.status !== 'archived' || keep.has(r.id)) continue;
      delete this.data.sessions[r.id]; excess--; n++;
    }
    if (n) this.save();
    return n;
  }
  /** Commits the new state and the idempotency record together. */
  commit(s: Session, state: any, requestId: string | null, response: any) {
    s.state = state; s.updatedAt = new Date().toISOString();
    if (requestId) {
      // An own property even for "__proto__" (a plain assignment would call the prototype setter instead).
      Object.defineProperty(s.requests, requestId, { value: response, enumerable: true, configurable: true, writable: true });
      const keys = Object.keys(s.requests); if (keys.length > 200) delete s.requests[keys[0]];
    }
    this.save();
  }
}
