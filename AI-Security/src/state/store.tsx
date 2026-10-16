/* Central application state: attempt state machine + progress + navigation. */
import React, { createContext, useContext, useMemo, useReducer, useRef } from "react";
import type {
  GuardrailConfig,
  Level,
  NodeId,
  Role,
  ScenarioConfig,
  SyntheticCustomer,
  AttemptState,
  RetestResult,
} from "@/engine/types";
import type { DetectionRule } from "@/engine/detection";
import {
  createAttempt,
  finaliseScore,
  runVariant,
  runBenign,
  runRetest,
  evalPredicate,
  buildAdminPayload,
  LocalAdminFeedSink,
} from "@/engine";
import { Rng } from "@/engine/rng";
import {
  browserStorage,
  emptyProgress,
  loadProgress,
  saveProgress,
  recordResult,
  resetProgress as resetProgressStore,
  scenarioId as sid,
  BADGE_CATALOG,
  type ProgressState,
  type UnlockMode,
} from "@/engine/progress";
import { getScenario } from "@/scenarios";
import { BRAND } from "@/brand/brand";

export type ViewKind =
  | "entry"
  | "mission"
  | "briefing"
  | "workspace"
  | "results"
  | "badges"
  | "learning";

export interface ChatMsg {
  from: "user" | "aero";
  text: string;
  vuln?: boolean;
  demo?: string;
}

export interface ActiveAttempt {
  scenario: ScenarioConfig;
  state: AttemptState;
  customers: SyntheticCustomer[];
  detectionRule: DetectionRule | null;
  chat: ChatMsg[];
  wrongCounted: string[];
  lastRetest: RetestResult | null;
  attemptNo: number;
}

export interface Toast {
  id: number;
  kind: "green" | "red" | "info" | "amber";
  text: string;
}

export interface FinalResult {
  scenarioId: string;
  level: Level;
  score: ReturnType<typeof finaliseScore>["score"];
  retest: RetestResult;
  evidence: ReturnType<typeof finaliseScore>["evidence"];
  detection: ReturnType<typeof finaliseScore>["detection"];
  fixFraction: number;
  reportFraction: number;
}

export interface AppState {
  progress: ProgressState | null;
  view: ViewKind;
  activeScenarioId: string | null;
  attempt: ActiveAttempt | null;
  result: FinalResult | null;
  toasts: Toast[];
}

type Action =
  | { t: "enter"; name: string }
  | { t: "resetProgress" }
  | { t: "setUnlockMode"; mode: UnlockMode }
  | { t: "mission" }
  | { t: "gotoEntry" }
  | { t: "gotoBadges" }
  | { t: "gotoLearning" }
  | { t: "openScenario"; scenarioId: string }
  | { t: "startScenario" }
  | { t: "setRole"; role: Role }
  | { t: "chat"; prompt: string; attack?: string }
  | { t: "toggleEvidence"; eventId: string }
  | { t: "setGuardrail"; layer: keyof GuardrailConfig; key: string; value: unknown }
  | { t: "useHint" }
  | { t: "setMapFix"; node: NodeId }
  | { t: "setReconPath"; path: NodeId[] }
  | { t: "setDetectionRule"; rule: DetectionRule | null }
  | { t: "runRetest" }
  | { t: "setReportInput"; key: string; value: string }
  | { t: "setFrameworkPick"; kind: "owasp" | "atlas" | "iso"; values: string[] }
  | { t: "setPhase"; phase: AttemptState["phase"] }
  | { t: "finalise" }
  | { t: "retake" }
  | { t: "toast"; kind: Toast["kind"]; text: string }
  | { t: "dismissToast"; id: number };

const adminSink = new LocalAdminFeedSink();
let toastId = 1;

function pushToast(state: AppState, kind: Toast["kind"], text: string): Toast[] {
  return [...state.toasts, { id: toastId++, kind, text }].slice(-4);
}

