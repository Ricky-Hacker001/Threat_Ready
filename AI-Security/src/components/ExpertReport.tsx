import React from "react";
import { useApp } from "@/state/store";
import { ArchitectureMap } from "./ArchitectureMap";
import { Field } from "./common";
import type { NodeId } from "@/engine/types";

const OWASP_OPTIONS = ["LLM01", "LLM02", "LLM03", "LLM04", "LLM05", "LLM06", "LLM07", "LLM08", "LLM09", "LLM10"];

const REPORT_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "summary", label: "Incident summary", hint: "What happened, in two or three sentences." },
  { key: "rootCause", label: "Root cause", hint: "The underlying flaw, not the symptom." },
  { key: "impact", label: "Technical & business impact", hint: "What was exposed or lost; who is affected." },
  { key: "containment", label: "Containment actions", hint: "What you did to stop it now." },
  { key: "remediation", label: "Long-term remediation", hint: "The durable fix and detection you added." },
];

export function ExpertReport() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const s = at.scenario;
  const pick = at.state.reportFrameworkPick;

  const marked = at.state.logs.filter((e) => at.state.markedEvidenceIds.includes(e.id)).sort((a, b) => a.ts - b.ts);

  const togglePath = (n: NodeId) => {
    const cur = at.state.reconstructedPath;
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n];
    dispatch({ t: "setReconPath", path: next });
  };

  const atlasOptions = unique([...s.report.atlas, "AML.T0043 — Craft Adversarial Data", "AML.T0048 — External Harms"]);
  const isoOptions = unique([...s.report.iso, "ISO/IEC 42001 A.8 — Data management", "ISO/IEC 42001 A.10 — Third-party"]);

  return (
    <div className="stack">
      <div className="card">
        <h3>Expert Incident Report</h3>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Reconstruct the attack path, map it to the frameworks, and write the report. The report is generated
          and scored even if some answers are wrong.
        </p>
      </div>

      <div className="card">
        <h3>1. Attack-path reconstruction</h3>
        <p className="small muted">Click the architecture nodes in the order the attack traversed them.</p>
        <ArchitectureMap mode="path-build" path={at.state.reconstructedPath} onPathToggle={togglePath} />
        <button className="btn sm ghost mt" onClick={() => dispatch({ t: "setReconPath", path: [] })}>
          Clear path
        </button>
      </div>

      <div className="card">
        <h3>2. Framework mapping</h3>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
          <Multi
            label="OWASP LLM Top 10"
            options={OWASP_OPTIONS}
            selected={pick.owasp}
            onChange={(v) => dispatch({ t: "setFrameworkPick", kind: "owasp", values: v })}
          />
          <Multi
            label="MITRE ATLAS"
            options={atlasOptions}
            selected={pick.atlas}
            onChange={(v) => dispatch({ t: "setFrameworkPick", kind: "atlas", values: v })}
          />
          <Multi
            label="ISO/IEC 42001"
            options={isoOptions}
            selected={pick.iso}
            onChange={(v) => dispatch({ t: "setFrameworkPick", kind: "iso", values: v })}
          />
        </div>
      </div>

      <div className="card">
        <h3>3. Evidence-linked timeline</h3>
        {marked.length === 0 && <p className="muted small">No evidence marked. Go back to the logs and mark the key events.</p>}
        {marked.length > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Session</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {marked.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{new Date(e.ts).toISOString().slice(11, 19)}</td>
                  <td>{e.type}</td>
                  <td className="mono small">{e.sessionId}</td>
                  <td>
                    <input
                      className="input"
                      placeholder="your interpretation…"
                      value={at.state.reportInputs[`note_${e.id}`] ?? ""}
                      onChange={(ev) => dispatch({ t: "setReportInput", key: `note_${e.id}`, value: ev.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card stack">
        <h3>4. Narrative</h3>
        {REPORT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <textarea
              className="input"
              rows={2}
              value={at.state.reportInputs[f.key] ?? ""}
              onChange={(e) => dispatch({ t: "setReportInput", key: f.key, value: e.target.value })}
            />
          </Field>
        ))}
        <div className="row">
          <button className="btn primary" onClick={() => dispatch({ t: "finalise" })}>
            Submit report & finish →
          </button>
        </div>
      </div>
    </div>
  );
}

function Multi({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (o: string) =>
    onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  return (
    <div>
      <label className="field">{label}</label>
      <div className="stack" style={{ gap: 6 }}>
        {options.map((o) => (
          <label key={o} className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} />
            <span>{o}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function unique(a: string[]): string[] {
  return Array.from(new Set(a));
}
