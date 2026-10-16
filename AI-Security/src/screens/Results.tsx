import React from "react";
import { useApp } from "@/state/store";
import { LevelTag } from "@/components/common";
import { downloadReportPdf } from "@/util/pdf";
import { getScenario } from "@/scenarios";
import { PASS_MARK } from "@/engine/scoring";

export function Results() {
  const { state, dispatch } = useApp();
  const r = state.result!;
  const scenario = getScenario(r.scenarioId)!;
  const sc = r.score;

  const breakdown: { label: string; value: number }[] = [
    { label: "Attack reproduced", value: sc.attackSucceeded },
    { label: "Evidence marked", value: sc.evidence },
    { label: "Detection rule", value: sc.detectionRule },
    { label: "Fix at correct layer", value: sc.fixCorrectLayer },
    { label: "Re-test passed", value: sc.retestPass },
    { label: "Benign traffic intact", value: sc.benignWorks },
    { label: "Expert report", value: sc.expertReport },
  ].filter((x) => x.value > 0 || ["Attack reproduced", "Fix at correct layer", "Re-test passed"].includes(x.label));

  const recs = buildRecommendations(r);

  const exportPdf = () =>
    downloadReportPdf({
      learner: state.progress!.learnerName,
      scenarioTitle: `${scenario.taskTitle}: ${scenario.title}`,
      level: scenario.level,
      score: sc,
      evidence: `${r.evidence.correct}/${r.evidence.required} accepted events marked${r.evidence.wrongPicks ? `, ${r.evidence.wrongPicks} wrong pick(s)` : ""}`,
      detection: scenario.detection.required ? (r.detection.ok ? "effective" : "missing/ineffective") : "not required",
      retestSummary: r.retest.overall ? "passed — attacks blocked, legitimate traffic intact" : r.retest.failureReason ?? "failed",
      recommendations: recs,
      kind: "scenario",
    });

  return (
    <div className="stack">
      <div className="crumbs">
        <span style={{ cursor: "pointer" }} onClick={() => dispatch({ t: "mission" })}>
          Mission Control
        </span>
        <span className="sep">/</span>
        <span>Results</span>
      </div>

      <div className="card pad-lg">
        <div className="row between wrap">
          <div>
            <div className="row">
              <h1 style={{ margin: 0 }}>
                {scenario.taskTitle}: {scenario.title}
              </h1>
              <LevelTag level={scenario.level} />
            </div>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {sc.passed ? "Passed" : "Not passed"} · pass mark {PASS_MARK}
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="score-big" style={{ color: sc.passed ? "var(--green)" : "var(--amber)" }}>
              {sc.total}
            </div>
            <div className="muted small">out of 100</div>
          </div>
        </div>

        <div className="bar mt">
          <span style={{ width: `${sc.total}%`, background: sc.passed ? "var(--green)" : "var(--amber)" }} />
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card">
          <h3>Score breakdown</h3>
          <table className="data">
            <tbody>
              {breakdown.map((b) => (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  <td style={{ textAlign: "right", fontWeight: 600, color: "var(--text-0)" }}>+{b.value}</td>
                </tr>
              ))}
              {sc.deductions > 0 && (
                <tr>
                  <td style={{ color: "var(--red)" }}>Deductions</td>
                  <td style={{ textAlign: "right", fontWeight: 600, color: "var(--red)" }}>−{sc.deductions}</td>
                </tr>
              )}
              <tr>
                <td style={{ fontWeight: 700 }}>Total</td>
                <td style={{ textAlign: "right", fontWeight: 700 }}>{sc.total}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Why you got this score</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
            {sc.lines.map((l, i) => (
              <li key={i} style={{ marginBottom: 4, color: l.startsWith("−") ? "var(--red)" : "var(--text-1)" }}>
                {l}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card">
        <h3>Investigation summary</h3>
        <div className="row wrap">
          <span className="pill info">
            Evidence {r.evidence.correct}/{r.evidence.required}
          </span>
          {scenario.detection.required && (
            <span className={`pill ${r.detection.ok ? "green" : "amber"}`}>
              Detection {r.detection.ok ? "effective" : r.detection.tooNoisy ? "too noisy" : "missed targets"}
            </span>
          )}
          <span className={`pill ${r.retest.overall ? "green" : "red"}`}>
            Re-test {r.retest.overall ? "passed" : "failed"}
          </span>
          <span className="pill grey">Fix coverage {Math.round(r.fixFraction * 100)}%</span>
        </div>
      </div>

      <div className="card">
        <h3>Recommended next practice</h3>
        <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
          {recs.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>

      <div className="row wrap">
        <button className="btn primary" onClick={() => dispatch({ t: "mission" })}>
          Back to Mission Control
        </button>
        <button className="btn" onClick={() => dispatch({ t: "retake" })}>
          Retake (re-randomised)
        </button>
        <button className="btn ghost" onClick={exportPdf}>
          ⬇ Download PDF report
        </button>
      </div>
    </div>
  );
}

function buildRecommendations(r: ReturnType<typeof useApp>["state"]["result"] & object): string[] {
  const out: string[] = [];
  if (!r) return out;
  const sc = r.score;
  if (sc.fixCorrectLayer < 15) out.push("Revisit which architecture layer actually owns this fix — a wrong-layer control looks right but fails the re-test.");
  if (r.evidence.correct < r.evidence.required) out.push("Practise log triage: isolate the attack events from the noise before fixing.");
  if (r.detection && !r.detection.ok) out.push("Tighten your detection rule so it catches every target tag without matching benign traffic.");
  if (!r.retest.overall) out.push("Your re-test did not pass — ensure every attack and bypass is contained while legitimate traffic still works.");
  if (sc.deductions > 0) out.push("Avoid over-blocking and wrong-layer attempts — they carry point deductions.");
  if (out.length === 0) out.push("Strong run. Move on to the next level or task.");
  return out;
}
