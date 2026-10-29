import { PLAN_INFO, type AdminOrgDetail, type AdminOrgList, type AdminOrgRow, type AppKey, type AiUsageTotals } from "@threatready/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Field, Notice } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { messageFor } from "../lib/errors";
import { fmtAgo, fmtDate, fmtInt, fmtUsd } from "../lib/format";
import { fmtDuration, fmtHours } from "./adminInsights";
import { AppTag, RANGES, RangePicker, Tile, UsageTable, rangeFor } from "./AdminPage";
import { AuditTable, PLAN_STATUS_LABEL, ROLE_LABEL } from "./OrgPage";

/* ------------------------------------------------------------------ */
/* Platform admin: organisations (business accounts). Plans are set   */
/* by hand here until billing exists.                                 */
/* ------------------------------------------------------------------ */

const errorText = (err: unknown) => (err instanceof ApiError ? (err.status === 429 ? messageFor(err) : err.message) : "Couldn't load the admin data. Refresh to try again.");

function StatusBadge({ status }: { status: AdminOrgRow["status"] }) {
  return <span className={`badge ${status === "active" ? "badge-ok" : status === "pending" ? "badge-warn" : "badge-muted"}`}>{status === "active" ? "Active" : status === "pending" ? "Pending approval" : "Suspended"}</span>;
}

export function AdminOrgsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const range = useMemo(() => rangeFor(params.get("range")), [params]);
  const [q, setQ] = useState(params.get("q") ?? "");
  const status = params.get("status") ?? "";
  const sort = params.get("sort") ?? "created";
  const [list, setList] = useState<AdminOrgList | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    api.admin.orgs({ from: range.from, to: range.to, q: params.get("q") ?? undefined, status: status || undefined, sort }).then(
      (l) => {
        if (!cancelled) setList(l);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.key, params.get("q"), status, sort]);

  return (
    <div className="admin">
      <Link className="btn btn-quiet" to={`/app/admin?range=${range.key}`}>
        ← Admin console
      </Link>
      <div className="admin-head">
        <div>
          <h1>Organisations</h1>
          <p>Business and institute accounts: their plan, seats, people and what their members cost.</p>
        </div>
        <div className="admin-head-actions">
          <RangePicker value={range.key} onChange={(k) => set({ range: k })} />
        </div>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {list?.pending ? (
        <Notice tone="info">
          {list.pending} organisation{list.pending === 1 ? " is" : "s are"} waiting for approval.{" "}
          <button type="button" className="link-btn" onClick={() => set({ status: "pending" })}>
            Show them
          </button>
          .
        </Notice>
      ) : null}
      <section className="module-panel" aria-labelledby="admin-orgs">
        <div className="admin-users-head">
          <h2 id="admin-orgs" className="profile-section-title">
            Organisations {list ? <span className="count">{fmtInt(list.total)}</span> : null}
          </h2>
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: q.trim() || null });
            }}
          >
            <label className="visually-hidden" htmlFor="orgs-q">
              Search organisations
            </label>
            <input id="orgs-q" className="input" type="search" placeholder="Name or admin email" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="visually-hidden" htmlFor="orgs-status">
              Status
            </label>
            <select id="orgs-status" className="input" value={status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Any status</option>
              <option value="pending">Pending approval</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
            <label className="visually-hidden" htmlFor="orgs-sort">
              Sort by
            </label>
            <select id="orgs-sort" className="input" value={sort} onChange={(e) => set({ sort: e.target.value })}>
              <option value="created">Newest</option>
              <option value="members">Most members</option>
              <option value="cost">Highest AI cost</option>
              <option value="name">Name</option>
            </select>
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
                    <th scope="col">Organisation</th>
                    <th scope="col">Status</th>
                    <th scope="col">Plan</th>
                    <th scope="col" className="num">Seats</th>
                    <th scope="col">Admin contact</th>
                    <th scope="col">Created</th>
                    <th scope="col" className="num">Launches (month)</th>
                    <th scope="col" className="num">Time used</th>
                    <th scope="col" className="num">AI cost</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((o) => (
                    <tr key={o.id} className="clickable" onClick={() => navigate(`/app/admin/orgs/${encodeURIComponent(o.id)}?range=${range.key}`)}>
                      <th scope="row">
                        <Link to={`/app/admin/orgs/${encodeURIComponent(o.id)}?range=${range.key}`} onClick={(e) => e.stopPropagation()}>
                          {o.name}
                        </Link>
                        <span className="cell-sub">{o.segment === "institute" ? "Institute" : "Business"}</span>
                      </th>
                      <td>
                        <StatusBadge status={o.status} />
                      </td>
                      <td>
                        {PLAN_INFO[o.entitlement.plan].label}
                        <span className="cell-sub">
                          {PLAN_STATUS_LABEL[o.entitlement.status] ?? o.entitlement.status}
                          {o.entitlement.periodEnd ? ` · to ${fmtDate(o.entitlement.periodEnd)}` : ""}
                        </span>
                      </td>
                      <td className="num">
                        {fmtInt(o.members)} / {fmtInt(o.entitlement.seats)}
                        {o.pendingInvites ? <span className="cell-sub">{o.pendingInvites} pending</span> : null}
                      </td>
                      <td>
                        {o.contact.name ?? "—"}
                        <span className="cell-sub">{o.contact.email ?? ""}</span>
                      </td>
                      <td>{fmtDate(o.createdAt)}</td>
                      <td className="num">{fmtInt(o.launchesThisMonth)}</td>
                      <td className="num">{fmtDuration(o.seconds)}</td>
                      <td className="num strong">{fmtUsd(o.ai.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="quota">No organisations match.</p>
          )
        ) : (
          <p className="quota" role="status">
            Loading…
          </p>
        )}
        {list?.unavailable.length ? <p className="hint">AI figures leave out {list.unavailable.map((u) => u.app).join(", ")} (did not respond).</p> : null}
      </section>
    </div>
  );
}

