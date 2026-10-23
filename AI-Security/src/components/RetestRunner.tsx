import React, { useState } from "react";
import { useApp } from "@/state/store";
import { Modal } from "./common";

export function RetestRunner() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const r = at.lastRetest;
  const isExpert = at.scenario.level === "expert";
  const [confirmFinish, setConfirmFinish] = useState(false);

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
          {isExpert ? ", the chained path" : ""} and the legitimate-traffic suite against
          your current defences. It passes only if every attack is contained AND every legitimate request still
          works.
        </p>
      </div>

      {/* Announces each run's outcome (the run number makes a repeat result announce again). */}
      <div className="sr-only" role="status">
        {r
          ? `Re-test ${at.state.retests} ${r.overall ? "passed: attacks contained, legitimate traffic intact." : `failed. ${r.failureReason ?? ""}`}`
          : ""}
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
          <div className="scroll">
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
          </div>

          <div className="row wrap mt">
            {!r.overall && (
              <button className="btn" onClick={() => dispatch({ t: "setPhase", phase: "fix", tab: "guardrails" })}>
                ← Back to Fix
              </button>
            )}
            {/* A failed scenario still produces its result: finish now, recorded as not passed. */}
            {!r.overall && !isExpert && (
              <button className="btn ghost" onClick={() => setConfirmFinish(true)}>
                Finish anyway &amp; see results
              </button>
            )}
            {!r.overall && isExpert && (
              <button className="btn ghost" onClick={() => dispatch({ t: "setPhase", phase: "report", tab: "report" })}>
                Continue to Expert Report anyway
              </button>
            )}
            {r.overall && isExpert && (
              <button className="btn primary" onClick={() => dispatch({ t: "setPhase", phase: "report", tab: "report" })}>
                Continue to Expert Report →
              </button>
            )}
            {r.overall && !isExpert && (
              <button className="btn primary" onClick={() => dispatch({ t: "finalise" })}>
                Finish & see results →
              </button>
            )}
          </div>
          {!r.overall && isExpert && (
            <p className="small muted" style={{ margin: "8px 0 0" }}>
              You can submit the report with a failed re-test; the scenario is then recorded as not passed.
            </p>
          )}
        </div>
      )}

      {confirmFinish && (
        <Modal
          title="Finish with a failed re-test?"
          onClose={() => setConfirmFinish(false)}
          actions={
            <>
              <button className="btn ghost" onClick={() => setConfirmFinish(false)}>
                Keep fixing
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setConfirmFinish(false);
                  dispatch({ t: "finalise" });
                }}
              >
                Finish anyway
              </button>
            </>
          }
        >
          <p>
            This attempt will be scored now and recorded as <strong>not passed</strong> (re-test failed). You'll
            see the full breakdown and can retake the scenario afterwards.
          </p>
        </Modal>
      )}
    </div>
  );
}
