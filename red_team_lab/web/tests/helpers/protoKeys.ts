// Prototype-key fuzzing for routes and bodies that take a string id. A lookup such as `map[id]` with one
// of these names returns an inherited Object.prototype member instead of "nothing", which has produced
// silent replays and 500s before. Every route with an id must answer a plain client error (never a 5xx,
// never a success body). Framework-neutral (plain throws) so the same file serves vitest and node:test.
export const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '__defineGetter__'] as const;

export interface Answer { status: number; body: any }

/** The default check: a 4xx, and nothing that looks like data. */
export function expectRejected(res: Answer, label: string) {
  if (res.status >= 500) throw new Error(`${label}: answered ${res.status} (server error) ${JSON.stringify(res.body).slice(0, 200)}`);
  if (res.status < 400) throw new Error(`${label}: answered ${res.status} (success) ${JSON.stringify(res.body).slice(0, 200)}`);
}

/** For engine actions that answer 200 with an `ok:false` result: no 5xx, and the action must not have succeeded. */
export function expectActionRefused(res: Answer, label: string) {
  if (res.status >= 500) throw new Error(`${label}: answered ${res.status} (server error)`);
  if (res.status < 400 && res.body?.ok !== false) throw new Error(`${label}: action succeeded ${JSON.stringify(res.body).slice(0, 200)}`);
  if (res.body?.replayed) throw new Error(`${label}: treated as a replayed request`);
}

/** Sends every prototype key through `send` and applies `check` to each answer. */
export async function fuzzProtoKeys(label: string, send: (key: string) => Promise<Answer>, check: (res: Answer, label: string) => void = expectRejected) {
  for (const key of PROTO_KEYS) check(await send(key), `${label} [${key}]`);
}
