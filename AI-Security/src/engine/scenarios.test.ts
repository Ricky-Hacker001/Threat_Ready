/**
 * Generic acceptance tests across ALL 30 scenarios.
 * Encodes the design document's mandatory invariants so tasks 2–10 are verified,
 * not merely present.
 */
import { describe, it, expect } from "vitest";
import { allScenarios } from "@/scenarios";
import { createAttempt } from "./attempt";
import { runVariant, runBenign } from "./pipeline";
import { anyGroupHolds } from "./predicates";
import { variantCountFor } from "./validation";
import { Rng } from "./rng";
import type { ControlPredicate, GuardrailConfig, ScenarioConfig } from "./types";

/** Build a GuardrailConfig that satisfies a set of predicates. */
function satisfy(preds: ControlPredicate[], base: GuardrailConfig = {}): GuardrailConfig {
  const cfg: GuardrailConfig = JSON.parse(JSON.stringify(base));
  for (const p of preds) {
    const layer = (cfg[p.layer] = cfg[p.layer] ?? {});
    switch (p.op) {
      case "isTrue":
        layer[p.key] = true;
        break;
      case "isFalse":
        layer[p.key] = false;
        break;
      case "gte":
      case "lte":
      case "gt":
      case "lt":
      case "eq":
        layer[p.key] = (p.expected as never) ?? (0 as never);
        break;
      case "nonEmpty":
      case "listIncludes":
        layer[p.key] = [(p.expected as string) ?? "x"] as never;
        break;
      default:
        layer[p.key] = true;
        break;
    }
  }
  return cfg;
}

const scenarios = allScenarios();

describe("All 30 scenarios load", () => {
  it("has exactly 30 scenarios across 10 tasks × 3 levels", () => {
    expect(scenarios.length).toBe(30);
    const tasks = new Set(scenarios.map((s) => s.taskId));
    expect(tasks.size).toBe(10);
    for (let t = 1; t <= 10; t++) {
      const levels = scenarios.filter((s) => s.taskId === t).map((s) => s.level).sort();
      expect(levels).toEqual(["expert", "foundation", "intermediate"]);
    }
  });
});

describe.each(scenarios.map((s) => [s.id, s] as [string, ScenarioConfig]))(
  "Scenario %s invariants",
  (_id, s) => {
    const { state, customers } = createAttempt(s, 1);
    const initial = s.initialGuardrails ?? {};
    const required = satisfy(s.requiredControls, initial);

    it("primary attack is vulnerable before the fix", () => {
      const r = runVariant(s, s.attack, initial, state.secrets, customers, new Rng(1));
      expect(r.outcome).toBe("vulnerable");
    });

    it("the accepted evidence tags are producible across the attack sequence", () => {
      // Evidence may span the primary attack and its bypass variants (e.g. a
      // multi-turn expert attack), so check the union of what they plant.
      const tags = new Set<string>();
      for (const v of [s.attack, ...s.bypassVariants]) {
        const r = runVariant(s, v, initial, state.secrets, customers, new Rng(1));
        r.events.forEach((e) => e.tags.forEach((t) => tags.add(t)));
      }
      for (const t of s.evidence.acceptedTags) {
        expect(tags.has(t), `evidence tag ${t} is never produced`).toBe(true);
      }
    });

    it("the intended fix contains the primary attack and all exercised bypasses", () => {
      const prim = runVariant(s, s.attack, required, state.secrets, customers, new Rng(2));
      expect(prim.outcome).toBe("contained");
      const n = variantCountFor(s.level);
      for (const v of s.bypassVariants.slice(0, n)) {
        const r = runVariant(s, v, required, state.secrets, customers, new Rng(3));
        expect(r.outcome, `${v.id} should be contained`).toBe("contained");
      }
    });

    it("the intended fix does NOT over-block legitimate traffic", () => {
      for (const b of s.benignTests) {
        const r = runBenign(b, required);
        expect(r.outcome, `${b.id} should still work`).toBe("works");
      }
    });

    it("a wrong-layer control alone does not contain the primary attack", () => {
      if (s.wrongLayerControls.length === 0) return;
      const wrong = satisfy(s.wrongLayerControls, initial);
      const r = runVariant(s, s.attack, wrong, state.secrets, customers, new Rng(4));
      expect(r.outcome).toBe("vulnerable");
    });

    it("every bypass variant's defeatedBy is reachable from requiredControls", () => {
      const n = variantCountFor(s.level);
      for (const v of [s.attack, ...s.bypassVariants.slice(0, n)]) {
        expect(anyGroupHolds(required, v.defeatedBy), `${v.id} not covered by requiredControls`).toBe(true);
      }
    });
  },
);
