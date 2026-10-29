# Business accounts (organisations) — phase 1, 28 Oct 2026

An organisation (a company, team or institute) owns seats, a plan and the people it invites. Its org admin and managers run an organisation console; members use the product on the organisation's plan; the platform admin console shows every organisation and sets plans by hand. Billing is a later phase. Design: `claude/threatready-business-accounts-plan.md` (Project); this file records what landed.

## What a user sees

| Who | Where | What |
|---|---|---|
| Anyone | Sign-in page → **For your team** (`/?mode=business`) | Creates a normal account (username, work email, password, OTP) and remembers the organisation name; on the first sign-in the organisation is created and the browser lands on its console. OAuth and guest are not offered on this tab (an OAuth sign-up has no organisation name to remember). |
| Existing user | Profile → **Set up an organisation** (`/app/org/new`) | The same, for an account that already exists. One organisation per account for now. |
| Org admin / manager | **Organisation console** (`/app/org`, from the account menu) | Overview (seats, plan, usage this month, what needs attention), People (members with role, status, activity; pending invitations with resend/withdraw), Invite (paste addresses, pick member or manager), a member's page (progress per app, time by area), Settings (rename, leave; org admins only), Activity log. CSV export of members. |
| Invitee | Email link `/invite/<token>` | Shows who invited them to what; signs in or creates an account **with the invited address** and comes back; one button joins. The address must match exactly (verified); the link is single-use and expires after `ORG_INVITE_TTL_DAYS` (7). |
| Member | Profile | A card saying which organisation they belong to and whether their sessions count on its plan, with **Leave** (every role and status; the last active org admin hands over first). Members never see the console. |
| Platform admin | Admin console → **Organisations** (`/app/admin/orgs`) | Every organisation with status, plan, seats, contact, launches, time and AI cost (members' ledgers summed). Detail page: members with their AI cost, pending invitations, the organisation's audit log, **Plan and seats** (plan, status, seats, period end, AI cap — the caller retypes the name) and **Approval and suspension**. The users table gets an **Account** column (Individual / organisation + role) and a filter; the overview splits individuals from organisation members and counts organisations. Users CSV gains Account, Organisation, Organisation role. |

## Rules (org-rules.ts, unit-tested)

- **Seats:** active members + pending (unexpired, unrevoked) invitations ≤ purchased seats. Invites beyond that are reported as `no_seats`, not sent. Suspending or removing a member, withdrawing or letting an invitation expire frees the seat; reinstating a member or resending an expired invitation takes one back, so both are refused (`ORG_NO_SEATS`) when none is free. Accepting counts the invitation's own seat without clamping, so an organisation over its seats accepts nobody. The platform admin cannot set seats below what is in use.
- **Roles:** `org_admin` (everything, incl. roles and settings), `manager` (people, invitations, reports; acts on members only), `member` (uses the product). Nobody acts on themselves; the last active org admin cannot be demoted, suspended, removed, or leave.
- **Plan applies** (launches counted on the organisation's plan and `feature_launches.org_id` = the organisation) only while the organisation is `active`, the membership is `active`, the plan is `trialing` or `active`, and the period has not ended. Otherwise the user is on their personal plan and the profile says so. `past_due`, `suspended`, `cancelled`, pending approval and an ended period all fall back without deleting anything.
- **Console access** needs an active membership as manager/org admin and an organisation that is not suspended; permissions `org:read` / `org:write` / `org:admin` derive from the role in `memberships`, never from the request.
- **Names in emails:** an organisation name (on create and rename) may not look like a web address (`LINK_LIKE` in contracts: a domain such as `name.com` or an IPv4 address), because mail clients turn such text into links and the invitation comes from ThreatReady's own sending domain. The invitation email names the inviter by username only (never their email address), and leaves out any name that looks like a link.
- **Accepting:** the signed-in account's verified email must equal the invited address; guests cannot accept; an account already in another organisation must leave it first; a suspended organisation accepts nobody.
- **What an org admin sees of a member:** only what happened while the organisation's plan applied to them: the windows `planWindows` (tenancy.ts) rebuilds from the organisation's audit log (joined, member suspended/reinstated, organisation approved/suspended/reinstated, plan and period changes). From the apps: items (title, status, score, date) dated inside a window; their lifetime stats and AI usage are not passed on, because the apps report per user, not per organisation (phase 2). Time this month and the last app: activity rows (per UTC day and area) lying wholly inside a window. Launches: `feature_launches.org_id`. Never anything from before joining, while suspended, pending approval or after the plan lapsed (the personal workspace), nor the password or sessions/IPs. Opening a member's page and exporting the list are written to the organisation's audit log.

## Data (migration 0012)

- `organizations.kind` gains `business` (`institute` existed); `status` (`pending | active | suspended`), `segment`, `created_by`, `approved_at`.
- `memberships.role` gains `manager`, `member` (`org_admin` existed); `status` (`active | suspended`), `invited_by`; one organisation membership per user (partial unique index).
- `entitlements`: `seats`, `status` (`trialing | active | past_due | suspended | cancelled`), `period_end`, `ai_cap_usd`, `notes`; `plan` gains `business_trial`, `business`.
- `org_invitations` (token stored as SHA-256; one open row per address per organisation), `org_audit_log` (append-only for the API role).
- Migration 0013: `admin_audit_log` also takes `org.plan` and `org.status` (a platform admin's changes to an organisation). Migration 0014: index `org_audit_log (action, at)` for the platform-wide invitation counts.
- `feature_launches` gets a no-request-user SELECT policy (the consoles count launches per organisation the way the shared tables already allow since 0011); the owner policies stay.
- Existing rows are untouched: personal workspaces keep `personal` / `learner` / `free`.

## Deploying and rolling back

Migrations run at boot (the launcher runs onboard's migrate before the API starts) and are never reverted: a rollback runs older code on the newer schema.

- **Rollback floor (before this release reaches `main`).** After 0012, a user who creates or joins an organisation has two memberships: the personal one (`learner`/`trial`) and the organisation's. This release reads the personal one by role. The build before it (`main` at 7d81555) reads it with `where user_id = $1 limit 1`, no role filter and no order, returns no membership when that row is the organisation's, and its self-heal (`ensurePersonalWorkspace`) does nothing because a membership exists: the guard answers **403 `NO_MEMBERSHIP` on every request** for those users, depending on row order, and nothing repairs it. So first ship a one-commit release on `main` that adds `role in ('learner', 'trial')` to `findPersonalMembership` and `ensurePersonalWorkspace` (`tenancy.ts`; the same filter this release has), let it deploy and boot, then merge this release. From then on, never roll back past that release; roll forward instead.
- **0013** (two more values in `admin_audit_log`'s action CHECK) and **0014** (an index) are safe under older code: it never writes the new actions.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `ORG_APPROVAL_REQUIRED` | `false` | `true` creates organisations as `pending`: invitations work, launches stay on personal plans until a platform admin approves (admin console → Organisations). Approving starts the trial's `ORG_TRIAL_DAYS` from then (a later period end set by hand is kept). |
| `ORG_TRIAL_SEATS` / `ORG_TRIAL_DAYS` | 5 / 14 | The trial every new organisation starts on. |
| `ORG_INVITE_TTL_DAYS` | 7 | How long an invitation link works. |
| `ORG_INVITES_PER_DAY` | 20 | Invitation emails (new + resent) one organisation may send per rolling day; 0 = no limit. |
| `ORG_INVITES_PLATFORM_PER_DAY` | 50 | Invitation emails all organisations together may send per rolling day (scaled by `RATE_LIMIT_MULTIPLIER`, 1 in production); 0 = no limit. Invitations go through the same email account as sign-up, sign-in and reset codes: keep this under the provider's daily quota (Resend free: 100 a day), and raise both caps on a paid plan. One address gets at most 3 invitation emails a day from every organisation together (`INVITE_EMAILS_PER_ADDRESS_PER_DAY`); further ones are skipped (`too_many_emails`) or refused (`ORG_INVITE_ADDRESS_LIMIT`). |
| `ORG_REPORT_CONCURRENCY` | 4 | Reserved for batched member reports. |

Plans and per-seat limits are placeholders in `packages/contracts/src/index.ts` (`PLAN_LIMITS`, `PLAN_INFO`): business trial 5 interviews / unlimited labs / 20 reasoning per seat per month; business 20 / unlimited / 100. Change the figures there; the SPA reads the same table.

## Apps

`GET /api/internal/identity/session` now carries `org: { id, name, kind, role, plan }` when the session's launches count on an organisation's plan (absent otherwise). It is optional: InterviewPrep, Labs and Attack Reasoning ignore it today. Recording it on their usage rows is phase 2 (then per-organisation AI cost comes from the ledgers directly instead of summing members, and the AI cap can be enforced).

## Not in phase 1 (by decision)

Billing and invoices (plans are set by hand in the admin console), assignments, domain verification / auto-join, SSO/SCIM, weekly digests, per-organisation AI-cap enforcement in the apps, organisation-level data export and deletion (on request), the HR-screening candidate role.

## Tests

- `apps/api/test/org-rules.test.mjs` (12): seats (incl. reinstating, renewing an expired invitation and accepting while over), tokens, invitation states, accepting, roles, suspension/removal/leaving, invite batches, when the plan applies, the windows the console may show and the audit log read as their history, invitation email caps.
- `apps/api/test/units.test.mjs`: link-like organisation names refused and kept out of the invitation email.
- `apps/api/test/org.e2e.test.mjs` (16, API + PostgreSQL): creating, one-per-account, link-like names, cross-origin refusal; invite → email → accept with the right and wrong account, preview, once-only, seats across a batch, revoke/resend, seats never overbooked (reinstate, expired resend, accept while over), three emails per address a day, expiry; manager vs admin, last admin, suspend/reinstate/remove, a member or suspended member leaving, member visibility, the console showing activity only while on the plan (stub of the apps' summary endpoint), launches recorded on the organisation; approval restarting the trial; platform admin list/detail/plan/status, the organisation's log without the staff identity, the admin_audit_log trail, users' account column, overview counts.
- `test/e2e.test.mjs`: the RLS test's `feature_launches` expectation updated for the new read policy.
- Browser walk-through (Playwright, local stack): business sign-up → console → invite → accept in a second browser → people/member/settings/audit → admin organisations → plan saved; phone width without sideways scroll.
