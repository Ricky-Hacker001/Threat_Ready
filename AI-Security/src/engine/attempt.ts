/** Attempt factory + scoring finaliser — ties the engine modules together. */
import { Rng, hashSeed } from "./rng";
import { makeCustomers, makeSecrets } from "./randomiser";
import { generateNoise } from "./logger";
import { fractionHold } from "./predicates";
import { judgeDetection, type DetectionRule } from "./detection";
import {
  judgeEvidence,
  judgePath,
  runRetest,
} from "./validation";
import { scoreAttempt } from "./scoring";
import type {
  AttemptState,
  Level,
  ScenarioConfig,
  SyntheticCustomer,
} from "./types";

export interface AttemptBundle {
  state: AttemptState;
  customers: SyntheticCustomer[];
}

export function createAttempt(
  scenario: ScenarioConfig,
  attemptNo: number,
  noiseCount = 520,
): AttemptBundle {
  const seed = hashSeed(scenario.id, attemptNo, Date.now() % 100000);
  const rng = new Rng(seed);
  const secrets = makeSecrets(rng);
  const customers = makeCustomers(rng, 200);
  const logs = generateNoise(scenario, rng, noiseCount);

  const state: AttemptState = {
    attemptId: `att_${seed.toString(36)}_${attemptNo}`,
    scenarioId: scenario.id,
    level: scenario.level,
    seed,
    role: scenario.role,
    phase: "briefing",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    secrets,
    logs,
    attackSucceeded: false,
    markedEvidenceIds: [],
    detectionRuleId: null,
    guardrails: structuredCloneSafe(scenario.initialGuardrails ?? {}),
    mapFixSelection: null,
    reconstructedPath: [],
    reportInputs: {},
    reportFrameworkPick: { owasp: [], atlas: [], iso: [] },
    hintsUsed: 0,
    wrongLayerApplied: 0,
    retestHistory: [],
    retests: 0,
    score: null,
    completed: false,
  };
  return { state, customers };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Compute the final score for an attempt in its current state. */
export function finaliseScore(
  scenario: ScenarioConfig,
  state: AttemptState,
  customers: SyntheticCustomer[],
  detectionRule: DetectionRule | null,
) {
  const level: Level = scenario.level;

  const retest = runRetest(scenario, level, state.guardrails, state.secrets, customers, state.seed);

  const evidence = judgeEvidence(state.markedEvidenceIds, state.logs, scenario.evidence);

  const detection = judgeDetection(detectionRule, state.logs, scenario.detection);

  const fixFraction = fractionHold(state.guardrails, scenario.requiredControls);

  // Expert report quality = mean of path accuracy, framework-pick accuracy, completeness.
  let reportFraction = 0;
  if (level === "expert") {
    const pathAcc = judgePath(state.reconstructedPath, scenario.report.acceptedPath);
    const fwAcc = frameworkAccuracy(scenario, state);
    const completeness = reportCompleteness(state);
    reportFraction = (pathAcc + fwAcc + completeness) / 3;
  }

  // Re-tests from discarded attempts at this scenario count too (BIZ-08): discarding does not reset the allowance.
  const carried = state.carriedRetests ?? 0;
  const failedAfterSecond = Math.max(0, state.retests + carried - 2 - (retest.overall ? 1 : 0));

  const points = scoreAttempt({
    level,
    attackSucceeded: state.attackSucceeded,
    evidenceFraction: evidence.fraction,
    detectionOk: detection.ok,
    fixFraction,
    retestPassed: retest.overall,
    overBlockCount: retest.overBlockCount,
    reportFraction,
    hintsUsed: state.hintsUsed,
    wrongLayerApplied: state.wrongLayerApplied,
    failedRetestsAfterSecond: failedAfterSecond,
    carriedRetests: carried,
  });

  // A learner may finish with a failed re-test ("Finish anyway"); that attempt is recorded as not
  // passed even if its points would reach the pass mark, since the fix was never proven.
  const score =
    !retest.overall && points.passed
      ? { ...points, passed: false, lines: [...points.lines, "Not passed: the re-test failed, so the fix is not proven."] }
      : points;

  return { score, retest, evidence, detection, fixFraction, reportFraction };
}

function frameworkAccuracy(scenario: ScenarioConfig, state: AttemptState): number {
  const want = scenario.report;
  const pick = state.reportFrameworkPick;
  const parts = [
    setAccuracy(pick.owasp, want.owasp),
    setAccuracy(pick.atlas, want.atlas),
    setAccuracy(pick.iso, want.iso),
  ];
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function setAccuracy(picked: string[], want: string[]): number {
  if (want.length === 0) return 1;
  const w = new Set(want);
  const correct = picked.filter((x) => w.has(x)).length;
  const wrong = picked.filter((x) => !w.has(x)).length;
  // reward correct, penalise padding with unrelated frameworks
  return Math.max(0, Math.min(1, (correct - wrong * 0.5) / want.length));
}

function reportCompleteness(state: AttemptState): number {
  const required = ["summary", "rootCause", "impact", "containment", "remediation"];
  const filled = required.filter((k) => (state.reportInputs[k] ?? "").trim().length >= 12).length;
  return filled / required.length;
}
