import React, { useState } from "react";
import { attemptInProgress, useApp } from "@/state/store";
import { TASK_META, implementedTaskIds } from "@/scenarios";
import { unlockStatus, scenarioId, levelProgress } from "@/engine/progress";
import type { Level } from "@/engine/types";
import { LevelTag, Modal } from "@/components/common";
import { platformIdentityProblem } from "@/platform";

const LEVELS: Level[] = ["foundation", "intermediate", "expert"];
const LEVEL_LABEL: Record<Level, string> = {
  foundation: "Foundation",
  intermediate: "Intermediate",
  expert: "Expert",
};

type Confirm = { kind: "reset" } | { kind: "discard" } | { kind: "replace"; scenarioId: string } | null;

export function MissionControl() {
  const { state, dispatch } = useApp();
  const p = state.progress!;
  const [confirm, setConfirm] = useState<Confirm>(null);
  const impl = implementedTaskIds();
  const current = attemptInProgress(state.attempt) ? state.attempt : null;

  const totalScenarios = 30;
  const passed = Object.values(p.results).filter((r) => r.passed).length;
  const completion = Math.round((passed / totalScenarios) * 100);
  const totalScore = Object.values(p.results).reduce((a, r) => a + r.bestScore, 0);

  /** Open a scenario: resumes its attempt in progress; starting another one asks first. */
  const open = (id: string) => {
    if (current && current.scenario.id !== id) setConfirm({ kind: "replace", scenarioId: id });
    else dispatch({ t: "openScenario", scenarioId: id });
  };

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <h1>Mission Control</h1>
          <p className="muted">Welcome back, {p.learnerName}. Pick a scenario to begin.</p>
        </div>
        <div className="row wrap">
          <button className="btn ghost" onClick={() => dispatch({ t: "gotoLearning" })}>
            <span aria-hidden="true">📘</span> Learning Notebook
          </button>
          <button className="btn ghost" onClick={() => dispatch({ t: "gotoBadges" })}>
            <span aria-hidden="true">🏅</span> Badges
          </button>
          <button className="btn ghost" onClick={() => open("T1-F")}>
            Start Newbie Demo
          </button>
          <button className="btn danger ghost" onClick={() => setConfirm({ kind: "reset" })}>
            Reset Progress
          </button>
        </div>
      </div>

      {/* The attempt in progress is kept (per account) across reloads: offer to pick it up. */}
      {current && (
        <div className="card row between wrap" style={{ borderColor: "var(--accent-dim)", background: "var(--info-bg)" }}>
          <div>
            <div className="row wrap" style={{ gap: 8 }}>
              <strong>In progress:</strong>
              <span>
                {current.scenario.taskTitle} · {current.scenario.title}
              </span>
              <LevelTag level={current.scenario.level} />
            </div>
            <div className="small muted">
              {platformIdentityProblem() ? "Kept in this tab" : "Saved on this device"} at the {current.state.phase} stage
              {current.state.retests > 0 ? ` · ${current.state.retests} re-test(s) run` : ""}. Pick up where you left
              off.
            </div>
          </div>
          <div className="row wrap">
            <button className="btn primary" onClick={() => dispatch({ t: "openScenario", scenarioId: current.scenario.id })}>
              Resume
            </button>
            <button className="btn ghost" onClick={() => setConfirm({ kind: "discard" })}>
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Stat row */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Stat label="Overall completion" value={`${completion}%`} sub={`${passed}/${totalScenarios} scenarios passed`} />
        <Stat label="Accumulated score" value={String(totalScore)} sub="sum of best scores" />
        {LEVELS.map((lv) => {
          const lp = levelProgress(p, lv);
          return <Stat key={lv} label={LEVEL_LABEL[lv]} value={`${lp.passed}/10`} sub="passed" />;
        })}
      </div>

      {/* Badges */}
      <div className="card row wrap">
        <strong className="small">Badges:</strong>
        {p.badges.length === 0 && <span className="muted small">None yet — pass all 10 tasks at a level.</span>}
        {p.badges.map((b) => (
          <span key={b} className="pill green">
            <span aria-hidden="true">★</span> {b}
          </span>
        ))}
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
                    <ScenarioCell
                      taskId={t.id}
                      level={lv}
                      implemented={impl.has(t.id)}
                      inProgress={current?.scenario.id === scenarioId(t.id, lv)}
                      onOpen={open}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Lab settings: tucked away, since they change how levels open rather than anything in a scenario. */}
      <details className="card settings">
        <summary>Settings</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <div>
            <label className="field" htmlFor="unlock-mode">
              Unlock order
            </label>
            <select
              id="unlock-mode"
              className="select"
              aria-describedby="unlock-mode-help"
              value={p.unlockMode}
              onChange={(e) => dispatch({ t: "setUnlockMode", mode: e.target.value as never })}
            >
              <option value="per-task">Per task (default)</option>
              <option value="all-foundations-first">All Foundations first</option>
            </select>
            <p id="unlock-mode-help" className="small muted" style={{ margin: "6px 0 0" }}>
              Decides when harder levels open: per task (pass a task's Foundation to open its Intermediate, and so
              on), or level by level (pass all 10 Foundations before any Intermediate). Scores are kept either way.
            </p>
          </div>
        </div>
      </details>

      {confirm?.kind === "reset" && (
        <Modal
          title="Reset all progress?"
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  dispatch({ t: "resetProgress" });
                  setConfirm(null);
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

      {confirm?.kind === "discard" && current && (
        <Modal
          title="Discard the attempt in progress?"
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Keep it
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  dispatch({ t: "discardAttempt" });
                  setConfirm(null);
                }}
              >
                Discard attempt
              </button>
            </>
          }
        >
          <p>
            Your unfinished attempt at <strong>{current.scenario.title}</strong> (evidence, guardrails and re-tests)
            will be lost. It is not scored or recorded.
          </p>
        </Modal>
      )}

      {confirm?.kind === "replace" && current && (
        <Modal
          title="Start a different scenario?"
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  dispatch({ t: "openScenario", scenarioId: confirm.scenarioId });
                  setConfirm(null);
                }}
              >
                Start new scenario
              </button>
            </>
          }
        >
          <p>
            You have an unfinished attempt at <strong>{current.scenario.title}</strong>. Starting another scenario
            discards it (it is not scored or recorded).
          </p>
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

function ScenarioCell({
  taskId,
  level,
  implemented,
  inProgress,
  onOpen,
}: {
  taskId: number;
  level: Level;
  implemented: boolean;
  inProgress: boolean;
  onOpen: (id: string) => void;
}) {
  const { state } = useApp();
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
        <span aria-hidden="true">🔒</span> Locked
        <div style={{ fontSize: 11 }}>{unlock.reason}</div>
      </div>
    );
  }
  const status = inProgress ? "In progress" : rec?.passed ? "Passed" : rec ? "Attempted" : "Not started";
  const statusCls = inProgress ? "info" : rec?.passed ? "green" : rec ? "amber" : "grey";
  const label = inProgress ? "Resume" : rec ? "Retake" : "Start";
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className={`pill ${statusCls}`}>{status}</span>
      {rec && <div className="small muted">Best {rec.bestScore} · {rec.attempts} attempt(s)</div>}
      <button
        className="btn sm primary"
        aria-label={`${label} Task ${taskId} ${level}`}
        onClick={() => onOpen(id)}
      >
        {label}
      </button>
    </div>
  );
}
