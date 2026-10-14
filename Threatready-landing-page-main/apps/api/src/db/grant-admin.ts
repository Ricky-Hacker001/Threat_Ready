/**
 * Grants or revokes the platform admin role (the /admin console).
 *   pnpm --filter @threatready/api admin:grant someone@example.com
 *   pnpm --filter @threatready/api admin:grant someone@example.com --revoke
 * Only a verified, non-trial account can be granted.
 */
import pg from "pg";

const [email, flag] = process.argv.slice(2);
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!email || (flag && flag !== "--revoke")) {
  console.error("usage: admin:grant <email> [--revoke]");
  process.exit(2);
}
if (!url) {
  console.error("DATABASE_MIGRATION_URL or DATABASE_URL must be set");
  process.exit(2);
}

const role = flag === "--revoke" ? "user" : "admin";
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const { rows } = await client.query<{ id: string; email_verified: boolean }>(
    `UPDATE users SET role = $2, updated_at = now()
      WHERE lower(email) = lower($1) AND is_anonymous IS NOT TRUE AND ($2 = 'user' OR email_verified)
      RETURNING id, email_verified`,
    [email, role],
  );
  if (!rows.length) {
    console.error(`No verified account with email ${email}. Sign up and verify first.`);
    process.exitCode = 1;
  } else {
    console.log(`${email}: role = ${role}`);
  }
} finally {
  await client.end();
}
