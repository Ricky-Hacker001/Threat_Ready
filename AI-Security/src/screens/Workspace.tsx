import React from "react";
import { useApp } from "@/state/store";
import type { WorkspaceTab as Tab } from "@/state/routes";
import { TargetApp } from "@/components/TargetApp";
import { LogsConsole } from "@/components/LogsConsole";
import { GuardrailPanel } from "@/components/GuardrailPanel";
import { DetectionBuilder } from "@/components/DetectionBuilder";
import { RetestRunner } from "@/components/RetestRunner";
import { ExpertReport } from "@/components/ExpertReport";
import { ArchitectureMap } from "@/components/ArchitectureMap";
import { Crumbs, LevelTag } from "@/components/common";
import { judgeMapFix } from "@/engine/validation";
import type { NodeId } from "@/engine/types";
import { nodeName } from "./Briefing";

export function Workspace() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const s = at.scenario;

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
  // A tab from an old link that this level doesn't have falls back to the target app.
  const tab: Tab = tabs.some((t) => t.show && t.id === state.tab) ? state.tab : "target";

  return (
    <div className="stack">
      <Crumbs
        onHome={() => dispatch({ t: "requestExit" })}
        trail={[
          `${s.taskTitle} · ${s.title}`,
          <span style={{ textTransform: "capitalize" }}>{at.state.phase}</span>,
        ]}
      />

      <div className="row wrap" style={{ gap: 10 }}>
        <h1 style={{ margin: 0 }}>
          {s.taskTitle}: {s.title}
        </h1>
        <LevelTag level={s.level} />
      </div>

      <PhaseGuide />

      <div className="tabs" role="group" aria-label="Workspace sections">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? "active" : ""}`}
              aria-current={tab === t.id ? "true" : undefined}
              onClick={() => dispatch({ t: "setTab", tab: t.id })}
            >
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
          Before configuring your fix, select the node where the correct fix belongs (click it, or Tab to it and
          press Enter). This is scored.
        </p>
        <ArchitectureMap
          mode="fix-select"
          hit={at.state.attackSucceeded ? s.map.hit : []}
          selectedFix={at.state.mapFixSelection}
          onFixSelect={(n: NodeId) => dispatch({ t: "setMapFix", node: n })}
        />
        {/* Always rendered, so the verdict is announced when a node is chosen. */}
        <div role="status">
          {at.state.mapFixSelection && (
            <div className={`pill ${correct ? "green" : "amber"} mt`} style={{ whiteSpace: "normal" }}>
              {correct
                ? `Correct — the fix belongs at ${nodeName(at.state.mapFixSelection)}.`
                : `Reconsider — ${nodeName(at.state.mapFixSelection)} isn't where this fix belongs.`}
            </div>
          )}
        </div>
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
          <summary className="small" style={{ cursor: "pointer", color: "var(--accent-text)" }}>
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

      <ul className="row wrap mt checklist" style={{ gap: 8 }} aria-label="Progress">
        <Check done={at.state.attackSucceeded} label="Attack reproduced" />
        <Check
          done={at.state.markedEvidenceIds.length > 0}
          label={`Evidence marked (${at.state.markedEvidenceIds.length})`}
        />
        {s.detection.required && <Check done={!!at.detectionRule} label="Detection rule" />}
        <Check done={!!at.lastRetest?.overall} label="Re-test passed" />
      </ul>
    </div>
  );
}

function Check({ done, label }: { done: boolean; label: string }) {
  return (
    <li className={`pill ${done ? "green" : "grey"}`}>
      <span aria-hidden="true">{done ? "✓" : "○"}</span> {label}
      <span className="sr-only">{done ? "(done)" : "(not yet)"}</span>
    </li>
  );
}
