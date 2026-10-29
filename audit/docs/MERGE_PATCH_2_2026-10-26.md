# Merge of security patch 2 into main — 26 Oct 2026

This merges `security/patch-2-2026-10-23` (`e33ce6b`, PRABU-S-19; notes in `SECURITY_PATCH_2_2026-10-23.md`) into
`main` (`1f65d38`; notes in `SECURITY_PATCH_2026-10-24.md`). Patch 2 was built on patch 1 (`8a74bb4`), so it did not
include the UI/UX redesign or the fixes in `main`. The merge had 47 conflicts. Both sides' security, business
rules, tests and design are kept. Where both sides fixed the same thing, the stronger version is used, or the two
are combined.

## Before deploying

1. **Set `LLM_MODEL_SMALL=claude-haiku-4-5` on Render.** You can also sync the Blueprint, which declares it.
   InterviewPrep refuses to start in production without it. Tested: without it the new release exits at boot.
   The health check then keeps the current release live, so nothing goes down.
2. **Render must run Node 24.** `render.yaml` already sets `NODE_VERSION=24`, and every app now declares
   `engines >= 24`.
3. **Migrations run on boot.** These are the patch 2 migrations, renumbered so they come after the ones
   production has already applied:
   - InterviewPrep `0016_security_patch_2`: evaluating lease column, indexes, `serve_count` with its trigger, and
     column grants that hide `reasoning_items.private` from the app role. Every statement is idempotent.
     Sessions that are mid-evaluation keep their current lease.
   - Onboard `0011_rls_backstop_shared_tables`: request-scoped RLS on users, memberships and organizations.
   - Both were tested on fresh databases and on copies of today's databases.

## Architecture after the merge

- **Three supervised children:** onboard, InterviewPrep, and labs (the labs hub, every hosted lab and Attack
  Reasoning, in `deploy/labs-child.mjs` on loopback). A lab crash no longer affects sign-in.
- **What the gateway keeps:**
  - client-IP rules (`CLIENT_IP_SOURCE`, right-most `X-Forwarded-For` by default; a visitor-set
    `CF-Connecting-IP` is not trusted);
  - the request-smuggling guard, the body cap, timeouts and the 415 response for compressed bodies;
  - the internal-route guard and the per-path CSP.
- **What the gateway adds:** request IDs, and friendly lab pages while the labs child restarts (no raw JSON).
- **Lab state:** the Postgres lab-state mirror restores lab, SOC and Red Team files before the labs child starts.
  On shutdown the child flushes them, and the launcher uploads them.
- **Internal tokens:** they are per caller (HKDF), and no child gets the raw token in production. They also cover
  the internal routes `main` added. The labs child's token can read summaries, but it cannot erase a learner.

## Combined fixes (both sides had one)

| Area | What is used now |
|---|---|
| DOCX limits | Both checks: their central-directory limits run first, then our structural scan with bounded inflate. |
| Redaction | Our bounded, linear email rule and every phone format; both sides' tests pass. |
| Stuck evaluations | Their lease column and per-session sweeper, plus our recovery. The lease is 5 minutes (theirs was 120 s) so retries fit. |
| Pool answer keys | Their column grants and owner-only read, plus our rule that public views never show the pool item id. |
| SOC client URLs | One resumable, capped stream; their duplicate stream was dropped. |
| Red Team target | Their fresh sandboxed `/target-frame.html` for each response, plus our message checks. CSP `frame-src 'self'` applies to pages only. |
| ThreatWall passwords | Our hash upgrade, which uses compare-and-swap; their weaker re-hash and the old `lib/storage.ts` were dropped. |
| AI-Security deps | jspdf 4.2.1 and express 4.22.3 (both sides), plus their vitest 5. |

## Also in this merge

- **Dependency patches:** `body-parser` (2.4.0 / 1.20.9) and `multer` (2.5.0) close GHSA-27r3-jxmh-p828 and
  GHSA-q7qp-rjg7-q26m. The new CI audit gate checks every lockfile and passes. Onboard has one moderate advisory
  left, below the gate: `esbuild` 0.18.20 (GHSA-67mh-4wv8-2f99, dev-only, pulled in through `better-auth` →
  `drizzle-kit`); `qs` 6.16.0 (GHSA-6pq8-jhm2-2vcw, runtime, soc and onboard) was published after this merge.
- **CI:** their matrix on Node 24 (typecheck, lint with the regex scanner, tests, `npm audit`, gitleaks and a full
  `deploy/build.sh`), plus our onboard e2e settings, publish check and site check.

## Verified

Every one of the 59 test steps passes. That covers both sides' suites, their security harness and regex
scanner, all builds, and the browser suites.

A production-style launcher boot passed 73/73 checks:
- fresh databases;
- sign-up and sign-in through the gateway;
- every app with a session;
- internal routes hidden;
- request IDs and the per-path CSP;
- the lab state round trip across a restart;
- no child restarts.

The security, business-logic and UI reviews confirmed 6 issues. Four are fixed, one needed only a documentation
note, and the dependency advisory is fixed by the patches above.
