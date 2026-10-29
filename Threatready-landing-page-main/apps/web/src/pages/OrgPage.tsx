import { PLAN_INFO, PLAN_LIMITS, orgNameSchema, type FeatureKey, type OrgAuditRow, type OrgInvitationRow, type OrgMemberDetail, type OrgMemberList, type OrgMemberRow, type OrgOverview, type OrgRole } from "@threatready/contracts";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { useMe } from "../components/AppShell";
import { Button, Field, Notice, usePageTitle } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { API_ORIGIN } from "../lib/auth-client";
import { messageFor } from "../lib/errors";
import { fmtAgo, fmtDate, fmtDateTime, fmtInt } from "../lib/format";
import { ACTIVITY_APP_LABEL, Tile, areaLabel, fmtDuration, fmtHours } from "./adminInsights";

/* ------------------------------------------------------------------ */
/* The organisation console (business accounts): for org admins and   */
/* managers. Members use the product; they never see this.            */
/* ------------------------------------------------------------------ */

const errorText = (err: unknown) => (err instanceof ApiError ? (err.status === 429 ? messageFor(err) : err.message) : messageFor(null));

const FEATURE_LABEL: Record<FeatureKey, string> = { interview: "Interviews", simulations: "Lab sessions", reasoning: "Reasoning questions" };
const ROLE_LABEL: Record<OrgRole, string> = { org_admin: "Organisation admin", manager: "Manager", member: "Member" };
const PLAN_STATUS_LABEL: Record<string, string> = { trialing: "Trial", active: "Active", past_due: "Past due", suspended: "Suspended", cancelled: "Cancelled" };

/** Opens the console for managers and org admins; sends everyone else where they belong. */
export function OrgGate({ children }: { children: ReactNode }) {
  const { me } = useMe();
  if (!me.org) return <Navigate to="/app/org/new" replace />;
  if (me.org.role === "member" || me.org.memberStatus !== "active" || me.org.status === "suspended") return <Navigate to="/app/profile" replace />;
  return <>{children}</>;
}

