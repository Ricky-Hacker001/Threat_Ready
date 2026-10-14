#!/usr/bin/env node
/**
 * Pre-flight check for `pnpm dev`. Fails fast with the exact fix instead of
 * letting the API die on a busy port or a missing .env.
 *   node scripts/doctor.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
let failed = false;

const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const fail = (m, fix) => {
  failed = true;
  console.log(`  FAIL  ${m}`);
  for (const line of [].concat(fix)) console.log(`        ${line}`);
};

console.log("\nThreatReady pre-flight\n");

/* Node version (--env-file-if-exists needs 22.9) */
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj > 22 || (maj === 22 && min >= 9)) ok(`Node ${process.versions.node}`);
else fail(`Node ${process.versions.node} is too old`, "Install Node 22.9 or newer from https://nodejs.org");

/* Builds from `pnpm setup` */
for (const [path, what] of [
  ["node_modules", "dependencies"],
  ["packages/contracts/dist/index.js", "shared contracts build"],
  ["apps/api/dist/main.js", "API build"],
]) {
  if (existsSync(join(root, path))) ok(what);
  else fail(`${what} missing`, "Run: pnpm setup");
}

/* .env */
const envPath = join(root, "apps/api/.env");
const env = {};
if (!existsSync(envPath)) {
  fail(
    "apps/api/.env not found",
    win ? "Run: copy apps\\api\\.env.example apps\\api\\.env" : "Run: cp apps/api/.env.example apps/api/.env",
  );
} else {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32 || secret.startsWith("replace-with")) {
    fail("BETTER_AUTH_SECRET is not set", ["Run: pnpm gen:secret", "Paste the output after BETTER_AUTH_SECRET= in apps/api/.env"]);
  } else ok("apps/api/.env");
}

/* Ports: is anything already listening? */
function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(800, () => (s.destroy(), resolve(false)));
  });
}

function findAndKill(port) {
  return win
    ? [
        `Find it:  netstat -ano | findstr :${port}      (last column is the PID)`,
        `          tasklist /FI "PID eq <PID>"`,
        `Stop it:  taskkill /PID <PID> /F`,
        `Usual culprits: VS Code Live Server / Live Preview, "npx serve", "http-server", an old "pnpm dev" window.`,
      ]
    : [`Find it:  lsof -i :${port}`, `Stop it:  kill <PID>`, `Usual culprits: "npx serve", "http-server", an old "pnpm dev".`];
}

const apiPort = Number(env.PORT || 3000);
if (await listening(apiPort)) {
  let isOurs = false;
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(1500) });
    isOurs = res.ok && (await res.json()).ok === true;
  } catch {}
  if (isOurs) fail(`ThreatReady API is already running on :${apiPort}`, ["Close the other terminal running pnpm dev, or just use it.", ...findAndKill(apiPort)]);
  else fail(`Port ${apiPort} is taken by another program (this is what showed the "Index of threatready/" page)`, findAndKill(apiPort));
} else ok(`port ${apiPort} free (API)`);

if (await listening(5173)) fail("Port 5173 is taken by another program", findAndKill(5173));
else ok("port 5173 free (web)");

/* Database reachable and migrated */
if (env.DATABASE_URL) {
  try {
    const require = createRequire(join(root, "apps/api/package.json"));
    const pg = require("pg");
    const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    await client.connect();
    const { rows } = await client.query("select to_regclass('public.users') is not null as migrated");
    await client.end();
    if (rows[0]?.migrated) ok("database reachable and migrated");
    else fail("database has no tables yet", "Run: pnpm db:migrate");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`database not reachable (${msg})`, [
      "Start the bundled PostgreSQL in another terminal and leave it open:  pnpm db:local",
      "  (or with Docker running:  pnpm db:up)",
      "Then run:  pnpm db:migrate",
    ]);
  }
}

if (failed) {
  console.log("\nFix the items above, then run pnpm dev again.\n");
  process.exit(1);
}
console.log("\nAll good. Open http://localhost:5173 once Vite prints its URL (not :3000, that's the API).\n");
