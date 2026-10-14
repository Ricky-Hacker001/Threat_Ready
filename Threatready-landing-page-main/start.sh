#!/usr/bin/env bash
# ThreatReady: one-command local start for macOS/Linux.  ./start.sh
set -euo pipefail
cd "$(dirname "$0")"
step() { printf '\n==> %s\n' "$1"; }
die()  { printf '\n%s\n\n' "$1" >&2; exit 1; }
port_open() { node -e "require('net').connect($1,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; }

step "Checking Node.js"
command -v node >/dev/null || die "Node.js is not installed. Install Node 22 LTS from https://nodejs.org."
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=9)?0:1)" \
  || die "Node $(node -v) is too old. Install Node 22.9 or newer."
node scripts/verify-files.mjs

step "Checking pnpm"
command -v pnpm >/dev/null || { corepack enable 2>/dev/null || npm install -g pnpm@10; }

step "Installing and building"
pnpm bootstrap

step "Starting PostgreSQL"
if port_open 5432; then
  echo "PostgreSQL already running on localhost:5432"
elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker compose up -d --wait postgres
else
  echo "No PostgreSQL or Docker found; starting the bundled PostgreSQL 16 (log: .local/postgres.log)"
  mkdir -p .local
  nohup pnpm db:local > .local/postgres.log 2>&1 &
  for _ in $(seq 1 120); do sleep 1; port_open 5432 && break; done
  port_open 5432 || die "Bundled PostgreSQL didn't start. See .local/postgres.log"
  sleep 3
fi

step "Applying database migrations"
for i in 1 2 3 4 5; do pnpm db:migrate && break; [ "$i" = 5 ] && die "Migrations failed."; sleep 3; done

step "Starting ThreatReady: open http://localhost:5173 (Ctrl+C to stop)"
exec pnpm dev
