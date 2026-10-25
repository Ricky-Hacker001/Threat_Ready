import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store';

const tmpDirs: string[] = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-store-')); tmpDirs.push(d); return d; };
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('Red Team store — TR-15 (caps + corrupt-file preservation) and LAB-REG1', () => {
  it('preserves an unparseable data file instead of overwriting it, then starts empty', () => {
    const dir = mkTmp();
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, '{ this is not valid json ');
    const store = new Store(file);
    expect(store.session('anything')).toBe(null);
    // The original bytes were moved aside (not destroyed) so the file can be recovered.
    const corrupt = fs.readdirSync(dir).filter(f => f.startsWith('store.json.corrupt.'));
    expect(corrupt.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, corrupt[0]), 'utf8')).toBe('{ this is not valid json ');
    // A subsequent write creates a fresh, valid file.
    store.createSession('u1', 'TR-RED-001', { x: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).sessions).toBeTruthy();
  });

  it('preserves a well-formed-JSON but wrong-shaped store too', () => {
    const dir = mkTmp();
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, '[1,2,3]');
    new Store(file);
    expect(fs.readdirSync(dir).some(f => f.startsWith('store.json.corrupt.'))).toBe(true);
  });

  it('caps stored runs per learner+lab (default 20), evicting the oldest archived runs only', () => {
    const store = new Store(null);
    for (let i = 0; i < 25; i++) store.createSession('u1', 'TR-RED-001', { run: i });
    const runs = store.sessionsOf('u1', 'TR-RED-001');
    expect(runs.length).toBe(20);
    expect(runs[runs.length - 1].status).toBe('active'); // newest run kept and still active
    expect(runs.filter(r => r.status === 'active').length).toBe(1);
    expect(runs[0].run).toBeGreaterThan(1); // oldest runs dropped
    // Another learner's runs are untouched by the first learner's churn.
    store.createSession('u2', 'TR-RED-001', {});
    expect(store.sessionsOf('u2', 'TR-RED-001').length).toBe(1);
  });

  it('BIZ-06: runs the caller protects are never evicted; the cap still holds by dropping the next oldest', () => {
    const store = new Store(null);
    const first = store.createSession('u1', 'TR-RED-001', {});
    const third = (store.createSession('u1', 'TR-RED-001', {}), store.createSession('u1', 'TR-RED-001', {}));
    for (let i = 0; i < 30; i++) store.createSession('u1', 'TR-RED-001', {}, [first.id, third.id]);
    const runs = store.sessionsOf('u1', 'TR-RED-001');
    expect(runs.length).toBe(20);
    expect(runs.map(r => r.run).slice(0, 3)).toEqual([1, 3, 16]); // runs 1 and 3 kept, the rest are the newest
    expect(runs[runs.length - 1].status).toBe('active');
  });

  it('keeps run numbers unique and increasing after the cap starts evicting (and after a reload)', () => {
    const dir = mkTmp();
    const file = path.join(dir, 'store.json');
    let store = new Store(file);
    for (let i = 0; i < 23; i++) store.createSession('u1', 'TR-RED-001', {});
    let runs = store.sessionsOf('u1', 'TR-RED-001').map(r => r.run);
    expect(runs).toEqual(Array.from({ length: 20 }, (_, i) => i + 4)); // runs 4..23, no repeated "run 21"
    store = new Store(file); // the next number comes from the stored runs, not from a count
    expect(store.createSession('u1', 'TR-RED-001', {}).run).toBe(24);
    runs = store.sessionsOf('u1', 'TR-RED-001').map(r => r.run);
    expect(new Set(runs).size).toBe(runs.length);
    expect(runs[0]).toBe(5);
  });

  it('LAB-REG1: a "__proto__" requestId is an ordinary own idempotency key, not prototype pollution', () => {
    const store = new Store(null);
    const s = store.createSession('u1', 'TR-RED-001', {});
    store.commit(s, { v: 1 }, '__proto__', { ok: true, tag: 'first' });
    const hasOwn = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k); // same check app.ts uses
    expect(hasOwn(s.requests, '__proto__')).toBe(true);
    expect(s.requests['__proto__']).toEqual({ ok: true, tag: 'first' });
    // The session's own prototype chain is intact (no pollution), and eviction keys still enumerate it.
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(s.requests)).toBe(Object.prototype);
    expect(Object.keys(s.requests)).toContain('__proto__');
    // Round-trips through JSON as an own key (how the file reloads).
    const reloaded = JSON.parse(JSON.stringify(s.requests));
    expect(hasOwn(reloaded, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(reloaded)).toBe(Object.prototype);
  });
});
