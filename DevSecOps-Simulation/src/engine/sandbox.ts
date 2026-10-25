/**
 * Runs the learner's cart.js for the simulated unit tests inside an <iframe sandbox="allow-scripts">
 * (public/sandbox.html, an opaque origin: no cookies, storage or same-origin requests), so no
 * learner code is ever evaluated on the ThreatReady origin itself.
 *
 * The shell engine is synchronous, so results are evaluated ahead of time and cached by source:
 * `prepare()` is awaited before any command runs (and at start-up for every lab seed), and
 * `cached()` is what the test cases read.
 *
 * One sandbox frame is kept for the page and runs one job at a time (each job gets a fresh Worker
 * inside the frame). A job that overruns its time limit takes the frame down with it, which also
 * kills a runaway loop; the next job loads a new frame. So does a job that ran on the frame's own
 * thread (no Worker there): its globals must not carry over into the next cart.js version.
 */

export interface CaseSpec {
  fn: string;
  args: unknown[];
}

export type CaseOutcome =
  | { ok: true; primitive: true; value: unknown }
  | { ok: true; primitive: false; received: string | undefined }
  | { ok: false; name: string; message: string };

/** Time the learner's code may run once the sandbox is up (a runaway loop fails every pending case). */
export const TIMEOUT_MS = 2000;
/** Time for the sandbox document itself to load; a miss here is transient and is not cached. */
const LOAD_TIMEOUT_MS = 15000;
/** Outcomes kept for this many sources (least recently used dropped first); pinned ones are kept for good. */
export const CACHE_LIMIT = 50;

/** In least-recently-used order (a hit moves the entry to the end). */
const results = new Map<string, CaseOutcome[]>();
const pinned = new Set<string>();
const inflight = new Map<string, Promise<CaseOutcome[] | null>>();

const key = (src: string, cases: CaseSpec[]) => `${JSON.stringify(cases)}\n${src}`;

function remember(k: string, r: CaseOutcome[]) {
  results.delete(k);
  results.set(k, r);
  let unpinned = 0;
  for (const x of results.keys()) if (!pinned.has(x)) unpinned++;
  for (const x of results.keys()) {
    if (unpinned <= CACHE_LIMIT) break;
    if (pinned.has(x)) continue;
    results.delete(x);
    unpinned--;
  }
}

export function cached(src: string, cases: CaseSpec[]): CaseOutcome[] | undefined {
  const k = key(src, cases);
  const hit = results.get(k);
  if (hit) {
    results.delete(k);
    results.set(k, hit);
  }
  return hit;
}

const timeoutOutcome = (): CaseOutcome => ({ ok: false, name: 'Error', message: `Exceeded timeout of ${TIMEOUT_MS} ms for a test.` });

function nonce(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Keep only the shape we expect from the frame. */
function sanitise(o: CaseOutcome): CaseOutcome {
  if (o.ok === true) {
    if (o.primitive === true) {
      const t = typeof o.value;
      return { ok: true, primitive: true, value: o.value === null || t === 'number' || t === 'string' || t === 'boolean' || t === 'undefined' ? o.value : String(o.value) };
    }
    return { ok: true, primitive: false, received: typeof o.received === 'string' ? o.received : undefined };
  }
  return { ok: false, name: String((o as { name?: unknown }).name), message: String((o as { message?: unknown }).message) };
}

/** `inline`: with `done`, the job ran on the frame's own thread (no Worker), so the frame is not reused. */
type FrameMessage = { sandboxReady?: boolean; nonce?: string; i?: number; done?: boolean; inline?: boolean; outcome?: CaseOutcome } | null;

interface Frame {
  iframe: HTMLIFrameElement;
  /** true once the document said it is ready; false if it never did within LOAD_TIMEOUT_MS. */
  ready: Promise<boolean>;
  /** The job running now, keyed by its nonce. */
  jobs: Map<string, (d: NonNullable<FrameMessage>) => void>;
  close: () => void;
}

let frame: Frame | null = null;

/** The page's sandbox frame, created on first use. */
function sandboxFrame(): Frame {
  if (frame) return frame;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  const jobs = new Map<string, (d: NonNullable<FrameMessage>) => void>();
  let markReady: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((r) => (markReady = r));
  const loadTimer = window.setTimeout(() => markReady(false), LOAD_TIMEOUT_MS);
  const onMessage = (ev: MessageEvent) => {
    // Only the sandboxed frame itself (an opaque origin serialises as "null").
    if (ev.source !== iframe.contentWindow || ev.origin !== 'null') return;
    const d = ev.data as FrameMessage;
    if (!d || typeof d !== 'object') return;
    if (d.sandboxReady) {
      clearTimeout(loadTimer);
      markReady(true);
      return;
    }
    // Only the job this run started.
    if (typeof d.nonce === 'string') jobs.get(d.nonce)?.(d);
  };
  const f: Frame = {
    iframe,
    ready,
    jobs,
    close: () => {
      clearTimeout(loadTimer);
      markReady(false);
      window.removeEventListener('message', onMessage);
      iframe.remove(); // also terminates the frame's worker, i.e. a runaway loop
      if (frame === f) frame = null;
    },
  };
  window.addEventListener('message', onMessage);
  iframe.src = `${import.meta.env.BASE_URL}sandbox.html`;
  document.body.appendChild(iframe);
  frame = f;
  return f;
}

/** Resolves with the outcomes, or null when the sandbox document never became ready. */
async function runInSandbox(src: string, cases: CaseSpec[]): Promise<CaseOutcome[] | null> {
  const f = sandboxFrame();
  if (!(await f.ready)) {
    f.close();
    return null;
  }
  return new Promise((resolve) => {
    const out: (CaseOutcome | undefined)[] = cases.map(() => undefined);
    const n = nonce();
    let timer = 0;
    const finish = (dropFrame: boolean) => {
      clearTimeout(timer);
      f.jobs.delete(n);
      if (dropFrame) f.close();
      resolve(out.map((o) => o ?? timeoutOutcome()));
    };
    f.jobs.set(n, (d) => {
      if (d.done) {
        finish(d.inline === true);
        return;
      }
      if (typeof d.i === 'number' && d.i >= 0 && d.i < out.length && d.outcome && typeof d.outcome === 'object') out[d.i] = sanitise(d.outcome);
    });
    timer = window.setTimeout(() => finish(true), TIMEOUT_MS);
    f.iframe.contentWindow?.postMessage({ nonce: n, src, cases }, '*');
  });
}

/** Jobs run one after another, so one learner's runaway loop never fails another job's cases. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue(src: string, cases: CaseSpec[]): Promise<CaseOutcome[] | null> {
  const run = queue.then(() => runInSandbox(src, cases));
  queue = run.catch(() => null);
  return run;
}

/**
 * Evaluate (once) and cache the outcomes for this source; a sandbox that failed to load is retried next time.
 * `pin` keeps them out of the least-recently-used limit.
 */
export function prepare(src: string, cases: CaseSpec[], opts: { pin?: boolean } = {}): Promise<CaseOutcome[] | null> {
  const k = key(src, cases);
  if (opts.pin) pinned.add(k);
  const hit = cached(src, cases);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    p = (typeof document === 'undefined' ? Promise.resolve(null) : enqueue(src, cases)).then((r) => {
      if (r) remember(k, r);
      inflight.delete(k);
      return r;
    });
    inflight.set(k, p);
  }
  return p;
}
