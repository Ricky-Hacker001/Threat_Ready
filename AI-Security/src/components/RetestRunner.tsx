import React from "react";
import { useApp } from "@/state/store";

export function RetestRunner() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const r = at.lastRetest;

  return (
    <div className="stack">
      <div className="card">
        <div className="row between wrap">
          <h3 style={{ margin: 0 }}>Re-test Runner</h3>
          <div className="row">
            <span className="pill grey">Retests: {at.state.retests}</span>
            <button className="btn primary" onClick={() => dispatch({ t: "runRetest" })}>
              Run re-test
            </button>
          </div>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Replays the original attack{at.scenario.level !== "foundation" ? ", the bypass variants" : ""}
          {at.scenario.level === "expert" ? ", the chained path" : ""} and the legitimate-traffic suite against
          your current defences. It passes only if every attack is contained AND every legitimate request still
          works.
        </p>
      </div>

      {!r && (
        <div className="card muted" style={{ textAlign: "center", padding: 28 }}>
          No re-test run yet. Configure your defences, then run the re-test.
        </div>
      )}

      {r && (
        <div className="card">
          <div className="row between">
            <h3 style={{ margin: 0 }}>Result</h3>
            <span className={`pill ${r.overall ? "green" : "red"}`}>{r.overall ? "PASSED" : "FAILED"}</span>
          </div>
          {!r.overall && r.failureReason && (
            <div className="card mt" style={{ background: "var(--red-bg)", borderColor: "#51272b" }}>
              <strong className="small">Why it failed:</strong> <span className="small">{r.failureReason}</span>
            </div>
          )}
          <table className="data mt">
            <thead>
              <tr>
                <th>Test</th>
                <th>Kind</th>
                <th>Result</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {r.results.map((t) => (
                <tr key={t.id}>
                  <td>{t.label}</td>
                  <td>
                    <span className="pill grey">{t.kind}</span>
                  </td>
                  <td>
                    <span className={`pill ${t.passed ? "green" : "red"}`}>{t.passed ? "OK" : "FAIL"}</span>
                  </td>
                  <td className="small muted">{t.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row mt">
            {!r.overall && (
              <button className="btn" onClick={() => dispatch({ t: "setPhase", phase: "fix" })}>
                ← Back to Fix
              </button>
            )}
            {r.overall && at.scenario.level === "expert" && (
              <button className="btn primary" onClick={() => dispatch({ t: "setPhase", phase: "report" })}>
                Continue to Expert Report →
              </button>
            )}
            {r.overall && at.scenario.level !== "expert" && (
              <button className="btn primary" onClick={() => dispatch({ t: "finalise" })}>
                Finish & see results →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
