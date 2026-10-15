import path from 'node:path';
import express from 'express';
import { Store } from './store';
import { createApp } from './app';
import { devIdentity, onboardIdentity } from './identity';

const root = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env: use the real environment */ }

const port = Number(process.env.PORT || 4300);
const appOrigin = new URL(process.env.APP_ORIGIN || 'http://localhost:5180').origin;
const devLogin = process.env.DEV_LOGIN ? process.env.DEV_LOGIN === 'true' : /localhost|127\.0\.0\.1/.test(appOrigin);
const devSecret = process.env.APP_SECRET || 'threatready-web-pentest-lab-dev-secret-change-me';

const identity = devLogin
  ? devIdentity(devSecret)
  : onboardIdentity({ identityUrl: process.env.IDENTITY_URL || 'http://localhost:3000', internalToken: process.env.INTERNAL_API_TOKEN || '', cacheSeconds: Number(process.env.IDENTITY_CACHE_SECONDS ?? 30) });

// The app lives under /lab (its API at /lab/api), matching vite base '/lab/'.
const lab = createApp(new Store(process.env.DATA_FILE || path.join(root, 'data', 'store.json')), path.join(root, 'dist'), {
  identity,
  internalToken: process.env.INTERNAL_API_TOKEN || undefined,
  appOrigin,
  onboardUrl: process.env.ONBOARD_URL ? new URL(process.env.ONBOARD_URL).origin : undefined,
  devLogin, devSecret,
});

const server = express();
server.disable('x-powered-by');
server.use('/lab', lab);
server.get('/', (_req, res) => res.redirect(302, '/lab/'));
server.listen(port, () => console.log(`ThreatReady Web Pentest Lab — http://localhost:${port}/lab/  (dev login: ${devLogin})`));
