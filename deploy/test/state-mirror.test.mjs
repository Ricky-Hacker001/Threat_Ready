// Lab state mirror (TR-15), migration lock and boot record (TR-14) against a real PostgreSQL, in a
// throwaway schema that is dropped afterwards. Needs STATE_MIRROR_TEST_DATABASE_URL (or
// TEST_DATABASE_URL); skipped without one. Files live in a temporary directory.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import zlib from 'node:zlib';
import { COPY_RETENTION_DAYS, JSON_PARSE_MAX_BYTES, createStateMirror, mirrorTable, stateMirrorConfig, wholeJson } from '../state-mirror.mjs';
import { MIGRATION_LOCK_KEY, recordBoot, releaseBooted, withAdvisoryLock } from '../db.mjs';

const url = process.env.STATE_MIRROR_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;
const skip = url ? false : 'set STATE_MIRROR_TEST_DATABASE_URL to a disposable PostgreSQL database';
const schema = `gw_mirror_test_${process.pid}`;
const table = `${schema}.lab_state_files`;
let tmp;
let db;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-mirror-'));
  if (skip) return;
  db = new pg.Client({ connectionString: url });
  await db.connect();
});
after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!db) return;
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db.end();
});

const logs = [];
const mirrorAt = (dir, opts = {}) => createStateMirror({
  connectionString: url, table, intervalMs: 0, restoreRetryMs: 2000, log: (m) => logs.push(m),
  targets: [{ key: 'labs', file: path.join(dir, 'labs.json') }, { key: 'soc', dir: path.join(dir, 'soc') }, { key: 'redteam', file: path.join(dir, 'redteam.json') }],
  ...opts,
});
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const rows = async () => (await db.query(`SELECT key, sha256, bytes, updated_at FROM ${mirrorTable(table).sql} ORDER BY key`)).rows;
/** The stored JSON of one row. */
const saved = async (key) => {
  const { rows: [row] } = await db.query(`SELECT content FROM ${mirrorTable(table).sql} WHERE key = $1`, [key]);
  return row ? JSON.parse(zlib.gunzipSync(row.content).toString('utf8')) : undefined;
};
const instance = (name) => { const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
/** A launcher that has restored and serves (start(): uploads allowed). */
const serving = async (dir, opts) => { const m = mirrorAt(dir, opts); assert.equal(await m.restore(), true); m.start(); return m; };

test('settings: defaults, off switch, 0 values, and only plain identifiers as the table', () => {
  assert.deepEqual(stateMirrorConfig({}), { enabled: true, table: 'threatready_ops.lab_state_files', intervalMs: 30_000, maxBytes: 8 * 1024 * 1024 });
  assert.equal(stateMirrorConfig({ STATE_MIRROR: 'off' }).enabled, false);
  assert.deepEqual(stateMirrorConfig({ STATE_MIRROR_INTERVAL_MS: '0', STATE_MIRROR_MAX_BYTES: '0' }).intervalMs, 0);
  assert.throws(() => stateMirrorConfig({ STATE_MIRROR_TABLE: 'x; DROP TABLE users' }), /STATE_MIRROR_TABLE/);
  assert.throws(() => stateMirrorConfig({ STATE_MIRROR: 'maybe' }), /STATE_MIRROR/);
});

test('whole-JSON check: a full parse for small files, a heap-free structural check past JSON_PARSE_MAX_BYTES', () => {
  assert.equal(wholeJson(Buffer.from('{"sessions":{}}')), true);
  assert.equal(wholeJson(Buffer.from('{"sessions":{')), false, 'cut off');
  assert.equal(wholeJson(Buffer.from('')), false);
  // Past the limit (tiny limit here): no parse, but a cut-off or non-UTF-8 file is still refused.
  const big = Buffer.from(` ${JSON.stringify({ sessions: { a: 'x'.repeat(200) } })}\n`);
  assert.equal(wholeJson(big, 16), true);
  assert.equal(wholeJson(Buffer.from('[1,2,3]'), 4), true);
  assert.equal(wholeJson(big.subarray(0, big.length - 5), 16), false, 'truncated');
  assert.equal(wholeJson(Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]), 4), false, 'not UTF-8');
  assert.equal(wholeJson(Buffer.from('{"a":1]'), 4), false, 'mismatched brackets');
  assert.ok(JSON_PARSE_MAX_BYTES >= 256 * 1024 && JSON_PARSE_MAX_BYTES <= 4 * 1024 * 1024);
});