/* ---------------- One organisation ---------------- */

export function AdminOrgPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const range = useMemo(() => rangeFor(params.get("range")), [params]);
  const [data, setData] = useState<AdminOrgDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = () =>
    api.admin.org(id, { from: range.from, to: range.to }).then(setData, (err: unknown) => setError(err instanceof ApiError && err.status === 404 ? "No such organisation." : errorText(err)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, range.key]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="quota" role="status">Loading…</p>;
  const { org } = data;
  return (
    <div className="admin">
      <Link className="btn btn-quiet" to={`/app/admin/orgs?range=${range.key}`}>
        ← Organisations
      </Link>
      <div className="admin-head">
        <div>
          <h1>{org.name}</h1>
          <p>
            {org.segment === "institute" ? "Institute" : "Business"} · <StatusBadge status={org.status} /> · created {fmtDate(org.createdAt)}
            {org.approvedAt ? ` · approved ${fmtDate(org.approvedAt)}` : ""} · contact {org.contact.email ?? "—"}
          </p>
        </div>
        <div className="admin-head-actions">
          <RangePicker value={range.key} onChange={(k) => setParams({ range: k }, { replace: true })} />
        </div>
      </div>
      {flash ? <Notice tone="ok">{flash}</Notice> : null}
      <section className="tiles" aria-label="Headline numbers">
        <Tile label="Plan" value={PLAN_INFO[org.entitlement.plan].label} sub={`${PLAN_STATUS_LABEL[org.entitlement.status] ?? org.entitlement.status}${org.entitlement.periodEnd ? ` · to ${fmtDate(org.entitlement.periodEnd)}` : ""}`} />
        <Tile label="Seats" value={`${fmtInt(org.members)} / ${fmtInt(org.entitlement.seats)}`} sub={`${fmtInt(org.pendingInvites)} pending · ${fmtInt(org.admins)} admin${org.admins === 1 ? "" : "s"}`} />
        <Tile label="Launches this month" value={fmtInt(org.launchesThisMonth)} />
        <Tile label="Time used in range" value={fmtHours(org.seconds)} />
        <Tile label="AI cost in range" value={fmtUsd(org.ai.costUsd)} sub={`${fmtInt(org.ai.calls)} LLM calls`} />
        <Tile label="AI cap" value={org.entitlement.aiCapUsd === null ? "Plan default" : fmtUsd(org.entitlement.aiCapUsd)} sub="per month, informational" />
      </section>

      <div className="admin-split">
        <PlanForm org={org} onSaved={(row, msg) => { setData((d) => (d ? { ...d, org: row } : d)); setFlash(msg); void load(); }} />
        <StatusForm org={org} onSaved={(row, msg) => { setData((d) => (d ? { ...d, org: row } : d)); setFlash(msg); void load(); }} />
      </div>

      <section className="module-panel">
        <h2 className="profile-section-title">AI usage by app</h2>
        <UsageTable first="App" rows={(Object.entries(org.aiByApp) as [AppKey, AiUsageTotals][]).map(([app, u]) => ({ ...u, key: app, label: <AppTag app={app} /> }))} />
      </section>

      <section className="module-panel" aria-labelledby="admin-org-members">
        <h2 id="admin-org-members" className="profile-section-title">
          Members <span className="count">{fmtInt(data.members.length)}</span>
        </h2>
        <div className="table-wrap">
          <table className="data users-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
                <th scope="col">Last seen</th>
                <th scope="col" className="num">Time (month)</th>
                <th scope="col" className="num">Launches (month)</th>
                <th scope="col" className="num">AI cost (range)</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.userId}>
                  <th scope="row">
                    <Link to={`/app/admin/users/${encodeURIComponent(m.userId)}?range=${range.key}`}>{m.name?.trim() || m.username || m.email || "Unnamed"}</Link>
                    <span className="cell-sub">
                      {m.email ?? "—"} {m.status === "suspended" ? <span className="badge badge-warn">Suspended</span> : null}
                    </span>
                  </th>
                  <td>{ROLE_LABEL[m.role]}</td>
                  <td>{fmtDate(m.joinedAt)}</td>
                  <td>{fmtAgo(m.lastSeenAt)}</td>
                  <td className="num">{fmtDuration(m.seconds)}</td>
                  <td className="num">{fmtInt((m.launches.interview ?? 0) + (m.launches.simulations ?? 0) + (m.launches.reasoning ?? 0))}</td>
                  <td className="num strong">{fmtUsd(m.ai.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.invitations.length ? <p className="hint">{data.invitations.length} pending invitation{data.invitations.length === 1 ? "" : "s"}: {data.invitations.map((i) => i.email).join(", ")}.</p> : null}
      </section>

      <section className="module-panel" aria-labelledby="admin-org-audit">
        <h2 id="admin-org-audit" className="profile-section-title">
          Activity log
        </h2>
        <AuditTable rows={data.audit} />
      </section>
    </div>
  );
}

