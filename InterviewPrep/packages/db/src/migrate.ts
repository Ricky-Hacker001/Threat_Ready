import { runMigrations } from './migrate-lib.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
await runMigrations(url);
process.stdout.write('migrations applied\n');
