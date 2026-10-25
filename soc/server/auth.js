// Sessions. The simulation runs standalone: the analyst signs in with a
// display name (POST /api/session/local). Optionally, when TR_SIM_SECRET is
// set, ThreatReady can open it with ?t=<JWT> instead. The client posts the token
// to POST /api/session; the server verifies it (HS256, TR_SIM_SECRET,
// aud "soc-sim", exp at most 5 minutes after iat) and sets a signed,
// HttpOnly session cookie. Every other /api route requires that cookie.

import crypto from 'node:crypto';
import express from 'express';
import { config, stateDurable } from './config.js';
import { HttpError } from './engine/response.js';

const COOKIE = 'soc_session';
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

// Exported for tests and for ThreatReady integration examples.
export function signToken(claims, secret = config.trSimSecret) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${b64u(hmac(secret, `${head}.${body}`))}`;
}

export function verifyToken(token, now = Date.now()) {
  if (!config.trSimSecret) throw new HttpError(401, 'bad_token', { message: 'Token sign-in is not configured on this server.' });
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new HttpError(401, 'bad_token', { message: 'The sign-in token is malformed.' });
  let head;
  let claims;
  try {
    head = JSON.parse(unb64u(parts[0]).toString('utf8'));
    claims = JSON.parse(unb64u(parts[1]).toString('utf8'));
  } catch {
    throw new HttpError(401, 'bad_token', { message: 'The sign-in token is malformed.' });
  }
  if (head.alg !== 'HS256') throw new HttpError(401, 'bad_token', { message: 'Unsupported token algorithm.' });
  const expect = hmac(config.trSimSecret, `${parts[0]}.${parts[1]}`);
  if (!safeEq(expect, unb64u(parts[2]))) throw new HttpError(401, 'bad_token', { message: 'The sign-in token signature is not valid.' });
  if (claims.aud !== 'soc-sim') throw new HttpError(401, 'bad_token', { message: 'The sign-in token is for a different application.' });
  const sec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') throw new HttpError(401, 'bad_token', { message: 'The sign-in token has no validity period.' });
  if (claims.exp - claims.iat > 300) throw new HttpError(401, 'bad_token', { message: 'The sign-in token is valid for too long.' });
  if (claims.iat > sec + 60) throw new HttpError(401, 'bad_token', { message: 'The sign-in token is not valid yet.' });
  if (claims.exp < sec) throw new HttpError(401, 'token_expired', { message: 'The sign-in token has expired. Open the simulation from ThreatReady again.' });
  const uid = String(claims.sub || '').trim().slice(0, 80);
  if (!uid) throw new HttpError(401, 'bad_token', { message: 'The sign-in token names no user.' });
  const name = String(claims.name || uid).trim().slice(0, 80) || uid;
  return { uid, name };
}

function sessionValue(user, now = Date.now(), hours = config.sessionHours) {
  const body = b64u(JSON.stringify({ uid: user.uid, name: user.name, iat: Math.floor(now / 1000), h: hours }));
  return `${body}.${b64u(hmac(config.sessionSecret, body))}`;
}

export function readSession(cookieValue, now = Date.now()) {
  if (!cookieValue || !config.sessionSecret) return null;
  const [body, sig] = String(cookieValue).split('.');
  if (!body || !sig) return null;
  if (!safeEq(hmac(config.sessionSecret, body), unb64u(sig))) return null;
  try {
    const p = JSON.parse(unb64u(body).toString('utf8'));
    if (!p.uid || Math.floor(now / 1000) - p.iat > (Number(p.h) || config.sessionHours) * 3600) return null;
    return { uid: String(p.uid), name: String(p.name || p.uid) };
  } catch {
    return null;
  }
}

// Name = the text before the first "=", trimmed. threatready-lab-001/server/hosted.ts
// (withoutSocSession) reads names the same way; keep the two in step.
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* not percent-encoded: keep it as sent */ }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

function setCookie(res, value, maxAge) {
  const attrs = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (config.production) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

// Attaches req.user when a valid session exists (or DEV_USER outside production).
// Mounted inside ThreatReady (threatready-lab-001/server/hosted.ts), the host signs the platform user
// in before this app runs: that identity is kept over any cookie, DEV_USER or test header, and the
// request is marked as hosted (the sign-in routes below are then refused).
export function sessionMiddleware(req, res, next) {
  if (req.user) {
    req.hostedIdentity = true;
    return next();
  }
  const s = readSession(cookies(req)[COOKIE]);
  // Test harness only: act as a named user without a token.
  if (config.testMode && req.headers['x-test-user']) req.user = { uid: String(req.headers['x-test-user']), name: String(req.headers['x-test-user']) };
  else if (s) req.user = s;
  else if (config.devUser) req.user = { uid: config.devUser, name: config.devUser };
  next();
}

const OPEN = new Set(['/health', '/session', '/session/local', '/session/info']);
export function requireSession(req, res, next) {
  if (OPEN.has(req.path)) return next();
  if (req.path === '/export/attempts') return next(); // bearer-token route, checked there
  if (!req.user) return res.status(401).json({ error: 'no_session', message: 'Sign in to the SOC simulation first.' });
  return next();
}

export const authRouter = express.Router();

// Inside ThreatReady the platform owns sign-in and sign-out: this app issues no session of its own,
// so a learner cannot detach their SOC records (or its per-user limits) from their account.
authRouter.post(['/session', '/session/local', '/session/logout'], (req, res, next) => {
  if (req.hostedIdentity) return res.status(404).json({ error: 'not_found', message: 'Sign-in is handled by ThreatReady.' });
  return next();
});

authRouter.post('/session', (req, res, next) => {
  try {
    const user = verifyToken((req.body || {}).token);
    setCookie(res, sessionValue(user), config.sessionHours * 3600);
    res.json({ user });
  } catch (e) {
    next(e);
  }
});

// Standalone sign-in: the analyst enters a display name. Each sign-in gets
// its own private user id, so two people using the same name never share
// records. Records live until sign-out, the session ends, or the daily wipe.
authRouter.post('/session/local', (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    if (name.length < 2) throw new HttpError(400, 'bad_name', { message: 'Enter a name of at least 2 characters.' });
    const user = { uid: `local_${crypto.randomBytes(9).toString('base64url')}`, name };
    setCookie(res, sessionValue(user, Date.now(), config.localSessionHours), config.localSessionHours * 3600);
    res.json({ user });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/session/logout', (req, res) => {
  setCookie(res, '', 0);
  res.json({ ok: true });
});

// Public: whether a session exists. No secrets.
// `hosted`: signed in through ThreatReady, so records belong to the platform account; `durable`: they
// are also kept across restarts (the launcher's database mirror), so they are saved with that account.
authRouter.get('/session/info', (req, res) => res.json({ homeUrl: config.trHomeUrl || null, signedIn: !!req.user, name: req.user?.name || null, dailyWipe: config.dailyWipe, hosted: !!req.hostedIdentity, durable: !!req.hostedIdentity && stateDurable() }));

authRouter.get('/me', (req, res) => res.json({ uid: req.user.uid, name: req.user.name }));
