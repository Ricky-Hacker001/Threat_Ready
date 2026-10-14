# ThreatReady: one-command local start for Windows.
# Double-click start.cmd, or run:  .\start.cmd
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Die($msg)  { Write-Host "`n$msg`n" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }
function PortOpen([int]$port) {
  node -e "require('net').connect($port,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
  return ($LASTEXITCODE -eq 0)
}

Step "Checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js is not installed. Install Node 22 LTS from https://nodejs.org and run this again." }
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=9)?0:1)"
if ($LASTEXITCODE -ne 0) { Die "Node $(node -v) is too old. Install Node 22.9 or newer from https://nodejs.org." }
Write-Host "Node $(node -v)"

Step "Checking project files"
node scripts/verify-files.mjs
if ($LASTEXITCODE -ne 0) { Die "Project files are incomplete (see above)." }

Step "Checking pnpm"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "pnpm not found, installing it with npm..."
  npm install -g pnpm@10
  if ($LASTEXITCODE -ne 0) { Die "Could not install pnpm. Run 'npm install -g pnpm@10' in an Administrator terminal." }
}
Write-Host "pnpm $(pnpm -v)"

Step "Installing and building (first run takes a few minutes)"
pnpm bootstrap
if ($LASTEXITCODE -ne 0) { Die "Setup failed (see above)." }

Step "Starting PostgreSQL"
if (PortOpen 5432) {
  Write-Host "PostgreSQL already running on localhost:5432"
} else {
  $dockerUp = $false
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { $dockerUp = $true }
  }
  if ($dockerUp) {
    Write-Host "Using Docker"
    docker compose up -d --wait postgres
    if ($LASTEXITCODE -ne 0) { Die "Docker couldn't start PostgreSQL (see above)." }
  } else {
    Write-Host "No PostgreSQL or Docker found. Starting the bundled PostgreSQL 16 in a new window."
    Write-Host "Keep that window open while you use ThreatReady." -ForegroundColor Yellow
    Start-Process powershell -WorkingDirectory $PSScriptRoot -ArgumentList @(
      "-NoExit", "-NoProfile", "-Command",
      "`$Host.UI.RawUI.WindowTitle = 'ThreatReady database (keep open)'; pnpm db:local"
    )
    $ready = $false
    for ($i = 0; $i -lt 120; $i++) {
      Start-Sleep -Seconds 1
      if (PortOpen 5432) { $ready = $true; break }
    }
    if (-not $ready) { Die "The bundled PostgreSQL didn't start within 2 minutes. Check the 'ThreatReady database' window for the error." }
    Start-Sleep -Seconds 3   # first run: let init.sql finish after the port opens
  }
}

Step "Applying database migrations"
$migrated = $false
for ($i = 0; $i -lt 5; $i++) {
  pnpm db:migrate
  if ($LASTEXITCODE -eq 0) { $migrated = $true; break }
  Start-Sleep -Seconds 3
}
if (-not $migrated) { Die "Migrations failed (see above)." }

Step "Starting ThreatReady. Open http://localhost:5173  (Ctrl+C to stop)"
Start-Job { Start-Sleep 15; Start-Process "http://localhost:5173" } | Out-Null
pnpm dev
