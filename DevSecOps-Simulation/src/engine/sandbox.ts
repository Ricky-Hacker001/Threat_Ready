/**
 * Runs the learner's cart.js for the simulated unit tests inside an <iframe sandbox="allow-scripts">
 * (public/sandbox.html, an opaque origin: no cookies, storage or same-origin requests), so no
 * learner code is ever evaluated on the ThreatReady origin itself.
 *
 * The shell engine is synchronous, so results are evaluated ahead of time and cached by source:
 * `prepare()` is awaited before any command runs (and at start-up for every lab seed), and
 * `cached()` is what the test cases read.
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

const results = new Map<string, CaseOutcome[]>();
const inflight = new Map<string, Promise<CaseOutcome[] | null>>();

const key = (src: string, cases: CaseSpec[]) => `${JSON.stringify(cases)}\n${src}`;

export function cached(src: string, cases: CaseSpec[]): CaseOutcome[] | undefined {
  return results.get(key(src, cases));
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

/** Resolves with the outcomes, or null when the sandbox document never became ready. */
function runInSandbox(src: string, cases: CaseSpec[]): Promise<CaseOutcome[] | null> {
  return new Promise((resolve) => {
    const out: (CaseOutcome | undefined)[] = cases.map(() => undefined);
    const n = nonce();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    let ready = false;
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove(); // also terminates the frame's worker, i.e. a runaway loop
      resolve(ready ? out.map((o) => o ?? timeoutOutcome()) : null);
    };
    const onMessage = (ev: MessageEvent) => {
      // Only the sandboxed frame itself (an opaque origin serialises as "null"), only this run.
      if (ev.source !== iframe.contentWindow || ev.origin !== 'null') return;
      const d = ev.data as { sandboxReady?: boolean; nonce?: string; i?: number; done?: boolean; outcome?: CaseOutcome } | null;
      if (!d || typeof d !== 'object') return;
      if (d.sandboxReady) {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        timer = window.setTimeout(finish, TIMEOUT_MS);
        iframe.contentWindow?.postMessage({ nonce: n, src, cases }, '*');
        return;
      }
      if (d.nonce !== n) return;
      if (d.done) {
        finish();
        return;
      }
      if (typeof d.i === 'number' && d.i >= 0 && d.i < out.length && d.outcome && typeof d.outcome === 'object') out[d.i] = sanitise(d.outcome);
    };
    timer = window.setTimeout(finish, LOAD_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    iframe.src = `${import.meta.env.BASE_URL}sandbox.html`;
    document.body.appendChild(iframe);
  });
}

/** Evaluate (once) and cache the outcomes for this source; a sandbox that failed to load is retried next time. */
export function prepare(src: string, cases: CaseSpec[]): Promise<CaseOutcome[] | null> {
  const k = key(src, cases);
  const hit = results.get(k);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    p = (typeof document === 'undefined' ? Promise.resolve(null) : runInSandbox(src, cases)).then((r) => {
      if (r) results.set(k, r);
      inflight.delete(k);
      return r;
    });
    inflight.set(k, p);
  }
  return p;
}
