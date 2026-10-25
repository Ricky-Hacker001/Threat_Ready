import React from "react";
import { BRAND } from "@/brand/brand";
import { useApp } from "@/state/store";
import { inPlatform, platformIdentityProblem, platformRetryAfter, usePlatformUser, waitText } from "@/platform";
import { Modal } from "./common";

export function Shell({ children }: { children: React.ReactNode }) {
  const { state, dispatch } = useApp();
  const at = state.attempt;
  const user = usePlatformUser();
  const inScenario = state.view === "briefing" || state.view === "workspace" || state.view === "results";
  useViewFocus(state.view);

  return (
    <div className="app">
      <header className="hdr">
        <div className="container hdr-row">
          {/* Inside ThreatReady the platform strip above carries the mark and wordmark. */}
          {!user && !inPlatform && (
            <>
              <img className="hdr-logo" src={BRAND.logoWhite} alt="" width="26" height="25" />
              <span className="hdr-title hide-xs">{BRAND.productFamily}</span>
              <span className="hdr-sep hide-xs" />
            </>
          )}
          <div>
            <div className="hdr-title">{BRAND.productName}</div>
            <div className="hdr-sub hide-sm">{BRAND.poweredByLine}</div>
          </div>
          <span className="hdr-spacer" />
          {at && inScenario && (
            <span className="pill info hide-sm">
              {at.scenario.taskTitle} · {at.scenario.title}
            </span>
          )}
          {state.progress && state.view !== "entry" && (user ? (
            // Inside ThreatReady the name is the account's; it is changed on the platform, not here.
            <span className="pill grey hide-sm">{state.progress.learnerName}</span>
          ) : (
            <button
              className="pill grey hide-sm"
              style={{ cursor: "pointer", background: "none" }}
              title="Change name"
              onClick={() => dispatch({ t: "gotoEntry" })}
            >
              {state.progress.learnerName} <span aria-hidden="true">▾</span>
            </button>
          ))}

          {state.view !== "entry" && state.view !== "mission" && (
            <button className="btn sm ghost" aria-label="Exit to Mission Control" onClick={() => dispatch({ t: "requestExit" })}>
              <span>
                Exit<span className="hide-sm"> to Mission Control</span>
              </span>
            </button>
          )}
        </div>
      </header>
      <main className="main" id="main">
        <div className="container">
          <SessionOnlyNotice />
          {state.view === "workspace" && <SmallScreenNotice />}
          {children}
        </div>
      </main>
      <Toasts />
      {state.confirmExit && at && (
        <Modal
          title="Exit to Mission Control?"
          onClose={() => dispatch({ t: "cancelExit" })}
          actions={
            <>
              <button className="btn ghost" onClick={() => dispatch({ t: "cancelExit" })}>
                Keep working
              </button>
              <button className="btn primary" onClick={() => dispatch({ t: "mission" })}>
                Exit
              </button>
            </>
          }
        >
          <p>
            Your attempt at <strong>{at.scenario.title}</strong> is not finished. It is kept
            {platformIdentityProblem() ? " in this tab" : " in this browser"}, so you can resume it from Mission
            Control — starting a different scenario replaces it.
          </p>
        </Modal>
      )}
    </div>
  );
}

/**
 * On a change of screen, start at the top and move focus to the new screen's heading (or the main
 * region), so keyboard and screen-reader users land on the new content instead of a removed button.
 */
function useViewFocus(view: string) {
  const prev = React.useRef(view);
  React.useEffect(() => {
    if (prev.current === view) return;
    prev.current = view;
    window.scrollTo(0, 0);
    const main = document.getElementById("main");
    const target = main?.querySelector<HTMLElement>("h1") ?? main;
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }, [view]);
}

/**
 * Inside ThreatReady when the signed-in user could not be confirmed: progress is kept for this tab
 * only (never under a key other learners on this browser could read), and we say so.
 */
function SessionOnlyNotice() {
  const problem = platformIdentityProblem();
  if (!problem) return null;
  const wait = platformRetryAfter();
  return (
    <div className="notice amber" role="status">
      <div>
        <strong>Progress won't be saved this time.</strong>{" "}
        {problem === "signed-out"
          ? "Your ThreatReady sign-in could not be confirmed (it may have expired)."
          : "We couldn't reach ThreatReady to confirm who is signed in."}{" "}
        You can still practise, but scores and attempts stay in this tab only.{" "}
        {problem === "signed-out"
          ? "Reload to sign in again."
          : wait
            ? `Reload in about ${waitText(wait)} to try again.`
            : "Reload to try again."}
      </div>
      <button className="btn sm" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

const SMALL_NOTE_KEY = "aeropay-lab:small-screen-note-dismissed";

/** Below 768 px (CSS) the workspace's logs, map and rule builder are cramped: say so, once. */
function SmallScreenNotice() {
  const [dismissed, setDismissed] = React.useState(() => {
    try {
      return window.sessionStorage.getItem(SMALL_NOTE_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div className="notice small-screen-note">
      <div>
        <strong>Best on a larger screen.</strong> The logs console, architecture map and rule builder are easier
        to use on a tablet or desktop. Everything still works here — wide panels scroll sideways.
      </div>
      <button
        className="btn sm ghost"
        onClick={() => {
          setDismissed(true);
          try {
            window.sessionStorage.setItem(SMALL_NOTE_KEY, "1");
          } catch {
            /* private mode: dismissed for this view only */
          }
        }}
      >
        Dismiss
      </button>
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
          {t.icon && <span aria-hidden="true">{t.icon} </span>}
          {t.text}
        </div>
      ))}
    </div>
  );
}
