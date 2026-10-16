/**
 * Structured detection-rule model + safe evaluator.
 * Rules are data, never code. They run against the scenario's synthetic logs.
 */
import type { DetectionSpec, LogEvent, LogType, Severity } from "./types";

export type RuleOp =
  | "eq"
  | "neq"
  | "contains"
  | "notContains"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "exists";

export interface RuleCondition {
  field: string; // a key inside LogEvent.fields (or "severity"/"type")
  op: RuleOp;
  value?: string | number | boolean;
}

export interface DetectionRule {
  id: string;
  name: string;
  description: string;
  logSource: LogType | "any";
  conditions: RuleCondition[];
  combine: "and" | "or";
  /** Optional aggregation: count events grouped by this field within the window. */
  aggregationField?: string; // "sessionId" or a fields key
  threshold?: number;
  timeWindowMin?: number;
  severity: Severity;
}

function fieldValue(e: LogEvent, field: string): unknown {
  if (field === "severity") return e.severity;
  if (field === "type") return e.type;
  if (field === "sessionId") return e.sessionId;
  return e.fields[field];
}

function matchCondition(e: LogEvent, c: RuleCondition): boolean {
  const v = fieldValue(e, c.field);
  switch (c.op) {
    case "exists":
      return v !== undefined && v !== null;
    case "eq":
      return String(v) === String(c.value);
    case "neq":
      return String(v) !== String(c.value);
    case "contains":
      return typeof v === "string" && v.toLowerCase().includes(String(c.value).toLowerCase());
    case "notContains":
      return !(typeof v === "string" && v.toLowerCase().includes(String(c.value).toLowerCase()));
    case "gt":
      return typeof v === "number" && typeof c.value === "number" && v > c.value;
    case "lt":
      return typeof v === "number" && typeof c.value === "number" && v < c.value;
    case "gte":
      return typeof v === "number" && typeof c.value === "number" && v >= c.value;
    case "lte":
      return typeof v === "number" && typeof c.value === "number" && v <= c.value;
    default:
      return false;
  }
}

function matchEvent(e: LogEvent, rule: DetectionRule): boolean {
  if (rule.logSource !== "any" && e.type !== rule.logSource) return false;
  if (rule.conditions.length === 0) return false;
  const results = rule.conditions.map((c) => matchCondition(e, c));
  return rule.combine === "and" ? results.every(Boolean) : results.some(Boolean);
}

export interface RuleEvalResult {
  matched: LogEvent[];
  matchedNoise: number;
  /** When aggregation is used, the groups that met the threshold. */
  firedGroups: string[];
}

/** Evaluate a rule against logs. Supports simple count-aggregation + window. */
export function evaluateRule(rule: DetectionRule, logs: LogEvent[]): RuleEvalResult {
  const perEvent = logs.filter((e) => matchEvent(e, rule));

  if (rule.aggregationField && rule.threshold && rule.threshold > 1) {
    const windowMs = (rule.timeWindowMin ?? 60) * 60 * 1000;
    const byGroup = new Map<string, LogEvent[]>();
    for (const e of perEvent) {
      const key = String(fieldValue(e, rule.aggregationField) ?? "∅");
      const arr = byGroup.get(key) ?? [];
      arr.push(e);
      byGroup.set(key, arr);
    }
    const matched: LogEvent[] = [];
    const firedGroups: string[] = [];
    for (const [key, arr] of byGroup) {
      arr.sort((a, b) => a.ts - b.ts);
      // sliding window count
      let fired = false;
      for (let i = 0; i < arr.length; i++) {
        let j = i;
        while (j < arr.length && arr[j].ts - arr[i].ts <= windowMs) j++;
        if (j - i >= rule.threshold) {
          fired = true;
          break;
        }
      }
      if (fired) {
        firedGroups.push(key);
        matched.push(...arr);
      }
    }
    return {
      matched,
      matchedNoise: matched.filter((e) => e.noise).length,
      firedGroups,
    };
  }

  return {
    matched: perEvent,
    matchedNoise: perEvent.filter((e) => e.noise).length,
    firedGroups: [],
  };
}

/** Does the rule satisfy the scenario's detection requirements? */
export interface DetectionVerdict {
  ok: boolean;
  caughtAllTargets: boolean;
  tooNoisy: boolean;
  missingTags: string[];
  noiseMatches: number;
}

export function judgeDetection(
  rule: DetectionRule | null,
  logs: LogEvent[],
  spec: DetectionSpec,
): DetectionVerdict {
  if (!spec.required) {
    return { ok: true, caughtAllTargets: true, tooNoisy: false, missingTags: [], noiseMatches: 0 };
  }
  if (!rule) {
    return {
      ok: false,
      caughtAllTargets: false,
      tooNoisy: false,
      missingTags: spec.mustMatchTags.slice(),
      noiseMatches: 0,
    };
  }
  const res = evaluateRule(rule, logs);
  const matchedTags = new Set<string>();
  for (const e of res.matched) for (const t of e.tags) matchedTags.add(t);
  const missingTags = spec.mustMatchTags.filter((t) => !matchedTags.has(t));
  const caughtAllTargets = missingTags.length === 0;
  const tooNoisy = res.matchedNoise > spec.maxBenignMatches;
  return {
    ok: caughtAllTargets && !tooNoisy,
    caughtAllTargets,
    tooNoisy,
    missingTags,
    noiseMatches: res.matchedNoise,
  };
}
