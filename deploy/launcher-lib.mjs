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
 * every caller presents the token minted for that callee. A compromised child therefore holds no
 * token that opens another child's internal API, and never the raw INTERNAL_API_TOKEN.
 *
 * The labs child hosts three callees (labs, Attack Reasoning, Red Team) in one process, so its
 * process-wide INTERNAL_TOKENS_ACCEPT is the union and the per-app values carry explicit prefixes
 * (deploy/labs-child.mjs hands them to each createApp).
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
