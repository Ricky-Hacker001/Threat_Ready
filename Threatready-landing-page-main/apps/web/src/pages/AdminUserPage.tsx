import type { AdminUserDetail, AiUsageTotals, AppKey } from "@threatready/contracts";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { AppCards } from "../components/Overview";
import { Avatar, displayName } from "../components/ProfileMenu";
import { Notice } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { fmtAgo, fmtCompact, fmtDate, fmtDateTime, fmtInt, fmtUsd } from "../lib/format";
import { AppTag, RangePicker, Tile, UsageTable, rangeFor, tokensOf } from "./AdminPage";

/** One user across every app: identity, sessions, each app's own summary, and AI usage. */
export function AdminUserPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const range = useMemo(() => rangeFor(params.get("range")), [params]);
  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.admin.user(id, { from: range.from, to: range.to }).then(
      (d) => !cancelled && setData(d),
      (err) => {
        if (cancelled) return;
        setError(err instanceof ApiError && err.status === 404 ? "No such user." : "Couldn't load this user. Refresh to try again.");
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, range.key]);

  const back = (
    <Link className="btn btn-quiet" to={`/app/admin?range=${range.key}`}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      All users
    </Link>
  );

  if (error) {
    return (
      <div className="admin">
        {back}
        <Notice tone="error">{error}</Notice>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="admin">
        {back}
        <p className="quota" role="status">
          Loading…
        </p>
      </div>
    );
  }

  const u = data.user;
  return (
    <div className="admin">
      {back}
      <div className="admin-head">
        <section className="profile-card" aria-labelledby="admin-user-name">
          <Avatar user={{ name: u.name, email: u.email, username: u.username }} size={64} />
          <div className="profile-card-id">
            <h1 id="admin-user-name">{displayName({ name: u.name, email: u.email, username: u.username })}</h1>
            <p>
              {u.email ?? "No email"}
              {u.username ? ` · @${u.username}` : ""}
            </p>
            <p className="badges">
              {u.isAdmin ? <span className="badge badge-info">Admin</span> : null}
              {u.isTrial ? <span className="badge badge-warn">Trial</span> : null}
              <span className={u.emailVerified ? "badge badge-ok" : "badge badge-muted"}>
                {u.emailVerified ? "Email verified" : "Email not verified"}
              </span>
            </p>
          </div>
        </section>
        <RangePicker value={range.key} onChange={(k) => setParams({ range: k }, { replace: true })} />
      </div>

      <section aria-label="This user's numbers" className="tiles">
        <Tile label="AI cost in range" value={fmtUsd(u.ai.costUsd)} sub={`${fmtInt(u.ai.calls)} LLM calls`} />
        <Tile label="Tokens in range" value={fmtCompact(tokensOf(u.ai))} sub={`${fmtCompact(u.ai.inputTokens)} in · ${fmtCompact(u.ai.outputTokens)} out`} />
        <Tile label="Joined" value={fmtDate(u.createdAt)} />
        <Tile label="Last seen" value={fmtAgo(u.lastSeenAt)} sub={`${u.activeSessions} active session${u.activeSessions === 1 ? "" : "s"}`} />
      </section>

      <section className="overview" aria-labelledby="admin-user-apps">
        <h2 id="admin-user-apps" className="profile-section-title">
          Activity in each app
        </h2>
        {/* Admin view: item links would open the learner's own pages, which the apps scope to the owner. */}
        <AppCards apps={data.apps} linkOut={false} />
      </section>

      <section className="module-panel">
        <h2 className="profile-section-title">AI usage by app</h2>
        <UsageTable
          first="App"
          rows={(Object.entries(u.aiByApp) as [AppKey, AiUsageTotals][]).map(([app, t]) => ({ ...t, key: app, label: <AppTag app={app} /> }))}
        />
      </section>

      <div className="admin-split">
        <section className="module-panel">
          <h2 className="profile-section-title">By model</h2>
          <UsageTable
            first="Model"
            rows={data.byModel.map((m) => ({
              ...m,
              key: `${m.app}:${m.model}`,
              label: (
                <span className="feature-cell">
                  <AppTag app={m.app} />
                  <code>{m.model}</code>
                </span>
              ),
            }))}
          />
        </section>
        <section className="module-panel">
          <h2 className="profile-section-title">By feature</h2>
          <UsageTable
            first="Feature"
            rows={data.byFeature.map((f) => ({
              ...f,
              key: `${f.app}:${f.feature}`,
              label: (
                <span className="feature-cell">
                  <AppTag app={f.app} />
                  <code>{f.feature}</code>
                </span>
              ),
            }))}
          />
        </section>
      </div>

      <section className="module-panel">
        <h2 className="profile-section-title">Account</h2>
        <dl className="profile-list">
          <div>
            <dt>User ID</dt>
            <dd>
              <code>{u.id}</code>
            </dd>
          </div>
          <div>
            <dt>Sign-in methods</dt>
            <dd>{data.signInMethods.length ? data.signInMethods.join(", ") : <span className="profile-empty">None</span>}</dd>
          </div>
        </dl>
      </section>

      <section className="module-panel">
        <h2 className="profile-section-title">Active sessions</h2>
        {data.sessions.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Expires</th>
                  <th scope="col">IP address</th>
                  <th scope="col">Browser</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{fmtDateTime(s.createdAt)}</td>
                    <td>{fmtDateTime(s.expiresAt)}</td>
                    <td>{s.ipAddress ?? "—"}</td>
                    <td className="ua" title={s.userAgent ?? undefined}>
                      {s.userAgent ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="quota">No active sessions.</p>
        )}
      </section>
    </div>
  );
}
