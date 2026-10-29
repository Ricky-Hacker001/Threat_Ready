import { safeNext } from "@threatready/contracts";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { CaseFile } from "../components/CaseFile";
import { appAt, nextPrefixes, ThemeToggle } from "../components/Platform";
import { Brand, Button, usePageTitle } from "../components/ui";
import { api, type PublicConfig } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { cameFromPlatform, clearNext, rememberNext } from "../lib/platform";

const NO_CONFIG: PublicConfig = { providers: { google: false, github: false }, turnstileSiteKey: null, apps: [], appOrigins: [] };

/**
 * Single sign-out for every app. The session cookie is shared, so ending it here signs the user out
 * everywhere. ?next= (checked like every return target) is where Cancel goes back to, and where
 * signing in again returns.
 *
 * A GET alone never ends the session from elsewhere: a link or image on any site could otherwise log
 * people out, so a cold visit asks first. When the click came from a ThreatReady page
 * (cameFromPlatform: the referrer is a registered app or a page inside one), the learner already
 * chose "Sign out" there and it happens at once. Until that is known the page says nothing about
 * signing out, so a learner who closes a slow tab does not believe they were signed out.
 */
export function SignOutPage() {
  usePageTitle("Sign out");
  const navigate = useNavigate();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  // No referrer (typed URL, bookmark, a link from a site that sends none): ask at once. A referrer is
  // checked against the platform's app origins, which come with the config.
  const [mode, setMode] = useState<"deciding" | "ask" | "signing-out">(() => (document.referrer ? "deciding" : "ask"));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const decided = useRef(false);
  const [rawNext] = useState(() => new URLSearchParams(window.location.search).get("next"));

  useEffect(() => {
    api.config().then(setConfig, () => setConfig(NO_CONFIG));
  }, []);

  const next = config ? safeNext(rawNext, config.appOrigins, nextPrefixes(config.apps)) : null;
  const backTo = next && config ? (appAt(config.apps, next)?.title ?? "ThreatReady") : "ThreatReady";

  async function signOut() {
    setMode("signing-out");
    try {
      await authClient.signOut();
    } finally {
      // To sign-in, keeping where they were: signing in again returns there.
      if (next) rememberNext(next);
      else clearNext();
      navigate(next ? `/?next=${encodeURIComponent(next)}` : "/", { replace: true });
    }
  }

  function cancel() {
    clearNext();
    if (next) window.location.assign(next);
    else navigate("/app", { replace: true });
  }

  useEffect(() => {
    // Decided once, when the config (app origins) arrives; the ref also covers StrictMode's second run.
    if (!config || decided.current) return;
    decided.current = true;
    if (document.referrer && cameFromPlatform(document.referrer, window.location.href, config.appOrigins, nextPrefixes(config.apps))) {
      void signOut();
    } else {
      setMode("ask");
    }
  }, [config]);

  useEffect(() => {
    if (mode === "ask") headingRef.current?.focus();
  }, [mode]);

  const asking = mode === "ask";
  const heading = asking ? "Sign out of ThreatReady?" : mode === "signing-out" ? "Signing you out…" : "One moment…";
  return (
    <div className="auth">
      <main className="auth-main">
        <div className="auth-top">
          <Brand />
          <ThemeToggle />
        </div>
        <div className="auth-form-wrap">
          <div className="auth-panel" aria-busy={!asking || undefined}>
            <div className="auth-heading">
              <h1 ref={headingRef} tabIndex={-1}>
                {heading}
              </h1>
              {asking ? (
                <p>This ends your session on this browser in every ThreatReady app: InterviewPrep, Lab Simulations and the Attack Reasoning Lab.</p>
              ) : mode === "signing-out" ? (
                <p role="status">Ending your session in every ThreatReady app on this browser.</p>
              ) : null}
            </div>
            {asking ? (
              <div className="signout-actions">
                {/* Enabled once the config says where "back" and the next sign-in lead. */}
                <Button type="button" disabled={!config} onClick={() => void signOut()}>
                  Sign out
                </Button>
                <Button type="button" variant="secondary" disabled={!config} onClick={cancel}>
                  {next ? `Stay signed in, back to ${backTo}` : "Stay signed in"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </main>
      <CaseFile />
    </div>
  );
}
