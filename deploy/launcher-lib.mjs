// Pure helpers for the launcher (deploy/start.mjs) and the labs child, kept free of side effects so
// deploy/test/launcher.test.mjs can cover them. Nothing here reads process.env or prints a secret.
import { createHash, hkdfSync } from 'node:crypto';
import { isIP } from 'node:net';

/* ---------------- Per-caller internal tokens (TOKEN_SPEC.md) ---------------- */

/** derived(caller, callee) = HKDF-SHA256(INTERNAL_API_TOKEN, salt 'threatready-internal', info 'caller->callee'), 32 bytes hex. */
export function derivedToken(secret, caller, callee) {
  return Buffer.from(hkdfSync('sha256', secret, 'threatready-internal', `${caller}->${callee}`, 32)).toString('hex');
}

/**
 * The token variables each process receives. Every callee accepts only the tokens of its callers;
 * every caller presents the token minted for that callee. A child is therefore given no token that
 * opens another child's internal API, and never the raw INTERNAL_API_TOKEN. (Given, not readable: all
 * processes share one user, so code running in a child can read the launcher's environment from
 * /proc; see deploy/README.md "Limits of the isolation".)
 *
 * The labs child hosts three callees (labs, Attack Reasoning, Red Team) in one process, so its
 * process-wide INTERNAL_TOKENS_ACCEPT is the union and the per-app values carry explicit prefixes
 * (deploy/labs-child.mjs hands them to each createApp).
 *
 * InterviewPrep serves two callers with different rights: Attack Reasoning (ar->interview) reads only
 * /internal/v1/reasoning/*; the summary, AI usage and account erasure routes are onboard's alone. Its
 * INTERNAL_TOKENS_ACCEPT (the reasoning routes) holds both tokens; INTERNAL_TOKEN_FROM_ONBOARD names the
 * one token those onboard-only routes accept, so the ar->interview token the labs child holds cannot
 * erase a learner's data (merge review M-SEC-1).
 */
export function internalTokenEnv(secret) {
  const t = (caller, callee) => derivedToken(secret, caller, callee);
  return {
    onboard: {
      INTERNAL_TOKENS_ACCEPT: [t('labs', 'onboard'), t('ar', 'onboard'), t('interview', 'onboard'), t('redteam', 'onboard')].join(','),
      INTERNAL_TOKEN_TO_INTERVIEW: t('onboard', 'interview'),
      INTERNAL_TOKEN_TO_LABS: t('onboard', 'labs'),
      INTERNAL_TOKEN_TO_AR: t('onboard', 'ar'),
    },
    interview: {
      INTERNAL_TOKENS_ACCEPT: [t('onboard', 'interview'), t('ar', 'interview')].join(','),
      INTERNAL_TOKEN_FROM_ONBOARD: t('onboard', 'interview'),
      INTERNAL_TOKEN_TO_ONBOARD: t('interview', 'onboard'),
    },
    labs: {
      INTERNAL_TOKENS_ACCEPT: [t('onboard', 'labs'), t('onboard', 'ar')].join(','),
      INTERNAL_TOKEN_TO_ONBOARD: t('labs', 'onboard'),
      INTERNAL_TOKEN_TO_INTERVIEW: t('ar', 'interview'),
      LABS_INTERNAL_TOKENS_ACCEPT: t('onboard', 'labs'),
      LABS_INTERNAL_TOKEN_TO_ONBOARD: t('labs', 'onboard'),
      AR_INTERNAL_TOKENS_ACCEPT: t('onboard', 'ar'),
      AR_INTERNAL_TOKEN_TO_ONBOARD: t('ar', 'onboard'),
      AR_INTERNAL_TOKEN_TO_INTERVIEW: t('ar', 'interview'),
      REDTEAM_INTERNAL_TOKEN_TO_ONBOARD: t('redteam', 'onboard'),
    },
  };
}

/* ---------------- Role password sync (A8) ---------------- */

export const ROLE_PASSWORD_STATE_KEY = 'app_role_password_sha256';
export const passwordDigest = (password) => createHash('sha256').update(password).digest('hex');

