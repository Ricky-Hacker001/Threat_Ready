import type { AdminOverview, AdminUserList, AdminUserRow, AiUsageTotals, AppKey } from "@threatready/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useMe } from "../components/AppShell";
import { APP_LABEL } from "../components/Overview";
import { Button, Notice } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { API_ORIGIN } from "../lib/auth-client";
import { fmtAgo, fmtCompact, fmtDate, fmtInt, fmtUsd } from "../lib/format";
import { ACTIVITY_APP_LABEL, ActivityChart, ShareBar, areaLabel, countryName, featureLabel, fmtDuration, fmtHours, regionOf, timeZoneName } from "./adminInsights";

export const RANGES = [
  { key: "1d", label: "24 hours", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "365d", label: "12 months", days: 365 },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];

export function rangeFor(key: string | null): { key: RangeKey; from: string; to: string } {
  const r = RANGES.find((x) => x.key === key) ?? RANGES[2];
  const to = new Date();
  return { key: r.key, from: new Date(to.getTime() - r.days * 86_400_000).toISOString(), to: to.toISOString() };
}

export const tokensOf = (u: AiUsageTotals) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export function RangePicker({ value, onChange }: { value: RangeKey; onChange: (k: RangeKey) => void }) {
  return (
    <div className="seg" role="group" aria-label="Time range">
      {RANGES.map((r) => (
        <button key={r.key} type="button" aria-pressed={value === r.key} onClick={() => onChange(r.key)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {sub ? <span className="tile-sub">{sub}</span> : null}
    </div>
  );
}

/** App identity: a dot in the app's fixed hue, always beside its name (never color alone). */
export function AppTag({ app }: { app: AppKey }) {
  return <span className={`app-tag app-tag-${app}`}>{APP_LABEL[app]}</span>;
}

export function UsageTable({
  rows,
  first,
}: {
  rows: (AiUsageTotals & { app?: AppKey; key: string; label: ReactNode })[];
  first: string;
}) {
  if (!rows.length) return <p className="quota">No AI usage in this range.</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">{first}</th>
            <th scope="col" className="num">Calls</th>
            <th scope="col" className="num">Input tokens</th>
            <th scope="col" className="num">Output tokens</th>
            <th scope="col" className="num">Cache tokens</th>
            <th scope="col" className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td className="num">{fmtInt(r.calls)}</td>
              <td className="num">{fmtInt(r.inputTokens)}</td>
              <td className="num">{fmtInt(r.outputTokens)}</td>
              <td className="num">{fmtInt(r.cacheReadTokens + r.cacheWriteTokens)}</td>
              <td className="num strong">{fmtUsd(r.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserBadges({ u }: { u: Pick<AdminUserRow, "isAdmin" | "isTrial" | "emailVerified"> }) {
  return (
    <>
      {u.isAdmin ? <span className="badge badge-info">Admin</span> : null}
      {u.isTrial ? <span className="badge badge-warn">Trial</span> : null}
      {!u.isTrial && !u.emailVerified ? <span className="badge badge-muted">Unverified</span> : null}
    </>
  );
}

export function AdminGate({ children }: { children: ReactNode }) {
  const { me } = useMe();
  if (!me.user.isAdmin) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Couldn't load the admin data. Refresh to try again.";

/**
 * Platform admin console: users across every app, with each user's AI tokens
 * and cost (from each app's own LLM ledger).
 */
export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const range = useMemo(() => rangeFor(params.get("range")), [params]);
  const [q, setQ] = useState(params.get("q") ?? "");
  const sort = params.get("sort") ?? "cost";
  const includeTrial = params.get("trial") === "1";
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [list, setList] = useState<AdminUserList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.admin.overview({ from: range.from, to: range.to }),
      api.admin.users({
        from: range.from,
        to: range.to,
        q: params.get("q") ?? undefined,
        sort,
        includeTrial,
        page,
        size: 25,
      }),
    ]).then(
      ([o, l]) => {
        if (cancelled) return;
        setOverview(o);
        setList(l);
        setLoading(false);
      },
      (err) => {
        if (cancelled) return;
        setError(errorText(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // range.from/to change every render of rangeFor; key on the inputs instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.key, params.get("q"), sort, includeTrial, page]);

  const pages = list ? Math.max(1, Math.ceil(list.total / 25)) : 1;
  const unavailable = overview?.unavailable ?? [];

  // A refetch (range, search, sort, page) keeps the current numbers on screen; say they are being replaced.
  const updating = loading && (overview !== null || list !== null);

  return (
    <div className="admin" aria-busy={loading || undefined}>
      <div className="admin-head">
        <div>
          <h1>Admin console</h1>
          <p>Users, activity and AI spend across every ThreatReady app.</p>
        </div>
        <div className="admin-head-actions">
          <RangePicker value={range.key} onChange={(k) => set({ range: k, page: null })} />
          <a
            className="btn btn-secondary"
            href={`${API_ORIGIN}/api/admin/export/users.csv?${new URLSearchParams({ from: range.from, to: range.to, sort, includeTrial: String(includeTrial), ...(params.get("q") ? { q: params.get("q")! } : {}) })}`}
            download
          >
            Download users (CSV)
          </a>
        </div>
      </div>

      <p className="updating" role="status">
        {updating ? (
          <>
            <span className="spinner spinner-sm" aria-hidden="true" /> Updating…
          </>
        ) : null}
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {unavailable.length ? (
        <Notice tone="info">
          {unavailable.map((u) => APP_LABEL[u.app]).join(", ")} didn't respond, so the AI totals below leave{" "}
          {unavailable.length === 1 ? "it" : "them"} out.
        </Notice>
      ) : null}

      {overview ? (
        <>
          <p className="admin-summary" aria-label="In short">
            <Summary o={overview} rangeLabel={RANGES.find((r) => r.key === range.key)!.label} />
          </p>
          <section aria-label="Headline numbers" className="tiles">
            <Tile label="Users" value={fmtInt(overview.users.total)} sub={`${fmtInt(overview.users.verified)} verified`} />
            <Tile label="Active, last 7 days" value={fmtInt(overview.users.activeLast7Days)} />
            <Tile label="New in range" value={fmtInt(overview.users.newInRange)} sub={`${fmtInt(overview.users.trial)} trial sessions exist`} />
            <Tile
              label="Time used in range"
              value={fmtHours(overview.time.seconds)}
              sub={overview.time.users ? `${fmtDuration(overview.time.seconds / overview.time.users)} per active user` : "Measured from now on"}
            />
            <Tile
              label="Countries"
              value={fmtInt(overview.locations.countries.filter((c) => c.country !== "LO" && c.country !== "ZZ").length)}
              sub={overview.locations.countries[0] ? `Most users: ${countryName(overview.locations.countries[0].country)}` : "No locations yet"}
            />
            <Tile label="AI cost in range" value={fmtUsd(overview.ai.costUsd)} sub={`${fmtInt(overview.ai.calls)} LLM calls`} />
            <Tile
              label="Tokens in range"
              value={fmtCompact(tokensOf(overview.ai))}
              sub={`${fmtCompact(overview.ai.inputTokens)} in · ${fmtCompact(overview.ai.outputTokens)} out`}
            />
            <Tile
              label="Cost per AI user"
              value={overview.ai.users ? fmtUsd(overview.ai.costUsd / overview.ai.users) : "—"}
              sub={`${fmtInt(overview.ai.users)} user${overview.ai.users === 1 ? "" : "s"} with AI calls in range`}
            />
          </section>

          <section className="module-panel" aria-labelledby="admin-time">
            <h2 id="admin-time" className="profile-section-title">
              Time used
            </h2>
            <ActivityChart daily={overview.time.daily} from={range.from} to={range.to} title="Active time across the platform" />
            {overview.time.byArea.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">App</th>
                      <th scope="col">Where</th>
                      <th scope="col" className="num">Users</th>
                      <th scope="col">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.time.byArea.map((a) => (
                      <tr key={`${a.app}:${a.area}`}>
                        <td>{ACTIVITY_APP_LABEL[a.app]}</td>
                        <th scope="row">{areaLabel(a.app, a.area)}</th>
                        <td className="num">{fmtInt(a.users)}</td>
                        <td>
                          <ShareBar value={a.seconds} max={overview.time.byArea[0]!.seconds} label={fmtDuration(a.seconds)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          <div className="admin-split">
            <section className="module-panel" aria-labelledby="admin-countries">
              <h2 id="admin-countries" className="profile-section-title">
                By country
              </h2>
              {overview.locations.countries.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col">Country</th>
                        <th scope="col" className="num">Users</th>
                        <th scope="col" className="num">Time</th>
                        <th scope="col" className="num">AI cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.locations.countries.map((c) => (
                        <tr key={c.country}>
                          <th scope="row">{countryName(c.country)}</th>
                          <td className="num">{fmtInt(c.users)}</td>
                          <td className="num">{fmtDuration(c.seconds)}</td>
                          <td className="num strong">{fmtUsd(c.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="quota">No locations in this range yet.</p>
              )}
              <p className="hint">Each user counts once, in the country they used ThreatReady from most. Country comes from an offline IP lookup; IP addresses are not stored with it.</p>
            </section>
            <section className="module-panel" aria-labelledby="admin-regions">
              <h2 id="admin-regions" className="profile-section-title">
                By region and time zone
              </h2>
              {overview.locations.timeZones.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col">Region</th>
                        <th scope="col">Time zone</th>
                        <th scope="col" className="num">Users</th>
                        <th scope="col" className="num">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.locations.timeZones.map((z) => (
                        <tr key={z.timeZone || "none"}>
                          <td>{regionOf(z.timeZone)}</td>
                          <th scope="row">{timeZoneName(z.timeZone)}</th>
                          <td className="num">{fmtInt(z.users)}</td>
                          <td className="num">{fmtDuration(z.seconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="quota">No time zones in this range yet.</p>
              )}
            </section>
          </div>

          <section className="module-panel">
            <h2 className="profile-section-title">AI usage by app</h2>
            <UsageTable
              first="App"
              rows={(Object.entries(overview.ai.byApp) as [AppKey, AiUsageTotals][]).map(([app, u]) => ({
                ...u,
                key: app,
                label: <AppTag app={app} />,
              }))}
            />
            {overview.unattributedCostUsd > 0.0001 ? (
              <p className="hint">
                {fmtUsd(overview.unattributedCostUsd)} of this is not tied to a user: shared work such as Attack Reasoning's question pool, or users who have been deleted.
              </p>
            ) : null}
          </section>

          {/* Many columns each: full width, stacked. */}
            <section className="module-panel">
              <h2 className="profile-section-title">By model</h2>
              <UsageTable first="Model" rows={overview.byModel.map((m) => ({ ...m, key: m.model, label: <code>{m.model}</code> }))} />
            </section>
            <section className="module-panel">
              <h2 className="profile-section-title">By feature</h2>
              <UsageTable
                first="Feature"
                rows={overview.byFeature.map((f) => ({
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
        </>
      ) : null}

      <section className="module-panel" aria-labelledby="admin-users">
        <div className="admin-users-head">
          <h2 id="admin-users" className="profile-section-title">
            Users {list ? <span className="count">{fmtInt(list.total)}</span> : null}
          </h2>
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: q.trim() || null, page: null });
            }}
          >
            <label className="visually-hidden" htmlFor="admin-q">
              Search users
            </label>
            <input
              id="admin-q"
              className="input"
              type="search"
              placeholder="Name, email or username"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <label className="visually-hidden" htmlFor="admin-sort">
              Sort by
            </label>
            <select id="admin-sort" className="input" value={sort} onChange={(e) => set({ sort: e.target.value, page: null })}>
              <option value="cost">Highest AI cost</option>
              <option value="tokens">Most tokens</option>
              <option value="time">Most time used</option>
              <option value="recent">Recently active</option>
              <option value="created">Newest</option>
            </select>
            <label className="check">
              <input type="checkbox" checked={includeTrial} onChange={(e) => set({ trial: e.target.checked ? "1" : null, page: null })} />
              Include trial users
            </label>
            <Button type="submit" variant="secondary">
              Search
            </Button>
          </form>
        </div>

        {list ? (
          list.rows.length ? (
            <div className="table-wrap">
              <table className="data users-table">
                <thead>
                  <tr>
                    <th scope="col">User</th>
                    <th scope="col">Joined</th>
                    <th scope="col">Last seen</th>
                    <th scope="col">Last active in</th>
                    <th scope="col">Country</th>
                    <th scope="col" className="num">Time used</th>
                    <th scope="col" className="num">LLM calls</th>
                    <th scope="col" className="num">Tokens</th>
                    <th scope="col" className="num">AI cost</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((u) => (
                    <tr key={u.id} className="clickable" onClick={() => navigate(`/app/admin/users/${encodeURIComponent(u.id)}?range=${range.key}`)}>
                      <th scope="row">
                        <Link to={`/app/admin/users/${encodeURIComponent(u.id)}?range=${range.key}`} onClick={(e) => e.stopPropagation()}>
                          {u.name?.trim() || u.username || u.email || "Unnamed"}
                        </Link>
                        <span className="cell-sub">
                          {u.email ?? (u.username ? `@${u.username}` : "—")} <UserBadges u={u} />
                        </span>
                      </th>
                      <td>{fmtDate(u.createdAt)}</td>
                      <td>{fmtAgo(u.lastSeenAt)}</td>
                      <td>
                        {u.lastApp ? (
                          <>
                            {ACTIVITY_APP_LABEL[u.lastApp.app]}
                            <span className="cell-sub">{areaLabel(u.lastApp.app, u.lastApp.area)}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {u.country ? countryName(u.country) : "—"}
                        {u.timeZone ? <span className="cell-sub">{timeZoneName(u.timeZone)}</span> : null}
                      </td>
                      <td className="num">{fmtDuration(u.seconds)}</td>
                      <td className="num">{fmtInt(u.ai.calls)}</td>
                      <td className="num">{fmtCompact(tokensOf(u.ai))}</td>
                      <td className="num strong">{fmtUsd(u.ai.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="quota">No users match.</p>
          )
        ) : loading ? (
          <p className="quota" role="status">
            Loading…
          </p>
        ) : null}

        {list && pages > 1 ? (
          <nav className="pager" aria-label="Pages">
            <Button type="button" variant="quiet" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>
              Previous
            </Button>
            <span>
              Page {page} of {pages}
            </span>
            <Button type="button" variant="quiet" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>
              Next
            </Button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}

/** The overview in one paragraph: who, how much time, where, and what the AI cost. */
function Summary({ o, rangeLabel }: { o: AdminOverview; rangeLabel: string }) {
  const top = (Object.entries(o.time.byArea.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.app]: (acc[a.app] ?? 0) + a.seconds }), {})) as [keyof typeof ACTIVITY_APP_LABEL, number][]).sort((a, b) => b[1] - a[1])[0];
  const countries = o.locations.countries.filter((c) => c.country !== "LO" && c.country !== "ZZ");
  const topSpend = (Object.entries(o.ai.byApp) as [AppKey, AiUsageTotals][]).sort((a, b) => b[1].costUsd - a[1].costUsd)[0];
  return (
    <>
      In the last {rangeLabel.toLowerCase()}, <strong>{fmtInt(o.time.users)}</strong> {o.time.users === 1 ? "user was" : "users were"} active for{" "}
      <strong>{fmtHours(o.time.seconds)}</strong>
      {top && o.time.seconds ? (
        <>
          , mostly in {ACTIVITY_APP_LABEL[top[0]]} ({Math.round((top[1] / o.time.seconds) * 100)}%)
        </>
      ) : null}
      {countries.length ? (
        <>
          , from {countries.length} {countries.length === 1 ? "country" : "countries"} (most: {countryName(countries[0]!.country)})
        </>
      ) : null}
      . {fmtInt(o.users.newInRange)} new {o.users.newInRange === 1 ? "account" : "accounts"}. AI cost <strong>{fmtUsd(o.ai.costUsd)}</strong> over{" "}
      {fmtInt(o.ai.calls)} call{o.ai.calls === 1 ? "" : "s"}
      {topSpend && o.ai.costUsd ? <>, {Math.round((topSpend[1].costUsd / o.ai.costUsd) * 100)}% in {APP_LABEL[topSpend[0]]}</> : null}
      {o.unattributedCostUsd > 0.0001 ? <> ({fmtUsd(o.unattributedCostUsd)} shared, not tied to a user)</> : null}.
    </>
  );
}
