// Unit-test sandbox (TR-16, UX-REG8): learner code only ever runs in an opaque-origin frame; replies are taken
// only from that frame and that job; a runaway job is cut off; one frame serves every run; the cache is bounded.
// The browser-level checks (opaque origin, no network, under the production CSP) are in tests/browser.e2e.mjs.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

globalThis.__VITE_ENV__.BASE_URL = '/labs/devsecops/';

/** A minimal DOM: iframes whose "sandbox document" answers like public/sandbox.html, scripted per test. */
const listeners = new Set();
const frames = [];
let behaviour = 'answer';
const dispatch = (ev) => listeners.forEach((l) => l(ev));
function makeFrame() {
  const attrs = {};
  const contentWindow = {
    postMessage(msg) {
      const job = msg;
      setTimeout(() => {
        if (behaviour === 'hang') return;
        const send = (data, extra = {}) => dispatch({ source: contentWindow, origin: 'null', data, ...extra });
        if (behaviour === 'forged') {
          // Wrong origin, wrong source, wrong nonce: all ignored. Then the real answer.
          send({ nonce: job.nonce, i: 0, outcome: { ok: true, primitive: true, value: 'forged' } }, { origin: 'http://tr.test' });
          dispatch({ source: {}, origin: 'null', data: { nonce: job.nonce, i: 0, outcome: { ok: true, primitive: true, value: 'forged' } } });
          send({ nonce: 'other-job', i: 0, outcome: { ok: true, primitive: true, value: 'forged' } });
        }
        job.cases.forEach((c, i) => send({ nonce: job.nonce, i, outcome: { ok: true, primitive: true, value: `${c.fn}:${job.src.length}` } }));
        if (behaviour === 'odd') send({ nonce: job.nonce, i: 0, outcome: { ok: true, primitive: true, value: { toString: () => 'obj' } } });
        send(behaviour === 'inline' ? { nonce: job.nonce, done: true, inline: true } : { nonce: job.nonce, done: true });
      }, 1);
    },
  };
  const iframe = {
    attrs,
    style: {},
    contentWindow,
    removed: false,
    setAttribute: (k, v) => void (attrs[k] = v),
    remove() {
      this.removed = true;
    },
    set src(v) {
      attrs.src = v;
      if (behaviour !== 'never-ready') setTimeout(() => dispatch({ source: contentWindow, origin: 'null', data: { sandboxReady: true } }), 1);
    },
  };
  frames.push(iframe);
  return iframe;
}
globalThis.window = {
  addEventListener: (t, l) => t === 'message' && listeners.add(l),
  removeEventListener: (t, l) => t === 'message' && listeners.delete(l),
  setTimeout: (...a) => globalThis.setTimeout(...a),
};
globalThis.document = { createElement: () => makeFrame(), body: { appendChild: () => {} } };

const { prepare, cached, CACHE_LIMIT, TIMEOUT_MS } = await import('../src/engine/sandbox.ts');
const CASES = [{ fn: 'cartTotal', args: [[]] }, { fn: 'applyCoupon', args: [5, { amount: 10 }] }];
const live = () => frames.filter((f) => !f.removed);

beforeEach(() => {
  behaviour = 'answer';
});

test('learner code is sent only to a sandbox="allow-scripts" frame (no allow-same-origin)', async () => {
  const r = await prepare('module.exports = {}', CASES);
  assert.equal(r.length, 2);
  assert.equal(frames[0].attrs.sandbox, 'allow-scripts');
  assert.equal(frames[0].attrs.src, '/labs/devsecops/sandbox.html');
});

test('twenty edits in a row use one sandbox frame (UX-REG8)', async () => {
  const before = frames.length;
  await Promise.all(Array.from({ length: 20 }, (_, i) => prepare(`// edit ${i}\nmodule.exports = {}`, CASES)));
  assert.equal(frames.length - before, 0, 'the frame from the first run is reused');
  assert.equal(live().length, 1);
});

test('a source already evaluated is not run again', async () => {
  const src = 'module.exports = { cached: true }';
  const a = await prepare(src, CASES);
  const b = await prepare(src, CASES);
  assert.equal(a, b);
  assert.deepEqual(cached(src, CASES), a);
});

test('replies from another origin, another window or another job are ignored', async () => {
  behaviour = 'forged';
  const r = await prepare('module.exports = { forged: 1 }', CASES);
  assert.ok(r.every((o) => o.ok && o.value !== 'forged'), JSON.stringify(r));
});

test('outcomes are reduced to the expected shape', async () => {
  behaviour = 'odd';
  const r = await prepare('module.exports = { odd: 1 }', CASES);
  assert.equal(r[0].value, 'obj');
});

test('a job that never answers times out, and its frame (and runaway worker) is dropped', async () => {
  behaviour = 'hang';
  const frame = live()[0];
  const t0 = Date.now();
  const r = await prepare('while (true) {}', CASES);
  assert.ok(Date.now() - t0 >= TIMEOUT_MS - 50);
  assert.deepEqual(r.map((o) => o.message), CASES.map(() => `Exceeded timeout of ${TIMEOUT_MS} ms for a test.`));
  assert.equal(frame.removed, true);
  assert.equal(live().length, 0);
});

test('a sandbox document that never loads gives null and is not cached', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  behaviour = 'never-ready';
  const src = 'module.exports = { slow: 1 }';
  const p = prepare(src, CASES);
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(15000);
  assert.equal(await p, null);
  assert.equal(cached(src, CASES), undefined);
  assert.equal(live().length, 0);
  t.mock.timers.reset();
});