function PlanForm({ org, onSaved }: { org: AdminOrgRow; onSaved: (row: AdminOrgRow, message: string) => void }) {
  const e = org.entitlement;
  const [form, setForm] = useState({ plan: e.plan, status: e.status, seats: String(e.seats), periodEnd: e.periodEnd ? e.periodEnd.slice(0, 10) : "", aiCapUsd: e.aiCapUsd === null ? "" : String(e.aiCapUsd), confirmName: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setForm({ plan: e.plan, status: e.status, seats: String(e.seats), periodEnd: e.periodEnd ? e.periodEnd.slice(0, 10) : "", aiCapUsd: e.aiCapUsd === null ? "" : String(e.aiCapUsd), confirmName: "" });
  }, [e.plan, e.status, e.seats, e.periodEnd, e.aiCapUsd]);
  const set = (k: keyof typeof form) => (ev: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: ev.target.value }));

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const row = await api.admin.setOrgPlan(org.id, {
        plan: form.plan,
        status: form.status,
        seats: Number(form.seats),
        periodEnd: form.periodEnd ? new Date(`${form.periodEnd}T23:59:59Z`).toISOString() : null,
        aiCapUsd: form.aiCapUsd === "" ? null : Number(form.aiCapUsd),
        confirmName: form.confirmName,
      });
      onSaved(row, "Plan saved. The organisation's admins see it in their console; the change is in both audit logs.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="module-panel" aria-labelledby="admin-org-plan">
      <h2 id="admin-org-plan" className="profile-section-title">
        Plan and seats
      </h2>
      <form className="form" onSubmit={submit} noValidate>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="field">
          <label htmlFor="plan-plan">Plan</label>
          <select id="plan-plan" className="input" value={form.plan} onChange={set("plan")}>
            <option value="business_trial">Business trial</option>
            <option value="business">Business</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="plan-status">Plan status</label>
          <select id="plan-status" className="input" value={form.status} onChange={set("status")}>
            <option value="trialing">Trial</option>
            <option value="active">Active (paid or agreed)</option>
            <option value="past_due">Past due (members fall back to free)</option>
            <option value="suspended">Suspended</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <Field label="Seats" type="number" inputMode="numeric" min={1} max={5000} value={form.seats} onChange={set("seats")} hint="Members plus pending invitations may not exceed this." />
        <Field label="Period end" type="date" value={form.periodEnd} onChange={set("periodEnd")} hint="Trial end or renewal date (UTC). Leave empty for open-ended." />
        <Field label="AI cap per month (USD)" type="number" inputMode="decimal" min={0} value={form.aiCapUsd} onChange={set("aiCapUsd")} hint="Recorded for the apps; informational until they enforce it. Empty = plan default." />
        <Field label="Type the organisation's name to confirm" value={form.confirmName} onChange={set("confirmName")} autoComplete="off" />
        <div>
          <Button type="submit" loading={busy} disabled={form.confirmName.trim().toLowerCase() !== org.name.trim().toLowerCase()}>
            Save plan
          </Button>
        </div>
      </form>
    </section>
  );
}

