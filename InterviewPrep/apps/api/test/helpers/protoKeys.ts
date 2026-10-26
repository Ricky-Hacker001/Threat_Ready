import { expect } from 'vitest';

/**
 * Prototype-key fuzzing (security patch 2, A11a). Any string a client controls that ends up as an
 * object key, a Map/Record lookup or a route parameter is tried with the names that mean something
 * special on JavaScript objects. The contract for every one of them: an ordinary rejection (4xx),
 * never a 500, never a success, and no change to Object.prototype afterwards.
 */
export const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '__defineGetter__'] as const;
export type ProtoKey = (typeof PROTO_KEYS)[number];

const CANARY = '__tr_proto_canary__';

/** Fails when any fuzzed call left a property behind on Object.prototype (prototype pollution). */
export function assertPrototypeClean(): void {
  const probe: Record<string, unknown> = {};
  expect(probe[CANARY], 'Object.prototype was polluted').toBeUndefined();
  expect(Object.keys(Object.prototype), 'Object.prototype gained enumerable keys').toEqual([]);
  for (const k of PROTO_KEYS) {
    // The built-ins must still be the built-ins (no fuzzed value replaced them).
    if (k === 'toString' || k === 'hasOwnProperty' || k === '__defineGetter__' || k === 'constructor') {
      expect(typeof (Object.prototype as unknown as Record<string, unknown>)[k], `Object.prototype.${k}`).toBe('function');
    }
  }
}

export interface FuzzOutcome<T> {
  key: ProtoKey;
  result?: T;
  error?: unknown;
}

/**
 * Unit-level variant: calls `fn` with each prototype key. The function may return or throw, but it
 * must throw only what `accept` allows (never a TypeError from reading a property of undefined, the
 * classic symptom of `obj[key]` hitting the prototype chain) and must not pollute the prototype.
 */
export function fuzzPure<T>(fn: (key: string) => T, accept: (outcome: FuzzOutcome<T>) => void): FuzzOutcome<T>[] {
  const out: FuzzOutcome<T>[] = [];
  for (const key of PROTO_KEYS) {
    let outcome: FuzzOutcome<T>;
    try {
      outcome = { key, result: fn(key) };
    } catch (error) {
      outcome = { key, error };
    }
    if (outcome.error instanceof TypeError) {
      throw new Error(`prototype key "${key}" produced a TypeError: ${outcome.error.message}`);
    }
    accept(outcome);
    out.push(outcome);
  }
  assertPrototypeClean();
  return out;
}

export interface HttpProbe {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  /** Headers added to every request (Origin for state-changing routes, Authorization for internal ones). */
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResult {
  probe: HttpProbe;
  key: ProtoKey;
  status: number;
  body: unknown;
}

type AgentLike = {
  [m in HttpProbe['method']]: (path: string) => { set(headers: Record<string, string>): { send(body?: unknown): Promise<{ status: number; body: unknown }> } & Promise<{ status: number; body: unknown }> };
};

/**
 * HTTP variant: `template` contains `{fuzz}` where the client-controlled value goes (a path segment
 * or a query value). Every prototype key is sent; the default expectation is a 4xx. Routes whose
 * nonexistent-id behaviour is legitimately a 2xx with an empty body (internal summaries for a user
 * this app has never seen) pass `allowEmptySuccess` and must still never reach 5xx.
 */
export async function fuzzHttp(agent: AgentLike, probes: HttpProbe[], opts: { allowEmptySuccess?: (r: HttpResult) => boolean } = {}): Promise<HttpResult[]> {
  const results: HttpResult[] = [];
  for (const probe of probes) {
    for (const key of PROTO_KEYS) {
      const path = probe.path.replace('{fuzz}', encodeURIComponent(key));
      const req = agent[probe.method](path).set(probe.headers ?? {});
      const res = await (probe.body !== undefined ? req.send(probe.body) : req);
      const r: HttpResult = { probe, key, status: res.status, body: res.body };
      results.push(r);
      const label = `${probe.method.toUpperCase()} ${path}`;
      expect(r.status, `${label} returned a server error`).toBeLessThan(500);
      if (opts.allowEmptySuccess?.(r)) continue;
      expect(r.status, `${label} should be rejected with a 4xx`).toBeGreaterThanOrEqual(400);
    }
  }
  assertPrototypeClean();
  return results;
}
