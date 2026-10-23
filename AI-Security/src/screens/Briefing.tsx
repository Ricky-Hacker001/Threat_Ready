import React from "react";
import { useApp } from "@/state/store";
import { Crumbs, LevelTag } from "@/components/common";
import { variantCountFor } from "@/engine/validation";

export function Briefing() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const s = at.scenario;
  const bypassN = variantCountFor(s.level);
  const started = at.state.phase !== "briefing";

  return (
    <div className="stack">
      <Crumbs onHome={() => dispatch({ t: "requestExit" })} trail={[`Task ${s.taskId}`, s.title]} />

      <div className="card pad-lg stack">
        <div className="row between wrap">
          <h1 style={{ margin: 0 }}>
            {s.taskTitle}: {s.title}
          </h1>
          <div className="row">
            <LevelTag level={s.level} />
            <span className="pill grey">~{s.estMinutes} min</span>
          </div>
        </div>

        <p>{s.story}</p>

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
          <Info label="Your role" value={s.role} />
          <Info label="Target component" value={nodeName(s.targetComponent)} />
          <Info label="OWASP mapping" value={s.report.owasp.join(", ")} />
          <Info label="Bypass variants to expect" value={bypassN === 0 ? "none" : String(bypassN)} />
        </div>

        <div className="card" style={{ background: "var(--bg-2)" }}>
          <h3>Objective</h3>
          <p style={{ marginBottom: 0 }}>{s.objective}</p>
        </div>

        <div className="card" style={{ background: "var(--bg-2)" }}>
          <h3>What must keep working (don't over-block)</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {s.benignTests.map((b) => (
              <li key={b.id}>{b.label}</li>
            ))}
          </ul>
        </div>

        {/* Guidance by level */}
        {s.level === "foundation" && (
          <div className="card" style={{ background: "var(--info-bg)", borderColor: "var(--accent-dim)" }}>
            <h3>Guided walkthrough</h3>
            <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {s.foundationSteps.map((st, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {st.text}
                </li>
              ))}
            </ol>
          </div>
        )}
        {s.level === "intermediate" && (
          <div className="card" style={{ background: "var(--bg-2)" }}>
            <h3>Approach</h3>
            <p className="small" style={{ marginBottom: 0 }}>
              Hints are available in the workspace but cost points. You must select the correct architecture
              layer on the map before configuring your fix.
            </p>
          </div>
        )}
        {s.level === "expert" && (
          <div className="card" style={{ background: "var(--amber-bg)", borderColor: "#3a3320" }}>
            <h3>Expert mode</h3>
            <p className="small" style={{ marginBottom: 0 }}>
              Objective and incident context only. The architecture map is hidden until the report stage —
              you'll reconstruct the attack path yourself, correlate across multiple log types, apply a
              layered defence and write an incident report.
            </p>
          </div>
        )}

        <div className="row wrap">
          <button className="btn primary" onClick={() => dispatch({ t: "startScenario" })}>
            {started ? "Resume scenario" : "Start scenario"}
          </button>
          <button className="btn ghost" onClick={() => dispatch({ t: "requestExit" })}>
            Back to Mission Control
          </button>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="small muted">{label}</div>
      <div style={{ fontWeight: 600, textTransform: "capitalize" }}>{value}</div>
    </div>
  );
}

export function nodeName(n: string): string {
  const map: Record<string, string> = {
    user: "User / Chat UI",
    input: "Input Guard",
    llm: "LLM + System Prompt",
    output: "Output Guard",
    docs: "Uploaded Documents",
    rag: "RAG Store",
    agent: "Agent Tools",
    registry: "Model Registry",
    logs: "AI Logs & Monitoring",
  };
  return map[n] ?? n;
}
