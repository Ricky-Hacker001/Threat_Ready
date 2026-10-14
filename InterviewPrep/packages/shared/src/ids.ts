import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Request ids look like req_<26 base32 chars>; they are the only correlation key in logs. */
export const newRequestId = (): string => `req_${randomBytes(16).toString('base64url').slice(0, 22)}`;

/**
 * Deterministic UUID (v5-shaped) from an idempotency key. Jobs are sent with this id, so
 * enqueuing the same key twice is a no-op at the queue (ADD L13 idempotency keys).
 */
export function idempotentUuid(key: string): string {
  const h = createHash('sha1').update(`threatready:${key}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Opaque object key: never contains a filename, email or anything personal. */
export const opaqueObjectKey = (prefix: string, orgId: string): string =>
  `${prefix}/${orgId}/${randomBytes(24).toString('base64url')}`;
