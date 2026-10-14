import path from 'node:path';
import express from 'express';
import { createApp } from './app';
import { onboardApps, onboardIdentity } from './identity';

const root = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env: use the real environment */ }

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (!v) { console.error(`Missing ${name}. Copy .env.example to .env (INTERNAL_API_TOKEN must match onboard's).`); process.exit(1); }
  return v;
};
const port = Number(process.env.PORT || 4100);
const internalToken = env('INTERNAL_API_TOKEN');
if (internalToken.length < 32) { console.error('INTERNAL_API_TOKEN must be at least 32 characters.'); process.exit(1); }
const identityUrl = env('IDENTITY_URL', 'http://localhost:3000');

// The app lives under /ar (its API at /ar/api, onboard's internal calls at /ar/internal).
const ar = createApp(path.join(root, 'dist'), {
  identity: onboardIdentity({ identityUrl, internalToken, cacheSeconds: Number(process.env.IDENTITY_CACHE_SECONDS ?? 30) }),
  internalToken,
  appOrigin: new URL(env('APP_ORIGIN', 'http://localhost:5176')).origin,
  onboardUrl: new URL(env('ONBOARD_URL', 'http://localhost:5173')).origin,
  apps: onboardApps(identityUrl),
});
const server = express();
server.disable('x-powered-by');
server.use('/ar', ar);
server.get('/', (_req, res) => res.redirect(302, '/ar/'));
server.listen(port, () => console.log(`ThreatReady Attack Reasoning — http://localhost:${port}/ar/`));
