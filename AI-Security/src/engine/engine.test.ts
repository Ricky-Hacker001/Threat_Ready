import { describe, it, expect } from "vitest";
import { createAttempt, finaliseScore } from "./attempt";
import { runVariant, runBenign } from "./pipeline";
import { Rng } from "./rng";
import type { DetectionRule } from "./detection";
import { T1_F, T1_I, T1_E } from "@/scenarios/task1";
import * as C from "@/scenarios/controls";
import {
  unlockStatus,
  emptyProgress,
  recordResult,
  scenarioId,
  memoryStorage,
  saveProgress,
  loadProgress,
  saveSession,
  loadSession,
  resetProgress,
} from "./progress";
import type { GuardrailConfig } from "./types";

function set(cfg: GuardrailConfig, layer: keyof GuardrailConfig, key: string, val: unknown): GuardrailConfig {
  return { ...cfg, [layer]: { ...(cfg[layer] ?? {}), [key]: val } };
}

describe("Task 1 Foundation — attack, fix, benign", () => {
  const { state, customers } = createAttempt(T1_F, 1);

  it("attack succeeds with defences off", () => {
    const r = runVariant(T1_F, T1_F.attack, {}, state.secrets, customers, new Rng(1));
    expect(r.outcome).toBe("vulnerable");
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.responseText).toContain(state.secrets.canary);
  });

  it("removing secrets alone contains it (DNF)", () => {
    const cfg = set({}, "systemPrompt", "secretsRemoved", true);
    const r = runVariant(T1_F, T1_F.attack, cfg, state.secrets, customers, new Rng(1));
    expect(r.outcome).toBe("contained");
  });

  it("echo block alone also contains it", () => {
    const cfg = set({}, "outputGuard", "echoBlock", true);
    const r = runVariant(T1_F, T1_F.attack, cfg, state.secrets, customers, new Rng(1));
    expect(r.outcome).toBe("contained");
  });

  it("wrong-layer keyword block does NOT contain it", () => {
    const cfg = set({}, "inputGuard", "blockWords", ["instructions", "system prompt"]);
    const r = runVariant(T1_F, T1_F.attack, cfg, state.secrets, customers, new Rng(1));
    expect(r.outcome).toBe("vulnerable");
  });

  it("over-broad block words break a benign request", () => {
    const cfg = set({}, "inputGuard", "blockWords", ["hours"]);
    const b = runBenign(T1_F.benignTests[0], cfg);
    expect(b.outcome).toBe("blocked");
  });
});

describe("Task 1 Foundation — full correct play scores a pass", () => {
  it("marks evidence + both controls -> >=70", () => {
    const { state, customers } = createAttempt(T1_F, 2);
    // run the attack to plant evidence
    const r = runVariant(T1_F, T1_F.attack, {}, state.secrets, customers, new Rng(state.seed + 1));
    state.logs.push(...r.events);
    state.attackSucceeded = true;
    // mark the two accepted evidence events
    const ev = state.logs.filter((e) => !e.noise);
    state.markedEvidenceIds = ev.map((e) => e.id);
    // apply both required controls
    state.guardrails = set(set({}, "systemPrompt", "secretsRemoved", true), "outputGuard", "echoBlock", true);
    const { score } = finaliseScore(T1_F, state, customers, null);
    expect(score.total).toBeGreaterThanOrEqual(70);
    expect(score.passed).toBe(true);
  });

  it("only one control -> fails to pass (partial fix, attack maybe contained but low fix credit)", () => {
    const { state, customers } = createAttempt(T1_F, 3);
    const r = runVariant(T1_F, T1_F.attack, {}, state.secrets, customers, new Rng(state.seed + 1));
    state.logs.push(...r.events);
    state.attackSucceeded = true;
    state.guardrails = set({}, "outputGuard", "echoBlock", true); // only one of two required
    const { score } = finaliseScore(T1_F, state, customers, null);
    // fix credit is only ~half; no evidence marked -> should be below pass
    expect(score.total).toBeLessThan(70);
  });
});

describe("Task 1 Intermediate — detection rule + layered fix", () => {
  it("plain echo block fails the translated bypass; fuzzy contains it", () => {
    const { state, customers } = createAttempt(T1_I, 1);
    const plain = set(set(T1_I.initialGuardrails ?? {}, "outputGuard", "echoBlock", true), "systemPrompt", "secretsRemoved", false);
    const r1 = runVariant(T1_I, T1_I.attack, plain, state.secrets, customers, new Rng(1));
    expect(r1.outcome).toBe("vulnerable");
    const fuzzy = set(plain, "outputGuard", "echoBlockFuzzy", true);
    const r2 = runVariant(T1_I, T1_I.attack, fuzzy, state.secrets, customers, new Rng(1));
    expect(r2.outcome).toBe("contained");
  });

  it("a canary detection rule catches the leak without excess noise", () => {
    const { state, customers } = createAttempt(T1_I, 2);
    const r = runVariant(T1_I, T1_I.attack, T1_I.initialGuardrails ?? {}, state.secrets, customers, new Rng(state.seed + 1));
    state.logs.push(...r.events);
    const rule: DetectionRule = {
      id: "r1",
      name: "Canary leak",
      description: "Responses where the canary leaked",
      logSource: "response",
      conditions: [{ field: "canaryHit", op: "eq", value: "true" }],
      combine: "and",
      severity: "critical",
    };
    const { detection } = finaliseScore(T1_I, state, customers, rule);
    expect(detection.ok).toBe(true);
  });

  it("finishing with a failed re-test is never a pass, even at 70+ points", () => {
    const { state, customers } = createAttempt(T1_I, 3);
    const r = runVariant(T1_I, T1_I.attack, T1_I.initialGuardrails ?? {}, state.secrets, customers, new Rng(state.seed + 1));
    state.logs.push(...r.events);
    state.attackSucceeded = true;
    state.markedEvidenceIds = state.logs.filter((e) => !e.noise).map((e) => e.id);
    let cfg: GuardrailConfig = T1_I.initialGuardrails ?? {};
    cfg = set(cfg, "systemPrompt", "secretsRemoved", true);
    cfg = set(cfg, "outputGuard", "echoBlock", true);
    cfg = set(cfg, "outputGuard", "echoBlockFuzzy", true);
    // Every required control, but an over-broad block word breaks "support hours": the re-test fails.
    cfg = set(cfg, "inputGuard", "blockWords", ["system prompt", "instructions", "hours"]);
    state.guardrails = cfg;
    const rule: DetectionRule = {
      id: "r2",
      name: "Canary leak",
      description: "",
      logSource: "response",
      conditions: [{ field: "canaryHit", op: "eq", value: "true" }],
      combine: "and",
      severity: "critical",
    };
    const { score, retest } = finaliseScore(T1_I, state, customers, rule);
    expect(retest.overall).toBe(false);
    expect(score.total).toBeGreaterThanOrEqual(70);
    expect(score.passed).toBe(false);
    expect(score.lines.some((l) => l.includes("re-test failed"))).toBe(true);
  });
});

