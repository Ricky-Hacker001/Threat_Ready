import type { AdminUserDetail, AiUsageTotals, AppKey } from "@threatready/contracts";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { AppCards } from "../components/Overview";
import { Avatar, displayName } from "../components/ProfileMenu";
import { useMe } from "../components/AppShell";
import { Button, Field, Notice, usePageTitle } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { messageFor } from "../lib/errors";
import type { AdminRoleChangeResult } from "@threatready/contracts";
import { fmtAgo, fmtCompact, fmtDate, fmtDateTime, fmtInt, fmtUsd } from "../lib/format";
import { AppTag, RANGES, RangePicker, Tile, UsageTable, rangeFor, tokensOf } from "./AdminPage";
import { ACTIVITY_APP_LABEL, ActivityChart, ShareBar, areaLabel, countryName, featureLabel, fmtDuration, regionOf, timeZoneName } from "./adminInsights";

/** One user across every app: identity, sessions, each app's own summary, and AI usage. */
export function AdminUserPage() {
  // No name or email in the tab title: browser history and tab sync are not the place for them.
  usePageTitle("User details · Admin");
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const range = useMemo(() => rangeFor(params.get("range")), [params]);
  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    api.admin.user(id, { from: range.from, to: range.to }).then(
      (d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      },
      (err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof ApiError && err.status === 404 ? "No such user." : "Couldn't load this user. Try again in a moment.");
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, range.key, reload]);

  const back = (
    <Link className="btn btn-quiet" to={`/app/admin?range=${range.key}`}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      All users
    </Link>
  );

  // No data yet: the error is the page. With data on screen (a range change failed), keep it and say so above.
  if (error && !data) {
    return (
      <div className="admin">
        {back}
        <Notice tone="error">
          {error}{" "}
          <button type="button" className="link-btn" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </Notice>
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
    <div className="admin" aria-busy={loading || undefined}>
      {back}
      <p className="updating" role="status">
        {loading ? (
          <>
            <span className="spinner spinner-sm" aria-hidden="true" /> Updating…
          </>
        ) : null}
      </p>
      {error ? (
        <Notice tone="error">
          {error}{" "}
          <button type="button" className="link-btn" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </Notice>
      ) : null}
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

      <RoleCard user={u} onChanged={() => setReload((n) => n + 1)} />

      <p className="admin-summary" aria-label="In short">
        {displayName({ name: u.name, email: u.email, username: u.username })}{" "}
        {u.seconds ? (
          <>
            used ThreatReady for <strong>{fmtDuration(u.seconds)}</strong> in the last {RANGES.find((r) => r.key === range.key)!.label.toLowerCase()}
          </>
        ) : (
          <>has no measured time in the last {RANGES.find((r) => r.key === range.key)!.label.toLowerCase()} (time is measured from the activity-tracking release on)</>
        )}
        {data.time.byArea[0] ? (
          <>
            , mostly {areaLabel(data.time.byArea[0].app, data.time.byArea[0].area)} in {ACTIVITY_APP_LABEL[data.time.byArea[0].app]}
          </>
        ) : null}
        {u.country ? <>, from {countryName(u.country)}{u.timeZone ? ` (${timeZoneName(u.timeZone)})` : ""}</> : null}. AI cost{" "}
        <strong>{fmtUsd(u.ai.costUsd)}</strong> over {fmtInt(u.ai.calls)} call{u.ai.calls === 1 ? "" : "s"}.{" "}
        {u.lastApp ? (
          <>
            Last active in {ACTIVITY_APP_LABEL[u.lastApp.app]} ({areaLabel(u.lastApp.app, u.lastApp.area)}), {fmtAgo(u.lastApp.at)}.
          </>
        ) : null}
      </p>

      <section aria-label="This user's numbers" className="tiles">
        <Tile label="Time used in range" value={fmtDuration(u.seconds)} sub={`${data.time.daily.length} active day${data.time.daily.length === 1 ? "" : "s"}`} />
        <Tile label="Location" value={u.country ? countryName(u.country) : "—"} sub={u.timeZone ? `${timeZoneName(u.timeZone)} · ${regionOf(u.timeZone)}` : "No location yet"} />
        <Tile label="AI cost in range" value={fmtUsd(u.ai.costUsd)} sub={`${fmtInt(u.ai.calls)} LLM calls`} />
        <Tile label="Tokens in range" value={fmtCompact(tokensOf(u.ai))} sub={`${fmtCompact(u.ai.inputTokens)} in · ${fmtCompact(u.ai.outputTokens)} out`} />
        <Tile label="Joined" value={fmtDate(u.createdAt)} />
        <Tile label="Last seen" value={fmtAgo(u.lastSeenAt)} sub={`${u.activeSessions} active session${u.activeSessions === 1 ? "" : "s"}`} />
      </section>

      <section className="module-panel" aria-labelledby="admin-user-time">
        <h2 id="admin-user-time" className="profile-section-title">
          Time used
        </h2>
        <ActivityChart daily={data.time.daily} from={range.from} to={range.to} title="This user's active time" />
        {data.time.byArea.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">App</th>
                  <th scope="col">Where</th>
                  <th scope="col">Time</th>
                  <th scope="col">Last active</th>
                </tr>
              </thead>
              <tbody>
                {data.time.byArea.map((a) => (
                  <tr key={`${a.app}:${a.area}`}>
                    <td>{ACTIVITY_APP_LABEL[a.app]}</td>
                    <th scope="row">{areaLabel(a.app, a.area)}</th>
                    <td>
                      <ShareBar value={a.seconds} max={data.time.byArea[0]!.seconds} label={fmtDuration(a.seconds)} />
                    </td>
                    <td>{fmtAgo(a.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
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

      {/* Many columns each: full width, stacked. */}
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
                  <span>
                    {featureLabel(f.feature)} <code className="cell-sub">{f.feature}</code>
                  </span>
                </span>
              ),
            }))}
          />
        </section>

      <section className="module-panel" aria-labelledby="admin-user-locations">
        <h2 id="admin-user-locations" className="profile-section-title">
          Where they use ThreatReady from
        </h2>
        {data.locations.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Country</th>
                  <th scope="col">Region</th>
                  <th scope="col">Time zone</th>
                  <th scope="col" className="num">Time</th>
                  <th scope="col">First seen</th>
                  <th scope="col">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.locations.map((l) => (
                  <tr key={`${l.country}:${l.timeZone}`}>
                    <th scope="row">{countryName(l.country)}</th>
                    <td>{regionOf(l.timeZone)}</td>
                    <td>{timeZoneName(l.timeZone)}</td>
                    <td className="num">{fmtDuration(l.seconds)}</td>
                    <td>{fmtDateTime(l.firstAt)}</td>
                    <td>{fmtDateTime(l.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="quota">No locations in this range yet.</p>
        )}
      </section>

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

/**
 * Promote this user to platform admin, or remove it. The server enforces the rules (not yourself,
 * not a trial or unverified account, not the last admin, not an ADMIN_EMAILS admin); this card
 * explains them up front and asks the admin to retype the user's email before the change.
 */
function RoleCard({ user, onChanged }: { user: AdminUserDetail["user"]; onChanged: () => void }) {
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<AdminRoleChangeResult | null>(null);
  useEffect(() => { setOpen(false); setConfirm(""); setError(null); setDone(null); }, [user.id, user.isAdmin]);

  const isSelf = me.user.id === user.id;
  const promote = !user.isAdmin;
  const title = promote ? "Make admin" : "Remove admin access";
  const blocked =
    isSelf ? "You can\'t change your own role. Ask another admin." :
    user.isTrial ? "Trial accounts can\'t be admins. The user needs to create an account first." :
    promote && !user.emailVerified ? "Only a verified email can be made admin. The user needs to verify first." :
    !promote && user.adminSource === "env" ? "This admin is listed in ADMIN_EMAILS. Remove the email from that setting; the console can\'t override it." :
    null;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.admin.setRole(user.id, { role: promote ? "admin" : "user", confirmEmail: confirm });
      setDone(r); setOpen(false); setConfirm(""); onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 429 ? messageFor(e) : e.message) : "Couldn\'t change the role. Try again.");
    } finally { setBusy(false); }
  };

  return (
    <section className="profile-card admin-role" aria-labelledby="admin-role-title">
      <div className="profile-card-id">
        <h2 id="admin-role-title" className="h3" style={{ margin: 0 }}>Platform role</h2>
        <p>
          {user.isAdmin
            ? <>This user is an <strong>admin</strong>{user.adminSource === "env" ? " (via ADMIN_EMAILS)" : ""}: they see every user, token and AI cost, and can change roles.</>
            : <>This user is a <strong>learner</strong>. Admins see every user, token and AI cost, and can change roles.</>}
        </p>
        {done ? (
          <Notice tone="ok">
            {done.user.isAdmin ? "Now an admin." : `Admin access removed${done.sessionsEnded ? `; signed out of ${done.sessionsEnded} session${done.sessionsEnded === 1 ? "" : "s"}` : ""}.`} Recorded in the audit log.
          </Notice>
        ) : null}
        {blocked ? (
          <p className="field-hint">{blocked}</p>
        ) : !open ? (
          <div className="admin-role-actions">
            <Button type="button" variant={promote ? "primary" : "signal"} onClick={() => { setOpen(true); setDone(null); }}>{title}</Button>
          </div>
        ) : (
          <form className="admin-role-confirm" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <p className="field-hint">
              {promote
                ? "They will immediately see every user\'s data and AI cost. Type their email to confirm."
                : "They will be signed out everywhere and lose the admin console at once. Type their email to confirm."}
            </p>
            {/* Server refusals (last admin, unverified, …) concern the whole change, not the typed email. */}
            {error ? <Notice tone="error">{error}</Notice> : null}
            <Field label="Confirm email" type="email" autoComplete="off" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} />
            <div className="admin-role-actions">
              <Button type="submit" variant={promote ? "primary" : "signal"} loading={busy} disabled={!confirm || confirm.trim().toLowerCase() !== (user.email ?? "").toLowerCase()}>{title}</Button>
              <Button type="button" variant="quiet" onClick={() => { setOpen(false); setConfirm(""); setError(null); }} disabled={busy}>Cancel</Button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
