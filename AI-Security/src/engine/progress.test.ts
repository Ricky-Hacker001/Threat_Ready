/* BIZ-08: only passed scenarios count towards the total, and re-tests in a discarded attempt are not wiped. */
import { describe, it, expect } from "vitest";
import { emptyProgress, passedScore, recordDiscarded, recordResult, totalScore, type ProgressState } from "./progress";
import { createAttempt, finaliseScore } from "./attempt";
import { runVariant } from "./pipeline";
import { Rng } from "./rng";
import { T1_F } from "@/scenarios/task1";
import type { GuardrailConfig } from "./types";

const set = (cfg: GuardrailConfig, layer: keyof GuardrailConfig, key: string, val: unknown): GuardrailConfig => ({
  ...cfg,
  [layer]: { ...(cfg[layer] ?? {}), [key]: val },
});

describe("total score", () => {
  it("a not-passed 'Finish anyway' adds nothing; a later pass adds its own score", () => {
    let p = emptyProgress("Tester");
    p = recordResult(p, "T1-F", 85, false, 0, 0);
    expect(totalScore(p)).toBe(0);
    expect(p.results["T1-F"].bestScore).toBe(85);
    p = recordResult(p, "T1-F", 72, true, 0, 0);
    expect(totalScore(p)).toBe(72);
    expect(passedScore(p.results["T1-F"])).toBe(72);
    // A higher not-passed score afterwards does not raise the counted score either.
    p = recordResult(p, "T1-F", 95, false, 0, 0);
    expect(totalScore(p)).toBe(72);
    p = recordResult(p, "T2-F", 80, true, 0, 0);
    expect(totalScore(p)).toBe(152);
  });

  it("records saved before the change count only when passed", () => {
    const p: ProgressState = {
      ...emptyProgress("Tester"),
      results: {
        "T1-F": { scenarioId: "T1-F", bestScore: 90, passed: true, attempts: 1, lastAt: 1, hintsUsed: 0, wrongLayer: 0 },
        "T2-F": { scenarioId: "T2-F", bestScore: 85, passed: false, attempts: 1, lastAt: 1, hintsUsed: 0, wrongLayer: 0 },
      },
    };
    expect(totalScore(p)).toBe(90);
  });
});

describe("discarded attempts", () => {
  it("an attempt with re-tests is recorded, and its re-tests carry over until the next finished attempt", () => {
    let p = emptyProgress("Tester");
    expect(recordDiscarded(p, "T1-F", 0)).toBe(p);
    p = recordDiscarded(p, "T1-F", 3);
    expect(p.results["T1-F"]).toMatchObject({ attempts: 1, discarded: 1, carriedRetests: 3, passed: false, bestScore: 0 });
    expect(totalScore(p)).toBe(0);
    p = recordDiscarded(p, "T1-F", 2);
    expect(p.results["T1-F"]).toMatchObject({ attempts: 2, discarded: 2, carriedRetests: 5 });
    p = recordResult(p, "T1-F", 80, true, 0, 0);
    expect(p.results["T1-F"]).toMatchObject({ attempts: 3, discarded: 2, carriedRetests: 0, passed: true });
  });

  it("carried re-tests count towards the failed re-test deduction", () => {
    const { state, customers } = createAttempt(T1_F, 2);
    const r = runVariant(T1_F, T1_F.attack, {}, state.secrets, customers, new Rng(state.seed + 1));
    state.logs.push(...r.events);
    state.attackSucceeded = true;
    state.markedEvidenceIds = state.logs.filter((e) => !e.noise).map((e) => e.id);
    state.guardrails = set(set({}, "systemPrompt", "secretsRemoved", true), "outputGuard", "echoBlock", true);
    state.retests = 1;
    const clean = finaliseScore(T1_F, state, customers, null).score;
    expect(clean.deductions).toBe(0);
    const carried = finaliseScore(T1_F, { ...state, carriedRetests: 4 }, customers, null).score;
    // 1 + 4 re-tests, the last one passing: 2 beyond the two free retries.
    expect(carried.deductions).toBe(10);
    expect(carried.total).toBe(clean.total - 10);
    expect(carried.lines.some((l) => l.includes("from a discarded attempt"))).toBe(true);
  });
});
