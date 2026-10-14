import { useEffect } from "react";
import { useNavigate } from "react-router";
import { authClient } from "../lib/auth-client";

/**
 * Single sign-out for every app. InterviewPrep and Labs link here
 * (onboard.threatready.io/signout?next=…); the session cookie is shared, so
 * ending it here signs the user out everywhere. ?next= is kept so signing back
 * in returns to the app they left.
 */
export function SignOutPage() {
  const navigate = useNavigate();
  useEffect(() => {
    let done = false;
    void authClient.signOut().finally(() => {
      if (!done) navigate("/", { replace: true });
    });
    return () => {
      done = true;
    };
  }, [navigate]);
  return (
    <div className="center-screen" role="status">
      Signing you out…
    </div>
  );
}
