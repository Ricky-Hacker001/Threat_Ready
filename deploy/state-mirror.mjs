// Durable copy of the in-process labs' JSON state (Lab Simulations, SOC simulation, Red Team lab)
// in Postgres. Render's free instance has no persistent disk: /tmp is empty after every restart,
// sleep or deploy. The launcher restores the files before the labs load them, uploads the files that
// changed every STATE_MIRROR_INTERVAL_MS, and once more on SIGTERM. The files stay the stores' source
// of truth; the table is their backup (one row per file, gzip-compressed, checksummed).
//
// Safety rules:
//  - A file is restored only when it is missing locally (a fresh instance); a local file is kept.
//  - If the database cannot be read at boot, nothing is uploaded for the life of this process, so a
//    good saved copy is never overwritten by the empty state the labs then start with.
//  - Nothing is uploaded before the launcher says this instance is serving (start(), when /healthz
//    turns 200): a new deploy that never goes live never touches the saved copies of the old one.
//  - The newest instance wins. Each row records which instance wrote it and when that instance
//    started. During a deploy the old and new instances overlap: when one finds the row was written
//    by the other since it last read it, the copy from the OLDER instance is kept aside as
//    "<key>@conflict-<writer start>-<writer id>" (one per instance, the newest 3 per file) and the
//    newer instance's copy is the one restored next time. Nothing is merged; every copy is logged.
//  - A restored file a store refuses (moved aside as <file>.corrupt*, then started empty) does not
//    silently replace its saved row with that empty store: the row is first copied to
//    "<key>@rejected-<time>-<id>".
//  - Conflict and rejected copies are deleted after COPY_RETENTION_DAYS (learner data is not kept
//    indefinitely in copies nobody restores).
//  - Files whose stored (gzip) copy would be over the size cap, and files that are not valid JSON
//    (mid-write), are skipped and logged.
//  - `durable` (onDurable) says whether progress written now outlives a restart: the saved state was
//    read at boot, no file is held back (over the cap, refused, unreadable, owned by a newer
//    instance) and uploads are not failing. The launcher turns it into TR_STATE_DURABLE, which the
//    labs and SOC read to say where records are kept.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import pg from 'pg';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
/** A file name under a mirrored directory: plain JSON files only (not .tmp writes or .corrupt copies). */
const DIR_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
/** Kept-aside copies per file and kind, and how long they are kept. Their keys contain '@'; file keys never do. */
const COPIES_KEPT = 3;
export const COPY_RETENTION_DAYS = 30;
const CONFLICT = '@conflict-';
const REJECTED = '@rejected-';
/** A file this many times over the (compressed) cap as plain JSON is not even read (lab JSON gzips about 10x). */
const RAW_READ_FACTOR = 4;
/** Consecutive failed upload rounds after which progress no longer counts as durable. */
const FAILED_ROUNDS_NOT_DURABLE = 2;

/** "[schema.]table" as quoted SQL, refusing anything but plain lower-case identifiers. */
export function mirrorTable(name) {
  const parts = String(name).split('.');
  if (parts.length > 2 || !parts.every((p) => IDENT.test(p))) throw new Error(`STATE_MIRROR_TABLE must be [schema.]table in lower case (got "${name}")`);
  return { schema: parts.length === 2 ? `"${parts[0]}"` : null, sql: parts.map((p) => `"${p}"`).join('.') };
}

