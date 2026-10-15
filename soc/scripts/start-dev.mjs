// Local development start: signs in a fixed test user without a ThreatReady
// token. Works the same in PowerShell, cmd and Unix shells.
//   npm run start:dev                 -> user "dev.analyst"
//   npm run start:dev -- asha.rivera  -> user "asha.rivera"
// Never use this in production: the server ignores DEV_USER when NODE_ENV=production.
if (process.env.NODE_ENV === 'production') {
  console.error('start:dev is for local development only. Use npm start in production.');
  process.exit(1);
}
process.env.DEV_USER = process.argv[2] || process.env.DEV_USER || 'dev.analyst';
console.log(`Development sign-in as "${process.env.DEV_USER}".`);
await import('../server/index.js');
