import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { Store } from './store';
import { createApp } from './app';
import { devIdentity, onboardIdentity } from './identity';
import { CLIENT_IP_HEADER } from './ratelimit';

const root = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env: use the real environment */ }

const port = Number(process.env.PORT || 4300);
const appOrigin = new URL(process.env.APP_ORIGIN || 'http://localhost:5180').origin;
const devLogin = process.env.DEV_LOGIN ? process.env.DEV_LOGIN === 'true' : /localhost|127\.0\.0\.1/.test(appOrigin);
// The dev-login cookie secret. Production must set APP_SECRET (or turn dev login off); a development
// run without one gets a random secret for this process, so sign-ins end when it restarts.
const LEGACY_DEFAULT_SECRET = 'threatready-web-pentest-lab-dev-secret-change-me';
let devSecret = process.env.APP_SECRET || '';
if (devLogin) {
  if (process.env.NODE_ENV === 'production' && (!devSecret || devSecret === LEGACY_DEFAULT_SECRET || devSecret.length < 32)) {
    console.error('DEV_LOGIN is on in production without a strong APP_SECRET (32+ characters). Set APP_SECRET, or set DEV_LOGIN=false to use the ThreatReady sign-in.');
    process.exit(1);
  }
  if (devSecret === LEGACY_DEFAULT_SECRET) { console.warn('APP_SECRET is the well-known default; using a random secret for this run instead.'); devSecret = ''; }
  if (!devSecret) { devSecret = crypto.randomBytes(32).toString('hex'); console.warn('APP_SECRET is not set: dev-login sessions use a random secret and end when this server restarts.'); }
}

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
// The client-IP header (per-IP rate limits, identity per-client cap) is set by the ThreatReady gateway
// in production; the hosted mount runs behind it. This standalone server is not behind that gateway, so
// a client-supplied header is not trusted and is stripped — unless REDTEAM_TRUST_CLIENT_IP_HEADER=1 says
// a trusted proxy in front sets it. Otherwise clientIp() falls back to the socket address (cross-unit
// client-IP policy, mirrors the labs hub).
const trustIpHeader = process.env.REDTEAM_TRUST_CLIENT_IP_HEADER === '1';
server.use((req, _res, next) => { if (!trustIpHeader) delete req.headers[CLIENT_IP_HEADER]; next(); });
server.use('/lab', lab);
server.get('/', (_req, res) => res.redirect(302, '/lab/'));
server.listen(port, () => console.log(`ThreatReady Web Pentest Lab — http://localhost:${port}/lab/  (dev login: ${devLogin})`));