/** Settings from the environment; "0" turns the periodic upload or the size cap off. */
export function stateMirrorConfig(env = process.env) {
  const int = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of 0 or more (got "${raw}")`);
    return n;
  };
  const mode = (env.STATE_MIRROR || 'on').trim().toLowerCase();
  if (!['on', 'off'].includes(mode)) throw new Error(`STATE_MIRROR must be on or off (got "${env.STATE_MIRROR}")`);
  const table = env.STATE_MIRROR_TABLE || 'threatready_ops.lab_state_files';
  mirrorTable(table);
  return { enabled: mode === 'on', table, intervalMs: int('STATE_MIRROR_INTERVAL_MS', 30_000), maxBytes: int('STATE_MIRROR_MAX_BYTES', 8 * 1024 * 1024) };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** 2026-10-23T12:02:37.123Z -> 20261023T120237.123Z (sorts by time, safe in a key). */
const stamp = (date) => new Date(date).toISOString().replace(/[-:]/g, '');
const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;
const reason = (err) => (err && typeof err === 'object' ? err.code || err.message : String(err));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.restore.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/**
 * targets: [{ key: 'labs', file: '/tmp/threatready-labs.json' }, { key: 'soc', dir: '/tmp/threatready-soc' }]
 * A directory target mirrors every *.json directly inside it (key "<key>/<name>").
 */
export function createStateMirror({ connectionString, targets, table = 'threatready_ops.lab_state_files', intervalMs = 30_000, maxBytes = 8 * 1024 * 1024, log = () => {}, onDurable = () => {}, connectTimeoutMs = 10_000, restoreRetryMs = 30_000 }) {
  const t = mirrorTable(table);
  /** Per key: what this process last saw in the table (sha or null for no row), and the local file it last uploaded. */
  const known = new Map();
  const uploaded = new Map();
  const warned = new Map();
  /** Keys held back by the size cap, with the file's mtime and size then (not re-read until it changes). */
  const oversize = new Map();
  /** Keys a newer instance owns now: this instance's later changes only go to its conflict copy. */
  const yieldedKeys = new Set();
  let failedRounds = 0;
  let durable = false;
  /** Files written back at boot, until checkRestored() has seen whether their store accepted them. */
  const restoredFiles = [];
  /** This instance, as recorded on every row it writes: a random id and its start time on the database clock. */
  const me = { id: randomBytes(4).toString('hex'), startedAt: null };
  let readable = false;
  let live = false;
  let timer = null;
  let running = null;

  const connect = async () => {
    const client = new pg.Client({ connectionString, application_name: 'threatready-launcher-state', connectionTimeoutMillis: connectTimeoutMs, statement_timeout: 20_000, query_timeout: 25_000 });
    await client.connect();
    return client;
  };
  /** Once per boot (restore): the table, and the writer columns on a table created by an earlier version. */
  const ensureTable = async (client) => {
    if (t.schema) await client.query(`CREATE SCHEMA IF NOT EXISTS ${t.schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.sql} (
      key text PRIMARY KEY,
      content bytea NOT NULL,
      sha256 text NOT NULL,
      bytes integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      writer text,
      writer_started timestamptz)`);
    const { rows: [{ n }] } = await client.query("SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = $1::regclass AND attname IN ('writer', 'writer_started') AND NOT attisdropped", [t.sql]);
    if (n < 2) await client.query(`ALTER TABLE ${t.sql} ADD COLUMN IF NOT EXISTS writer text, ADD COLUMN IF NOT EXISTS writer_started timestamptz`);
  };
  /** Copies kept aside for `key` of one kind: the newest COPIES_KEPT stay. */
  const prune = (client, key, kind) => client.query(`DELETE FROM ${t.sql} WHERE key IN (SELECT key FROM ${t.sql} WHERE starts_with(key, $1) ORDER BY updated_at DESC, key DESC OFFSET ${COPIES_KEPT})`, [`${key}${kind}`]);
  /** Log a per-key condition once until it changes (no repeat every interval). */
  const warnOnce = (key, what, msg) => { if (warned.get(key) !== what) { warned.set(key, what); log(msg); } };
  /** Re-evaluated after every step that can change it; onDurable hears each change (and the first value). */
  const updateDurable = (first = false) => {
    const now = readable && !oversize.size && !yieldedKeys.size && failedRounds < FAILED_ROUNDS_NOT_DURABLE
      && ![...known.values()].some((v) => typeof v === 'symbol');
    if (now === durable && !first) return;
    durable = now;
    try { onDurable(now); } catch { /* the caller's problem; never stops the mirror */ }
  };

  /** The local files currently covered: every file target, and the JSON files inside each directory target. */
  const localFiles = () => {
    const out = [];
    for (const target of targets) {
      if (target.file) { out.push({ key: target.key, file: target.file }); continue; }
      let names = [];
      try { names = fs.readdirSync(target.dir); } catch { /* not created yet */ }
      for (const name of names) if (DIR_ENTRY.test(name)) out.push({ key: `${target.key}/${name}`, file: path.join(target.dir, name) });
    }
    return out;
  };
  /** Where a stored row belongs locally, or null for a row this mirror does not own (other keys, kept-aside copies). */
  const fileFor = (key) => {
    for (const target of targets) {
      if (target.file && key === target.key) return target.file;
      if (target.dir && key.startsWith(`${target.key}/`)) {
        const name = key.slice(target.key.length + 1);
        if (DIR_ENTRY.test(name)) return path.join(target.dir, name);
      }
    }
    return null;
  };

  /** Boot: bring back missing files from the table. Retries for a while (Neon wakes up in seconds). */
  async function restore() {
    const started = Date.now();
    let delay = 1000;
    for (;;) {
      let client;
      try {
        client = await connect();
        await ensureTable(client);
        me.startedAt = (await client.query('SELECT now() AS now')).rows[0].now;
        const expired = await client.query(
          `DELETE FROM ${t.sql} WHERE (position($1 in key) > 0 OR position($2 in key) > 0) AND updated_at < now() - make_interval(days => ${COPY_RETENTION_DAYS})`,
          [CONFLICT, REJECTED],
        );
        if (expired.rowCount) log(`state mirror: deleted ${expired.rowCount} kept-aside copy(ies) older than ${COPY_RETENTION_DAYS} days`);
        const { rows } = await client.query(`SELECT key, content, sha256, bytes, updated_at FROM ${t.sql} WHERE position('@' in key) = 0`);
        let restored = 0;
        for (const row of rows) {
          const file = fileFor(row.key);
          if (!file) continue;
          known.set(row.key, row.sha256);
          if (fs.existsSync(file)) { log(`state mirror: kept local ${row.key} (a saved copy exists from ${row.updated_at.toISOString()})`); continue; }
          let buf;
          try { buf = zlib.gunzipSync(row.content); } catch { buf = null; }
          if (!buf || sha256(buf) !== row.sha256) {
            // Unreadable copy: keep it as it is (never overwritten by this process) and say so.
            known.set(row.key, Symbol('unreadable'));
            log(`state mirror: ERROR the saved copy of ${row.key} is unreadable; it is left untouched and not updated by this instance`);
            continue;
          }
          writeAtomic(file, buf);
          const st = fs.statSync(file);
          uploaded.set(row.key, { sha: row.sha256, mtimeMs: st.mtimeMs, size: st.size });
          restoredFiles.push({ key: row.key, file, sha: row.sha256, mtimeMs: st.mtimeMs });
          restored += 1;
          log(`state mirror: restored ${row.key} (${kb(buf.length)}, saved ${row.updated_at.toISOString()})`);
        }
        readable = true;
        updateDurable(true);
        log(`state mirror: ready (${restored} file(s) restored; uploads ${intervalMs ? `every ${Math.round(intervalMs / 1000)} s and ` : ''}on shutdown)`);
        return true;
      } catch (err) {
        if (Date.now() - started + delay > restoreRetryMs) {
          log(`state mirror: ERROR could not read saved lab state (${reason(err)}). Labs start empty and this instance will NOT upload snapshots, so the saved copy is not overwritten. Restart once the database is reachable.`);
          updateDurable(true);
          return false;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 8000);
      } finally {
        await client?.end().catch(() => {});
      }
    }
  }

  /**
   * After the stores have loaded (deploy/start.mjs): a store that refused a restored file (valid JSON
   * but not its shape: a stricter version, a hand edit) moved it aside as <file>.corrupt* and started
   * empty. Its saved row is copied to "<key>@rejected-…" before this instance's empty store can replace
   * it (the row itself stays until then, so an older instance still serving keeps its copy). If the
   * copy cannot be made, this instance never uploads that file. Never throws.
   */
  async function checkRestored() {
    const refused = [];
    for (const r of restoredFiles.splice(0)) {
      const dir = path.dirname(r.file);
      const base = path.basename(r.file);
      let aside = null;
      // rename() keeps the mtime: the store's .corrupt copy of this restored file has the restore's mtime.
      try { aside = fs.readdirSync(dir).find((n) => n.startsWith(`${base}.corrupt`) && fs.statSync(path.join(dir, n)).mtimeMs >= r.mtimeMs - 1) ?? null; } catch { /* dir gone */ }
      if (fs.existsSync(r.file) && !aside) continue;
      refused.push({ ...r, aside });
    }
    if (!refused.length) return 0;
    let client;
    try {
      client = await connect();
      for (const r of refused) {
        const copy = `${r.key}${REJECTED}${stamp(new Date())}-${me.id}`;
        // One copy per content (the same refused row comes back on every boot until the store saves):
        // updated_at = now() starts the retention clock when the copy is first made.
        const kept = await client.query(
          `INSERT INTO ${t.sql} (key, content, sha256, bytes, updated_at, writer, writer_started)
           SELECT $2::text, content, sha256, bytes, now(), writer, writer_started FROM ${t.sql} WHERE key = $1 AND sha256 = $3
             AND NOT EXISTS (SELECT 1 FROM ${t.sql} WHERE starts_with(key, $4) AND sha256 = $3)`,
          [r.key, copy, r.sha, `${r.key}${REJECTED}`],
        );
        const where = kept.rowCount ? copy
          : (await client.query(`SELECT key FROM ${t.sql} WHERE starts_with(key, $1) AND sha256 = $2 ORDER BY updated_at LIMIT 1`, [`${r.key}${REJECTED}`, r.sha])).rows[0]?.key;
        await prune(client, r.key, REJECTED);
        log(`state mirror: ERROR the lab store did not accept the restored ${r.key} (${r.aside ? `kept locally as ${r.aside}` : 'file removed'}) and started empty; ${where ? `the saved copy is kept as ${where}` : 'the saved copy had already been replaced by another instance'}. New progress is saved again once this instance serves; recover the old records from that copy by hand if needed.`);
      }
    } catch (err) {
      for (const r of refused) known.set(r.key, Symbol('rejected'));
      log(`state mirror: ERROR the lab store did not accept the restored ${refused.map((r) => r.key).join(', ')} and the saved copy could not be set aside (${reason(err)}); this instance will not update it`);
    } finally {
      await client?.end().catch(() => {});
      updateDurable();
    }
    return refused.length;
  }

  /** Upload each covered file that changed since the last upload. Connects only when something changed. */
  async function upload() {
    const changed = [];
    for (const { key, file } of localFiles()) {
      if (typeof known.get(key) === 'symbol') continue;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const last = uploaded.get(key);
      if (last && last.mtimeMs === st.mtimeMs && last.size === st.size) continue;
      const big = oversize.get(key);
      if (big && big.mtimeMs === st.mtimeMs && big.size === st.size) continue; // still over the cap
      const tooBig = (stored) => {
        oversize.set(key, { mtimeMs: st.mtimeMs, size: st.size });
        warnOnce(key, `big:${st.size}`, `state mirror: WARNING ${key} is ${kb(st.size)} (${stored}), over STATE_MIRROR_MAX_BYTES (${kb(maxBytes)} stored); its saved copy is not updated`);
      };
      // The cap is on the stored (gzip) copy; a file far past it as plain JSON is not read at all.
      if (maxBytes && st.size > maxBytes * RAW_READ_FACTOR) { tooBig('not compressed'); continue; }
      let buf;
      try { buf = fs.readFileSync(file); } catch { continue; }
      const sha = sha256(buf);
      // Same bytes as the last upload, or as the saved copy read at boot: nothing to send.
      if ((last && last.sha === sha) || known.get(key) === sha) { uploaded.set(key, { sha, mtimeMs: st.mtimeMs, size: st.size }); oversize.delete(key); continue; }
      try { JSON.parse(buf.toString('utf8')); } catch { warnOnce(key, `json:${sha}`, `state mirror: ${key} is not valid JSON right now; skipped this round`); continue; }
      const gz = zlib.gzipSync(buf);
      if (maxBytes && gz.length > maxBytes) { tooBig(`${kb(gz.length)} compressed`); continue; }
      changed.push({ key, buf, gz, sha, st });
    }
    if (!changed.length) return 0;
    const client = await connect();
    try {
      for (const c of changed) {
        const { gz } = c;
        let yielded = false;
        await client.query('BEGIN');
        try {
          const { rows } = await client.query(`SELECT sha256, writer, writer_started FROM ${t.sql} WHERE key = $1 FOR UPDATE`, [c.key]);
          const row = rows[0] ?? null;
          const expected = known.has(c.key) ? known.get(c.key) : null;
          if (row && row.sha256 !== expected && row.sha256 !== c.sha) {
            // Another instance wrote this file since this one last read or wrote it (a deploy overlap).
            const newer = row.writer !== me.id && row.writer_started && row.writer_started.getTime() > me.startedAt.getTime();
            if (newer) {
              // A newer instance owns the file now: this (older) instance's copy goes aside, the row stays.
              yielded = true;
              const copy = `${c.key}${CONFLICT}${stamp(me.startedAt)}-${me.id}`;
              const kept = await client.query(
                `INSERT INTO ${t.sql} AS t (key, content, sha256, bytes, updated_at, writer, writer_started) VALUES ($1, $2, $3, $4, now(), $5, $6)
                 ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, updated_at = EXCLUDED.updated_at`,
                [copy, gz, c.sha, c.buf.length, me.id, me.startedAt],
              );
              await prune(client, c.key, CONFLICT);
              yieldedKeys.add(c.key);
              if (kept.rowCount) warnOnce(c.key, 'yielded', `state mirror: WARNING ${c.key} is now saved by a newer instance; this instance's later changes are kept as ${copy}, not restored`);
            } else {
              // An older instance (or one that recorded no writer) wrote after this one read: keep its copy, then replace it.
              const copy = `${c.key}${CONFLICT}${stamp(row.writer_started ?? new Date())}-${row.writer ?? randomBytes(4).toString('hex')}`;
              const kept = await client.query(
                `INSERT INTO ${t.sql} AS t (key, content, sha256, bytes, updated_at, writer, writer_started)
                 SELECT $2::text, content, sha256, bytes, updated_at, writer, writer_started FROM ${t.sql} WHERE key = $1
                 ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, updated_at = EXCLUDED.updated_at
                 WHERE t.updated_at <= EXCLUDED.updated_at`,
                [c.key, copy],
              );
              await prune(client, c.key, CONFLICT);
              log(`state mirror: WARNING ${c.key} was changed by an older instance since this one read it; ${kept.rowCount ? `that copy is kept as ${copy}` : `a newer copy from it is already kept as ${copy}`}`);
            }
          }
          if (!yielded) {
            await client.query(
              `INSERT INTO ${t.sql} (key, content, sha256, bytes, updated_at, writer, writer_started) VALUES ($1, $2, $3, $4, now(), $5, $6)
               ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, updated_at = now(),
                 writer = EXCLUDED.writer, writer_started = EXCLUDED.writer_started`,
              [c.key, gz, c.sha, c.buf.length, me.id, me.startedAt],
            );
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
        // After yielding, `known` keeps the older value: every later change also goes to the copy.
        if (!yielded) { known.set(c.key, c.sha); warned.delete(c.key); }
        uploaded.set(c.key, { sha: c.sha, mtimeMs: c.st.mtimeMs, size: c.st.size });
        oversize.delete(c.key);
      }
      return changed.length;
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** One upload round; never throws (a failure is logged and retried next round). Rounds never overlap. */
  function snapshot() {
    if (!readable || !live) return Promise.resolve(0);
    running ??= upload()
      .then((n) => { failedRounds = 0; return n; })
      .catch((err) => { failedRounds += 1; log(`state mirror: upload failed (${reason(err)}); retrying next round`); return 0; })
      .finally(() => { running = null; updateDurable(); });
    return running;
  }

  return {
    restore,
    checkRestored,
    snapshot,
    get readable() { return readable; },
    /** Progress written now is kept across a restart (see the safety rules above). */
    get durable() { return durable; },
    /** This instance's writer id (logged in conflict copies' names). */
    get instanceId() { return me.id; },
    get live() { return live; },
    /** This instance serves now (the launcher's boot is complete): uploads begin, every intervalMs. */
    start() {
      live = true;
      if (intervalMs && !timer) timer = setInterval(() => { snapshot(); }, intervalMs).unref();
    },
    /** Shutdown: stop the timer, finish any round in progress, then a last one (none if never started); bounded by timeoutMs. */
    async stop({ timeoutMs = 15_000 } = {}) {
      if (timer) { clearInterval(timer); timer = null; }
      const last = (async () => { await running; return snapshot(); })();
      const deadline = new Promise((r) => setTimeout(() => r(-1), timeoutMs).unref());
      const n = await Promise.race([last, deadline]);
      if (n === -1) log('state mirror: final upload did not finish in time');
      return n;
    },
  };
}
