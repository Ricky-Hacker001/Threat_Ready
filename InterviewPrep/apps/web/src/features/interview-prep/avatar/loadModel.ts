import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MODEL_URL } from './avatarContract';

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Fetches the interviewer model from the API (signed-in users only), decrypts it with the per-
 * response AES-GCM key and parses it. The licence forbids making the model publicly downloadable,
 * so it never lives in `public/` or the HTTP cache. Loaded once per page; a failure clears the
 * cache so a later mount can retry, and the stage falls back to its 2D interviewer meanwhile.
 */
let pending: Promise<GLTF> | undefined;

/** AES-256-GCM decryption of an asset response (ciphertext with the tag appended). */
export async function decryptAsset(cipher: ArrayBuffer, keyB64: string, ivB64: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', b64(keyB64), 'AES-GCM', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(ivB64) }, k, cipher);
}

export function loadInterviewerModel(): Promise<GLTF> {
  pending ??= (async () => {
    const res = await fetch(MODEL_URL, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not load the interviewer model: ${res.status}`);
    const key = res.headers.get('X-Asset-Key');
    const iv = res.headers.get('X-Asset-Iv');
    if (!key || !iv) throw new Error('Interviewer model response is missing its key');
    const plain = await decryptAsset(await res.arrayBuffer(), key, iv);
    return new GLTFLoader().parseAsync(plain, '');
  })().catch((err: unknown) => {
    pending = undefined;
    throw err;
  });
  return pending;
}

/** Test helper: forget the cached model. */
export function resetInterviewerModel() {
  pending = undefined;
}
