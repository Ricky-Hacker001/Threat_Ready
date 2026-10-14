#!/usr/bin/env bash
# Render build: installs and builds every app for the single-origin deployment (see deploy/start.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
# Onboard is on the same origin, so the apps link to it with relative URLs.
export VITE_ONBOARD_URL=""

echo "==> onboard (identity, home, profile, admin)"
(cd Threatready-landing-page-main && npx -y pnpm@10.28.0 install --frozen-lockfile && npx -y pnpm@10.28.0 build)

echo "==> InterviewPrep"
(cd InterviewPrep && npm ci --no-audit --no-fund && npm run build)

echo "==> Lab Simulations"
(cd threatready-lab-001 && npm ci --no-audit --no-fund && npm run build)

echo "==> Attack Reasoning Lab"
(cd attack-reasoning && npm ci --no-audit --no-fund && npm run build)

echo "==> gateway"
(cd deploy && npm ci --no-audit --no-fund && npm run bundle)
echo "==> build complete"
