import React from "react";
import { BRAND } from "@/brand/brand";
import { useApp } from "@/state/store";

export function Shell({ children }: { children: React.ReactNode }) {
  const { state, dispatch } = useApp();
  const at = state.attempt;

  return (
    <div className="app">
      <header className="hdr">
        <div className="container hdr-row">
          <img className="hdr-logo" src={BRAND.logoWhite} alt={`${BRAND.company} logo`} />
          <span className="hdr-sep" />
          <div>
            <div className="hdr-title">{BRAND.productName}</div>
            <div className="hdr-sub hide-sm">{BRAND.poweredByLine}</div>
          </div>
          <span className="hdr-spacer" />
          {at && (
            <span className="pill info hide-sm">
              {at.scenario.taskTitle} · {at.scenario.title}
            </span>
          )}
          {state.progress && state.view !== "entry" && (
            <button
              className="pill grey hide-sm"
              style={{ cursor: "pointer", background: "none" }}
              title="Change name"
              onClick={() => dispatch({ t: "gotoEntry" })}
            >
              {state.progress.learnerName} ▾
            </button>
          )}
          {state.view !== "entry" && state.view !== "mission" && (
            <button className="btn sm ghost" onClick={() => dispatch({ t: "mission" })}>
              Exit to Mission Control
            </button>
          )}
        </div>
      </header>
      <main className="main">
        <div className="container">{children}</div>
      </main>
      <Toasts />
    </div>
  );
}

function Toasts() {
  const { state, dispatch } = useApp();
  React.useEffect(() => {
    if (state.toasts.length === 0) return;
    const last = state.toasts[state.toasts.length - 1];
    const timer = setTimeout(() => dispatch({ t: "dismissToast", id: last.id }), 3600);
    return () => clearTimeout(timer);
  }, [state.toasts, dispatch]);
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dispatch({ t: "dismissToast", id: t.id })}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
