/* Central application state: attempt state machine + progress + navigation. */
import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from "react";
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
  loadSession,
  saveSession,
  recordResult,
  resetProgress as resetProgressStore,
  scenarioId as sid,
  BADGE_CATALOG,
  type ProgressState,
  type UnlockMode,
} from "@/engine/progress";
import { getScenario } from "@/scenarios";
import { BRAND } from "@/brand/brand";
import { hashOf, isWorkspaceTab, parseHash, type Route, type WorkspaceTab } from "./routes";

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
  /** Decorative glyph shown before the text (hidden from screen readers). */
  icon?: string;
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
  /** The workspace tab (part of the route, so reload and Back return to it). */
  tab: WorkspaceTab;
  /** "Exit to Mission Control" was asked for mid-attempt and awaits confirmation. */
  confirmExit: boolean;
}

/** An attempt that has been started and not yet finished (and so is worth resuming). */
export function attemptInProgress(at: ActiveAttempt | null): at is ActiveAttempt {
  return !!at && !at.state.completed && at.state.phase !== "briefing";
}

type Action =
  | { t: "enter"; name: string }
  | { t: "resetProgress" }
  | { t: "setUnlockMode"; mode: UnlockMode }
  | { t: "mission" }
  | { t: "requestExit" }
  | { t: "cancelExit" }
  | { t: "gotoEntry" }
  | { t: "gotoBadges" }
  | { t: "gotoLearning" }
  | { t: "route"; route: Route | null }
  /** Resumes the attempt in progress on this scenario, if any; `fresh` always starts a new one. */
  | { t: "openScenario"; scenarioId: string; fresh?: boolean }
  | { t: "discardAttempt" }
  | { t: "setTab"; tab: WorkspaceTab }
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
  | { t: "setPhase"; phase: AttemptState["phase"]; tab?: WorkspaceTab }
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
      return { ...state, view: "mission", confirmExit: false };
    case "requestExit":
      // Leaving keeps the attempt (it can be resumed), but ask first so it isn't left by accident.
      return attemptInProgress(state.attempt) && (state.view === "briefing" || state.view === "workspace")
        ? { ...state, confirmExit: true }
        : { ...state, view: "mission" };
    case "cancelExit":
      return { ...state, confirmExit: false };
    case "route":
      return applyRoute(state, a.route);
    case "discardAttempt":
      return { ...state, attempt: null };
    case "setTab":
      return { ...state, tab: a.tab };
    case "openScenario": {
      const scenario = getScenario(a.scenarioId);
      if (!scenario) return state;
      const cur = state.attempt;
      if (!a.fresh && cur && cur.scenario.id === a.scenarioId && !cur.state.completed) {
        return {
          ...state,
          activeScenarioId: a.scenarioId,
          view: cur.state.phase === "briefing" ? "briefing" : "workspace",
        };
      }
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
      return { ...state, attempt, activeScenarioId: a.scenarioId, result: null, view: "briefing", tab: "target" };
    }
    case "startScenario": {
      if (!state.attempt) return state;
      // Back to the briefing of an attempt already under way: carry on where it was.
      if (state.attempt.state.phase !== "briefing") return { ...state, view: "workspace" };
      return withPhase(state, "recon");
    }
    case "setPhase": {
      const s2 = withPhase(state, a.phase);
      return a.tab ? { ...s2, tab: a.tab } : s2;
    }
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
      return reducer(state, { t: "openScenario", scenarioId: state.activeScenarioId, fresh: true });
    }
    case "toast":
      return { ...state, toasts: pushToast(state, a.kind, a.text) };
    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) };
    default:
      return state;
  }
}

/** The view for a route (from the URL on load, or Back/Forward), falling back to Mission Control. */
function applyRoute(state: AppState, r: Route | null): AppState {
  const s = { ...state, confirmExit: false };
  if (!s.progress) return { ...s, view: "entry" };
  if (!r) return { ...s, view: "mission" };
  switch (r.view) {
    case "entry":
    case "mission":
    case "badges":
    case "learning":
      return { ...s, view: r.view };
    case "briefing":
    case "workspace": {
      const at = s.attempt;
      // Only the attempt in progress can be returned to; a finished one is not reopened for edits.
      if (!at || at.scenario.id !== r.scenarioId || at.state.completed) return { ...s, view: "mission" };
      if (r.view !== "workspace" || at.state.phase === "briefing") return { ...s, view: "briefing", activeScenarioId: at.scenario.id };
      return { ...s, view: "workspace", tab: r.tab, activeScenarioId: at.scenario.id };
    }
    case "results":
      return s.result && s.result.scenarioId === r.scenarioId ? { ...s, view: "results" } : { ...s, view: "mission" };
  }
}

/** The route the current state shows. */
export function routeOf(state: AppState): Route {
  const id = state.attempt?.scenario.id;
  if ((state.view === "briefing" || state.view === "workspace") && id) {
    return state.view === "briefing" ? { view: "briefing", scenarioId: id } : { view: "workspace", scenarioId: id, tab: state.tab };
  }
  if (state.view === "results" && state.result) return { view: "results", scenarioId: state.result.scenarioId };
  if (state.view === "entry" || state.view === "badges" || state.view === "learning") return { view: state.view };
  return { view: "mission" };
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
    toasts = [...toasts, { id: toastId++, kind: "green" as const, icon: "🏅", text: `Badge unlocked — ${def?.title ?? id}!` }].slice(-5);
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
  tab: "target",
  confirmExit: false,
};

