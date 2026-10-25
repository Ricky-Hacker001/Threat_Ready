// Persistence boundary. The prototype uses an atomic JSON file; the platform build swaps this class
// for a PostgreSQL repository (lab_instances header + lab_state/lab_events) behind the same interface.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface Session { id: string; userId: string; labId: string; run: number; status: 'active' | 'archived'; state: any; requests: Record<string, any>; createdAt: string; updatedAt: string }
interface Data { users: Record<string, { id: string; name: string }>; sessions: Record<string, Session> }

/** Per-minute-style limit from the environment (0 disables), matching the labs' *_RATE_* convention. */
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
/** Runs kept per learner per lab; older archived runs are evicted so one learner can't grow the store without bound (TR-15), except the ones the caller protects (BIZ-06). 0 disables. */
const MAX_RUNS_PER_LAB = envInt('REDTEAM_MAX_RUNS_PER_LAB', 20);
const isData = (d: any): d is Data => !!d && typeof d === 'object' && typeof d.users === 'object' && d.users !== null && typeof d.sessions === 'object' && d.sessions !== null;

export class Store {
  private data: Data = { users: {}, sessions: {} };
  constructor(private file: string | null) {
    if (file && fs.existsSync(file)) {
      let parsed: any;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { parsed = undefined; }
      if (isData(parsed)) this.data = parsed;
      else {
        // Preserve an unreadable or wrong-shaped store instead of silently overwriting it on the next
        // save, so a corrupt file can be recovered rather than lost (TR-15 / LAB-04).
        try { fs.renameSync(file, `${file}.corrupt.${Date.now()}`); console.warn(`store: ${file} is unreadable; moved it aside (.corrupt.*) and started empty`); }
        catch { console.warn('store: could not parse data file, starting empty'); }
      }
    }
  }
  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data)); fs.renameSync(tmp, this.file);
  }
  upsertUser(id: string, name: string) {
    const u = this.data.users[id];
    if (!u || u.name !== name) { this.data.users[id] = { id, name }; this.save(); }
    return this.data.users[id];
  }
  session(id: string) { return this.data.sessions[id] || null; }
  allSessionsOf(userId: string) { return Object.values(this.data.sessions).filter(s => s.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  sessionsOf(userId: string, labId: string) { return Object.values(this.data.sessions).filter(s => s.userId === userId && s.labId === labId).sort((a, b) => a.run - b.run); }
  /** `keep`: archived runs the cap must never evict (the caller's best and best completed run, BIZ-06). */
  createSession(userId: string, labId: string, state: any, keep: Iterable<string> = []): Session {
    const prior = this.sessionsOf(userId, labId); const now = new Date().toISOString();
    for (const p of prior) if (p.status === 'active') p.status = 'archived';
    // Next after the highest run, not the count: once the cap below evicts old runs the count stops
    // growing, and run numbers must stay unique and increasing (they order the runs and label them).
    const run = prior.reduce((m, p) => Math.max(m, Number(p.run) || 0), 0) + 1;
    const s: Session = { id: crypto.randomUUID(), userId, labId, run, status: 'active', state, requests: {}, createdAt: now, updatedAt: now };
    this.data.sessions[s.id] = s;
    // Keep at most MAX_RUNS_PER_LAB runs for this learner+lab. The one just created is the newest (and the
    // only active one), so eviction only ever drops archived runs: the oldest first, skipping the ones in
    // `keep`, so the profile's "Best score" and "Completed" survive a reset loop (BIZ-06).
    if (MAX_RUNS_PER_LAB > 0) {
      const protect = new Set(keep);
      const runs = this.sessionsOf(userId, labId); // ascending by run
      let excess = runs.length - MAX_RUNS_PER_LAB;
      for (const r of runs) {
        if (excess <= 0) break;
        if (r.status === 'active' || protect.has(r.id)) continue;
        delete this.data.sessions[r.id]; excess--;
      }
    }
    this.save(); return s;
  }
  commit(s: Session, state: any, requestId: string | null, response: any) {
    s.state = state; s.updatedAt = new Date().toISOString();
    if (requestId) {
      // defineProperty, not `s.requests[requestId] = …`: a learner-chosen requestId of "__proto__" must
      // become an ordinary own key (so the idempotency check hasOwn() matches on a replay), not invoke
      // the prototype setter. Enumerable + configurable keep Object.keys() eviction and JSON round-trips
      // working (LAB-REG1). The object may be a plain {} loaded from JSON, so this runs on every commit.
      Object.defineProperty(s.requests, requestId, { value: response, writable: true, enumerable: true, configurable: true });
      const keys = Object.keys(s.requests); if (keys.length > 300) delete s.requests[keys[0]];
    }
    this.save();
  }
}
