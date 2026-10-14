#!/usr/bin/env bash
# Starts the whole ThreatReady platform locally. Services already listening are left alone.
#   ./start-all.sh          start everything (logs in .logs/)
#   ./start-all.sh stop     stop every service started from this folder
# Ports: onboard API 3200 / web 5173, InterviewPrep API 3100 / web 5174 (+ worker),
#        Labs API 4000 / web 5175, Attack Reasoning API 4100 / web 5176.
set -u
R="$(cd "$(dirname "$0")" && pwd)"
L="$R/.logs"
mkdir -p "$L"

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if [ "${1:-}" = "stop" ]; then
  for p in 3200 5173 3100 5174 4000 5175 4100 5176; do
    pid=$(ss -ltnp 2>/dev/null | grep ":$p " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "$pid" ] && kill "$pid" && echo "stopped :$p"
  done
  pkill -f "src/main.ts worker" && echo "stopped InterviewPrep worker"
  exit 0
fi

# PostgreSQL (onboard and InterviewPrep databases live in this container)
if command -v docker >/dev/null && docker ps -a --format '{{.Names}}' | grep -qx tr-interviewprep-pg; then
  if [ "$(docker inspect -f '{{.State.Running}}' tr-interviewprep-pg)" != "true" ]; then
    docker start tr-interviewprep-pg >/dev/null || { echo "Could not start tr-interviewprep-pg (is something else on :55432?)"; exit 1; }
  fi
  for _ in $(seq 1 30); do docker exec tr-interviewprep-pg pg_isready -q 2>/dev/null && break; sleep 1; done
  if listening 55432; then echo "PostgreSQL ready on :55432"; else
    echo "tr-interviewprep-pg is running but :55432 is not published. Fix: docker stop tr-interviewprep-pg && docker network connect bridge tr-interviewprep-pg && docker start tr-interviewprep-pg"; exit 1; fi
fi

start() { # port name dir command...
  local port=$1 name=$2 dir=$3; shift 3
  if [ "$port" != "-" ] && listening "$port"; then echo "  $name already running on :$port"; return; fi
  (cd "$dir" && setsid nohup "$@" > "$L/$name.log" 2>&1 < /dev/null &)
  echo "  started $name${port:+ (:$port)}"
}
ipenv() { set -a; . "$R/InterviewPrep/.env"; set +a; exec npx tsx src/main.ts "$1"; }
export -f ipenv
export R

echo "Starting ThreatReady…"
start 3200 onboard-api  "$R/Threatready-landing-page-main/apps/api" node --env-file=.env dist/main.js
start 5173 onboard-web  "$R/Threatready-landing-page-main/apps/web" env API_PROXY_TARGET=http://localhost:3200 npx vite
start 3100 interview-api "$R/InterviewPrep/apps/api" bash -c 'ipenv api'
if pgrep -f "src/main.ts worker" >/dev/null; then echo "  interview-worker already running"; else start - interview-worker "$R/InterviewPrep/apps/api" bash -c 'ipenv worker'; fi
start 5174 interview-web "$R/InterviewPrep/apps/web" npx vite
start 4000 labs-api     "$R/threatready-lab-001" npx tsx server/index.ts
start 5175 labs-web     "$R/threatready-lab-001" npx vite
start 4100 ar-api       "$R/attack-reasoning" npx tsx server/index.ts
start 5176 ar-web       "$R/attack-reasoning" npx vite

echo "Waiting for services…"
for p in 3200 5173 3100 5174 4000 5175 4100 5176; do
  for _ in $(seq 1 60); do listening "$p" && break; sleep 1; done
  listening "$p" && echo "  :$p up" || echo "  :$p NOT up — see $L/"
done
echo
echo "Open http://localhost:5173  (InterviewPrep :5174/interview-prep · Labs :5175/labs/ · Attack Reasoning :5176/ar/)"
