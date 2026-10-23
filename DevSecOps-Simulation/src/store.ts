import type { LabState } from './engine/types';
import type { Mode } from './engine/lab';

// Per-browser progress: chosen mode, saved lab workspaces and results. Inside ThreatReady (served at
// /labs/devsecops/ behind the platform sign-in) every key is namespaced by the signed-in account,
// which the Labs API next to the lab (/labs/api/me) names; standalone or signed out it is 'local'.

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

const PREFIX = 'devsecops-lab:';
let namespace = 'local';
const KEY = () => `${PREFIX}${namespace}:progress:v1`;
const LAB_KEY = (id: string) => `${PREFIX}${namespace}:state:v1:${id}`;

const BASE = import.meta.env.BASE_URL;
const inPlatform = typeof window !== 'undefined' && BASE.startsWith('/labs/');

/** Resolve the account namespace once, before anything reads storage (main.tsx awaits this). */
export async function initStorageNamespace(): Promise<string> {
  if (inPlatform) {
    try {
      const res = await fetch(new URL('../api/me', window.location.origin + BASE), { credentials: 'include', cache: 'no-store' });
      if (res.ok) {
        const u = (await res.json()) as { id?: unknown };
        if (typeof u?.id === 'string' && u.id) namespace = u.id.replace(/[^A-Za-z0-9_.@-]/g, '_');
      }
    } catch {
      /* standalone or signed out: stay local */
    }
  }
  migrateLegacyKeys();
  return namespace;
}

/**
 * Keys written before namespacing (`devsecops-lab:progress:v1`, `devsecops-lab:state:v1:<id>`) are
 * claimed by the first account that boots on this browser, provided no account has namespaced
 * state yet (so a learner upgrading keeps their progress), and then removed. Once any namespaced
 * state exists the old keys are never read again.
 */
function migrateLegacyKeys() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX));
    const legacy = keys.filter((k) => /^devsecops-lab:(progress:v1|state:v1:)/.test(k));
    if (!legacy.length) return;
    const claimed = keys.some((k) => !legacy.includes(k));
    for (const k of legacy) {
      const v = localStorage.getItem(k);
      const mine = `${PREFIX}${namespace}:${k.slice(PREFIX.length)}`;
      if (!claimed && v !== null && localStorage.getItem(mine) === null) localStorage.setItem(mine, v);
      localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
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

/** Reset this account's progress only. */
export function resetAll() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(`${PREFIX}${namespace}:`))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