/* ------------------------------ persistence ------------------------------- */

/** What survives a reload (per account, beside progress). The scenario itself is looked up by id. */
interface SavedSession {
  v: 1;
  attempt: (Omit<ActiveAttempt, "scenario"> & { scenarioId: string }) | null;
  result: FinalResult | null;
  activeScenarioId: string | null;
  tab: WorkspaceTab;
}

function toSaved(state: AppState): SavedSession {
  const at = state.attempt;
  let attempt: SavedSession["attempt"] = null;
  if (at) {
    const { scenario, ...rest } = at;
    attempt = { ...rest, scenarioId: scenario.id };
  }
  return { v: 1, attempt, result: state.result, activeScenarioId: state.activeScenarioId, tab: state.tab };
}

function restoreSession(): Pick<AppState, "attempt" | "result" | "activeScenarioId" | "tab"> | null {
  const saved = loadSession<SavedSession>(browserStorage());
  if (!saved || saved.v !== 1) return null;
  let attempt: ActiveAttempt | null = null;
  if (saved.attempt?.state && Array.isArray(saved.attempt.state.logs)) {
    const { scenarioId, ...rest } = saved.attempt;
    const scenario = getScenario(scenarioId);
    if (scenario) attempt = { ...rest, scenario };
  }
  const result = saved.result && getScenario(saved.result.scenarioId) ? saved.result : null;
  return {
    attempt,
    result,
    activeScenarioId: typeof saved.activeScenarioId === "string" ? saved.activeScenarioId : null,
    tab: isWorkspaceTab(saved.tab) ? saved.tab : "target",
  };
}

function initState(s: AppState): AppState {
  const existing = loadProgress(browserStorage());
  if (!existing) return s;
  const restored = { ...s, progress: existing, ...(restoreSession() ?? {}) };
  // Reload lands on the view in the URL (the attempt in progress, its tab, the results…).
  return applyRoute(restored, parseHash(window.location.hash));
}

interface Ctx {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  adminSink: LocalAdminFeedSink;
}

const AppCtx = createContext<Ctx | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial, initState);
  const sinkRef = useRef(adminSink);
  usePersistSession(state);
  useHashRoute(state, dispatch);
  const value = useMemo(() => ({ state, dispatch, adminSink: sinkRef.current }), [state]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/**
 * Keeps the attempt in progress (evidence, guardrails, chat, re-tests…) in storage so a reload
 * resumes it. Writes are debounced (an attempt carries ~200 KB of logs) and flushed when the page
 * is hidden or unloaded.
 */
function usePersistSession(state: AppState) {
  const latest = useRef(state);
  const dirty = useRef(false);
  latest.current = state;

  useEffect(() => {
    const flush = () => {
      if (!dirty.current || !latest.current.progress) return;
      dirty.current = false;
      saveSession(browserStorage(), toSaved(latest.current));
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, []);

  useEffect(() => {
    if (!state.progress) return;
    dirty.current = true;
    const timer = window.setTimeout(() => {
      dirty.current = false;
      saveSession(browserStorage(), toSaved(latest.current));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [state.progress, state.attempt, state.result, state.activeScenarioId, state.tab]);
}

/**
 * Mirrors the view in the URL hash (push for a new screen, replace for a tab switch or a redirect)
 * and follows Back/Forward, so browser history moves between the lab's screens.
 */
function useHashRoute(state: AppState, dispatch: React.Dispatch<Action>) {
  const prev = useRef<Route | null>(null);
  /** The hash already handled, so popstate + hashchange for one navigation act once. */
  const handled = useRef<string | null>(null);
  /** The current entry came from the URL (load, Back/Forward): correct it in place, don't push. */
  const fromUrl = useRef(true);

  useEffect(() => {
    const onNav = () => {
      const h = window.location.hash;
      if (h === handled.current) return;
      handled.current = h;
      fromUrl.current = true;
      dispatch({ t: "route", route: parseHash(h) });
    };
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    return () => {
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
    };
  }, [dispatch]);

  useEffect(() => {
    const route = routeOf(state);
    const want = hashOf(route);
    const before = prev.current;
    prev.current = route;
    if (window.location.hash !== want) {
      const sameScreen =
        !!before &&
        before.view === route.view &&
        ("scenarioId" in before ? before.scenarioId : "") === ("scenarioId" in route ? route.scenarioId : "");
      const replace =
        fromUrl.current ||
        sameScreen || // a workspace tab switch
        before?.view === "entry" || // entering the lab; Back shouldn't return to the name screen
        (before?.view === "workspace" && route.view === "results"); // a finished attempt isn't re-entered
      const url = window.location.pathname + window.location.search + want;
      if (replace) window.history.replaceState(window.history.state, "", url);
      else window.history.pushState(null, "", url);
    }
    handled.current = want;
    fromUrl.current = false;
  });
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp must be used within AppProvider");
  return c;
}

export { sid as scenarioId };
