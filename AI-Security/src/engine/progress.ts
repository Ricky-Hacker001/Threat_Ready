/** Progress store: storage abstraction, unlock rules, badges. */
import type { Level } from "./types";
import { PASS_MARK } from "./scoring";

export type UnlockMode = "per-task" | "all-foundations-first";

export interface ScenarioResultRecord {
  scenarioId: string;
  /** Best score of any finished attempt, passed or not. */
  bestScore: number;
  /** Best score of a passed attempt: what counts towards the total score. Absent in records saved before it existed. */
  bestPassedScore?: number;
  passed: boolean;
  /** Finished attempts, plus discarded ones that had run a re-test. */
  attempts: number;
  /** Of those, attempts discarded unfinished (recorded because they had run a re-test). */
  discarded?: number;
  /**
   * Re-tests run in attempts discarded since the last finished one. The next attempt starts with them, so they count
   * towards its re-test allowance: discarding cannot wipe failed re-tests from the record.
   */
  carriedRetests?: number;
  lastAt: number;
  hintsUsed: number;
  wrongLayer: number;
}

export interface ProgressState {
  learnerName: string;
  unlockMode: UnlockMode;
  results: Record<string, ScenarioResultRecord>;
  badges: string[];
  createdAt: number;
}

export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const memoryStorage = (): StorageAdapter => {
  const m = new Map<string, string>();
  return {
    get: (k) => (m.has(k) ? (m.get(k) as string) : null),
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
};

/** One memory store per page, so progress still lasts the session when localStorage can't be used. */
let memoryFallback: StorageAdapter | null = null;
/**
 * Inside ThreatReady with no confirmed user: keep everything in memory for this tab only, so nothing
 * is read from or written to a key another learner on this browser could share.
 */
let sessionOnly = false;
export function setSessionOnlyStorage(): void {
  sessionOnly = true;
}

export const browserStorage = (): StorageAdapter => {
  if (sessionOnly) return (memoryFallback ??= memoryStorage());
  try {
    const t = "__tp_test__";
    window.localStorage.setItem(t, "1");
    window.localStorage.removeItem(t);
    return {
      get: (k) => window.localStorage.getItem(k),
      set: (k, v) => window.localStorage.setItem(k, v),
      remove: (k) => window.localStorage.removeItem(k),
    };
  } catch {
    return (memoryFallback ??= memoryStorage());
  }
};

const KEY = "aeropay-lab:progress:v1";
/** Inside ThreatReady, progress is kept per signed-in account (set before the store first reads). */
let namespace = "";
export function setProgressNamespace(ns: string): void {
  namespace = ns;
}
const key = () => (namespace ? `${KEY}:${namespace}` : KEY);

/** The attempt in progress (and the last result), kept next to progress under the same namespace. */
const SESSION_KEY = "aeropay-lab:session:v1";
const sessionKey = () => (namespace ? `${SESSION_KEY}:${namespace}` : SESSION_KEY);

export function loadSession<T>(store: StorageAdapter): T | null {
  const raw = store.get(sessionKey());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function saveSession(store: StorageAdapter, session: unknown): void {
  try {
    store.set(sessionKey(), JSON.stringify(session));
  } catch {
    // Storage full or blocked: the attempt then just won't survive a reload.
  }
}

export function emptyProgress(learnerName: string): ProgressState {
  return {
    learnerName,
    unlockMode: "per-task",
    results: {},
    badges: [],
    createdAt: Date.now(),
  };
}

export function loadProgress(store: StorageAdapter): ProgressState | null {
  const raw = store.get(key());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProgressState;
  } catch {
    return null;
  }
}

export function saveProgress(store: StorageAdapter, p: ProgressState): void {
  store.set(key(), JSON.stringify(p));
}

export function resetProgress(store: StorageAdapter): void {
  store.remove(key());
  store.remove(sessionKey());
}

export function scenarioId(taskId: number, level: Level): string {
  const L = level === "foundation" ? "F" : level === "intermediate" ? "I" : "E";
  return `T${taskId}-${L}`;
}

export function isPassed(p: ProgressState, id: string): boolean {
  return p.results[id]?.passed ?? false;
}

/** Unlock rule. Returns {unlocked, reason?}. */
export function unlockStatus(
  p: ProgressState,
  taskId: number,
  level: Level,
): { unlocked: boolean; reason?: string } {
  if (p.unlockMode === "all-foundations-first") {
    if (level === "foundation") return { unlocked: true };
    const allFound = Array.from({ length: 10 }, (_, i) => scenarioId(i + 1, "foundation")).every(
      (id) => isPassed(p, id),
    );
    if (level === "intermediate") {
      return allFound
        ? { unlocked: true }
        : { unlocked: false, reason: "Pass all 10 Foundation scenarios first." };
    }
    const allInter = Array.from({ length: 10 }, (_, i) => scenarioId(i + 1, "intermediate")).every(
      (id) => isPassed(p, id),
    );
    return allInter
      ? { unlocked: true }
      : { unlocked: false, reason: "Pass all 10 Intermediate scenarios first." };
  }

  // per-task (default)
  if (level === "foundation") return { unlocked: true };
  if (level === "intermediate") {
    return isPassed(p, scenarioId(taskId, "foundation"))
      ? { unlocked: true }
      : { unlocked: false, reason: `Pass Task ${taskId} Foundation first.` };
  }
  return isPassed(p, scenarioId(taskId, "intermediate"))
    ? { unlocked: true }
    : { unlocked: false, reason: `Pass Task ${taskId} Intermediate first.` };
}

/** The points a scenario adds to the total: its best passed score (a not-passed attempt adds nothing). */
export function passedScore(r: ScenarioResultRecord): number {
  return r.bestPassedScore ?? (r.passed ? r.bestScore : 0);
}

/** Total score: the sum of each scenario's best passed score. */
export function totalScore(p: ProgressState): number {
  return Object.values(p.results).reduce((a, r) => a + passedScore(r), 0);
}

/** A finished attempt (its re-tests, including any carried from discarded attempts, are now scored). */
export function recordResult(
  p: ProgressState,
  id: string,
  score: number,
  passed: boolean,
  hintsUsed: number,
  wrongLayer: number,
): ProgressState {
  const prev = p.results[id];
  const prevPassed = prev ? passedScore(prev) : 0;
  const rec: ScenarioResultRecord = {
    scenarioId: id,
    bestScore: Math.max(prev?.bestScore ?? 0, score),
    bestPassedScore: passed ? Math.max(prevPassed, score) : prevPassed,
    passed: (prev?.passed ?? false) || passed,
    attempts: (prev?.attempts ?? 0) + 1,
    discarded: prev?.discarded ?? 0,
    carriedRetests: 0,
    lastAt: Date.now(),
    hintsUsed,
    wrongLayer,
  };
  const next: ProgressState = { ...p, results: { ...p.results, [id]: rec } };
  return applyBadges(next);
}

/**
 * An attempt discarded unfinished. If it ran any re-test it is recorded as an attempt (no score) and its re-tests
 * carry into the next attempt at this scenario, so the re-test cannot be used as a free oracle and then wiped.
 */
export function recordDiscarded(p: ProgressState, id: string, retests: number): ProgressState {
  if (retests <= 0) return p;
  const prev = p.results[id];
  const rec: ScenarioResultRecord = {
    scenarioId: id,
    bestScore: prev?.bestScore ?? 0,
    bestPassedScore: prev ? passedScore(prev) : 0,
    passed: prev?.passed ?? false,
    attempts: (prev?.attempts ?? 0) + 1,
    discarded: (prev?.discarded ?? 0) + 1,
    carriedRetests: (prev?.carriedRetests ?? 0) + retests,
    lastAt: Date.now(),
    hintsUsed: prev?.hintsUsed ?? 0,
    wrongLayer: prev?.wrongLayer ?? 0,
  };
  return { ...p, results: { ...p.results, [id]: rec } };
}

export interface BadgeDef {
  id: string;
  title: string;
  description: string;
  kind: "task" | "tier";
  taskId?: number;
  level?: Level;
  icon: string; // short emoji/glyph for the showcase
}

/** One appreciation badge per task (all 3 levels passed) + three tier badges. */
export const TASK_BADGES: BadgeDef[] = [
  { id: "badge-t1", title: "Prompt Guardian", description: "Mastered System Prompt Leak across all three levels.", kind: "task", taskId: 1, icon: "🛡️" },
  { id: "badge-t2", title: "Jailbreak Breaker", description: "Beat Direct Prompt Injection at every level.", kind: "task", taskId: 2, icon: "⛓️" },
  { id: "badge-t3", title: "Injection Interceptor", description: "Stopped Indirect Prompt Injection end to end.", kind: "task", taskId: 3, icon: "🧲" },
  { id: "badge-t4", title: "Access Sentinel", description: "Closed every PII / RAG access leak.", kind: "task", taskId: 4, icon: "🔑" },
  { id: "badge-t5", title: "Exfil Stopper", description: "Shut every data-exfiltration channel.", kind: "task", taskId: 5, icon: "🚫" },
  { id: "badge-t6", title: "Agency Warden", description: "Contained Excessive Agency at every level.", kind: "task", taskId: 6, icon: "⚖️" },
  { id: "badge-t7", title: "Output Shield", description: "Neutralised insecure output (XSS / SQL).", kind: "task", taskId: 7, icon: "🧱" },
  { id: "badge-t8", title: "Wallet Defender", description: "Defeated Denial of Wallet at every level.", kind: "task", taskId: 8, icon: "💰" },
  { id: "badge-t9", title: "Supply Gatekeeper", description: "Blocked Tool / MCP poisoning.", kind: "task", taskId: 9, icon: "🔌" },
  { id: "badge-t10", title: "Model Custodian", description: "Secured the model supply chain.", kind: "task", taskId: 10, icon: "📦" },
];

export const TIER_BADGES: BadgeDef[] = [
  { id: "AI Security Foundations", title: "AI Security Foundations", description: "Passed all 10 Foundation scenarios.", kind: "tier", level: "foundation", icon: "🥉" },
  { id: "AI Security Practitioner", title: "AI Security Practitioner", description: "Passed all 10 Intermediate scenarios.", kind: "tier", level: "intermediate", icon: "🥈" },
  { id: "AI Security Expert", title: "AI Security Expert", description: "Passed all 10 Expert scenarios.", kind: "tier", level: "expert", icon: "🥇" },
];

export const BADGE_CATALOG: BadgeDef[] = [...TASK_BADGES, ...TIER_BADGES];

/** A task badge is earned when all three of its levels are passed. */
export function taskComplete(p: ProgressState, taskId: number): boolean {
  return (["foundation", "intermediate", "expert"] as Level[]).every((lv) =>
    isPassed(p, scenarioId(taskId, lv)),
  );
}

/** Award (never revoke) task and tier badges. */
export function applyBadges(p: ProgressState): ProgressState {
  const badges = new Set(p.badges);
  for (const b of TASK_BADGES) {
    if (b.taskId && taskComplete(p, b.taskId)) badges.add(b.id);
  }
  for (const b of TIER_BADGES) {
    const all = Array.from({ length: 10 }, (_, i) => scenarioId(i + 1, b.level!)).every((id) =>
      isPassed(p, id),
    );
    if (all) badges.add(b.id);
  }
  return { ...p, badges: Array.from(badges) };
}

/** For the showcase: every badge with earned state + progress fraction. */
export function badgeShowcase(p: ProgressState): { def: BadgeDef; earned: boolean; progress: number }[] {
  return BADGE_CATALOG.map((def) => {
    let earned = p.badges.includes(def.id);
    let progress = 0;
    if (def.kind === "task" && def.taskId) {
      const levels: Level[] = ["foundation", "intermediate", "expert"];
      const passed = levels.filter((lv) => isPassed(p, scenarioId(def.taskId!, lv))).length;
      progress = passed / 3;
      earned = earned || passed === 3;
    } else if (def.kind === "tier" && def.level) {
      const lp = levelProgress(p, def.level);
      progress = lp.passed / lp.total;
      earned = earned || lp.passed === lp.total;
    }
    return { def, earned, progress };
  });
}

export function levelProgress(p: ProgressState, level: Level): { passed: number; total: number } {
  const ids = Array.from({ length: 10 }, (_, i) => scenarioId(i + 1, level));
  return { passed: ids.filter((id) => isPassed(p, id)).length, total: 10 };
}

export { PASS_MARK };
