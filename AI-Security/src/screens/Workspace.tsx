import React, { useState } from "react";
import { useApp } from "@/state/store";
import { TargetApp } from "@/components/TargetApp";
import { LogsConsole } from "@/components/LogsConsole";
import { GuardrailPanel } from "@/components/GuardrailPanel";
import { DetectionBuilder } from "@/components/DetectionBuilder";
import { RetestRunner } from "@/components/RetestRunner";
import { ExpertReport } from "@/components/ExpertReport";
import { ArchitectureMap } from "@/components/ArchitectureMap";
import { judgeMapFix } from "@/engine/validation";
import type { NodeId } from "@/engine/types";
import { nodeName } from "./Briefing";

type Tab = "target" | "map" | "logs" | "guardrails" | "detection" | "retest" | "report";

export function Workspace() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const s = at.scenario;
  const [tab, setTab] = useState<Tab>("target");

  const needDetection = s.detection.required;
  const isExpert = s.level === "expert";

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "target", label: `${"AeroPay"} App`, show: true },
    { id: "map", label: "Architecture", show: true },
    { id: "logs", label: "Logs", show: true },
    { id: "guardrails", label: "Guardrails", show: true },
    { id: "detection", label: "Detection", show: needDetection },
    { id: "retest", label: "Re-test", show: true },
    { id: "report", label: "Report", show: isExpert },
  ];

  return (
    <div className="stack">
      <div className="crumbs">
        <span style={{ cursor: "pointer" }} onClick={() => dispatch({ t: "mission" })}>
          Mission Control
        </span>
        <span className="sep">/</span>
        <span>
          {s.taskTitle} · {s.title}
        </span>
        <span className="sep">/</span>
        <span style={{ color: "var(--text-0)", textTransform: "capitalize" }}>{at.state.phase}</span>
      </div>

      <PhaseGuide />

      <div className="tabs">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
      </div>

      {tab === "target" && <TargetApp />}
      {tab === "map" && <MapTab />}
      {tab === "logs" && <LogsConsole />}
      {tab === "guardrails" && <GuardrailPanel />}
      {tab === "detection" && <DetectionBuilder />}
      {tab === "retest" && <RetestRunner />}
      {tab === "report" && <ExpertReport />}
    </div>
  );
}

function MapTab() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const s = at.scenario;

  if (s.level === "foundation") {
    return (
      <div className="card">
        <h3>Architecture Map</h3>
        <p className="small muted">
          The attack path lights up once your attack succeeds. After you fix the right layer, the correct fix
          location is shown in green.
        </p>
        <ArchitectureMap
          mode="static"
          hit={at.state.attackSucceeded ? s.map.hit : []}
          fix={s.map.fix}
          showFix={at.state.retests > 0}
        />
      </div>
    );
  }

  if (s.level === "intermediate") {
    const correct = judgeMapFix(at.state.mapFixSelection, s.map);
    return (
      <div className="card">
        <h3>Architecture Map — select the fix layer</h3>
        <p className="small muted">
          Before configuring your fix, click the node where the correct fix belongs. This is scored.
        </p>
        <ArchitectureMap
          mode="fix-select"
          hit={at.state.attackSucceeded ? s.map.hit : []}
          selectedFix={at.state.mapFixSelection}
          onFixSelect={(n: NodeId) => dispatch({ t: "setMapFix", node: n })}
        />
        {at.state.mapFixSelection && (
          <div className={`pill ${correct ? "green" : "amber"} mt`}>
            {correct
              ? `Correct — the fix belongs at ${nodeName(at.state.mapFixSelection)}.`
              : `Reconsider — ${nodeName(at.state.mapFixSelection)} isn't where this fix belongs.`}
          </div>
        )}
      </div>
    );
  }

  // expert — hidden until report
  return <ArchitectureMap mode="hidden" />;
}

function PhaseGuide() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const s = at.scenario;

  return (
    <div className="card" style={{ background: "var(--bg-2)" }}>
      <div className="row between wrap">
        <strong>Objective</strong>
        {s.level === "intermediate" && at.state.hintsUsed < s.hints.length && (
          <button className="btn sm ghost" onClick={() => dispatch({ t: "useHint" })}>
            Reveal hint (−5)
          </button>
        )}
      </div>
      <p className="small" style={{ margin: "6px 0 0" }}>
        {s.objective}
      </p>

      {s.level === "foundation" && (
        <details style={{ marginTop: 10 }}>
          <summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>
            Show guided steps
          </summary>
          <ol className="small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {s.foundationSteps.map((st, i) => (
              <li key={i} style={{ marginBottom: 3 }}>
                {st.text}
              </li>
            ))}
          </ol>
        </details>
      )}

      {s.level === "intermediate" && at.state.hintsUsed > 0 && (
        <div className="stack" style={{ marginTop: 10 }}>
          {s.hints.slice(0, at.state.hintsUsed).map((h, i) => (
            <div key={i} className="pill amber" style={{ whiteSpace: "normal" }}>
              Hint {i + 1}: {h}
            </div>
          ))}
        </div>
      )}

      <div className="row wrap mt" style={{ gap: 8 }}>
        <span className={`pill ${at.state.attackSucceeded ? "green" : "grey"}`}>
          {at.state.attackSucceeded ? "✓" : "○"} Attack reproduced
        </span>
        <span className={`pill ${at.state.markedEvidenceIds.length > 0 ? "green" : "grey"}`}>
          {at.state.markedEvidenceIds.length > 0 ? "✓" : "○"} Evidence marked ({at.state.markedEvidenceIds.length})
        </span>
        {s.detection.required && (
          <span className={`pill ${at.detectionRule ? "green" : "grey"}`}>
            {at.detectionRule ? "✓" : "○"} Detection rule
          </span>
        )}
        <span className={`pill ${at.lastRetest?.overall ? "green" : "grey"}`}>
          {at.lastRetest?.overall ? "✓" : "○"} Re-test passed
        </span>
      </div>
    </div>
  );
}