function StatusForm({ org, onSaved }: { org: AdminOrgRow; onSaved: (row: AdminOrgRow, message: string) => void }) {
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(status: AdminOrgRow["status"], label: string) {
    setBusy(status);
    setError(null);
    try {
      const row = await api.admin.setOrgStatus(org.id, { status, confirmName });
      onSaved(row, `${org.name} is now ${label}. Its admins have been emailed.`);
      setConfirmName("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }
  const ok = confirmName.trim().toLowerCase() === org.name.trim().toLowerCase();
  return (
    <section className="module-panel" aria-labelledby="admin-org-status">
      <h2 id="admin-org-status" className="profile-section-title">
        Approval and suspension
      </h2>
      <div className="form">
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p>
          {org.status === "pending"
            ? "Waiting for approval: its admin can invite people, but nobody launches on the organisation's plan until it is approved."
            : org.status === "active"
              ? "Active. Suspending closes the console and drops every member to the free plan; nothing is deleted."
              : "Suspended. Members are on the free plan and the console is closed."}
        </p>
        <Field label="Type the organisation's name to confirm" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
        <div className="org-actions">
          {org.status !== "active" ? (
            <Button type="button" loading={busy === "active"} disabled={!ok || busy !== null} onClick={() => void change("active", org.status === "pending" ? "approved" : "active again")}>
              {org.status === "pending" ? "Approve" : "Reinstate"}
            </Button>
          ) : null}
          {org.status !== "suspended" ? (
            <Button type="button" variant="secondary" loading={busy === "suspended"} disabled={!ok || busy !== null} onClick={() => void change("suspended", "suspended")}>
              Suspend
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export { RANGES };
