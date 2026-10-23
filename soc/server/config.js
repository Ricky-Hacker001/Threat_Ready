// Runtime configuration. Read once at start-up. Nothing here is ever sent
// to the client.

import crypto from 'node:crypto';

const env = process.env;
const production = env.NODE_ENV === 'production';
const DEV_SESSION_SECRET = 'dev-only-session-secret-change-me';
// The session-cookie secret: SOC_SESSION_SECRET (set by the ThreatReady launcher) first, then the
// original SIM_SESSION_SECRET. Production never runs on the development default.
const givenSessionSecret = env.SOC_SESSION_SECRET || env.SIM_SESSION_SECRET || '';
if (production && givenSessionSecret === DEV_SESSION_SECRET) {
  throw new Error('SOC_SESSION_SECRET / SIM_SESSION_SECRET is the development default; set a real secret (e.g. `openssl rand -hex 32`) for production.');
}

export const config = {
  production,
  // Optional ThreatReady hand-off. Off unless TR_SIM_SECRET is set.
  trSimSecret: env.TR_SIM_SECRET || '',
  // Standalone by default: without a configured secret a random one is made
  // at start-up (sessions then end when the server restarts).
  sessionSecret: givenSessionSecret || (production ? crypto.randomBytes(32).toString('hex') : DEV_SESSION_SECRET),
  sessionSecretGenerated: !givenSessionSecret && production,
  trHomeUrl: env.TR_HOME_URL || '',
  // DEV_USER signs a fixed user in without a token. Ignored in production.
  devUser: !production && env.DEV_USER ? String(env.DEV_USER).trim().slice(0, 60) : '',
  dailyWipe: String(env.DAILY_WIPE ?? 'true').toLowerCase() !== 'false',
  webhookUrl: env.TR_WEBHOOK_URL || '',
  webhookSecret: env.TR_WEBHOOK_SECRET || '',
  exportToken: env.TR_EXPORT_TOKEN || '',
  sessionHours: 8,       // ThreatReady token sessions
  localSessionHours: 24, // name sign-in sessions (records are wiped daily anyway)
  // Test runs may pin a variant (no renaming, no jitter). Never honoured
  // outside the test harness.
  testMode: env.SOC_SIM_TEST === '1' && !production,
};

// Nothing is required: the simulation runs standalone with its own name
// sign-in. Returns warnings to log at start-up.
export function checkConfig() {
  const warn = [];
  if (production) {
    if (config.sessionSecretGenerated) warn.push('SOC_SESSION_SECRET / SIM_SESSION_SECRET is not set: using a random secret, so sessions end when the server restarts.');
    if (env.DEV_USER) warn.push('DEV_USER is set but ignored in production.');
  }
  return warn;
}