function reducer(state: AppState, a: Action): AppState {
  switch (a.t) {
    case "enter": {
      const store = browserStorage();
      const existing = loadProgress(store);
      const name = a.name.trim();
      const progress = existing
        ? { ...existing, learnerName: name || existing.learnerName }
        : emptyProgress(name || "Analyst");
      saveProgress(store, progress);
      return { ...state, progress, view: "mission" };
    }
    case "gotoEntry":
      return { ...state, view: "entry" };
    case "gotoBadges":
      return { ...state, view: "badges" };
    case "gotoLearning":
      return { ...state, view: "learning" };
    case "resetProgress": {
      const store = browserStorage();
      resetProgressStore(store);
      const p = emptyProgress(state.progress?.learnerName ?? "Analyst");
      saveProgress(store, p);
      return { ...state, progress: p, attempt: null, result: null, view: "mission" };
    }
    case "setUnlockMode": {
      if (!state.progress) return state;
      const p = { ...state.progress, unlockMode: a.mode };
      saveProgress(browserStorage(), p);
      return { ...state, progress: p };
    }
    case "mission":
      return { ...state, view: "mission" };
    case "openScenario": {
      const scenario = getScenario(a.scenarioId);
      if (!scenario) return state;
      const prevNo = state.progress?.results[a.scenarioId]?.attempts ?? 0;
      const attemptNo = prevNo + 1;
      const { state: attemptState, customers } = createAttempt(scenario, attemptNo);
      const attempt: ActiveAttempt = {
        scenario,
        state: attemptState,
        customers,
        detectionRule: null,
        chat: [],
        wrongCounted: [],
        lastRetest: null,
        attemptNo,
      };
      return { ...state, attempt, activeScenarioId: a.scenarioId, result: null, view: "briefing" };
    }
    case "startScenario": {
      if (!state.attempt) return state;
      return withPhase(state, "recon");
    }
    case "setPhase":
      return withPhase(state, a.phase);
    case "setRole": {
      if (!state.attempt) return state;
      return patchAttempt(state, (at) => ({ state: { ...at.state, role: a.role } }));
    }
    case "chat": {
      if (!state.attempt) return state;
      return handleChat(state, a.prompt, a.attack);
    }
    case "toggleEvidence": {
      if (!state.attempt) return state;
      const cur = state.attempt.state.markedEvidenceIds;
      const next = cur.includes(a.eventId)
        ? cur.filter((x) => x !== a.eventId)
        : [...cur, a.eventId];
      return patchAttempt(state, (at) => ({ state: { ...at.state, markedEvidenceIds: next } }));
    }
    case "setGuardrail":
      return handleGuardrail(state, a.layer, a.key, a.value);
    case "useHint": {
      if (!state.attempt) return state;
      const s2 = patchAttempt(state, (at) => ({
        state: { ...at.state, hintsUsed: at.state.hintsUsed + 1 },
      }));
      return { ...s2, toasts: pushToast(s2, "amber", "Hint revealed (−5 points at Intermediate).") };
    }
    case "setMapFix":
      return patchAttempt(state, (at) => ({ state: { ...at.state, mapFixSelection: a.node } }));
    case "setReconPath":
      return patchAttempt(state, (at) => ({ state: { ...at.state, reconstructedPath: a.path } }));
    case "setDetectionRule":
      return patchAttempt(state, (at) => ({
        detectionRule: a.rule,
        state: { ...at.state, detectionRuleId: a.rule?.id ?? null },
      }));
    case "runRetest":
      return handleRetest(state);
    case "setReportInput":
      return patchAttempt(state, (at) => ({
        state: { ...at.state, reportInputs: { ...at.state.reportInputs, [a.key]: a.value } },
      }));
    case "setFrameworkPick":
      return patchAttempt(state, (at) => ({
        state: {
          ...at.state,
          reportFrameworkPick: { ...at.state.reportFrameworkPick, [a.kind]: a.values },
        },
      }));
    case "finalise":
      return handleFinalise(state);
    case "retake": {
      if (!state.activeScenarioId) return state;
      return reducer(state, { t: "openScenario", scenarioId: state.activeScenarioId });
    }
    case "toast":
      return { ...state, toasts: pushToast(state, a.kind, a.text) };
    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
    default:
      return state;
  }
}

function withPhase(state: AppState, phase: AttemptState["phase"]): AppState {
  if (!state.attempt) return state;
  const view: ViewKind = phase === "briefing" ? "briefing" : "workspace";
  return patchAttempt({ ...state, view }, (at) => ({ state: { ...at.state, phase } }));
}

function patchAttempt(
  state: AppState,
  fn: (at: ActiveAttempt) => Partial<ActiveAttempt>,
): AppState {
  if (!state.attempt) return state;
  const patch = fn(state.attempt);
  const attempt: ActiveAttempt = {
    ...state.attempt,
    ...patch,
    state: { ...(patch.state ?? state.attempt.state), updatedAt: Date.now() },
  };
  return { ...state, attempt };
}

function handleChat(state: AppState, prompt: string, attackId?: string): AppState {
  const at = state.attempt!;
  const { scenario } = at;
  const chat: ChatMsg[] = [...at.chat, { from: "user", text: prompt }];

  if (attackId) {
    const variant =
      attackId === "primary"
        ? scenario.attack
        : scenario.bypassVariants.find((v) => v.id === attackId) ?? scenario.attack;
    const r = runVariant(
      scenario,
      variant,
      at.state.guardrails,
      at.state.secrets,
      at.customers,
      new Rng(at.state.seed + chat.length),
    );
    chat.push({ from: "aero", text: r.responseText, vuln: r.outcome === "vulnerable", demo: r.demonstration });
    const logs =
      r.outcome === "vulnerable" ? [...at.state.logs, ...r.events] : at.state.logs;
    const attackSucceeded =
      at.state.attackSucceeded || (variant.id === scenario.attack.id && r.outcome === "vulnerable");
    const toastMsg =
      r.outcome === "vulnerable"
        ? "Attack succeeded — evidence written to the logs."
        : "Attack contained by your current defences.";
    const next = patchAttempt(state, () => ({
      chat,
      state: { ...at.state, logs, attackSucceeded },
    }));
    return { ...next, toasts: pushToast(next, r.outcome === "vulnerable" ? "red" : "green", toastMsg) };
  }

  // benign / freeform
  const benign = scenario.benignTests.find((b) => b.prompt === prompt);
  if (benign) {
    const r = runBenign(benign, at.state.guardrails);
    chat.push({ from: "aero", text: r.responseText });
  } else {
    chat.push({ from: "aero", text: `${BRAND.assistantName}: I can help with that — this is a safe, benign request.` });
  }
  return patchAttempt(state, () => ({ chat }));
}

