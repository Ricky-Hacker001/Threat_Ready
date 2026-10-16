import type { AppInfo, Me } from "@threatready/contracts";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { api, ApiError, type PublicConfig } from "../lib/api";
import { authClient, useSession } from "../lib/auth-client";
import { messageFor } from "../lib/errors";
import { appForUrl, clearNext, pendingNext, takeNext } from "../lib/platform";
import { AppSwitcher, BrandLink, PlatformFooter, PlatformHeader, PlatformLoading, rememberApps, ThemeToggle, type ShellLocation } from "./Platform";
import { ProfileMenu } from "./ProfileMenu";
import { Button, Notice } from "./ui";

interface MeContext {
  me: Me;
  refresh: () => Promise<void>;
  /** Every ThreatReady app with its public URL and status */
  apps: AppInfo[];
}

const appTitleFor = (apps: AppInfo[], url: string) => appForUrl(apps, url)?.title ?? "that app";
const Ctx = createContext<MeContext | null>(null);
export function useMe(): MeContext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMe outside AppShell");
  return v;
}

/** Protected layout: no session → back to the auth page. */
export function AppShell() {
  const { data: session } = useSession();
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

  const refresh = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([api.me(), api.config()]);
      setMe(m);
      setConfig(c);
      rememberApps(c.apps);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate("/", { replace: true });
        return;
      }
      setError(err instanceof ApiError ? err.message : messageFor(null));
    }
  }, [navigate]);

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
      setFlash(`${title} needs a ThreatReady account. Create one to continue; your trial stays here.`);
      return;
    }
    const { url, bounced } = takeNext(config.appOrigins);
    if (url) {
      setLeaving(appTitleFor(config.apps, url));
      window.location.replace(url);
    } else if (bounced) {
      setFlash(`We couldn't open ${appTitleFor(config.apps, bounced)}. It may be unavailable; try again in a moment.`);
    }
  }, [me, config]);

  async function signOut() {
    setSigningOut(true);
    // A trial user can't come back to the same trial, so remove it rather than leave an orphan.
    if (me?.user.isTrial) await authClient.deleteAnonymousUser().catch(() => undefined);
    await authClient.signOut();
    navigate("/", { replace: true });
  }

  let who: ReactNode = null;
  if (me?.user.isTrial) {
    who = (
      <>
        <span className="pill hide-narrow">Free trial</span>
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
              {me?.user.isTrial ? "Leave trial" : "Sign out"}
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
