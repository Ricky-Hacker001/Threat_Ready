#!/usr/bin/env node
/**
 * Bundled PostgreSQL 16 for local development: no Docker, no installer.
 *   pnpm db:local        (keep this terminal open while you work; Ctrl+C stops it)
 *
 * Data lives in .local/postgres (git-ignored). On the first start it creates
 * the cluster and applies infra/db/init.sql (roles + database). Development
 * only: the superuser password is "postgres" and it listens on 127.0.0.1.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
// 55432 is the tr-interviewprep-pg Docker container (shared onboard + InterviewPrep databases).
const PORT = 55433;
const dataDir = join(root, ".local", "postgres");

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(800, () => (s.destroy(), resolve(false)));
  });
}

if (await portInUse(PORT)) {
  console.log(`Something is already listening on localhost:${PORT}; assuming it's PostgreSQL. Nothing to start.`);
  process.exit(0);
}

let EmbeddedPostgres;
try {
  const embeddedPostgresUrl = pathToFileURL(require.resolve("embedded-postgres")).href;
  EmbeddedPostgres = (await import(embeddedPostgresUrl)).default;
} catch {
  console.error("embedded-postgres isn't installed. Run: pnpm bootstrap");
  process.exit(1);
}

const fresh = !existsSync(join(dataDir, "PG_VERSION"));
mkdirSync(dirname(dataDir), { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  port: PORT,
  user: "postgres",
  password: "postgres",
  authMethod: "scram-sha-256",
  persistent: true,
  // Postgres refuses to run as root; only relevant inside Linux containers/CI.
  createPostgresUser: typeof process.getuid === "function" && process.getuid() === 0,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
  onLog: () => {},
  onError: (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/error|fatal|panic/i.test(msg)) console.error(msg.trim());
  },
});

/** infra/db/init.sql without psql meta-commands: part before \connect runs on "postgres", the rest on "threatready". */
async function applyInitSql() {
  const sql = readFileSync(join(root, "infra/db/init.sql"), "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const [server, database = ""] = sql.split(/^\\connect\s+threatready\s*$/m);
  const statements = (s) =>
    s
      .split(/;\s*(?:\n|$)/)
      .map((x) => x.trim())
      .filter(Boolean);

  for (const [dbName, part] of [
    ["postgres", server],
    ["threatready", database],
  ]) {
    const client = pg.getPgClient(dbName, "127.0.0.1");
    await client.connect();
    try {
      for (const stmt of statements(part)) await client.query(stmt);
    } finally {
      await client.end();
    }
  }
}

try {
  if (fresh) {
    console.log("First run: creating the local PostgreSQL 16 cluster in .local/postgres ...");
    await pg.initialise();
  }
  await pg.start();
  if (fresh) {
    await applyInitSql();
    console.log("Applied infra/db/init.sql (roles and threatready database).");
  }
} catch (err) {
  console.error(`\nLocal PostgreSQL failed to start: ${err instanceof Error ? err.message : String(err)}`);
  if (fresh) console.error("Delete the .local/postgres folder and run pnpm db:local again.");
  process.exit(1);
}

console.log(`\nPostgreSQL 16 is running on localhost:${PORT}. Keep this window open; press Ctrl+C to stop it.\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log("\nStopping PostgreSQL ...");
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGBREAK", stop); // Windows: closing the console window / Ctrl+Break
setInterval(() => {}, 1 << 30);
