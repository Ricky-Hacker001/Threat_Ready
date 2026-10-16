import React, { useState } from "react";
import { BRAND } from "@/brand/brand";
import { useApp } from "@/state/store";
import { usePlatformUser } from "@/platform";

export function Entry() {
  const { state, dispatch } = useApp();
  const [name, setName] = useState(state.progress?.learnerName ?? "");
  const returning = Boolean(state.progress);
  // Inside ThreatReady the signed-in user is the learner: enter straight away, no name prompt.
  const user = usePlatformUser();
  React.useEffect(() => {
    if (user) dispatch({ t: "enter", name: user.name });
  }, [user, dispatch]);
  if (user !== null) {
    return (
      <div className="card pad-lg" style={{ maxWidth: 520, margin: "40px auto" }} role="status">
        <img src={BRAND.logoWhite} alt={BRAND.company} style={{ height: 30, marginBottom: 18 }} />
        <h1>{BRAND.productName}</h1>
        <p className="muted">{user ? `Opening as ${user.name}…` : "Opening…"}</p>
      </div>
    );
  }
  return (
    <div className="card pad-lg" style={{ maxWidth: 520, margin: "40px auto" }}>
      <img src={BRAND.logoWhite} alt={BRAND.company} style={{ height: 30, marginBottom: 18 }} />
      <h1>{BRAND.productName}</h1>
      <p>
        A hands-on, fully-simulated AI/LLM security training range. You attack{" "}
        <strong>{BRAND.assistantName}</strong>, {BRAND.targetOrg}'s assistant ({BRAND.targetOrgDescriptor}),
        then detect, fix, re-test and report — the full{" "}
        <span className="mono">ATTACK → DETECT → FIX → RE-TEST → REPORT</span> loop.
      </p>
      <p className="small muted">
        Nothing here is real. No external model is called, no payload executes, and all data is synthetic.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          dispatch({ t: "enter", name });
        }}
        className="stack mt"
      >
        <input
          className="input"
          placeholder="Your name (for your report)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Your name"
        />
        <div className="row">
          <button className="btn primary" type="submit">
            {returning ? "Save & continue" : "Enter the lab"}
          </button>
          {returning && (
            <button type="button" className="btn ghost" onClick={() => dispatch({ t: "mission" })}>
              Back to Mission Control
            </button>
          )}
        </div>
      </form>
      <div className="small muted mt">{BRAND.poweredByLine}</div>
    </div>
  );
}
