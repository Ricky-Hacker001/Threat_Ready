/** Validation engine: re-test, evidence, map selection, expert path. */
import { Rng } from "./rng";
import { allHold } from "./predicates";
import { runBenign, runVariant } from "./pipeline";
import type {
  AttemptSecrets,
  EvidenceSpec,
  GuardrailConfig,
  Level,
  LogEvent,
  MapConfig,
  NodeId,
  RetestResult,
  ScenarioConfig,
  SyntheticCustomer,
  TestResult,
} from "./types";

/** How many bypass variants are exercised at each level. */
export function variantCountFor(level: Level): number {
  return level === "foundation" ? 0 : level === "intermediate" ? 2 : 3;
}

export function runRetest(
  scenario: ScenarioConfig,
  level: Level,
  guardrails: GuardrailConfig,
  secrets: AttemptSecrets,
  customers: SyntheticCustomer[],
  seed: number,
): RetestResult {
  const results: TestResult[] = [];

  // 1. Original attack must be contained.
  const primary = runVariant(scenario, scenario.attack, guardrails, secrets, customers, new Rng(seed + 1));
  results.push({
    id: scenario.attack.id,
    label: `Original attack: ${scenario.attack.label}`,
    kind: "attack",
    passed: primary.outcome === "contained",
    detail:
      primary.outcome === "contained"
        ? "Blocked / safely contained."
        : "Still succeeds — the current defences do not stop it.",
  });

  // 2. Bypass variants (by level).
  const nVariants = variantCountFor(level);
  const variants = scenario.bypassVariants.slice(0, nVariants);
  variants.forEach((v, i) => {
    const r = runVariant(scenario, v, guardrails, secrets, customers, new Rng(seed + 10 + i));
    results.push({
      id: v.id,
      label: `Bypass variant: ${v.label}`,
      kind: "bypass",
      passed: r.outcome === "contained",
      detail: r.outcome === "contained" ? "Blocked." : "Bypass still works.",
    });
  });

  // 3. Expert chained path: ALL required controls must hold.
  if (level === "expert") {
    const chained = allHold(guardrails, scenario.requiredControls);
    results.push({
      id: "chain",
      label: "Chained attack path",
      kind: "chain",
      passed: chained,
      detail: chained
        ? "Full chain contained across every required layer."
        : "Chain not fully contained — at least one required layer is missing.",
    });
  }

  // 4. Benign suite must all still work.
  let overBlockCount = 0;
  for (const b of scenario.benignTests) {
    const r = runBenign(b, guardrails);
    const ok = r.outcome === "works";
    if (!ok) overBlockCount += 1;
    results.push({
      id: b.id,
      label: `Legitimate: ${b.label}`,
      kind: "benign",
      passed: ok,
      detail: ok ? "Still works." : "Blocked — over-blocking a real customer.",
    });
  }

  const attacksBlocked = results
    .filter((r) => r.kind === "attack" || r.kind === "bypass" || r.kind === "chain")
    .every((r) => r.passed);
  const benignOk = results.filter((r) => r.kind === "benign").every((r) => r.passed);
  const overall = attacksBlocked && benignOk;

  let failureReason: string | undefined;
  if (!overall) {
    if (!attacksBlocked) {
      const f = results.find((r) => (r.kind === "attack" || r.kind === "bypass" || r.kind === "chain") && !r.passed);
      failureReason = `Attack not contained: ${f?.label}. Fix the correct defensive layer and re-test.`;
    } else {
      const f = results.find((r) => r.kind === "benign" && !r.passed);
      failureReason = `A legitimate request was blocked: ${f?.label}. Loosen the over-aggressive control.`;
    }
  }

  return { ran: true, overall, results, overBlockCount, failureReason };
}

/* ----------------------------- evidence ------------------------------- */

export interface EvidenceVerdict {
  correct: number;
  required: number;
  fraction: number;
  wrongPicks: number;
}

export function judgeEvidence(
  markedIds: string[],
  logs: LogEvent[],
  spec: EvidenceSpec,
): EvidenceVerdict {
  const byId = new Map(logs.map((e) => [e.id, e]));
  const acceptedTags = new Set(spec.acceptedTags);
  const correctTags = new Set<string>();
  let wrongPicks = 0;
  for (const id of markedIds) {
    const e = byId.get(id);
    if (!e) continue;
    const hit = e.tags.find((t) => acceptedTags.has(t));
    if (hit) correctTags.add(hit);
    else wrongPicks += 1;
  }
  const correct = correctTags.size;
  const required = Math.max(spec.minRequired, spec.acceptedTags.length);
  return {
    correct,
    required,
    fraction: required === 0 ? 1 : Math.min(1, correct / required),
    wrongPicks,
  };
}

/* ----------------------------- map / path ----------------------------- */

export function judgeMapFix(selection: NodeId | null, map: MapConfig): boolean {
  return selection !== null && map.fix.includes(selection);
}

export function judgePath(reconstructed: NodeId[], acceptedPath: NodeId[]): number {
  if (acceptedPath.length === 0) return 1;
  let correct = 0;
  for (let i = 0; i < acceptedPath.length; i++) {
    if (reconstructed[i] === acceptedPath[i]) correct += 1;
  }
  return correct / acceptedPath.length;
}
