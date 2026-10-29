# Security policy

ThreatReady is a cybersecurity training platform; we want to hear about weaknesses in it.

## Reporting a vulnerability

Email **security@threatready.io** (the address published at
`https://threatready.io/.well-known/security.txt`). Please include:

- the affected app or host (`threatready.io`, `app.threatready.io`, a lab under `/labs/…`, the InterviewPrep
  or Attack Reasoning apps) and the path or endpoint;
- steps to reproduce, or a proof of concept;
- the impact you believe it has;
- whether you want to be credited, and under what name.

We acknowledge every report within **2 business days** (Monday–Friday, India Standard Time) and keep you
informed while we investigate and fix it. We ask that you give us a reasonable time to fix an issue before
disclosing it publicly, and that you do not access, change or delete other people's data, run denial-of-service
tests, or send phishing to our users or staff.

**There is no bug bounty programme yet.** We credit reporters who want to be credited once a fix has shipped.

## Scope

In scope: everything served from `threatready.io` and its subdomains, and the code in this repository.
Out of scope: third-party services we use (Render, Cloudflare, Anthropic, GitHub) — report those to the
provider — and findings in the deliberately vulnerable **training content** (the lab targets, synthetic
credentials in the lab fixtures, the simulated SOC logs); those are the exercises, not bugs.

## Supported versions

Only the current deployment (the `main` branch) is supported; fixes ship as deploys, not as versioned releases.

## What we do on our side

Pull requests run the checks in `.github/workflows/ci.yml`: unit and end-to-end tests, a ReDoS lint over every
server source directory, hash-based CSP checks for the marketing site, `npm audit` / `pnpm audit` on runtime
dependencies, gitleaks on every commit, and a publish guard that keeps secrets, licensed assets and internal
audit material (`audit/`) out of anything we publish. Dependabot keeps actions and dependencies current.