test('a fresh instance gets back every saved file; unchanged files are not uploaded again', { skip }, async () => {
  const a = instance('a');
  const m1 = mirrorAt(a);
  assert.equal(await m1.restore(), true, 'creates the schema and table when missing');
  m1.start();
  write(path.join(a, 'labs.json'), { users: { u1: { id: 'u1', name: 'Asha' } }, sessions: {} });
  write(path.join(a, 'soc/cases.json'), { seq: 1001, cases: { c1: { id: 'c1' } } });
  write(path.join(a, 'soc/attempts.json'), { attempts: {} });
  write(path.join(a, 'soc/cases.json.tmp'), '{"half":');
  write(path.join(a, 'soc/cases.json.corrupt.1700000000'), 'garbage');
  assert.equal(await m1.snapshot(), 3);
  assert.deepEqual((await rows()).map((r) => r.key), ['labs', 'soc/attempts.json', 'soc/cases.json']);
  const before = await rows();
  assert.equal(await m1.snapshot(), 0, 'nothing changed');
  fs.utimesSync(path.join(a, 'labs.json'), new Date(), new Date(Date.now() + 5000));
  assert.equal(await m1.snapshot(), 0, 'touched but same bytes');
  assert.deepEqual((await rows()).map((r) => r.updated_at.getTime()), before.map((r) => r.updated_at.getTime()));

  // Restart: an empty instance gets the same bytes back before the labs would load them.
  const b = instance('b');
  assert.equal(await mirrorAt(b).restore(), true);
  assert.equal(fs.readFileSync(path.join(b, 'labs.json'), 'utf8'), fs.readFileSync(path.join(a, 'labs.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(b, 'soc/cases.json'), 'utf8'), fs.readFileSync(path.join(a, 'soc/cases.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(b, 'soc/attempts.json')));
  assert.ok(!fs.existsSync(path.join(b, 'redteam.json')), 'never saved, never created');
});

test('a local file is kept, not replaced by the saved copy; changes upload', { skip }, async () => {
  const c = instance('c');
  write(path.join(c, 'labs.json'), { users: {}, sessions: { s9: { id: 's9' } } });
  const m = await serving(c);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c, 'labs.json'), 'utf8')).sessions, { s9: { id: 's9' } });
  assert.equal(await m.snapshot(), 1);
  const saved = (await rows()).find((r) => r.key === 'labs');
  assert.equal(saved.bytes, fs.statSync(path.join(c, 'labs.json')).size);
});

test('over the size cap or not valid JSON: skipped and logged, the saved copy stays', { skip }, async () => {
  const d = instance('d');
  const states = [];
  const m = await serving(d, { maxBytes: 200, onDurable: (on) => states.push(on) });
  assert.deepEqual(states, [true]);
  const savedBefore = (await rows()).find((r) => r.key === 'labs');
  // The cap is on the stored (gzip) copy: random text does not compress.
  write(path.join(d, 'labs.json'), { users: {}, sessions: { big: randomBytes(300).toString('base64') } });
  assert.equal(await m.snapshot(), 0);
  assert.ok(logs.some((l) => /labs is .* compressed\), over STATE_MIRROR_MAX_BYTES/.test(l)));
  assert.equal(m.durable, false, 'a held-back file means progress is not kept across a restart');
  assert.deepEqual(states, [true, false]);
  write(path.join(d, 'labs.json'), '{"users": {');
  assert.equal(await m.snapshot(), 0);
  assert.ok(logs.some((l) => /labs is not valid JSON/.test(l)));
  assert.equal((await rows()).find((r) => r.key === 'labs').sha256, savedBefore.sha256);
  // Larger than the cap as JSON but under it compressed (lab JSON is repetitive): saved, durable again.
  write(path.join(d, 'labs.json'), { users: {}, sessions: { big: 'x'.repeat(500) } });
  assert.ok(fs.statSync(path.join(d, 'labs.json')).size > 200);
  assert.equal(await m.snapshot(), 1);
  assert.equal((await saved('labs')).sessions.big.length, 500);
  assert.equal(m.durable, true);
  assert.deepEqual(states, [true, false, true]);
  // Far past the cap as plain JSON: not even read.
  write(path.join(d, 'labs.json'), { users: {}, sessions: { big: 'y'.repeat(1000) } });
  assert.equal(await m.snapshot(), 0);
  assert.ok(logs.some((l) => /labs is .* \(not compressed\), over STATE_MIRROR_MAX_BYTES/.test(l)));
  assert.equal(m.durable, false);
});

