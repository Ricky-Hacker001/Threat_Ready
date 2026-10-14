import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MODEL_URL } from './avatarContract';

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Fetches the interviewer model from the API (signed-in users only), decrypts it with the per-
 * response AES-GCM key and parses it. The licence forbids making the model publicly downloadable,
 * so it never lives in `public/` or the HTTP cache. Loaded once per page.
 *
 * Failures: a 4xx (model not installed on this server, or not signed in) is final for the page, so
 * the stage stays on its 2D interviewer instead of asking again on every render. A network error or
 * 5xx may be transient: it can be retried, but not more than once per RETRY_AFTER_MS.
 */
let pending: Promise<GLTF> | undefined;
export const RETRY_AFTER_MS = 30_000;

class ModelUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`Could not load the interviewer model: ${status}`);
  }
}

/** AES-256-GCM decryption of an asset response (ciphertext with the tag appended). */
export async function decryptAsset(cipher: ArrayBuffer, keyB64: string, ivB64: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', b64(keyB64), 'AES-GCM', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(ivB64) }, k, cipher);
}

export function loadInterviewerModel(): Promise<GLTF> {
  pending ??= (async () => {
    const res = await fetch(MODEL_URL, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new ModelUnavailableError(res.status);
    const key = res.headers.get('X-Asset-Key');
    const iv = res.headers.get('X-Asset-Iv');
    if (!key || !iv) throw new Error('Interviewer model response is missing its key');
    const plain = await decryptAsset(await res.arrayBuffer(), key, iv);
    return new GLTFLoader().parseAsync(plain, '');
  })();
  const attempt = pending;
  attempt.catch((err: unknown) => {
    const permanent = err instanceof ModelUnavailableError && err.status >= 400 && err.status < 500;
    // Keep the rejected promise cached: every caller gets the same failure without a new request.
    if (!permanent) setTimeout(() => { if (pending === attempt) pending = undefined; }, RETRY_AFTER_MS);
  });
  return attempt;
}

/** Test helper: forget the cached model. */
export function resetInterviewerModel() {
  pending = undefined;
}