describe("Task 1 Expert — chained fix required", () => {
  it("one layer is not enough; all three contain the chain", () => {
    const { state, customers } = createAttempt(T1_E, 1);
    const oneLayer = set({}, "systemPrompt", "secretsRemoved", true);
    const r1 = runVariant(T1_E, T1_E.attack, oneLayer, state.secrets, customers, new Rng(1));
    // secretsRemoved + refundServerSide needed together; secrets alone not enough here
    expect(r1.outcome).toBe("vulnerable");

    let full: GuardrailConfig = {};
    full = set(full, "systemPrompt", "secretsRemoved", true);
    full = set(full, "outputGuard", "echoBlock", true);
    full = set(full, "agentTools", "refundServerSideCheck", true);
    const r2 = runVariant(T1_E, T1_E.attack, full, state.secrets, customers, new Rng(1));
    expect(r2.outcome).toBe("contained");
  });
});

describe("Randomisation varies across attempts but keys stay valid", () => {
  it("three attempts produce different canaries", () => {
    const a = createAttempt(T1_F, 1).state.secrets.canary;
    const b = createAttempt(T1_F, 2).state.secrets.canary;
    const c = createAttempt(T1_F, 3).state.secrets.canary;
    const uniq = new Set([a, b, c]);
    expect(uniq.size).toBeGreaterThanOrEqual(2);
  });
  it("noise count >= 500", () => {
    const { state } = createAttempt(T1_F, 1);
    expect(state.logs.length).toBeGreaterThanOrEqual(500);
  });
});

describe("Unlock rules + badges", () => {
  it("intermediate locked until foundation passes", () => {
    let p = emptyProgress("Tester");
    expect(unlockStatus(p, 1, "intermediate").unlocked).toBe(false);
    p = recordResult(p, scenarioId(1, "foundation"), 85, true, 0, 0);
    expect(unlockStatus(p, 1, "intermediate").unlocked).toBe(true);
    expect(unlockStatus(p, 1, "expert").unlocked).toBe(false);
  });
  it("foundation badge needs all 10 tasks", () => {
    let p = emptyProgress("Tester");
    for (let t = 1; t <= 10; t++) p = recordResult(p, scenarioId(t, "foundation"), 80, true, 0, 0);
    expect(p.badges).toContain("AI Security Foundations");
  });
  it("progress round-trips through storage", () => {
    const store = memoryStorage();
    let p = emptyProgress("Tester");
    p = recordResult(p, scenarioId(1, "foundation"), 90, true, 1, 0);
    saveProgress(store, p);
    const back = loadProgress(store);
    expect(back?.results["T1-F"].bestScore).toBe(90);
  });
  it("the attempt in progress round-trips through storage and is cleared by a reset", () => {
    const store = memoryStorage();
    const { state } = createAttempt(T1_F, 1);
    saveSession(store, { v: 1, attempt: { scenarioId: "T1-F", state } });
    const back = loadSession<{ attempt: { scenarioId: string; state: typeof state } }>(store);
    expect(back?.attempt.scenarioId).toBe("T1-F");
    expect(back?.attempt.state.logs.length).toBe(state.logs.length);
    resetProgress(store);
    expect(loadSession(store)).toBeNull();
  });
});

describe("Wrong-layer fix is penalised via scoring input", () => {
  it("applying a wrong-layer control reduces the score", () => {
    const { state, customers } = createAttempt(T1_F, 9);
    const r = runVariant(T1_F, T1_F.attack, {}, state.secrets, customers, new Rng(state.seed + 1));
    state.logs.push(...r.events);
    state.attackSucceeded = true;
    state.markedEvidenceIds = state.logs.filter((e) => !e.noise).map((e) => e.id);
    state.guardrails = set(set({}, "systemPrompt", "secretsRemoved", true), "outputGuard", "echoBlock", true);
    state.wrongLayerApplied = 1; // learner also tried keyword blocking first
    const { score } = finaliseScore(T1_F, state, customers, null);
    expect(score.deductions).toBeGreaterThanOrEqual(10);
  });
});

// keep C referenced so unused-import lint stays quiet in strict builds
void C;
