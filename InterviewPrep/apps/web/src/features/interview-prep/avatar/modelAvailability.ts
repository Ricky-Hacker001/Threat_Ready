/**
 * Whether this browser session already learned the server has no 3D interviewer model (a 4xx).
 * Kept apart from loadModel.ts so the stage can check it without pulling three.js into the
 * main bundle.
 */
const KEY = 'tr-ivw-model-unavailable';

export function modelKnownUnavailable(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markModelUnavailable(): void {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* private mode: the in-memory cache in loadModel still prevents refetching on this page */
  }
}

export function clearModelUnavailable(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
