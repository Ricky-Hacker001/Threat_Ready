import type { AppInfo, AppKey } from "@threatready/contracts";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

/**
 * The ThreatReady platform shell (header and footer) in threatready.io's
 * design. Labs and Attack Reasoning render the same markup with the same
 * platform.css, so moving between apps feels like one product.
 */

export function ThemeToggle() {
  const [light, setLight] = useState(() => document.documentElement.getAttribute("data-theme") === "light");
  function toggle() {
    const next = !light;
    setLight(next);
    // theme-init.js (loaded in <head>) stores it in the shared cookie for every ThreatReady app.
    (window as unknown as { trSetTheme: (t: string) => void }).trSetTheme(next ? "light" : "dark");
  }
  return (
    <button
      type="button"
      className="tr-theme-btn"
      onClick={toggle}
      aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
      title={light ? "Dark theme" : "Light theme"}
    >
      <svg className="tr-icon tr-i-moon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
      </svg>
      <svg className="tr-icon tr-i-sun" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    </button>
  );
}

export function BrandLink({ to = "/app", sub }: { to?: string; sub?: string }) {
  return (
    <Link className="tr-brand" to={to} aria-label="ThreatReady home">
      <img src="/logo-sm.png" width="26" height="25" alt="" />
      ThreatReady
      {sub ? <small>{sub}</small> : null}
    </Link>
  );
}

/** The last app list seen, shared with every ThreatReady app so each header is complete on first paint. */
const APPS_KEY = "tr-platform-apps";
export const rememberApps = (apps: AppInfo[]) => {
  try {
    localStorage.setItem(APPS_KEY, JSON.stringify({ at: Date.now(), apps }));
  } catch {
    /* storage unavailable */
  }
};

/**
 * The one loading screen every ThreatReady app shows while it opens. It never mentions sign-in:
 * a signed-out visitor is redirected to the auth page, never shown a form here.
 */
export function PlatformLoading({ app = "ThreatReady" }: { app?: string }) {
  return (
    <div className="trp tr-loading" role="status" aria-live="polite">
      <div className="tr-loading-in">
        <span className="tr-loading-mark">
          <img src="/logo-sm.png" alt="" />
          ThreatReady
        </span>
        <span className="tr-loading-bar" aria-hidden="true">
          <i />
        </span>
        <p>Opening {app}…</p>
      </div>
    </div>
  );
}

// Relative to each app's base URL, which may include a path (https://host/labs/) in a single-origin deployment.
const APP_PATH: Record<AppKey, string> = { interview: "interview-prep", labs: "", reasoning: "" };

/** Where an app's own home page is. */
export const appHref = (a: Pick<AppInfo, "key" | "url">) => new URL(APP_PATH[a.key], a.url).toString();

export type ShellLocation = "home" | "profile" | "admin" | AppKey;

/** Home plus every ThreatReady app, each a link to its own subdomain. Names come from the app registry. */
export function AppSwitcher({ apps, current }: { apps: AppInfo[]; current: ShellLocation }) {
  return (
    <nav aria-label="ThreatReady apps">
      <ul className="tr-apps">
        <li>
          <Link className="tr-app-link" to="/app" aria-current={current === "home" ? "page" : undefined}>
            Home
          </Link>
        </li>
        {apps.map((a) => (
          <li key={a.key}>
            {a.status === "live" ? (
              <a className="tr-app-link" href={appHref(a)} aria-current={current === a.key ? "page" : undefined}>
                <span className={`tr-dot tr-dot-${a.key}`} aria-hidden="true" />
                {a.title}
              </a>
            ) : (
              <span className="tr-app-link" aria-disabled="true" title="Coming soon">
                <span className={`tr-dot tr-dot-${a.key}`} aria-hidden="true" />
                {a.title}
                <span className="tr-tag tr-tag-soon tr-tag-plain">Soon</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function PlatformHeader({ children }: { children: ReactNode }) {
  return (
    <header className="tr-nav">
      <div className="tr-wrap tr-nav-in">{children}</div>
    </header>
  );
}

const SITE = "https://threatready.io";

export function PlatformFooter() {
  return (
    <footer className="tr-footer">
      <div className="tr-wrap">
        <div className="tr-footer-in">
          <div>
            <a className="tr-brand" href={SITE}>
              <img src="/logo-sm.png" width="26" height="25" alt="" />
              ThreatReady
            </a>
            <p>Role-based assessment of security reasoning and interview readiness. A product of Aerovant Technologies.</p>
          </div>
          <nav aria-label="Legal and help">
            <ul>
              <li><a href={`${SITE}/how-it-works.html`} target="_blank" rel="noopener noreferrer">How it works</a></li>
              <li><a href={`${SITE}/rubric.html`} target="_blank" rel="noopener noreferrer">Scoring rubric</a></li>
              <li><a href={`${SITE}/security.html`} target="_blank" rel="noopener noreferrer">Security</a></li>
              <li><a href={`${SITE}/privacy.html`} target="_blank" rel="noopener noreferrer">Privacy</a></li>
              <li><a href={`${SITE}/terms.html`} target="_blank" rel="noopener noreferrer">Terms</a></li>
              <li><a href={`${SITE}/contact.html`} target="_blank" rel="noopener noreferrer">Contact</a></li>
            </ul>
          </nav>
        </div>
        <div className="tr-footer-bottom">
          <span>© {new Date().getFullYear()} Aerovant Technologies Pvt. Ltd.</span>
          <span>Simulated environments only. No real systems are touched.</span>
        </div>
      </div>
    </footer>
  );
}