export function OrgLayout() {
  const { me } = useMe();
  const { state } = useLocation() as { state?: { created?: string } };
  const org = me.org!;
  return (
    <div className="org">
      <div className="admin-head">
        <div>
          <p className="org-kicker">{org.segment === "institute" ? "Institute account" : "Business account"}</p>
          <h1>{org.name}</h1>
          <p>
            {PLAN_INFO[org.plan].label}
            {org.planStatus !== "trialing" && org.planStatus !== "active" ? <> · {PLAN_STATUS_LABEL[org.planStatus] ?? org.planStatus}</> : null}
            {org.periodEnd ? <> · {org.planStatus === "trialing" ? "trial ends" : "period ends"} {fmtDate(org.periodEnd)}</> : null} · you are {ROLE_LABEL[org.role].toLowerCase()}
          </p>
        </div>
      </div>
      {state?.created ? (
        <Notice tone="ok">
          {state.created} is set up. Invite your people from <Link to="/app/org/invite">Invite</Link>; they'll get an email with a link.
        </Notice>
      ) : null}
      <div className="org-layout">
        <nav className="org-nav" aria-label="Organisation console">
          <NavLink to="/app/org" end>
            Overview
          </NavLink>
          <NavLink to="/app/org/people">People</NavLink>
          <NavLink to="/app/org/invite">Invite</NavLink>
          {org.role === "org_admin" ? <NavLink to="/app/org/settings">Settings</NavLink> : null}
          <NavLink to="/app/org/audit">Activity log</NavLink>
        </nav>
        <div className="org-main">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/* ---------------- Overview ---------------- */

export function OrgOverviewPage() {
  usePageTitle("Organisation");
  const [data, setData] = useState<OrgOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.org.overview().then(setData, (err: unknown) => setError(errorText(err)));
  }, []);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="quota" role="status">Loading…</p>;
  const { org, usage, attention } = data;
  const limits = PLAN_LIMITS[org.entitlement.plan];
  return (
    <div className="admin">
      {attention.length ? (
        <div className="org-attention">
          {attention.map((a) => (
            <Notice key={a.kind} tone={a.kind === "plan_past_due" ? "error" : "info"}>
              {a.message}
              {a.kind === "invites_expiring" || a.kind === "seats_low" ? (
                <>
                  {" "}
                  <Link to="/app/org/people">Open People</Link>.
                </>
              ) : null}
            </Notice>
          ))}
        </div>
      ) : null}
      <section className="tiles" aria-label="Seats and plan">
        <Tile label="Seats" value={`${fmtInt(org.seats.used)} of ${fmtInt(org.seats.purchased)}`} sub={org.seats.pending ? `${fmtInt(org.seats.pending)} held by pending invitations` : `${fmtInt(org.seats.available)} free`} />
        <Tile label="Active this week" value={fmtInt(usage.activeMembers7d)} sub={`of ${fmtInt(org.seats.used)} member${org.seats.used === 1 ? "" : "s"}`} />
        <Tile label="Time used this month" value={usage.seconds ? fmtHours(usage.seconds) : "0 h"} sub={usage.seconds && org.seats.used ? `${fmtDuration(usage.seconds / org.seats.used)} per member` : "Measured while people use the apps"} />
        {usage.launches.map((l) => (
          <Tile key={l.feature} label={`${FEATURE_LABEL[l.feature]} this month`} value={fmtInt(l.count)} sub={limits[l.feature].limit === null ? "No per-seat limit" : `${fmtInt(limits[l.feature].limit!)} per seat per month`} />
        ))}
      </section>
      <section className="module-panel" aria-labelledby="org-plan">
        <h2 id="org-plan" className="profile-section-title">
          Your plan
        </h2>
        <dl className="org-facts">
          <div>
            <dt>Plan</dt>
            <dd>
              {PLAN_INFO[org.entitlement.plan].label}
              {org.entitlement.status !== "trialing" ? <> · {PLAN_STATUS_LABEL[org.entitlement.status] ?? org.entitlement.status}</> : null}
            </dd>
          </div>
          <div>
            <dt>{org.entitlement.status === "trialing" ? "Trial ends" : "Period ends"}</dt>
            <dd>{org.entitlement.periodEnd ? fmtDate(org.entitlement.periodEnd) : "Open-ended"}</dd>
          </div>
          <div>
            <dt>Per seat, each month</dt>
            <dd>
              {(Object.keys(limits) as FeatureKey[]).map((k) => `${limits[k].limit === null ? "unlimited" : limits[k].limit} ${FEATURE_LABEL[k].toLowerCase()}`).join(" · ")}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{org.status === "active" ? "Active" : org.status === "pending" ? "Waiting for approval" : "Suspended"}</dd>
          </div>
        </dl>
        <p className="hint">Plans, seats and renewals are set with ThreatReady for now; billing inside the console comes later. To add seats or change plan, write to the address on your contract or use the contact page.</p>
      </section>
    </div>
  );
}

/* ---------------- People ---------------- */

function RoleBadge({ role }: { role: OrgRole }) {
  return <span className={`badge ${role === "org_admin" ? "badge-info" : role === "manager" ? "badge-ok" : "badge-muted"}`}>{ROLE_LABEL[role]}</span>;
}

