import type { LabState } from './engine/types';
import type { Mode } from './engine/lab';

// Per-learner progress: chosen mode, saved lab workspaces and results. Standalone the keys are per browser; inside
// ThreatReady they are namespaced by the signed-in user (see setStorageNamespace).

export interface LabResult {
  score: number;
  max: number;
  mode: Mode;
  minutes: number;
  completedAt: number;
}

export interface Progress {
  mode: Mode | null;
  results: Record<string, LabResult>;
}

const ROOT = 'devsecops-lab:';
/** Prefix of user-namespaced keys: devsecops-lab:u:<id>:… */
const USER_ROOT = `${ROOT}u:`;
let namespace = '';

/** Set once at start-up, before anything is read, when a ThreatReady user is known. */
export function setStorageNamespace(userId: string) {
  namespace = userId ? encodeURIComponent(userId) : '';
}

const prefix = () => (namespace ? `${USER_ROOT}${namespace}:` : ROOT);
const KEY = () => `${prefix()}progress:v1`;
const LAB_KEY = (id: string) => `${prefix()}state:v1:${id}`;

/** Keys written before progress was namespaced (devsecops-lab:progress:v1, devsecops-lab:state:v1:<lab>). */
function legacyKeys(): string[] {
  return Object.keys(localStorage).filter((k) => k.startsWith(ROOT) && !k.startsWith(USER_ROOT));
}

/**
 * One-time migration: progress saved before keys were namespaced moves into the first signed-in user's keys and is
 * removed from the shared keys, so the next user on the same browser starts fresh.
 */
export function migrateLegacyProgress() {
  if (!namespace) return;
  try {
    for (const k of legacyKeys()) {
      const target = `${prefix()}${k.slice(ROOT.length)}`;
      const v = localStorage.getItem(k);
      if (v !== null && localStorage.getItem(target) === null) localStorage.setItem(target, v);
      localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable: nothing to migrate */
  }
}

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY());
    if (raw) return { mode: null, results: {}, ...(JSON.parse(raw) as Partial<Progress>) };
  } catch {
    /* storage unavailable */
  }
  return { mode: null, results: {} };
}

export function saveProgress(p: Progress) {
  try {
    localStorage.setItem(KEY(), JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

export function loadLabState(id: string): LabState | null {
  try {
    const raw = localStorage.getItem(LAB_KEY(id));
    return raw ? (JSON.parse(raw) as LabState) : null;
  } catch {
    return null;
  }
}

export function saveLabState(s: LabState) {
  try {
    localStorage.setItem(LAB_KEY(s.labId), JSON.stringify(s));
  } catch {
    // quota exceeded: drop bulky pipeline logs and retry once
    try {
      const slim = { ...s, pipelineRuns: s.pipelineRuns.slice(-5) };
      localStorage.setItem(LAB_KEY(s.labId), JSON.stringify(slim));
    } catch {
      /* give up silently; progress still lives in memory */
    }
  }
}

export function clearLabState(id: string) {
  try {
    localStorage.removeItem(LAB_KEY(id));
  } catch {
    /* ignore */
  }
}

/** Remove this learner's progress only (other users' namespaced keys are left alone). */
export function resetAll() {
  try {
    const keys = namespace ? Object.keys(localStorage).filter((k) => k.startsWith(prefix())) : legacyKeys();
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