test('an instance that never serves (a deploy that never went live) uploads nothing, even on stop()', { skip }, async () => {
  const n = instance('never-live');
  const m = mirrorAt(n);
  assert.equal(await m.restore(), true);
  write(path.join(n, 'soc/awards.json'), { badges: {} }); // e.g. SOC's flushAll() on SIGTERM
  assert.equal(await m.snapshot(), 0);
  assert.equal(await m.stop({ timeoutMs: 2000 }), 0);
  assert.ok(!(await rows()).some((r) => r.key === 'soc/awards.json'));
});

test('deploy overlap: the newest instance wins; the old one\'s late changes are kept as its conflict copy', { skip }, async () => {
  // The review's ordering: A serves; B (the new deploy) restores; A saves again; B saves; A saves on SIGTERM.
  const a = instance('overlap-a');
  const b = instance('overlap-b');
  const mA = await serving(a);
  write(path.join(a, 'redteam.json'), { users: {}, sessions: { v: 'A1' } });
  assert.equal(await mA.snapshot(), 1);
  const mB = mirrorAt(b);
  await mB.restore();
  write(path.join(a, 'redteam.json'), { users: {}, sessions: { v: 'A2' } });
  assert.equal(await mA.snapshot(), 1, 'B is not serving yet: A still owns the file');
  mB.start();
  write(path.join(b, 'redteam.json'), { users: {}, sessions: { v: 'A1+B1' } });
  assert.equal(await mB.snapshot(), 1);
  write(path.join(a, 'redteam.json'), { users: {}, sessions: { v: 'A3' } });
  assert.equal(await mA.stop({ timeoutMs: 5000 }), 1);
  assert.equal(await mB.stop({ timeoutMs: 5000 }), 0, 'B had nothing new');
  assert.equal(mA.durable, false, 'the old instance no longer keeps its changes once a newer one owns the file');
  assert.equal(mB.durable, true);

  assert.deepEqual((await saved('redteam')).sessions, { v: 'A1+B1' }, 'the old instance did not overwrite the new one');
  const copies = (await rows()).map((r) => r.key).filter((k) => k.startsWith('redteam@conflict-'));
  assert.equal(copies.length, 1, 'one copy per old instance, holding its latest state');
  assert.match(copies[0], new RegExp(`-${mA.instanceId}$`));
  assert.deepEqual((await saved(copies[0])).sessions, { v: 'A3' });
  assert.ok(logs.some((l) => /redteam was changed by an older instance since this one read it; that copy is kept as redteam@conflict-/.test(l)));
  assert.ok(logs.some((l) => /redteam is now saved by a newer instance; this instance's later changes are kept as/.test(l)));
  // A fresh boot gets the newest instance's state; copies are never restored as files.
  const fresh = instance('overlap-fresh');
  await mirrorAt(fresh).restore();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, 'redteam.json'), 'utf8')).sessions, { v: 'A1+B1' });
  assert.ok(!fs.readdirSync(fresh).some((n) => n.includes('@')));
});

