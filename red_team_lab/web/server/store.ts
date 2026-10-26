// Persistence boundary. The prototype uses an atomic JSON file; the platform build swaps this class
// for a PostgreSQL repository (lab_instances header + lab_state/lab_events) behind the same interface.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface Session { id: string; userId: string; labId: string; run: number; status: 'active' | 'archived'; state: any; requests: Record<string, any>; createdAt: string; updatedAt: string }
interface Data { users: Record<string, { id: string; name: string }>; sessions: Record<string, Session> }

/** Moves an unreadable store file to `<file>.corrupt-<timestamp>`; returns the new path, or null when that failed. */
export function quarantine(file: string): string | null {
  const kept = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try { fs.renameSync(file, kept); return kept; } catch { return null; }
}

export class Store {
  private data: Data = { users: {}, sessions: {} };
  constructor(private file: string | null) {
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
        this.data = { users: {}, sessions: {}, ...parsed };
      } catch (err) {
        // A corrupt or truncated file is kept for recovery, never overwritten by the next save.
        const kept = quarantine(file);
        console.error(`store: ${file} could not be read (${(err as Error).message}); ${kept ? `kept as ${kept}` : 'could not be moved aside'}, starting empty`);
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
  createSession(userId: string, labId: string, state: any): Session {
    const prior = this.sessionsOf(userId, labId); const now = new Date().toISOString();
    for (const p of prior) if (p.status === 'active') p.status = 'archived';
    const s: Session = { id: crypto.randomUUID(), userId, labId, run: prior.length + 1, status: 'active', state, requests: {}, createdAt: now, updatedAt: now };
    this.data.sessions[s.id] = s; this.save(); return s;
  }
  commit(s: Session, state: any, requestId: string | null, response: any) {
    s.state = state; s.updatedAt = new Date().toISOString();
    if (requestId) { s.requests[requestId] = response; const keys = Object.keys(s.requests); if (keys.length > 300) delete s.requests[keys[0]]; }
    this.save();
  }
}
