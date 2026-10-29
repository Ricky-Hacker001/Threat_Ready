import { Link } from "react-router";
import { Brand, usePageTitle } from "../components/ui";

/**
 * Any address that is no page of onboard (a mistyped or stale link). Says so and offers the ways back,
 * instead of silently landing on sign-in as if the link had worked. Needs no session, so it has no shell.
 */
export function NotFoundPage() {
  usePageTitle("Page not found");
  return (
    <main id="main" className="notfound">
      <div className="notfound-card">
        <Brand to="/" />
        <p className="notfound-code" aria-hidden="true">
          404
        </p>
        <h1>Page not found</h1>
        <p>There is nothing at this address on ThreatReady. The link may be mistyped or out of date.</p>
        <div className="notfound-actions">
          <Link className="btn btn-primary" to="/app">
            Go to your home
          </Link>
          <Link className="btn btn-secondary" to="/">
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