test('conflicts from several instances in the same second are all kept (newest 3 per file), none overwrites the newest', { skip }, async () => {
  const dirs = ['s1', 's2', 's3', 's4', 's5', 'snew'].map((n) => instance(`same-${n}`));
  const mirrors = [];
  for (const d of dirs) mirrors.push(await serving(d)); // restored in this order: the last is the newest
  const newest = mirrors.at(-1);
  write(path.join(dirs.at(-1), 'labs.json'), { users: {}, sessions: { v: 'new' } });
  assert.equal(await newest.snapshot(), 1);
  // Five older instances save within the same second: each keeps its own copy, none overwrites the newest.
  for (let i = 0; i < 5; i += 1) {
    write(path.join(dirs[i], 'labs.json'), { users: {}, sessions: { v: `old${i}` } });
    assert.equal(await mirrors[i].snapshot(), 1);
  }
  const copies = (await rows()).map((r) => r.key).filter((k) => k.startsWith('labs@conflict-'));
  assert.equal(copies.length, 3, 'newest three copies kept');
  for (const i of [2, 3, 4]) assert.ok(copies.some((k) => k.endsWith(`-${mirrors[i].instanceId}`)), `copy of old${i} kept`);
  assert.deepEqual((await saved('labs')).sessions, { v: 'new' });
  for (const m of mirrors) await m.stop({ timeoutMs: 2000 });
});

test('a restored file the store refuses: its saved row is copied aside before the empty store replaces it', { skip }, async () => {
  const seed = instance('rejected-seed');
  const mSeed = await serving(seed);
  write(path.join(seed, 'labs.json'), { users: { u1: {} } }); // valid JSON, but no "sessions": the store refuses it
  assert.equal(await mSeed.stop({ timeoutMs: 5000 }), 1);
  const before = (await rows()).find((r) => r.key === 'labs');

  const r = instance('rejected-boot');
  const m = mirrorAt(r);
  await m.restore();
  // What the labs Store does with it: move it aside, start empty (and later save).
  const file = path.join(r, 'labs.json');
  fs.renameSync(file, `${file}.corrupt-2026-10-24T10-00-00-000Z`);
  assert.equal(await m.checkRestored(), 1);
  const copy = (await rows()).find((x) => x.key.startsWith('labs@rejected-'));
  assert.ok(copy, 'kept aside');
  assert.equal(copy.sha256, before.sha256);
  assert.equal((await rows()).find((x) => x.key === 'labs').sha256, before.sha256, 'the row itself is untouched until this instance serves');
  assert.ok(logs.some((l) => /ERROR the lab store did not accept the restored labs \(kept locally as .*labs\.json\.corrupt-.*\) and started empty; the saved copy is kept as labs@rejected-/.test(l)));

  m.start();
  write(file, { users: {}, sessions: {} });
  assert.equal(await m.snapshot(), 1, 'new progress is saved again');
  assert.deepEqual(await saved('labs'), { users: {}, sessions: {} });
  assert.deepEqual(await saved(copy.key), { users: { u1: {} } });
  // The same refused row on a later boot (no progress saved meanwhile) is not copied again.
  const again = instance('rejected-again');
  await (async () => {
    const seed2 = instance('rejected-seed2');
    const m3 = await serving(seed2);
    write(path.join(seed2, 'labs.json'), { users: { u1: {} } });
    await m3.stop({ timeoutMs: 5000 });
  })();
  for (let i = 0; i < 2; i += 1) {
    const dir = path.join(again, String(i));
    fs.mkdirSync(dir, { recursive: true });
    const mi = mirrorAt(dir);
    await mi.restore();
    fs.renameSync(path.join(dir, 'labs.json'), path.join(dir, 'labs.json.corrupt.1'));
    assert.equal(await mi.checkRestored(), 1);
  }
  const sameShaCopies = (await rows()).filter((x) => x.key.startsWith('labs@rejected-') && x.sha256 === before.sha256);
  assert.equal(sameShaCopies.length, 1, 'one copy per refused content');
  // An accepted restore is left alone.
  const ok = instance('accepted-boot');
  const m2 = mirrorAt(ok);
  await m2.restore();
  assert.equal(await m2.checkRestored(), 0);
});

