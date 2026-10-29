import type { InvitationPreview } from "@threatready/contracts";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CaseFile } from "../components/CaseFile";
import { ThemeToggle } from "../components/Platform";
import { Brand, Button, Notice, usePageTitle } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/auth-client";
import { messageFor } from "../lib/errors";
import { rememberNext } from "../lib/platform";

/**
 * The page an invitation email links to (/invite/<token>). Works signed out: it shows who invited
 * whom to what, then sends the person to sign in or create an account with the invited address and
 * brings them back here. Signed in, one button joins. The token is never stored client-side.
 */
export function InvitePage() {
  // A token URL: no organisation or inviter name in the tab title (history, tab sync).
  usePageTitle("Invitation");
  const { token = "" } = useParams();
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<{ name: string; role: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.invitation.preview(token).then(
      (p) => {
        if (!cancelled) setPreview(p);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError && err.status === 404 ? "This invitation link isn't valid. Check the latest email from your organisation, or ask its admin to send a new one." : errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  const user = session?.user as { isAnonymous?: boolean | null; email?: string | null } | undefined;
  const signedIn = !isPending && !!session && !user?.isAnonymous;
  const here = `${window.location.origin}/invite/${token}`;

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.invitation.accept(token);
      setJoined({ name: r.org.name, role: r.role });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function goSignIn(mode?: "signup") {
    rememberNext(here);
    navigate(mode ? `/?mode=${mode}` : "/", { replace: false });
  }

  const roleText = (r: string) => (r === "manager" ? "a manager: you'll invite people and see the team's progress" : "a member: you'll use ThreatReady on the organisation's plan");

  return (
    <div className="auth">
      <main className="auth-main">
        <div className="auth-top">
          <Brand />
          <ThemeToggle />
        </div>
        <div className="auth-form-wrap">
          <div className="auth-panel">
            {joined ? (
              <>
                <div className="auth-heading">
                  <h1>You're in</h1>
                  <p>
                    You've joined <strong>{joined.name}</strong> as {roleText(joined.role)}.
                  </p>
                </div>
                <div className="form">
                  <Button type="button" block onClick={() => navigate(joined.role === "manager" ? "/app/org" : "/app", { replace: true })}>
                    {joined.role === "manager" ? "Open the organisation console" : "Go to ThreatReady"}
                  </Button>
                </div>
              </>
            ) : preview ? (
              <>
                <div className="auth-heading">
                  <h1>Join {preview.org.name}</h1>
                  <p>
                    {preview.invitedBy ? <>{preview.invitedBy} invited you</> : <>You're invited</>} to {preview.org.name} on ThreatReady as {roleText(preview.role)}. The invitation was sent to{" "}
                    <strong>{preview.emailHint}</strong>.
                  </p>
                </div>
                {preview.state !== "valid" ? (
                  <Notice tone="info">
                    {preview.state === "expired"
                      ? "This invitation has expired. Ask your organisation's admin to send a new one."
                      : preview.state === "accepted"
                        ? "This invitation has already been used. If that was you, sign in."
                        : "This invitation was withdrawn. Ask your organisation's admin for a new one."}
                  </Notice>
                ) : null}
                {error ? <Notice tone="error">{error}</Notice> : null}
                {preview.state === "valid" ? (
                  signedIn ? (
                    <div className="form">
                      <p>
                        You're signed in as <strong>{user?.email ?? "your account"}</strong>. Joining counts your ThreatReady activity on the organisation's plan, and its admins see your progress and scores there from the day you join. What you did before, and anything on your personal plan, stays yours.
                      </p>
                      <Button type="button" block loading={busy} onClick={() => void accept()}>
                        Join {preview.org.name}
                      </Button>
                      <p className="field-hint">
                        Not the invited address?{" "}
                        <Link to="/signout" onClick={() => rememberNext(here)}>
                          Sign out
                        </Link>{" "}
                        and sign in with {preview.emailHint}.
                      </p>
                    </div>
                  ) : (
                    <div className="form">
                      <p>Sign in with the invited address, or create an account with it. You'll come back here to finish joining.</p>
                      <Button type="button" block onClick={() => goSignIn()}>
                        Sign in
                      </Button>
                      <Button type="button" variant="secondary" block onClick={() => goSignIn("signup")}>
                        Create an account
                      </Button>
                    </div>
                  )
                ) : (
                  <div className="form">
                    <Button type="button" variant="secondary" block onClick={() => navigate("/")}>
                      Go to sign in
                    </Button>
                  </div>
                )}
              </>
            ) : error ? (
              <>
                <div className="auth-heading">
                  <h1>Invitation not found</h1>
                </div>
                <Notice tone="error">{error}</Notice>
                <div className="form">
                  <Button type="button" variant="secondary" block onClick={() => navigate("/")}>
                    Go to sign in
                  </Button>
                </div>
              </>
            ) : (
              <p className="quota" role="status">
                Checking the invitation…
              </p>
            )}
          </div>
        </div>
      </main>
      <CaseFile />
    </div>
  );
}

const errorText = (err: unknown) => (err instanceof ApiError ? (err.status === 429 ? messageFor(err) : err.message) : messageFor(null));
