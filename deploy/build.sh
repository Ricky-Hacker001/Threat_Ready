#!/usr/bin/env bash
# Render build: installs and builds every app for the single-origin deployment (see deploy/start.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
# Render applies the service's environment to the build too, and with NODE_ENV=production `npm ci`
# skips devDependencies (vite, typescript, esbuild), so every install asks for them explicitly. The
# runtime keeps NODE_ENV=production.
# Onboard is on the same origin, so the apps link to it with relative URLs.
export VITE_ONBOARD_URL=""

echo "==> onboard (identity, home, profile, admin)"
(cd Threatready-landing-page-main && npx -y pnpm@10.28.0 install --frozen-lockfile --prod=false && npx -y pnpm@10.28.0 build)

echo "==> InterviewPrep"
(cd InterviewPrep && npm ci --include=dev --no-audit --no-fund && npm run build)

echo "==> Lab Simulations"
(cd threatready-lab-001 && npm ci --include=dev --no-audit --no-fund && npm run build)

echo "==> hosted labs (SOC simulation, DevSecOps lab, ThreatReady Firewall, Red Team web pentest, AI Security), served under /labs/<slug>/"
(cd soc && npm ci --include=dev --no-audit --no-fund && npm run build -- --base /labs/soc/)
(cd DevSecOps-Simulation && npm ci --include=dev --no-audit --no-fund && npm run build -- --base /labs/devsecops/)
(cd ThreatWall && npm ci --include=dev --no-audit --no-fund && npm run build -- --base /labs/threatwall/)
(cd AI-Security && npm ci --include=dev --no-audit --no-fund && npm run build -- --base /labs/aisec/)
(cd red_team_lab/web && npm ci --include=dev --no-audit --no-fund && npm run build -- --base /labs/redteam/)

echo "==> Attack Reasoning Lab"
(cd attack-reasoning && npm ci --include=dev --no-audit --no-fund && npm run build)

echo "==> gateway"
(cd deploy && npm ci --include=dev --no-audit --no-fund && npm run bundle)
echo "==> build complete"
