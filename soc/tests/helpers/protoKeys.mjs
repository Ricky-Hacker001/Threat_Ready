// Prototype-key fuzzing for routes and bodies that take a string id (same helper as the other labs'
// tests/helpers/protoKeys.ts). A lookup such as `map[id]` with one of these names returns an inherited
// Object.prototype member instead of "nothing", which has produced silent replays and 500s before.
// Every route with an id must answer a plain client error (never a 5xx, never a success body).
export const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '__defineGetter__'];

/** The default check: a 4xx, and nothing that looks like data. */
export function expectRejected(res, label) {
  if (res.status >= 500) throw new Error(`${label}: answered ${res.status} (server error) ${JSON.stringify(res.body).slice(0, 200)}`);
  if (res.status < 400) throw new Error(`${label}: answered ${res.status} (success) ${JSON.stringify(res.body).slice(0, 200)}`);
}

/** Sends every prototype key through `send` and applies `check` to each answer. */
export async function fuzzProtoKeys(label, send, check = expectRejected) {
  for (const key of PROTO_KEYS) check(await send(key), `${label} [${key}]`);
}
