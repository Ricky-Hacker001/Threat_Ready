import path from 'node:path';
import { onboardApps, onboardIdentity } from './identity';
import { createStandaloneServer, trustProxyFrom } from './standalone';

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

// The reasoning engine: the ThreatReady monolith (InterviewPrep API). Optional so the catalogue still serves without it.
const reasoningApiUrl = process.env.REASONING_API_URL;
if (!reasoningApiUrl) console.warn('REASONING_API_URL is not set: assessments are unavailable; the catalogue still serves.');

// The app lives under /ar (its API at /ar/api, onboard's internal calls at /ar/internal); /v1 is the engine.
const appOrigin = new URL(env('APP_ORIGIN', 'http://localhost:5176')).origin;
const server = createStandaloneServer(path.join(root, 'dist'), {
  identity: onboardIdentity({ identityUrl, internalToken, cacheSeconds: Number(process.env.IDENTITY_CACHE_SECONDS ?? 30) }),
  internalToken,
  appOrigin,
  onboardUrl: new URL(env('ONBOARD_URL', 'http://localhost:5173')).origin,
  apps: onboardApps(identityUrl),
  reasoningApi: reasoningApiUrl ? { url: new URL(reasoningApiUrl).origin } : undefined,
}, {
  // Behind a reverse proxy, say so (AR_TRUST_PROXY=1, or loopback, or its addresses); a proxy that
  // sets x-threatready-client-ip for every request: AR_TRUST_CLIENT_IP_HEADER=1.
  trustProxy: trustProxyFrom(process.env.AR_TRUST_PROXY),
  trustClientIpHeader: process.env.AR_TRUST_CLIENT_IP_HEADER === '1',
  hsts: appOrigin.startsWith('https://'),
});
server.listen(port, () => console.log(`ThreatReady Attack Reasoning — http://localhost:${port}/ar/`));
