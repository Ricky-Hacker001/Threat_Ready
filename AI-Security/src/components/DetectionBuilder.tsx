import React, { useState } from "react";
import { useApp } from "@/state/store";
import { evaluateRule, type DetectionRule, type RuleCondition, type RuleOp } from "@/engine/detection";

const OPS: RuleOp[] = ["eq", "neq", "contains", "notContains", "gt", "lt", "gte", "lte", "exists"];
const SOURCES = ["any", "prompt", "response", "retrieval", "toolcall", "usage", "supplychain"] as const;
const FIELDS: Record<string, string[]> = {
  prompt: ["prompt", "role", "inputFilter", "ip"],
  response: ["response", "canaryHit", "policyViolation", "outputFilter"],
  retrieval: ["role", "docId", "classification", "ownerId", "acl", "chunk"],
  toolcall: ["tool", "callerRole", "approval", "externalDest", "args"],
  usage: ["user", "inTokens", "outTokens", "costINR", "ip"],
  supplychain: ["artefact", "source", "hash", "scan", "load"],
  any: ["severity", "type", "sessionId"],
};

export function DetectionBuilder() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const spec = at.scenario.detection;
  const existing = at.detectionRule;

  const [name, setName] = useState(existing?.name ?? "");
  const [source, setSource] = useState<(typeof SOURCES)[number]>((existing?.logSource as never) ?? "response");
  const [conds, setConds] = useState<RuleCondition[]>(
    existing?.conditions ?? [{ field: "canaryHit", op: "eq", value: "true" }],
  );
  const [combine, setCombine] = useState<"and" | "or">(existing?.combine ?? "and");
  const [useAgg, setUseAgg] = useState(Boolean(existing?.aggregationField));
  const [aggField, setAggField] = useState(existing?.aggregationField ?? "sessionId");
  const [threshold, setThreshold] = useState(existing?.threshold ?? 2);
  const [windowMin, setWindowMin] = useState(existing?.timeWindowMin ?? 60);
  const [tested, setTested] = useState<ReturnType<typeof evaluateRule> | null>(null);

  if (!spec.required) {
    return (
      <div className="card">
        <h3>Detection Rule Builder</h3>
        <p className="muted">No detection rule is required at Foundation level for this task.</p>
      </div>
    );
  }

  const buildRule = (): DetectionRule => ({
    id: existing?.id ?? `rule_${Date.now().toString(36)}`,
    name: name || "Untitled rule",
    description: "",
    logSource: source,
    conditions: conds,
    combine,
    aggregationField: useAgg ? aggField : undefined,
    threshold: useAgg ? threshold : undefined,
    timeWindowMin: useAgg ? windowMin : undefined,
    severity: "high",
  });

  const test = () => setTested(evaluateRule(buildRule(), at.state.logs));
  const save = () => {
    dispatch({ t: "setDetectionRule", rule: buildRule() });
    dispatch({ t: "toast", kind: "info", text: "Detection rule saved. It will be scored at finalisation." });
  };

  const fieldOptions = FIELDS[source] ?? FIELDS.any;

  return (
    <div className="stack">
      <div className="card">
        <h3>Detection Rule Builder</h3>
        <p className="small muted">
          Build a structured rule (no code). Target tags for this scenario:{" "}
          <span className="mono">{spec.mustMatchTags.join(", ")}</span>. Suggested fields:{" "}
          <span className="mono">{spec.suggestedFields.join(", ")}</span>. Keep noise matches ≤{" "}
          {spec.maxBenignMatches}.
        </p>

        <div className="stack">
          <div className="row wrap" style={{ gap: 10 }}>
            <input className="input" style={{ maxWidth: 240 }} placeholder="Rule name" value={name} onChange={(e) => setName(e.target.value)} />
            <label className="row small">
              <span className="muted">Log source</span>
              <select className="select" style={{ width: "auto" }} value={source} onChange={(e) => setSource(e.target.value as never)}>
                {SOURCES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="row small">
              <span className="muted">Combine</span>
              <select className="select" style={{ width: "auto" }} value={combine} onChange={(e) => setCombine(e.target.value as never)}>
                <option value="and">AND</option>
                <option value="or">OR</option>
              </select>
            </label>
          </div>

          {conds.map((c, i) => (
            <div key={i} className="row wrap" style={{ gap: 8 }}>
              <select
                className="select"
                style={{ width: "auto" }}
                value={c.field}
                onChange={(e) => setConds(upd(conds, i, { field: e.target.value }))}
              >
                {fieldOptions.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
              <select
                className="select"
                style={{ width: "auto" }}
                value={c.op}
                onChange={(e) => setConds(upd(conds, i, { op: e.target.value as RuleOp }))}
              >
                {OPS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
              {c.op !== "exists" && (
                <input
                  className="input"
                  style={{ width: 140 }}
                  value={String(c.value ?? "")}
                  onChange={(e) => setConds(upd(conds, i, { value: e.target.value }))}
                />
              )}
              <button className="btn sm ghost" onClick={() => setConds(conds.filter((_, j) => j !== i))} disabled={conds.length === 1}>
                ✕
              </button>
            </div>
          ))}
          <button className="btn sm ghost" onClick={() => setConds([...conds, { field: fieldOptions[0], op: "eq", value: "" }])}>
            + Add condition
          </button>

          <label className="row small">
            <input type="checkbox" checked={useAgg} onChange={(e) => setUseAgg(e.target.checked)} />
            Aggregate / correlate (count within a window)
          </label>
          {useAgg && (
            <div className="row wrap" style={{ gap: 8 }}>
              <label className="row small">
                <span className="muted">Group by</span>
                <select className="select" style={{ width: "auto" }} value={aggField} onChange={(e) => setAggField(e.target.value)}>
                  {["sessionId", "user", "ip", "callerRole", "docId"].map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
              <label className="row small">
                <span className="muted">≥</span>
                <input className="input" type="number" style={{ width: 70 }} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
                <span className="muted">events in</span>
                <input className="input" type="number" style={{ width: 70 }} value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))} />
                <span className="muted">min</span>
              </label>
            </div>
          )}

          <div className="row">
            <button className="btn" onClick={test}>
              Test rule
            </button>
            <button className="btn primary" onClick={save}>
              Save rule
            </button>
          </div>
        </div>
      </div>

      {tested && (
        <div className="card">
          <h3>Test results</h3>
          <div className="row wrap">
            <span className="pill info">{tested.matched.length} events matched</span>
            <span className={`pill ${tested.matchedNoise > spec.maxBenignMatches ? "red" : "green"}`}>
              {tested.matchedNoise} noise matches (limit {spec.maxBenignMatches})
            </span>
            {(() => {
              const tags = new Set<string>();
              tested.matched.forEach((e) => e.tags.forEach((t) => tags.add(t)));
              const missing = spec.mustMatchTags.filter((t) => !tags.has(t));
              return (
                <span className={`pill ${missing.length === 0 ? "green" : "amber"}`}>
                  {missing.length === 0 ? "Catches all targets" : `Missing: ${missing.join(", ")}`}
                </span>
              );
            })()}
          </div>
          <p className="small muted mt">
            A good rule matches every target tag and stays under the noise limit. Save it once it does.
          </p>
        </div>
      )}
    </div>
  );
}

function upd<T>(arr: T[], i: number, patch: Partial<T>): T[] {
  return arr.map((x, j) => (j === i ? { ...x, ...patch } : x));
}
