import type { LabState } from './engine/types';
import type { Mode } from './engine/lab';
import { inPlatform } from './platform';

// Per-learner progress: chosen mode, saved lab workspaces and results. Standalone the keys are per browser; inside
// ThreatReady they are namespaced by the signed-in user (see setStorageNamespace). Inside ThreatReady with no
// confirmed user, everything is kept in memory for this tab only (setSessionOnlyStorage): the un-namespaced keys are
// never read or written there, so nothing is shared with, or handed to, another learner on this browser.

export interface LabResult {
  score: number;
  max: number;
  mode: Mode;
  /** Wall-clock minutes from the start of the attempt to completion: what the Expert speed bonus measures. */
  minutes: number;
  /** Active minutes (time away excluded), for information. Absent in results saved before it was recorded. */
  activeMinutes?: number;
  completedAt: number;
}

export interface Progress {
  mode: Mode | null;
  results: Record<string, LabResult>;
}

/** The parts of Storage this module uses, so the tab-only store can stand in for localStorage. */
interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  keys(): string[];
}

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

const local: KeyValueStore = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
  keys: () => Object.keys(localStorage),
};

const ROOT = 'devsecops-lab:';
/** Prefix of user-namespaced keys: devsecops-lab:u:<id>:… */
const USER_ROOT = `${ROOT}u:`;
/** Set once the pre-namespacing keys have been dealt with on this browser (see migrateLegacyProgress). */
const MIGRATED_KEY = `${ROOT}legacy-migrated`;
let namespace = '';
/** Inside ThreatReady nothing touches localStorage until a user is confirmed; until then (or if never) it is tab memory. */
let backend: KeyValueStore = inPlatform ? memoryStore() : local;
const store = () => backend;

/** Set once at start-up, before anything is read, when a ThreatReady user is known. */
export function setStorageNamespace(userId: string) {
  namespace = userId ? encodeURIComponent(userId) : '';
  backend = namespace || !inPlatform ? local : memoryStore();
}

/** Inside ThreatReady with no confirmed user: keep progress in memory for this tab only (the lab shows a notice). */
export function setSessionOnlyStorage() {
  namespace = '';
  backend = memoryStore();
}

const prefix = () => (namespace ? `${USER_ROOT}${namespace}:` : ROOT);
const KEY = () => `${prefix()}progress:v1`;
const LAB_KEY = (id: string) => `${prefix()}state:v1:${id}`;

/** Keys written before progress was namespaced (and still used standalone): devsecops-lab:progress:v1, devsecops-lab:state:v1:<lab>. */
const isLegacyKey = (k: string) => k === `${ROOT}progress:v1` || k.startsWith(`${ROOT}state:v1:`);

/**
 * One-time, claim-safe migration of progress saved before keys were namespaced. It runs at the first boot on this
 * browser with a confirmed user: if no account has namespaced progress here yet, that user takes the old progress;
 * otherwise the old keys are dropped rather than handed to whoever opens the lab next. Either way the shared keys
 * are removed and a marker is written, so later boots (any account) never migrate again.
 */
export function migrateLegacyProgress() {
  if (!namespace) return;
  try {
    const keys = local.keys();
    const legacy = keys.filter(isLegacyKey);
    const claimed = local.getItem(MIGRATED_KEY) !== null || keys.some((k) => k.startsWith(USER_ROOT));
    for (const k of legacy) {
      const v = local.getItem(k);
      const target = `${prefix()}${k.slice(ROOT.length)}`;
      if (!claimed && v !== null && local.getItem(target) === null) local.setItem(target, v);
      local.removeItem(k);
    }
    if (local.getItem(MIGRATED_KEY) === null) local.setItem(MIGRATED_KEY, String(Date.now()));
  } catch {
    /* storage unavailable: nothing to migrate */
  }
}

export function loadProgress(): Progress {
  try {
    const raw = store().getItem(KEY());
    if (raw) return { mode: null, results: {}, ...(JSON.parse(raw) as Partial<Progress>) };
  } catch {
    /* storage unavailable */
  }
  return { mode: null, results: {} };
}

export function saveProgress(p: Progress) {
  try {
    store().setItem(KEY(), JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

export function loadLabState(id: string): LabState | null {
  try {
    const raw = store().getItem(LAB_KEY(id));
    return raw ? (JSON.parse(raw) as LabState) : null;
  } catch {
    return null;
  }
}

export function saveLabState(s: LabState) {
  try {
    store().setItem(LAB_KEY(s.labId), JSON.stringify(s));
  } catch {
    // quota exceeded: drop bulky pipeline logs and retry once
    try {
      const slim = { ...s, pipelineRuns: s.pipelineRuns.slice(-5) };
      store().setItem(LAB_KEY(s.labId), JSON.stringify(slim));
    } catch {
      /* give up silently; progress still lives in memory */
    }
  }
}

export function clearLabState(id: string) {
  try {
    store().removeItem(LAB_KEY(id));
  } catch {
    /* ignore */
  }
}

/** Remove this learner's progress only (other users' namespaced keys are left alone). */
export function resetAll() {
  try {
    const s = store();
    const keys = namespace ? s.keys().filter((k) => k.startsWith(prefix())) : s.keys().filter(isLegacyKey);
    keys.forEach((k) => s.removeItem(k));
  } catch {
    /* ignore */
  }
}
