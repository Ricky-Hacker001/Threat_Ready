import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  entities: { roles: { provider: "" } },
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL ?? "" },
});
