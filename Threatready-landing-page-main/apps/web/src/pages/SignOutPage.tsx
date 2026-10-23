import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../components/ui";
import { authClient } from "../lib/auth-client";

/**
 * Single sign-out for every app. InterviewPrep and Labs link here
 * (onboard.threatready.io/signout?next=…); the session cookie is shared, so
 * ending it here signs the user out everywhere. ?next= is kept so signing back
 * in returns to the app they left.
 *
 * Signing out happens on the button, never on page load: a GET must not change
 * auth state (an image tag or link on any site could otherwise log people out).
 * The in-app menu signs out directly (AppShell) and never comes here.
 */
export function SignOutPage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await authClient.signOut();
    } finally {
      navigate("/", { replace: true });
    }
  }

  return (
    <div className="center-screen">
      <div style={{ display: "grid", gap: 16, justifyItems: "center", textAlign: "center" }}>
        <p style={{ margin: 0 }}>Sign out of ThreatReady on this browser?</p>
        <div style={{ display: "flex", gap: 12 }}>
          <Button type="button" variant="quiet" onClick={() => navigate("/", { replace: true })} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void signOut()} loading={busy}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