test('after a dropped frame the next run loads a new one', async () => {
  const before = frames.length;
  const r = await prepare('module.exports = { after: 1 }', CASES);
  assert.equal(r.length, 2);
  assert.equal(frames.length - before, 1);
  assert.equal(live().length, 1);
});

test('a job that ran on the frame\'s own thread (no Worker) is not followed by another job in that frame', async () => {
  behaviour = 'inline';
  const r1 = await prepare('globalThis.leak = 1; module.exports = {}', CASES);
  assert.equal(r1.length, 2);
  assert.ok(r1.every((o) => o.ok), JSON.stringify(r1));
  assert.equal(live().length, 0, 'the frame used inline is dropped once the job is done');
  const before = frames.length;
  behaviour = 'answer';
  await prepare('module.exports = { next: 1 }', CASES);
  assert.equal(frames.length - before, 1, 'the next job loads a new frame');
  await prepare('module.exports = { next: 2 }', CASES);
  assert.equal(frames.length - before, 1, 'a Worker job keeps its frame for the next one');
  assert.equal(live().length, 1);
});

test('the outcome cache keeps the most recent sources and every pinned one', async () => {
  behaviour = 'answer';
  const pinnedSrc = 'module.exports = { seed: 1 }';
  await prepare(pinnedSrc, CASES, { pin: true });
  const first = 'module.exports = { first: 1 }';
  await prepare(first, CASES);
  for (let i = 0; i < CACHE_LIMIT + 5; i++) await prepare(`module.exports = { n: ${i} }`, CASES);
  assert.equal(cached(first, CASES), undefined, 'least recently used source dropped');
  assert.ok(cached(pinnedSrc, CASES), 'pinned seed kept');
  assert.ok(cached(`module.exports = { n: ${CACHE_LIMIT + 4} }`, CASES));
});

test('sandbox.html keeps its own deny-all policy and accepts jobs only from its parent', () => {
  const html = fs.readFileSync(new URL('../public/sandbox.html', import.meta.url), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
  for (const d of ["default-src 'none'", "connect-src 'none'", 'worker-src blob:', "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(d), d);
  assert.match(html, /ev\.source !== window\.parent/);
  assert.match(html, /typeof d\.nonce !== 'string'/);
  assert.doesNotMatch(html, /allow-same-origin/);
  const ts = fs.readFileSync(new URL('../src/engine/sandbox.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(ts, /allow-same-origin/);
  assert.match(ts, /ev\.origin !== 'null'/);
});

/** Runs public/sandbox.html's own script in a fresh realm; `worker` gives it a Worker (run in another realm). */
function loadSandboxDocument({ worker }) {
  const html = fs.readFileSync(new URL('../public/sandbox.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const replies = [];
  // JSON round trip: the messages come from another realm (and postMessage would clone them anyway).
  const parent = { postMessage: (m) => replies.push(JSON.parse(JSON.stringify(m))) };
  const listeners = [];
  const blobs = new Map();
  const ctx = { setTimeout, parent, addEventListener: (t, l) => t === 'message' && listeners.push(l) };
  ctx.window = ctx;
  if (worker) {
    ctx.Blob = class { constructor(parts) { this.text = parts.join(''); } };
    ctx.URL = { createObjectURL: (b) => (blobs.set(`blob:${blobs.size}`, b.text), `blob:${blobs.size - 1}`) };
    ctx.Worker = class {
      constructor(url) {
        const self = { postMessage: (m) => setTimeout(() => this.onmessage?.({ data: m }), 0) };
        self.self = self;
        vm.runInNewContext(blobs.get(url), self);
        this.self = self;
      }
      postMessage(d) { setTimeout(() => this.self.onmessage({ data: d }), 0); }
      terminate() {}
    };
  }
  vm.runInNewContext(script, ctx);
  const job = (src) =>
    new Promise((resolve) => {
      const nonce = `n${replies.length}`;
      const start = replies.length;
      listeners.forEach((l) => l({ source: parent, origin: 'http://tr.test', data: { nonce, src, cases: [{ fn: 'f', args: [] }] } }));
      const poll = () => {
        const mine = replies.slice(start).filter((m) => m.nonce === nonce);
        if (mine.some((m) => m.done)) resolve(mine);
        else setTimeout(poll, 1);
      };
      poll();
    });
  return { replies, job };
}

test('sandbox.html marks a job it ran without a Worker as inline, and a Worker job not', async () => {
  const src = 'module.exports = { f: () => typeof leftover }';
  const inline = loadSandboxDocument({ worker: false });
  assert.deepEqual(inline.replies, [{ sandboxReady: true }]);
  const a = await inline.job('globalThis.leftover = 1; module.exports = { f: () => 2 }');
  assert.deepEqual(a.at(-1), { nonce: a[0].nonce, done: true, inline: true });
  assert.deepEqual(a[0].outcome, { ok: true, primitive: true, value: 2 });
  // Why the parent drops that frame: a second job there would see the first one's global.
  const b = await inline.job(src);
  assert.equal(b[0].outcome.value, 'number');

  const worker = loadSandboxDocument({ worker: true });
  const c = await worker.job('globalThis.leftover = 1; module.exports = { f: () => 2 }');
  assert.deepEqual(c.at(-1), { nonce: c[0].nonce, done: true });
  assert.deepEqual(c[0].outcome, { ok: true, primitive: true, value: 2 });
  const d = await worker.job(src);
  assert.equal(d[0].outcome.value, 'undefined', 'each Worker job starts in a fresh realm');
});
