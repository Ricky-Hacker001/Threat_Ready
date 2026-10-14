/**
 * One-off migration task (ADD L9): run before each deploy with the owner role.
 *   DATABASE_MIGRATION_URL=... node dist/db/migrate.js
 */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error("DATABASE_MIGRATION_URL is not set");
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  await migrate(drizzle(pool), { migrationsFolder });
  console.log("migrations applied");
} catch (err) {
  console.error("migration failed", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
