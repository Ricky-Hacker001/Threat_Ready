import path from 'node:path';
import express from 'express';
import { Store } from './store';
import { createApp, loadHostedLabs } from './app';
import { onboardApps, onboardIdentity } from './identity';

const root = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env: use the real environment */ }

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (!v) { console.error(`Missing ${name}. Copy .env.example to .env (INTERNAL_API_TOKEN must match onboard's).`); process.exit(1); }
  return v;
};
const port = Number(process.env.PORT || 4000);
const internalToken = env('INTERNAL_API_TOKEN');
if (internalToken.length < 32) { console.error('INTERNAL_API_TOKEN must be at least 32 characters.'); process.exit(1); }

// The app lives under /labs (its API at /labs/api, onboard's internal calls at /labs/internal).
// The SOC simulation, DevSecOps lab, ThreatReady Firewall and Red Team lab live beside this app in the checkout.
const appOrigin = new URL(env('APP_ORIGIN', 'http://localhost:5175')).origin;
const onboardUrl = new URL(env('ONBOARD_URL', 'http://localhost:5173')).origin;
const identity = onboardIdentity({ identityUrl: env('IDENTITY_URL', 'http://localhost:3000'), internalToken, cacheSeconds: Number(process.env.IDENTITY_CACHE_SECONDS ?? 30) });
const hosted = await loadHostedLabs(path.resolve(root, '..'), { catalogUrl: `${appOrigin}/labs/`, identity, appOrigin, onboardUrl });
const labs = createApp(new Store(process.env.DATA_FILE || path.join(root, 'data', 'store.json')), path.join(root, 'dist'), {
  identity,
  internalToken,
  appOrigin,
  onboardUrl,
  apps: onboardApps(env('IDENTITY_URL', 'http://localhost:3000')),
  hosted,
});
if (hosted.length) console.log(`Hosted labs: ${hosted.map(h => h.slug).join(', ')}`);
const server = express();
server.disable('x-powered-by');
server.use('/labs', labs);
server.get('/', (_req, res) => res.redirect(302, '/labs/'));
server.listen(port, () => console.log(`ThreatReady Labs — http://localhost:${port}/labs/`));
