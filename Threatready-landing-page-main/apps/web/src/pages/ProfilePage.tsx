import type { Overview } from "@threatready/contracts";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMe } from "../components/AppShell";
import { ActivityList, AppCards, AppCardsSkeleton } from "../components/Overview";
import { Avatar, displayName } from "../components/ProfileMenu";
import { Button, GitHubLogo, GoogleLogo, Notice } from "../components/ui";
import { OrgCard } from "./OrgPage";
import { api } from "../lib/api";
import { authClient, useSession } from "../lib/auth-client";

const PROVIDERS: Record<string, { label: string; icon?: ReactNode }> = {
  google: { label: "Google", icon: <GoogleLogo /> },
  github: { label: "GitHub", icon: <GitHubLogo /> },
  credential: { label: "Username and password" },
};

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" });

/**
 * The unified profile: progress from every ThreatReady app (each keeps its own
 * dashboard, reports and status; this page shows the overview and links in),
 * then the read-only account summary. Profile editing is not offered in this
 * release (/update-user is disabled on the API).
 */
export function ProfilePage() {
  const { me } = useMe();
  const { data: session } = useSession();
  const [methods, setMethods] = useState<string[] | null>(null);
  const [methodsError, setMethodsError] = useState(false);
  const [methodsAttempt, setMethodsAttempt] = useState(0);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState(false);

  const loadOverview = useCallback(() => {
    setOverviewError(false);
    api.overview().then(setOverview, () => setOverviewError(true));
  }, []);

  useEffect(() => {
    if (!me.user.isTrial) loadOverview();
  }, [me.user.isTrial, loadOverview]);

  useEffect(() => {
    if (me.user.isTrial) return;
    let cancelled = false;
    setMethodsError(false);
    authClient.listAccounts().then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) setMethodsError(true);
      else setMethods([...new Set(data.map((a) => a.providerId))]);
    });
    return () => {
      cancelled = true;
    };
  }, [me.user.isTrial, methodsAttempt]);

  const back = (
    <Link className="btn btn-quiet" to="/app">
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Home
    </Link>
  );

  if (me.user.isTrial) {
    return (
      <div className="module">
        {back}
        <div className="module-head">
          <h1>Profile</h1>
          <p>You're browsing as a guest, so there's no profile yet. Create a free account to start practising and keep your progress.</p>
        </div>
        <div>
          <Link className="btn btn-primary" to="/?mode=signup">
            Create account
          </Link>
        </div>
      </div>
    );
  }

  const user = {
    name: session?.user.name,
    image: session?.user.image,
    username: me.user.username,
    email: me.user.email,
  };
  const createdAt = session?.user.createdAt ? new Date(session.user.createdAt) : null;
  const verified = session?.user.emailVerified;

  return (
    <div className="module module-wide">
      {back}

      <section className="profile-card" aria-labelledby="profile-name">
        <Avatar user={user} size={72} />
        <div className="profile-card-id">
          <h1 id="profile-name">{displayName(user)}</h1>
          {me.user.username ? <p>@{me.user.username}</p> : null}
        </div>
      </section>

      <section className="overview" aria-labelledby="profile-overview">
        <div className="overview-head">
          <h2 id="profile-overview" className="profile-section-title">
            Your progress across ThreatReady
          </h2>
          {overview ? (
            <Button type="button" variant="quiet" onClick={loadOverview}>
              Refresh
            </Button>
          ) : null}
        </div>
        {overviewError ? (
          <Notice tone="error">
            Couldn't load your progress just now. Nothing is lost: interviews, Attack Reasoning and the server-scored labs
            are saved to your account, and the DevSecOps Lab, ThreatReady Firewall and AI Security Lab keep their progress
            in this browser.{" "}
            <button type="button" className="link-btn" onClick={loadOverview}>
              Try again
            </button>
          </Notice>
        ) : overview ? (
          <>
            <AppCards apps={overview.apps} onRetry={loadOverview} />
            <div className="module-panel">
              <h3 className="profile-section-title">Recent activity</h3>
              <ActivityList items={overview.recent} />
            </div>
          </>
        ) : (
          <>
            <p className="visually-hidden" role="status">
              Loading your progress…
            </p>
            <AppCardsSkeleton />
          </>
        )}
      </section>

      <OrgCard />

      <section className="module-panel" aria-labelledby="profile-account">
        <h2 id="profile-account" className="profile-section-title">
          Account details
        </h2>
        <dl className="profile-list">
          <div>
            <dt>Full name</dt>
            <dd>{session?.user.name?.trim() || <span className="profile-empty">Not provided</span>}</dd>
          </div>
          <div>
            <dt>Username</dt>
            <dd>
              {me.user.username ?? <span className="profile-empty">Not set (you signed in with a provider)</span>}
            </dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd className="profile-email">
              {me.user.email ?? <span className="profile-empty">Not provided</span>}
              {me.user.email && verified !== undefined ? (
                <span className={verified ? "badge badge-ok" : "badge badge-warn"}>
                  {verified ? "Verified" : "Not verified"}
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>{createdAt ? dateFmt.format(createdAt) : "—"}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd className="profile-cap">{me.plan}</dd>
          </div>
        </dl>
      </section>

      <section className="module-panel" aria-labelledby="profile-signin">
        <h2 id="profile-signin" className="profile-section-title">
          Sign-in methods
        </h2>
        {methodsError ? (
          <Notice tone="error">
            Couldn't load your sign-in methods.{" "}
            <button type="button" className="link-btn" onClick={() => setMethodsAttempt((n) => n + 1)}>
              Try again
            </button>
          </Notice>
        ) : methods === null ? (
          <p className="quota" role="status">
            Loading…
          </p>
        ) : (
          <ul className="profile-methods">
            {methods.map((id) => {
              const p = PROVIDERS[id] ?? { label: id };
              return (
                <li key={id}>
                  {p.icon ?? (
                    <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <rect x="4" y="9" width="12" height="8" rx="1.5" />
                      <path d="M7 9V6.5a3 3 0 016 0V9" />
                    </svg>
                  )}
                  {p.label}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