export function OrgPeoplePage() {
  usePageTitle("People · Organisation");
  const { me, refresh } = useMe();
  const navigate = useNavigate();
  const [list, setList] = useState<OrgMemberList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isAdmin = me.org?.role === "org_admin";

  const load = useCallback(() => api.org.members().then(setList, (err: unknown) => setError(errorText(err))), []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    setError(null);
    setFlash(null);
    try {
      await fn();
      setFlash(done);
      await load();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const confirmThen = (question: string, key: string, fn: () => Promise<unknown>, done: string) => {
    if (window.confirm(question)) void act(key, fn, done);
  };

  if (error && !list) return <Notice tone="error">{error}</Notice>;
  if (!list) return <p className="quota" role="status">Loading…</p>;

  return (
    <div className="admin">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      <section className="module-panel" aria-labelledby="org-members">
        <div className="admin-users-head">
          <h2 id="org-members" className="profile-section-title">
            Members <span className="count">{fmtInt(list.members.length)}</span>
          </h2>
          <div className="filters">
            <a className="btn btn-secondary" href={`${API_ORIGIN}/api/org/export/members.csv`} download>
              Download members (CSV)
            </a>
            <Link className="btn btn-primary" to="/app/org/invite">
              Invite people
            </Link>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data users-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col" className="org-activity">Activity</th>
                <th scope="col" className="num" title="Interviews · lab sessions · reasoning questions this month">
                  Sessions <span className="cell-sub">interviews · labs · reasoning</span>
                </th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.members.map((m) => {
                const self = m.userId === me.user.id;
                const canAct = !self && (isAdmin || m.role === "member");
                return (
                  <tr key={m.userId} className={m.status === "suspended" ? "org-row-suspended" : undefined}>
                    <th scope="row">
                      <Link to={`/app/org/members/${encodeURIComponent(m.userId)}`}>{m.name?.trim() || m.username || m.email || "Unnamed"}</Link>
                      <span className="cell-sub">
                        {m.email ?? (m.username ? `@${m.username}` : "—")} {self ? <span className="badge badge-muted">You</span> : null}
                        {m.status === "suspended" ? <span className="badge badge-warn">Suspended</span> : null}
                        {!m.emailVerified ? <span className="badge badge-muted">Unverified</span> : null}
                      </span>
                    </th>
                    <td>
                      <RoleBadge role={m.role} />
                    </td>
                    <td className="org-activity">
                      {m.lastSeenAt ? `Seen ${fmtAgo(m.lastSeenAt)}` : "Not signed in yet"}
                      {m.seconds ? ` · ${fmtDuration(m.seconds)} this month` : ""}
                      <span className="cell-sub">
                        Joined {fmtDate(m.joinedAt)}
                        {m.lastApp ? ` · last in ${ACTIVITY_APP_LABEL[m.lastApp.app as keyof typeof ACTIVITY_APP_LABEL] ?? m.lastApp.app}${m.lastApp.area ? ` / ${areaLabel(m.lastApp.app as keyof typeof ACTIVITY_APP_LABEL, m.lastApp.area)}` : ""}` : ""}
                      </span>
                    </td>
                    <td className="num org-sessions">
                      {fmtInt(m.launches.interview ?? 0)} · {fmtInt(m.launches.simulations ?? 0)} · {fmtInt(m.launches.reasoning ?? 0)}
                    </td>
                    <td>
                      {canAct ? (
                        <div className="org-actions">
                          {isAdmin ? (
                            <select
                              className="input input-sm"
                              aria-label={`Role of ${m.name}`}
                              value={m.role}
                              disabled={busy !== null}
                              onChange={(e) => {
                                const role = e.target.value as OrgRole;
                                confirmThen(`Make ${m.name} ${ROLE_LABEL[role].toLowerCase()}?`, m.userId, () => api.org.setRole(m.userId, { role }), `${m.name} is now ${ROLE_LABEL[role].toLowerCase()}.`);
                              }}
                            >
                              <option value="member">Member</option>
                              <option value="manager">Manager</option>
                              <option value="org_admin">Organisation admin</option>
                            </select>
                          ) : null}
                          {m.status === "active" ? (
                            <Button type="button" variant="quiet" loading={busy === `s:${m.userId}`} disabled={busy !== null} onClick={() => confirmThen(`Suspend ${m.name}? They keep their account and fall back to the free plan; the seat is freed.`, `s:${m.userId}`, () => api.org.setStatus(m.userId, { status: "suspended" }), `${m.name} is suspended.`)}>
                              Suspend
                            </Button>
                          ) : (
                            <Button type="button" variant="quiet" loading={busy === `s:${m.userId}`} disabled={busy !== null} onClick={() => void act(`s:${m.userId}`, () => api.org.setStatus(m.userId, { status: "active" }), `${m.name} is active again.`)}>
                              Reinstate
                            </Button>
                          )}
                          <Button type="button" variant="quiet" loading={busy === `r:${m.userId}`} disabled={busy !== null} onClick={() => confirmThen(`Remove ${m.name} from ${me.org!.name}? Their account and personal workspace stay; the seat is freed.`, `r:${m.userId}`, () => api.org.remove(m.userId), `${m.name} was removed.`)}>
                            Remove
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">Suspending frees the seat and drops the person to the free plan; removing does the same and takes them out of the list. Neither touches their account. Counts are this calendar month, on the organisation's plan.</p>
      </section>

      <section className="module-panel" aria-labelledby="org-invites">
        <h2 id="org-invites" className="profile-section-title">
          Pending invitations <span className="count">{fmtInt(list.invitations.length)}</span>
        </h2>
        {list.invitations.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Invited</th>
                  <th scope="col">Expires</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {list.invitations.map((i) => (
                  <InvitationRow key={i.id} i={i} busy={busy} onResend={() => void act(`i:${i.id}`, () => api.org.resend(i.id), `Invitation to ${i.email} sent again.`)} onRevoke={() => confirmThen(`Withdraw the invitation to ${i.email}? The link in their email stops working and the seat is freed.`, `i:${i.id}`, () => api.org.revoke(i.id), `Invitation to ${i.email} withdrawn.`)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="quota">
            No pending invitations.{" "}
            <button type="button" className="link-btn" onClick={() => navigate("/app/org/invite")}>
              Invite people
            </button>
            .
          </p>
        )}
      </section>
    </div>
  );
}

function InvitationRow({ i, busy, onResend, onRevoke }: { i: OrgInvitationRow; busy: string | null; onResend: () => void; onRevoke: () => void }) {
  return (
    <tr>
      <th scope="row">
        {i.email}
        {i.state === "expired" ? (
          <span className="cell-sub">
            <span className="badge badge-warn">Expired</span>
          </span>
        ) : null}
      </th>
      <td>{i.role === "manager" ? "Manager" : "Member"}</td>
      <td>
        {fmtDate(i.createdAt)}
        {i.invitedBy.name ? <span className="cell-sub">by {i.invitedBy.name}</span> : null}
      </td>
      <td>{fmtDate(i.expiresAt)}</td>
      <td>
        <div className="org-actions">
          <Button type="button" variant="quiet" loading={busy === `i:${i.id}`} disabled={busy !== null} onClick={onResend}>
            {i.state === "expired" ? "Send again" : "Resend"}
          </Button>
          <Button type="button" variant="quiet" disabled={busy !== null} onClick={onRevoke}>
            Withdraw
          </Button>
        </div>
      </td>
    </tr>
  );
}

/* ---------------- Invite ---------------- */

export function OrgInvitePage() {
  usePageTitle("Invite people · Organisation");
  const { me } = useMe();
  const [text, setText] = useState("");
  const [role, setRole] = useState<"member" | "manager">("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.org.invite>> | null>(null);
  const emails = text
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!emails.length) {
      setError("Enter at least one email address.");
      return;
    }
    if (emails.length > 50) {
      setError("Up to 50 addresses at a time.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.org.invite({ emails, role });
      setResult(r);
      if (r.sent.length) setText(r.skipped.filter((s) => s.reason === "no_seats").map((s) => s.email).join("\n"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const reasonText: Record<string, string> = {
    already_member: "already a member",
    already_invited: "already invited",
    no_seats: "no seat free",
    invalid: "not a valid email address",
    self: "that's you",
  };

  return (
    <div className="admin">
      <section className="module-panel" aria-labelledby="org-invite">
        <h2 id="org-invite" className="profile-section-title">
          Invite people to {me.org!.name}
        </h2>
        <form className="form" onSubmit={submit} noValidate>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {result ? (
            <Notice tone={result.sent.length ? "ok" : "info"}>
              {result.sent.length ? (
                <>
                  Sent {result.sent.length} invitation{result.sent.length === 1 ? "" : "s"}. Each link works for 7 days.{" "}
                </>
              ) : null}
              {result.skipped.length ? (
                <>
                  Skipped: {result.skipped.map((s) => `${s.email} (${reasonText[s.reason] ?? s.reason})`).join(", ")}.{" "}
                </>
              ) : null}
              {result.seats.available} seat{result.seats.available === 1 ? "" : "s"} left.
            </Notice>
          ) : null}
          <div className="field">
            <label htmlFor="org-invite-emails">Email addresses</label>
            <textarea
              id="org-invite-emails"
              className="input invite-textarea"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"one per line, or separated by commas\npriya@company.com\nrahul@company.com"}
              aria-describedby="org-invite-hint"
            />
            <span className="field-hint" id="org-invite-hint">
              {emails.length ? `${emails.length} address${emails.length === 1 ? "" : "es"}. ` : ""}Each person gets an email with a one-time link and joins with that exact address. One seat per invitation, held until they join or the link expires.
            </span>
          </div>
          <fieldset className="field segment-choice">
            <legend>Invite as</legend>
            <label className="check">
              <input type="radio" name="role" value="member" checked={role === "member"} onChange={() => setRole("member")} />
              Member — uses ThreatReady on the organisation's plan
            </label>
            <label className="check">
              <input type="radio" name="role" value="manager" checked={role === "manager"} onChange={() => setRole("manager")} />
              Manager — also invites people and sees the team's progress
            </label>
          </fieldset>
          <div>
            <Button type="submit" loading={busy}>
              Send invitations
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

/* ---------------- One member ---------------- */

export function OrgMemberPage() {
  // No name or email in the tab title.
  usePageTitle("Member details · Organisation");
  const { id = "" } = useParams();
  const [data, setData] = useState<OrgMemberDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.org.member(id).then(setData, (err: unknown) => setError(err instanceof ApiError && err.status === 404 ? "This person isn't in your organisation." : errorText(err)));
  }, [id]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="quota" role="status">Loading…</p>;
  const m = data.member;
  return (
    <div className="admin">
      <Link className="btn btn-quiet" to="/app/org/people">
        ← People
      </Link>
      <div className="admin-head">
        <div>
          <h1>{m.name?.trim() || m.username || m.email}</h1>
          <p>
            {m.email} · <RoleBadge role={m.role} /> {m.status === "suspended" ? <span className="badge badge-warn">Suspended</span> : null} · joined {fmtDate(m.joinedAt)} · last seen {fmtAgo(m.lastSeenAt)}
          </p>
        </div>
      </div>
      <section className="tiles" aria-label="This month">
        <Tile label="Time this month" value={fmtHours(m.seconds)} />
        <Tile label="Interviews" value={fmtInt(m.launches.interview ?? 0)} />
        <Tile label="Lab sessions" value={fmtInt(m.launches.simulations ?? 0)} />
        <Tile label="Reasoning questions" value={fmtInt(m.launches.reasoning ?? 0)} />
      </section>
      {data.time.length ? (
        <section className="module-panel">
          <h2 className="profile-section-title">Where their time went this month</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">App</th>
                  <th scope="col">Where</th>
                  <th scope="col" className="num">Time</th>
                  <th scope="col">Last</th>
                </tr>
              </thead>
              <tbody>
                {data.time.map((t) => (
                  <tr key={`${t.app}:${t.area}`}>
                    <td>{ACTIVITY_APP_LABEL[t.app as keyof typeof ACTIVITY_APP_LABEL] ?? t.app}</td>
                    <th scope="row">{areaLabel(t.app as keyof typeof ACTIVITY_APP_LABEL, t.area)}</th>
                    <td className="num">{fmtDuration(t.seconds)}</td>
                    <td>{fmtDateTime(t.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {data.apps.map((a) => (
        <section key={a.key} className="module-panel" aria-labelledby={`org-m-${a.key}`}>
          <h2 id={`org-m-${a.key}`} className="profile-section-title">
            {a.title}
          </h2>
          {a.status !== "live" ? (
            <p className="quota">Coming soon.</p>
          ) : a.error || !a.summary ? (
            <p className="quota">Unavailable right now{a.error ? ` (${a.error})` : ""}.</p>
          ) : (
            <>
              {a.summary.stats.length ? (
                <dl className="org-facts">
                  {a.summary.stats.map((s) => (
                    <div key={s.label}>
                      <dt>{s.label}</dt>
                      <dd>{s.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {a.summary.items.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col">Item</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="num">Score</th>
                        <th scope="col">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.summary.items.map((it) => (
                        <tr key={it.id}>
                          <th scope="row">{it.title}</th>
                          <td>{it.status}</td>
                          <td className="num">{it.score === null ? "—" : it.score}</td>
                          <td>{fmtDateTime(it.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="quota">Nothing yet.</p>
              )}
            </>
          )}
        </section>
      ))}
      <p className="hint">You see what this person did and scored, as each app reports it. Their password, sessions and personal workspace are theirs; opening this page is recorded in the activity log.</p>
    </div>
  );
}

/* ---------------- Settings ---------------- */

export function OrgSettingsPage() {
  usePageTitle("Settings · Organisation");
  const { me, refresh } = useMe();
  const navigate = useNavigate();
  const [name, setName] = useState(me.org?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const nameError = orgNameSchema.safeParse(name).success ? null : "Use 2–80 letters, numbers, spaces and basic punctuation.";

  async function save(e: FormEvent) {
    e.preventDefault();
    if (nameError) return;
    setBusy(true);
    setError(null);
    try {
      await api.org.update({ name: name.trim() });
      await refresh();
      setFlash("Saved.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!window.confirm(`Leave ${me.org!.name}? Your account and personal workspace stay. If you're the last admin, make someone else admin first.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.org.leave();
      await refresh();
      navigate("/app/profile", { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="admin">
      <section className="module-panel" aria-labelledby="org-settings">
        <h2 id="org-settings" className="profile-section-title">
          Organisation
        </h2>
        <form className="form" onSubmit={save} noValidate>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {flash ? <Notice tone="ok">{flash}</Notice> : null}
          <Field label="Organisation name" value={name} onChange={(e) => setName(e.target.value)} error={name !== me.org?.name ? nameError : null} />
          <div>
            <Button type="submit" loading={busy} disabled={name.trim() === me.org?.name || !!nameError}>
              Save changes
            </Button>
          </div>
        </form>
      </section>
      <section className="module-panel" aria-labelledby="org-data">
        <h2 id="org-data" className="profile-section-title">
          Data and people
        </h2>
        <p>
          Members' activity on the organisation's plan is visible to its admins and managers: progress, scores and reports. Their passwords, sign-in sessions and anything they do in their personal workspace are not. Removing someone frees the seat and keeps their account; what they did while a member stays in your reports.
        </p>
        <p className="hint">Plan changes, seats and invoices are handled with ThreatReady directly for now. Export of the organisation's data and deletion of the organisation are on request.</p>
      </section>
      <section className="module-panel" aria-labelledby="org-leave">
        <h2 id="org-leave" className="profile-section-title">
          Leave this organisation
        </h2>
        <p>You keep your ThreatReady account and personal workspace. The organisation keeps its reports.</p>
        <div>
          <Button type="button" variant="secondary" loading={busy} onClick={() => void leave()}>
            Leave {me.org!.name}
          </Button>
        </div>
      </section>
    </div>
  );
}

/* ---------------- Activity log ---------------- */

const ACTION_LABEL: Record<string, string> = {
  "org.create": "created the organisation",
  "org.update": "renamed the organisation",
  "org.approve": "approved the organisation",
  "org.suspend": "suspended the organisation",
  "org.reinstate": "reinstated the organisation",
  "plan.set": "set the plan",
  "invite.send": "sent an invitation",
  "invite.resend": "resent an invitation",
  "invite.revoke": "withdrew an invitation",
  "invite.accept": "joined",
  "member.role": "changed a role",
  "member.suspend": "suspended a member",
  "member.reinstate": "reinstated a member",
  "member.remove": "removed a member",
  "member.leave": "left the organisation",
  "members.export": "downloaded the members list",
  "member.view": "viewed a member's progress",
};

export function OrgAuditPage() {
  usePageTitle("Activity log · Organisation");
  const [rows, setRows] = useState<OrgAuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.org.audit().then(setRows, (err: unknown) => setError(errorText(err)));
  }, []);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!rows) return <p className="quota" role="status">Loading…</p>;
  return (
    <div className="admin">
      <section className="module-panel" aria-labelledby="org-audit">
        <h2 id="org-audit" className="profile-section-title">
          Activity log
        </h2>
        <AuditTable rows={rows} />
        <p className="hint">Everything admins, managers and ThreatReady did to this organisation. Entries are never edited or deleted.</p>
      </section>
    </div>
  );
}

export function AuditTable({ rows }: { rows: OrgAuditRow[] }) {
  if (!rows.length) return <p className="quota">Nothing yet.</p>;
  const detailText = (r: OrgAuditRow) => {
    const d = r.detail as Record<string, unknown>;
    if (r.action === "member.role") return `${String(d.from)} → ${String(d.to)}`;
    if (r.action === "plan.set") {
      const to = d.to as Record<string, unknown> | undefined;
      return to ? `${String(to.plan)} · ${String(to.status)} · ${String(to.seats)} seats` : "";
    }
    if (r.action.startsWith("invite.") && typeof d.email === "string") return `${d.email}${typeof d.role === "string" ? ` (${d.role})` : ""}`;
    if (r.action === "org.create") return `${String(d.name)} (${String(d.segment)})`;
    if (r.action === "org.update") return String(d.name ?? "");
    if (r.action === "members.export") return `${String(d.rows)} rows`;
    return "";
  };
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            <th scope="col">Whom / detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{fmtDateTime(r.at)}</td>
              <td>{r.detail && (r.detail as Record<string, unknown>).by === "platform_admin" ? "ThreatReady" : (r.actor.email ?? "—")}</td>
              <th scope="row">{ACTION_LABEL[r.action] ?? r.action}</th>
              <td>
                {r.target.email && r.target.email !== r.actor.email ? r.target.email : null}
                {r.target.email && r.target.email !== r.actor.email && detailText(r) ? " · " : null}
                {detailText(r)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Create (existing users) ---------------- */

export function OrgNewPage() {
  usePageTitle("Set up your organisation");
  const { me, refresh } = useMe();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [segment, setSegment] = useState<"business" | "institute">("business");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (me.org) return <Navigate to={me.org.role === "member" ? "/app/profile" : "/app/org"} replace />;
  if (me.user.isTrial) return <Navigate to="/?mode=business" replace />;
  const nameError = orgNameSchema.safeParse(name).success ? null : "Use 2–80 letters, numbers, spaces and basic punctuation.";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (nameError) return;
    setBusy(true);
    setError(null);
    try {
      const org = await api.org.create({ name: name.trim(), segment });
      await refresh();
      navigate("/app/org", { replace: true, state: { created: org.name } });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="admin org-new">
      <div className="admin-head">
        <div>
          <h1>Set up your organisation</h1>
          <p>A business account for your team or institute. You become its admin, invite people by email, and see their progress in one console. It starts on a free trial; no card needed.</p>
        </div>
      </div>
      <section className="module-panel">
        <form className="form" onSubmit={submit} noValidate>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field label="Organisation name" autoComplete="organization" value={name} onChange={(e) => setName(e.target.value)} hint="Your company, team or institute, as your people know it." error={touched ? nameError : null} required />
          <fieldset className="field segment-choice">
            <legend>This organisation is</legend>
            <label className="check">
              <input type="radio" name="segment" value="business" checked={segment === "business"} onChange={() => setSegment("business")} />
              A company or team
            </label>
            <label className="check">
              <input type="radio" name="segment" value="institute" checked={segment === "institute"} onChange={() => setSegment("institute")} />
              A college or training institute
            </label>
          </fieldset>
          <p className="hint">The account you're signed in with ({me.user.email}) becomes the organisation's admin. One organisation per account for now.</p>
          <div>
            <Button type="submit" loading={busy}>
              Create organisation
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

/** Used by the profile page: a short card about the person's organisation, whatever their role. */
export function OrgCard() {
  const { me } = useMe();
  const org = me.org;
  if (!org) {
    return (
      <section className="module-panel" aria-labelledby="profile-org">
        <h2 id="profile-org" className="profile-section-title">
          Organisation
        </h2>
        <p>You're on an individual plan. Setting up ThreatReady for a team or an institute? Create an organisation: you invite people by email and see their progress in one place.</p>
        <div>
          <Link className="btn btn-secondary" to="/app/org/new">
            Set up an organisation
          </Link>
        </div>
      </section>
    );
  }
  const console_ = org.role !== "member" && org.memberStatus === "active" && org.status !== "suspended";
  return (
    <section className="module-panel" aria-labelledby="profile-org">
      <h2 id="profile-org" className="profile-section-title">
        Organisation
      </h2>
      <p>
        You're {ROLE_LABEL[org.role].toLowerCase()} at <strong>{org.name}</strong>
        {org.memberStatus === "suspended" ? " (your membership is suspended)" : org.status === "suspended" ? " (the organisation is suspended)" : org.status === "pending" ? " (waiting for ThreatReady's approval)" : null}.{" "}
        {org.effective ? `Your sessions count on its ${PLAN_INFO[org.plan].label.toLowerCase()} plan; its admins see your progress and scores.` : "Right now your sessions count on your personal plan."}
      </p>
      {console_ ? (
        <div>
          <Link className="btn btn-secondary" to="/app/org">
            Open the organisation console
          </Link>
        </div>
      ) : null}
    </section>
  );
}

export { ROLE_LABEL, PLAN_STATUS_LABEL };
export type { OrgMemberRow };
