import type { AppInfo, Me } from "@threatready/contracts";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { api, ApiError, type PublicConfig } from "../lib/api";
import { authClient, useSession } from "../lib/auth-client";
import { messageFor } from "../lib/errors";
import { clearNext, pendingNext, rememberNext, takeNext } from "../lib/platform";
import { appAt, AppSwitcher, BrandLink, nextPrefixes, PlatformFooter, PlatformHeader, PlatformLoading, rememberApps, ThemeToggle, type ShellLocation } from "./Platform";
import { ProfileMenu } from "./ProfileMenu";
import { Button, Notice } from "./ui";

interface MeContext {
  me: Me;
  refresh: () => Promise<void>;
  /** Every ThreatReady app with its public URL and status */
  apps: AppInfo[];
}

const appTitleFor = (apps: AppInfo[], url: string) => appAt(apps, url)?.title ?? "that app";
const Ctx = createContext<MeContext | null>(null);
export function useMe(): MeContext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMe outside AppShell");
  return v;
}

/** Set when a 401 sent the browser to sign in; a second one moments later means the local session is stuck. */
const EXPIRED_KEY = "tr_session_expired_at";

/** Protected layout: no session → back to the auth page. */
export function AppShell() {
  const { data: session, refetch: refetchSession } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Header "current" follows the route; only /app itself is Home.
  const here: ShellLocation = pathname.startsWith("/app/admin") ? "admin" : pathname.startsWith("/app/profile") ? "profile" : "home";
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const expired = useRef(false);

  const refresh = useCallback(async () => {
    if (expired.current) return; // already on the way to sign-in
    try {
      const [m, c] = await Promise.all([api.me(), api.config()]);
      setMe(m);
      setConfig(c);
      rememberApps(c.apps);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        expired.current = true;
        // The session ended (signed out elsewhere, revoked, cookies cleared). Re-read it past the
        // cookie cache first: the auth page trusts the client's cached session and would send the
        // browser straight back here, again and again. Then sign in and return to this page.
        let last = 0;
        try {
          last = Number(sessionStorage.getItem(EXPIRED_KEY)) || 0;
          sessionStorage.setItem(EXPIRED_KEY, String(Date.now()));
        } catch {
          /* storage unavailable */
        }
        await refetchSession({ query: { disableCookieCache: true } }).catch(() => undefined);
        // Bounced straight back: drop the local session outright rather than loop.
        if (Date.now() - last < 10_000) await authClient.signOut().catch(() => undefined);
        rememberNext(window.location.href);
        navigate("/?reason=expired", { replace: true });
        return;
      }
      setError(err instanceof ApiError ? (err.status === 429 ? messageFor(err) : err.message) : messageFor(null));
    }
  }, [navigate, refetchSession]);

  // The API, not the client-side session cache, decides access: /api/me
  // returning 401 sends the user back to sign in. Re-checks when the session
  // identity changes (sign-in, sign-out, trial → account).
  const sessionUserId = session?.user.id;
  useEffect(() => {
    void refresh();
  }, [sessionUserId, refresh]);

  // Signed in and came from another app: send them back there (once).
  useEffect(() => {
    if (!me || !config || !pendingNext()) return;
    if (me.user.isTrial) {
      const title = appTitleFor(config.apps, pendingNext()!);
      clearNext();
      setFlash(`${title} needs a ThreatReady account. Create a free one to continue.`);
      return;
    }
    const { url, bounced } = takeNext(config.appOrigins, nextPrefixes(config.apps));
    if (url) {
      const target = new URL(url);
      if (target.origin === window.location.origin && /^\/app(\/|$)/.test(target.pathname)) {
        // One of onboard's own pages (a session that expired here): no reload needed.
        navigate(`${target.pathname}${target.search}${target.hash}`, { replace: true });
        return;
      }
      setLeaving(appTitleFor(config.apps, url));
      window.location.replace(url);
    } else if (bounced) {
      setFlash(`We couldn't open ${appTitleFor(config.apps, bounced)}. It may be unavailable; try again in a moment.`);
    }
  }, [me, config, navigate]);

  async function signOut() {
    setSigningOut(true);
    expired.current = true; // leaving on purpose: no "session ended" round trip
    clearNext();
    // A trial user can't come back to the same trial, so remove it rather than leave an orphan.
    if (me?.user.isTrial) await authClient.deleteAnonymousUser().catch(() => undefined);
    await authClient.signOut().catch(() => undefined);
    // A fresh page load, not a client-side navigation: the client's session store still holds the old
    // session for a moment after sign-out (Better Auth refetches it later), so the sign-in page would
    // send the browser back to /app and on to "Your session ended". A new document reads the session anew.
    window.location.replace("/");
  }

  let who: ReactNode = null;
  if (me?.user.isTrial) {
    who = (
      <>
        <span className="pill hide-narrow">Guest</span>
        <Link className="btn btn-primary hide-narrow" to="/?mode=signup">
          Create account
        </Link>
      </>
    );
  } else if (me) {
    const user = {
      name: session?.user.name,
      image: session?.user.image,
      username: me.user.username,
      email: me.user.email,
    };
    who = (
      <ProfileMenu
        user={user}
        isAdmin={me.user.isAdmin}
        apps={config?.apps ?? []}
        current={here}
        signingOut={signingOut}
        onSignOut={() => void signOut()}
      />
    );
  }

  // The shared loading screen until the session and config are known, and while leaving for another app.
  if (!error && (leaving || !me || !config)) return <PlatformLoading app={leaving ?? "ThreatReady"} />;

  return (
    <div className="tr-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <PlatformHeader>
        <BrandLink />
        {config ? <AppSwitcher apps={config.apps} current={here} /> : null}
        <div className="tr-nav-end topbar-user">
          <ThemeToggle />
          {who}
          {me && !me.user.isTrial ? null : (
            <Button type="button" variant="quiet" loading={signingOut} onClick={() => void signOut()}>
              {me?.user.isTrial ? "Leave guest session" : "Sign out"}
            </Button>
          )}
        </div>
      </PlatformHeader>
      <main id="main" className="page" tabIndex={-1}>
        {error ? (
          <div className="form">
            <Notice tone="error">{error}</Notice>
            <div>
              <Button type="button" variant="secondary" onClick={() => void refresh()}>
                Try again
              </Button>
            </div>
          </div>
        ) : me && config ? (
          <Ctx.Provider value={{ me, refresh, apps: config.apps }}>
            {flash ? (
              <div className="flash">
                <Notice tone="info">{flash}</Notice>
              </div>
            ) : null}
            <Outlet />
          </Ctx.Provider>
        ) : null}
      </main>
      <PlatformFooter />
    </div>
  );
}

export function Loading() {
  return (
    <PlatformLoading />
  );
}
