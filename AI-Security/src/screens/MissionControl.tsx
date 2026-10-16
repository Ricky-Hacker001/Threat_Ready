import React, { useState } from "react";
import { useApp } from "@/state/store";
import { TASK_META, implementedTaskIds } from "@/scenarios";
import { unlockStatus, scenarioId, levelProgress } from "@/engine/progress";
import type { Level } from "@/engine/types";
import { Modal } from "@/components/common";

const LEVELS: Level[] = ["foundation", "intermediate", "expert"];
const LEVEL_LABEL: Record<Level, string> = {
  foundation: "Foundation",
  intermediate: "Intermediate",
  expert: "Expert",
};

export function MissionControl() {
  const { state, dispatch } = useApp();
  const p = state.progress!;
  const [confirmReset, setConfirmReset] = useState(false);
  const impl = implementedTaskIds();

  const totalScenarios = 30;
  const passed = Object.values(p.results).filter((r) => r.passed).length;
  const completion = Math.round((passed / totalScenarios) * 100);
  const totalScore = Object.values(p.results).reduce((a, r) => a + r.bestScore, 0);

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <h1>Mission Control</h1>
          <p className="muted">Welcome back, {p.learnerName}. Pick a scenario to begin.</p>
        </div>
        <div className="row wrap">
          <button className="btn ghost" onClick={() => dispatch({ t: "gotoLearning" })}>
            📘 Learning Notebook
          </button>
          <button className="btn ghost" onClick={() => dispatch({ t: "gotoBadges" })}>
            🏅 Badges
          </button>
          <button className="btn ghost" onClick={() => dispatch({ t: "openScenario", scenarioId: "T1-F" })}>
            Start Newbie Demo
          </button>
          <button className="btn danger ghost" onClick={() => setConfirmReset(true)}>
            Reset Progress
          </button>
        </div>
      </div>

      {/* Stat row */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Overall completion" value={`${completion}%`} sub={`${passed}/${totalScenarios} scenarios passed`} />
        <Stat label="Accumulated score" value={String(totalScore)} sub="sum of best scores" />
        {LEVELS.map((lv) => {
          const lp = levelProgress(p, lv);
          return <Stat key={lv} label={LEVEL_LABEL[lv]} value={`${lp.passed}/10`} sub="passed" />;
        })}
      </div>

      {/* Badges + unlock mode */}
      <div className="card row between wrap">
        <div className="row wrap">
          <strong className="small">Badges:</strong>
          {p.badges.length === 0 && <span className="muted small">None yet — pass all 10 tasks at a level.</span>}
          {p.badges.map((b) => (
            <span key={b} className="pill green">
              ★ {b}
            </span>
          ))}
        </div>
        <label className="row small">
          <span className="muted">Unlock mode:</span>
          <select
            className="select"
            style={{ width: "auto" }}
            value={p.unlockMode}
            onChange={(e) => dispatch({ t: "setUnlockMode", mode: e.target.value as never })}
          >
            <option value="per-task">Per-task (Foundation → Intermediate → Expert)</option>
            <option value="all-foundations-first">All Foundations first</option>
          </select>
        </label>
      </div>

      {/* Grid */}
      <div className="card scroll">
        <table className="data" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ width: "34%" }}>Task</th>
              {LEVELS.map((lv) => (
                <th key={lv}>{LEVEL_LABEL[lv]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TASK_META.map((t) => (
              <tr key={t.id}>
                <td>
                  <div style={{ fontWeight: 600, color: "var(--text-0)" }}>
                    {t.id}. {t.title}
                  </div>
                  <div className="small muted">{t.short}</div>
                  <div className="small muted">OWASP {t.owasp}</div>
                </td>
                {LEVELS.map((lv) => (
                  <td key={lv}>
                    <ScenarioCell taskId={t.id} level={lv} implemented={impl.has(t.id)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmReset && (
        <Modal
          title="Reset all progress?"
          onClose={() => setConfirmReset(false)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  dispatch({ t: "resetProgress" });
                  setConfirmReset(false);
                }}
              >
                Reset everything
              </button>
            </>
          }
        >
          <p>This clears scores, badges and unlocks for {p.learnerName}. This cannot be undone.</p>
        </Modal>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card">
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
      <div className="small muted">{sub}</div>
    </div>
  );
}

function ScenarioCell({ taskId, level, implemented }: { taskId: number; level: Level; implemented: boolean }) {
  const { state, dispatch } = useApp();
  const p = state.progress!;
  const id = scenarioId(taskId, level);
  const rec = p.results[id];
  const unlock = unlockStatus(p, taskId, level);

  if (!implemented) {
    return <span className="pill grey">Coming soon</span>;
  }
  if (!unlock.unlocked) {
    return (
      <div className="small muted" title={unlock.reason}>
        🔒 Locked
        <div style={{ fontSize: 11 }}>{unlock.reason}</div>
      </div>
    );
  }
  const status = rec?.passed ? "Passed" : rec ? "Attempted" : "Not started";
  const statusCls = rec?.passed ? "green" : rec ? "amber" : "grey";
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className={`pill ${statusCls}`}>{status}</span>
      {rec && <div className="small muted">Best {rec.bestScore} · {rec.attempts} attempt(s)</div>}
      <button className="btn sm primary" onClick={() => dispatch({ t: "openScenario", scenarioId: id })}>
        {rec ? "Retake" : "Start"}
      </button>
    </div>
  );
}
