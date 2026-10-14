#!/usr/bin/env node
/**
 * Checks the project wasn't partially extracted or copied. Runs before install,
 * so it uses nothing but Node built-ins.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
  "docker-compose.yml",
  "infra/db/init.sql",
  "packages/contracts/package.json",
  "packages/contracts/src/index.ts",
  "apps/api/package.json",
  "apps/api/.env.example",
  "apps/api/src/main.ts",
  "apps/api/src/auth/auth.ts",
  "apps/api/drizzle/0000_init.sql",
  "apps/web/package.json",
  "apps/web/index.html",
  "apps/web/src/main.tsx",
  "apps/web/src/pages/AuthPage.tsx",
];

const missing = required.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error("\nThis copy of the project is incomplete. Missing:");
  for (const f of missing) console.error(`  - ${f}`);
  console.error(
    "\nRe-download threatready-auth-landing.zip and extract ALL of it (Windows: right-click > Extract All).\n" +
      "Then run the commands from the inner 'threatready' folder that contains pnpm-workspace.yaml.\n",
  );
  process.exit(1);
}
console.log(`project files complete (${required.length} key files checked)`);