test(`kept-aside copies older than ${COPY_RETENTION_DAYS} days are deleted at boot`, { skip }, async () => {
  const t = mirrorTable(table).sql;
  await db.query(`INSERT INTO ${t} (key, content, sha256, bytes, updated_at) VALUES ('soc/cases.json@conflict-old-1', '\\x00', 'x', 1, now() - interval '31 days'),
    ('soc/cases.json@rejected-old-2', '\\x00', 'x', 1, now() - interval '31 days'), ('soc/cases.json@conflict-recent-3', '\\x00', 'x', 1, now() - interval '2 days')`);
  await mirrorAt(instance('retention')).restore();
  const keys = (await rows()).map((r) => r.key).filter((k) => k.startsWith('soc/cases.json@'));
  assert.deepEqual(keys, ['soc/cases.json@conflict-recent-3']);
  assert.ok(logs.some((l) => /deleted 2 kept-aside copy\(ies\) older than 30 days/.test(l)));
});

test('database unreachable at boot: labs start empty and this instance never uploads', { skip }, async () => {
  const e = instance('e');
  const bad = new URL(url);
  bad.port = '9';
  const m = createStateMirror({ connectionString: bad.toString(), table, intervalMs: 0, restoreRetryMs: 1500, connectTimeoutMs: 500, log: (l) => logs.push(l), targets: [{ key: 'labs', file: path.join(e, 'labs.json') }] });
  assert.equal(await m.restore(), false);
  assert.equal(m.readable, false);
  assert.equal(m.durable, false, 'nothing this instance records is kept');
  write(path.join(e, 'labs.json'), { users: {}, sessions: {} });
  assert.equal(await m.snapshot(), 0);
  assert.equal(await m.stop({ timeoutMs: 1000 }), 0);
  assert.ok(logs.some((l) => /will NOT upload snapshots/.test(l)));
});

test('stop() makes a final upload of what changed (SIGTERM path)', { skip }, async () => {
  const f = instance('f');
  const m = await serving(f, { intervalMs: 60_000 });
  write(path.join(f, 'soc/awards.json'), { badges: { b1: true } });
  assert.equal(await m.stop({ timeoutMs: 10_000 }), 1);
  assert.ok((await rows()).some((r) => r.key === 'soc/awards.json'));
});

test('migration lock: a second launcher waits until the first has finished', { skip }, async () => {
  const order = [];
  const first = withAdvisoryLock(url, MIGRATION_LOCK_KEY, async () => { order.push('first:start'); await new Promise((r) => setTimeout(r, 600)); order.push('first:end'); });
  await new Promise((r) => setTimeout(r, 150));
  const waits = [];
  const second = withAdvisoryLock(url, MIGRATION_LOCK_KEY, async () => { order.push('second:start'); }, { log: (m) => waits.push(m) });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  assert.match(waits[0], /another instance is migrating/);
  // The lock is released after an error too.
  await assert.rejects(withAdvisoryLock(url, MIGRATION_LOCK_KEY, async () => { throw new Error('migration failed'); }), /migration failed/);
  let ran = false;
  await withAdvisoryLock(url, MIGRATION_LOCK_KEY, async () => { ran = true; }, { waitMs: 2000 });
  assert.equal(ran, true);
});

test('boot record: a release is unknown until it has booted once; only the newest 20 are kept', { skip }, async () => {
  const boots = `${schema}.launcher_boots`;
  assert.equal(await releaseBooted(url, 'r1', { table: boots }), false, 'no table yet');
  await recordBoot(url, 'r1', { table: boots });
  assert.equal(await releaseBooted(url, 'r1', { table: boots }), true);
  assert.equal(await releaseBooted(url, 'r2', { table: boots }), false, 'new code or settings');
  await recordBoot(url, 'r1', { table: boots }); // a restart notes it again
  for (let i = 0; i < 25; i += 1) await recordBoot(url, `later${i}`, { table: boots });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM "${schema}".launcher_boots`)).rows[0].n, 20);
  assert.equal(await releaseBooted(url, 'r1', { table: boots }), false, 'oldest dropped');
  const bad = new URL(url);
  bad.port = '9';
  assert.equal(await releaseBooted(bad.toString(), 'later24', { table: boots, timeoutMs: 500 }), false, 'unreachable: treated as a new release');
  await assert.rejects(releaseBooted(url, 'x', { table: 'x; DROP TABLE y' }), /invalid table name/);
});
