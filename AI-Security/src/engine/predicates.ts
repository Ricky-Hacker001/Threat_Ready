/** Safe, structured evaluation of ControlPredicates against a GuardrailConfig. */
import type { ControlPredicate, ControlValue, GuardrailConfig } from "./types";

export function getControl(
  cfg: GuardrailConfig,
  layer: ControlPredicate["layer"],
  key: string,
): ControlValue | undefined {
  const layerCfg = cfg[layer];
  if (!layerCfg) return undefined;
  return layerCfg[key];
}

function asNumber(v: ControlValue | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Evaluate one predicate. Never uses eval; only structured comparisons. */
export function evalPredicate(cfg: GuardrailConfig, p: ControlPredicate): boolean {
  const v = getControl(cfg, p.layer, p.key);
  switch (p.op) {
    case "exists":
      return v !== undefined;
    case "isTrue":
      return v === true;
    case "isFalse":
      return v === false || v === undefined;
    case "eq":
      return JSON.stringify(v) === JSON.stringify(p.expected);
    case "neq":
      return JSON.stringify(v) !== JSON.stringify(p.expected);
    case "gte": {
      const n = asNumber(v);
      return n !== undefined && typeof p.expected === "number" && n >= p.expected;
    }
    case "lte": {
      const n = asNumber(v);
      return n !== undefined && typeof p.expected === "number" && n <= p.expected;
    }
    case "gt": {
      const n = asNumber(v);
      return n !== undefined && typeof p.expected === "number" && n > p.expected;
    }
    case "lt": {
      const n = asNumber(v);
      return n !== undefined && typeof p.expected === "number" && n < p.expected;
    }
    case "listIncludes":
      return Array.isArray(v) && v.includes(p.expected as never);
    case "listExcludes":
      return Array.isArray(v) && !v.includes(p.expected as never);
    case "nonEmpty":
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "string") return v.trim().length > 0;
      return false;
    default:
      return false;
  }
}

export function allHold(cfg: GuardrailConfig, preds: ControlPredicate[]): boolean {
  return preds.every((p) => evalPredicate(cfg, p));
}

export function anyHold(cfg: GuardrailConfig, preds: ControlPredicate[]): boolean {
  return preds.some((p) => evalPredicate(cfg, p));
}

/** DNF containment: true when ANY inner group fully holds. */
export function anyGroupHolds(cfg: GuardrailConfig, groups: ControlPredicate[][]): boolean {
  if (groups.length === 0) return false;
  return groups.some((g) => allHold(cfg, g));
}

/** Fraction of predicates that hold — used for partial correct-layer credit. */
export function fractionHold(cfg: GuardrailConfig, preds: ControlPredicate[]): number {
  if (preds.length === 0) return 1;
  const n = preds.filter((p) => evalPredicate(cfg, p)).length;
  return n / preds.length;
}