/**
 * ALTER ROLE ... PASSWORD runs only when the password changed (or FORCE_ROLE_SYNC=true): the statement
 * is otherwise re-issued on every boot, which rewrites pg_authid and leaves the password in any
 * statement log for nothing. `stored` is the digest kept in threatready_launcher_state (null = none).
 */
export function roleSyncNeeded({ roleExists, stored, password, force = false }) {
  if (!roleExists || force) return true;
  return stored !== passwordDigest(password);
}

/* ---------------- Observability (A13) ---------------- */

/** One structured line per child exit: machine-parseable in Render's log search. */
export function childExitLine({ name, code, signal, startedAt, exits, now = Date.now() }) {
  return JSON.stringify({ event: 'child_exit', name, code: code ?? null, signal: signal ?? null, uptimeMs: Math.max(0, now - startedAt), exits });
}

/** heapUsed from a child's health response body, when it offers one (onboard /__health, labs child /). */
export function heapUsedOf(body) {
  const n = body && typeof body === 'object' ? body.heapUsed : undefined;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* ---------------- Labs child: trusting the gateway's client-IP stamp ---------------- */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/**
 * Middleware for a loopback-only child behind the gateway: the gateway's stamped client-IP header becomes
 * X-Forwarded-For (what Express's `trust proxy` reads), so `req.ip` in every mounted app is the visitor.
 * Only a loopback peer may carry the stamp; anything else loses both headers and is keyed on its socket.
 */
export function gatewayIpToForwardedFor(headerName) {
  return (req, _res, next) => {
    const raw = req.headers[headerName];
    const ip = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim() || '';
    if (LOOPBACK.has(req.socket?.remoteAddress ?? '') && isIP(ip)) req.headers['x-forwarded-for'] = ip;
    else { delete req.headers['x-forwarded-for']; delete req.headers[headerName]; }
    next();
  };
}

/** `true`/`false` strings from the environment with a default. */
export const boolEnv = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes)$/i.test(v));

/* ---------------- CAPTCHA at boot (audit H4) ---------------- */

/**
 * Whether production may boot without Turnstile. Onboard requires both keys in production unless
 * ALLOW_NO_CAPTCHA=true is an explicit opt-in; the launcher used to set that for it whenever the keys
 * were missing, which turned onboard's boot check into a warning. Now: `on` when both keys are set;
 * `fatal` (the deploy must fail) in production without both keys unless the operator set
 * ALLOW_NO_CAPTCHA=true themselves; `warning` otherwise when CAPTCHA is off.
 */
export function captchaCheck({ siteKey = '', secretKey = '', allowNoCaptcha, production }) {
  const on = !!(siteKey && secretKey);
  const optedOut = allowNoCaptcha === 'true';
  if (on) return { on, fatal: null, warning: null };
  const missing = siteKey || secretKey ? `${siteKey ? 'TURNSTILE_SECRET_KEY' : 'TURNSTILE_SITE_KEY'} is missing` : 'TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are not set';
  if (production && !optedOut) {
    return { on, fatal: `${missing}: production needs Cloudflare Turnstile (both keys), or ALLOW_NO_CAPTCHA=true set in the service environment to run sign-up on rate limits alone (a demo deployment).`, warning: null };
  }
  return { on, fatal: null, warning: `${missing}; CAPTCHA is OFF${optedOut ? ' (ALLOW_NO_CAPTCHA=true)' : ''}: sign-up relies on rate limits alone until both Turnstile keys are set.` };
}

/* ---------------- Labs child: identity cache ---------------- */

/** The largest identity cache the labs child accepts (seconds): a sign-out is seen within this long. Same bound as InterviewPrep's IDENTITY_CACHE_SECONDS. */
export const IDENTITY_CACHE_MAX_SECONDS = 300;
/**
 * IDENTITY_CACHE_SECONDS for the labs child's resolvers: a whole number of seconds, 0..300 (clamped: a
 * larger value is 300, a negative one 0), 30 when unset or not a number. InterviewPrep refuses to boot on
 * an out-of-range value; the labs child, whose boot the launcher would retry forever, clamps and logs.
 */
export function identityCacheSeconds(raw, fallback = 30) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(IDENTITY_CACHE_MAX_SECONDS, Math.max(0, Math.floor(n)));
}
