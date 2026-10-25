import type { AppKey, AppSummaryItem, OverviewApp } from "@threatready/contracts";
import { fmtAgo } from "../lib/format";

/** Product names as threatready.io uses them (same as the app registry in the API config). */
export const APP_LABEL: Record<AppKey, string> = {
  interview: "InterviewPrep",
  labs: "Lab Simulations",
  reasoning: "Attack Reasoning Lab",
};

/** Where each app's own dashboard lives; the overview links there for the full picture. */
// Paths are relative to each app's base URL (it may include a path, e.g. https://host/labs/).
const APP_HOME: Record<AppKey, string> = {
  interview: "interview-prep",
  labs: "",
  reasoning: "",
};

/** The first thing to do in an app that has no activity yet (empty state with a way forward). */
const FIRST_STEP: Record<AppKey, { label: string; path: string }> = {
  interview: { label: "Start your first interview", path: "interview-prep/new" },
  labs: { label: "Choose a lab", path: "" },
  reasoning: { label: "Browse scenarios", path: "" },
};

/** Scores are 0–100 in every app; always say so, so a score is never mistaken for a level or a count. */
export const fmtScore = (score: number | null) => (score === null ? "—" : `${Math.round(score)}/100`);

/** Skeleton cards while the apps answer, so the layout doesn't jump when they do. */
export function AppCardsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <ul className="app-cards" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="app-card">
          <span className="tr-skel" style={{ height: 20, width: "55%" }} />
          <div className="stat-list">
            {[0, 1, 2, 3].map((n) => (
              <div key={n}>
                <span className="tr-skel" style={{ height: 12, width: "70%", marginBottom: 6 }} />
                <span className="tr-skel" style={{ height: 22, width: "40%" }} />
              </div>
            ))}
          </div>
          <span className="tr-skel" style={{ height: 40, marginTop: "auto" }} />
        </li>
      ))}
    </ul>
  );
}

function AppState({ app }: { app: OverviewApp }) {
  if (app.status === "soon") return <span className="badge badge-muted">Coming soon</span>;
  if (app.error) return <span className="badge badge-warn">Unavailable</span>;
  return <span className="badge badge-ok">Live</span>;
}

/**
 * One card per app with that app's own numbers. The app keeps the detail
 * (reports, runs, history); the card links into it.
 */
export function AppCards({ apps, linkOut = true, onRetry }: { apps: OverviewApp[]; linkOut?: boolean; onRetry?: () => void }) {
  return (
    <ul className="app-cards">
      {apps.map((app) => (
        <li key={app.key} className={`app-card app-${app.key}`}>
          <div className="app-card-head">
            <h3>{app.title}</h3>
            <AppState app={app} />
          </div>
          {app.status === "soon" ? (
            <p className="quota">Not open yet. Your progress will show here when it launches.</p>
          ) : app.error ? (
            <div className="app-card-error">
              <p className="quota">
                {/* Truthful either way (BIZ-06): a summary that cannot be fetched changes nothing in the app,
                    whether it keeps progress on its server or, for some labs, in the learner's browser. */}
                We couldn't reach {APP_LABEL[app.key]} just now, so its progress isn't shown here. This doesn't change your progress; the app keeps it.
                {/* Admin view (linkOut=false) keeps the technical reason for troubleshooting. */}
                {!linkOut ? ` (${app.error})` : null}
              </p>
              {onRetry ? (
                <button type="button" className="link-btn" onClick={onRetry}>
                  Try again
                </button>
              ) : null}
            </div>
          ) : app.summary ? (
            <>
              <dl className="stat-list">
                {app.summary.stats.map((s) => (
                  <div key={s.label} title={s.hint}>
                    <dt>{s.label}</dt>
                    <dd>{s.value}</dd>
                  </div>
                ))}
              </dl>
              {app.summary.items.length ? (
                <ul className="mini-list">
                  {app.summary.items.slice(0, 3).map((i) => (
                    <li key={i.id}>
                      {linkOut ? (
                        <a href={i.url}>{i.title}</a>
                      ) : (
                        <span>{i.title}</span>
                      )}
                      <span className="mini-meta">
                        {i.status}
                        {i.score !== null ? ` · Score ${fmtScore(i.score)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : linkOut ? (
                <div className="app-card-empty">
                  <p className="quota">Nothing here yet.</p>
                  <a className="link-arrow" href={new URL(FIRST_STEP[app.key].path, app.url).toString()}>
                    {FIRST_STEP[app.key].label} <span aria-hidden="true">→</span>
                  </a>
                </div>
              ) : (
                <p className="quota">No activity yet.</p>
              )}
            </>
          ) : null}
          {linkOut && app.status === "live" ? (
            <a className="btn btn-secondary app-card-cta" href={new URL(APP_HOME[app.key], app.url).toString()}>
              Open {APP_LABEL[app.key]}
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ActivityList({ items, linkOut = true }: { items: (AppSummaryItem & { app: AppKey })[]; linkOut?: boolean }) {
  if (!items.length) {
    return (
      <p className="quota">
        No activity yet. {linkOut ? "Start an interview, a lab or a scenario and it will show up here." : null}
      </p>
    );
  }
  return (
    <ol className="activity">
      {items.map((i) => (
        <li key={`${i.app}:${i.id}`}>
          <span className={`app-tag app-tag-${i.app}`}>{APP_LABEL[i.app]}</span>
          <span className="activity-title">{linkOut ? <a href={i.url}>{i.title}</a> : i.title}</span>
          <span className="activity-status">{i.status}</span>
          <span className="activity-score" aria-label={i.score !== null ? `Score ${fmtScore(i.score)}` : "No score"}>
            {fmtScore(i.score)}
          </span>
          <time dateTime={i.at} title={new Date(i.at).toLocaleString()}>
            {fmtAgo(i.at)}
          </time>
        </li>
      ))}
    </ol>
  );
}