function handleGuardrail(
  state: AppState,
  layer: keyof GuardrailConfig,
  key: string,
  value: unknown,
): AppState {
  const at = state.attempt!;
  const nextGuard: GuardrailConfig = {
    ...at.state.guardrails,
    [layer]: { ...(at.state.guardrails[layer] ?? {}), [key]: value as never },
  };
  // Count a newly-satisfied wrong-layer control once.
  let wrongCounted = at.wrongCounted;
  let wrongApplied = at.state.wrongLayerApplied;
  for (const wl of at.scenario.wrongLayerControls) {
    const tag = `${wl.layer}.${wl.key}`;
    const held = evalPredicate(nextGuard, wl);
    if (held && !wrongCounted.includes(tag)) {
      wrongCounted = [...wrongCounted, tag];
      wrongApplied += 1;
    }
  }
  const s2 = patchAttempt(state, () => ({
    wrongCounted,
    state: { ...at.state, guardrails: nextGuard, wrongLayerApplied: wrongApplied },
  }));
  if (wrongApplied > at.state.wrongLayerApplied) {
    return { ...s2, toasts: pushToast(s2, "amber", "That control is the wrong layer for this attack (−10).") };
  }
  return s2;
}

function handleRetest(state: AppState): AppState {
  const at = state.attempt!;
  const retest = runRetest(
    at.scenario,
    at.scenario.level,
    at.state.guardrails,
    at.state.secrets,
    at.customers,
    at.state.seed,
  );
  const s2 = patchAttempt(state, () => ({
    lastRetest: retest,
    state: {
      ...at.state,
      retests: at.state.retests + 1,
      retestHistory: [...at.state.retestHistory, retest],
      phase: retest.overall ? at.state.phase : "fix",
    },
  }));
  return {
    ...s2,
    toasts: pushToast(s2, retest.overall ? "green" : "red", retest.overall ? "Re-test passed." : retest.failureReason ?? "Re-test failed."),
  };
}

function handleFinalise(state: AppState): AppState {
  const at = state.attempt!;
  const out = finaliseScore(at.scenario, at.state, at.customers, at.detectionRule);
  const score = out.score;
  // record progress
  let progress = state.progress!;
  progress = recordResult(
    progress,
    at.scenario.id,
    score.total,
    score.passed,
    at.state.hintsUsed,
    at.state.wrongLayerApplied,
  );
  saveProgress(browserStorage(), progress);
  // admin feed
  void adminSink.send(buildAdminPayload(progress.learnerName, at.state, score));
  // newly-earned badges (for celebration toasts)
  const prevBadges = new Set(state.progress!.badges);
  const newBadges = progress.badges.filter((b) => !prevBadges.has(b));

  const result: FinalResult = {
    scenarioId: at.scenario.id,
    level: at.scenario.level,
    score,
    retest: out.retest,
    evidence: out.evidence,
    detection: out.detection,
    fixFraction: out.fixFraction,
    reportFraction: out.reportFraction,
  };
  const s2 = patchAttempt({ ...state, progress, result, view: "results" }, (a) => ({
    state: { ...a.state, score, completed: true, phase: "completed" },
  }));
  let toasts = pushToast(s2, score.passed ? "green" : "amber", `Scenario scored ${score.total}/100.`);
  for (const id of newBadges) {
    const def = BADGE_CATALOG.find((b) => b.id === id);
    toasts = [...toasts, { id: toastId++, kind: "green" as const, text: `🏅 Badge unlocked — ${def?.title ?? id}!` }].slice(-5);
  }
  return { ...s2, toasts };
}

/* --------------------------------- context -------------------------------- */

const initial: AppState = {
  progress: null,
  view: "entry",
  activeScenarioId: null,
  attempt: null,
  result: null,
  toasts: [],
};

interface Ctx {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  adminSink: LocalAdminFeedSink;
}

const AppCtx = createContext<Ctx | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial, (s): AppState => {
    const store = browserStorage();
    const existing = loadProgress(store);
    return existing ? { ...s, progress: existing, view: "mission" } : s;
  });
  const sinkRef = useRef(adminSink);
  const value = useMemo(() => ({ state, dispatch, adminSink: sinkRef.current }), [state]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp must be used within AppProvider");
  return c;
}

export { sid as scenarioId };
