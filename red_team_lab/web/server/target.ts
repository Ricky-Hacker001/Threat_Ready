// The AeroCart target application: a pure request handler over TargetState.
// handle(target, req) returns a response, detection events and any Set-Cookie jar updates.
// It performs NO real I/O: "injection", "traversal", "SSRF" etc. are resolved against the
// synthetic data model only. Nothing is ever executed, fetched or read for real.

import crypto from 'node:crypto';
import { HttpRequest, HttpResponse, resp, json, parseBody, parseQuery } from './http';
import { TargetState, NcUser, NcOrder, metadataResponse } from './fixture';

export const TARGET_HOST = 'shop.aerocart.lab';

export interface TargetEvent { type: string; data: Record<string, any> }
export interface HandleResult { res: HttpResponse; events: TargetEvent[]; setCookies: Record<string, string> }

// ---------- HTML helpers ----------
const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const page = (title: string, bodyHtml: string, user?: NcUser | null) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · AeroCart</title></head>
<body style="font-family:system-ui,Arial,sans-serif;margin:0;background:#f6f7fb;color:#1a2234">
<header style="background:#101828;color:#fff;padding:12px 20px;display:flex;gap:18px;align-items:center">
<strong style="font-size:18px">🛒 AeroCart</strong>
<a href="/products" style="color:#cdd4e3">Shop</a><a href="/search" style="color:#cdd4e3">Search</a>
<a href="/account" style="color:#cdd4e3">Account</a><a href="/support" style="color:#cdd4e3">Support</a>
<span style="margin-left:auto;color:#9aa4bd">${user ? 'Signed in: ' + esc(user.username) + (user.role === 'admin' ? ' (admin)' : '') : '<a href="/login" style="color:#cdd4e3">Sign in</a>'}</span>
</header><main style="max-width:860px;margin:0 auto;padding:24px">${bodyHtml}</main></body></html>`;

// ---------- JWT (HS256) for the admin SSO token ----------
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o: any) => b64url(Buffer.from(JSON.stringify(o)));
export function signJwt(payload: any, secret: string): string {
  const head = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson(payload);
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}
export function verifyJwt(token: string, secret: string): any | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest());
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch { return null; }
}

// ---------- injection detectors (deterministic, synthetic) ----------
function sqliProbe(input: string): { injected: boolean; comment: boolean; tautology: boolean; targetUser?: string; union: boolean } {
  const s = input || '';
  const comment = /('|%27)\s*(--|#)/.test(s) || /\b--\s*$/.test(s);
  const tautology = /('|%27)?\s*(or|\|\|)\s+('?\w+'?\s*=\s*'?\w+'?|\d+\s*=\s*\d+)/i.test(s);
  const union = /union\s+(all\s+)?select/i.test(s);
  const nameMatch = s.match(/^\s*([a-zA-Z0-9_]+)\s*('|%27)\s*(--|#)/);
  return { injected: comment || tautology || union, comment, tautology, union, targetUser: nameMatch?.[1] };
}

const sessionUser = (t: TargetState, req: HttpRequest): NcUser | null => {
  const tok = req.cookies['ac_session'];
  const s = tok ? t.sessions[tok] : null;
  return s ? t.users.find(u => u.id === s.userId) || null : null;
};

const timed = (base = 8) => base + Math.floor(Math.random() * 12);

// ---------- main handler ----------
export function handle(t: TargetState, req: HttpRequest): HandleResult {
  const events: TargetEvent[] = [];
  const setCookies: Record<string, string> = {};
  const q = parseQuery(req.query);
  const emit = (type: string, data: Record<string, any> = {}) => events.push({ type, data: { route: `${req.method} ${req.path}`, ...data } });
  const done = (res: HttpResponse): HandleResult => { emit('web.response', { status: res.status }); return { res, events, setCookies }; };
  const user = sessionUser(t, req);
  const path = req.path.replace(/\/+$/, '') || '/';

  // ---- public pages ----
  if (req.method === 'GET' && (path === '/' || path === '/home'))
    return done(resp(200, page('Home', `<h1>Welcome to AeroCart</h1><p>India's fastest-growing electronics store.</p>
      <p><a href="/products">Browse products →</a></p>`, user), 'text/html', secHeaders(t), timed()));

  if (req.method === 'GET' && path === '/robots.txt')
    return done(resp(200, `User-agent: *\nDisallow: /admin\nDisallow: /backups/\nDisallow: /.env\nDisallow: /api/\nSitemap: /sitemap.xml\n`, 'text/plain', secHeaders(t), timed()));

  if (req.method === 'GET' && path === '/sitemap.xml')
    return done(resp(200, `<?xml version="1.0"?><urlset><url><loc>/products</loc></url><url><loc>/search</loc></url><url><loc>/support</loc></url><url><loc>/login</loc></url></urlset>`, 'text/plain', secHeaders(t), timed()));

  if (req.method === 'GET' && path === '/products') {
    const rows = t.products.map(p => `<li><a href="/product?id=${p.id}">${esc(p.name)}</a> — ₹${p.price} <small>(${esc(p.category)})</small></li>`).join('');
    return done(resp(200, page('Products', `<h1>Products</h1><ul>${rows}</ul><p><a href="/search">Search the catalogue</a></p>`, user), 'text/html', secHeaders(t), timed()));
  }

  // ---- product detail: SQL injection sink (UNION dump) on id ----
  if (req.method === 'GET' && path === '/product') {
    const id = q.id ?? '';
    const probe = sqliProbe(id);
    if (!t.fixes.sqli && probe.union) {
      emit('web.sqlInjection', { param: 'id', payload: id, union: true, dumped: true });
      const dump = t.users.map(u => `${u.id}, ${u.username}, ${u.password}, ${u.role}`).join('<br>');
      return done(resp(200, page('Product', `<h1>Product lookup</h1><pre>Query returned extra columns:<br>${dump}</pre>`, user), 'text/html', secHeaders(t), timed(30)));
    }
    if (!t.fixes.sqli && probe.injected) emit('web.sqlInjection', { param: 'id', payload: id, union: false });
    const p = t.products.find(x => String(x.id) === String(parseInt(id, 10)));
    if (!p) return done(resp(404, page('Not found', `<h1>404</h1><p>No such product.</p>`, user), 'text/html', secHeaders(t), timed()));
    return done(resp(200, page(p.name, `<h1>${esc(p.name)}</h1><p>₹${p.price} — ${esc(p.category)}</p><p>${esc(p.description)}</p>`, user), 'text/html', secHeaders(t), timed()));
  }

  // ---- search: reflected XSS sink on q ----
  if (req.method === 'GET' && (path === '/search')) {
    const term = q.q ?? '';
    const hits = term ? t.products.filter(p => p.name.toLowerCase().includes(term.toLowerCase())) : [];
    const list = hits.map(p => `<li><a href="/product?id=${p.id}">${esc(p.name)}</a></li>`).join('') || '<li>No products matched.</li>';
    const echo = t.fixes.reflectedXss ? esc(term) : term;  // the vulnerability: raw echo
    if (!t.fixes.reflectedXss && term && /<\s*(script|img|svg|iframe|body)|on\w+\s*=/i.test(term))
      emit('web.reflectedXss', { param: 'q', payload: term });
    return done(resp(200, page('Search', `<h1>Search</h1><form method="get" action="/search"><input name="q" value="${t.fixes.reflectedXss ? esc(term) : term}" placeholder="Search products"><button>Go</button></form>
      <p>Results for <b>${echo}</b>:</p><ul>${list}</ul>`, user), 'text/html', secHeaders(t), timed()));
  }

  // ---- login: SQL injection auth bypass ----
  if (path === '/login') {
    if (req.method === 'GET')
      return done(resp(200, page('Sign in', `<h1>Sign in</h1><form method="post" action="/login">
        <p><input name="username" placeholder="Username"></p><p><input name="password" type="password" placeholder="Password"></p>
        <button>Sign in</button></form>`, user), 'text/html', secHeaders(t), timed()));
    const b = parseBody(req.body, req.headers['content-type']);
    const u = b.username ?? '', pw = b.password ?? '';
    let authed: NcUser | null = null, bypass = false;
    if (t.fixes.sqli) {
      authed = t.users.find(x => x.username === u && x.password === pw) || null;
    } else {
      const probe = sqliProbe(u);
      if (probe.injected) {
        bypass = true;
        emit('web.sqlInjection', { param: 'username', payload: u, bypass: true, union: probe.union });
        authed = (probe.targetUser && t.users.find(x => x.username === probe.targetUser)) || t.users[0];
      } else {
        authed = t.users.find(x => x.username === u && x.password === pw) || null;
      }
    }
    if (!authed) return done(resp(401, page('Sign in', `<h1>Sign in</h1><p style="color:#b4231c">Invalid credentials.</p>`, user), 'text/html', secHeaders(t), timed(20)));
    const tok = 'ncs_' + crypto.randomBytes(9).toString('hex');
    t.sessions[tok] = { userId: authed.id, createdAt: new Date().toISOString() };
    setCookies['ac_session'] = tok;
    return done(resp(200, page('Account', `<h1>Welcome, ${esc(authed.fullName)}</h1><p>You are signed in${bypass ? ' (authentication bypassed)' : ''}.</p><p><a href="/account">Your account</a></p>`, authed), 'text/html', secHeaders(t), timed()));
  }

  if (req.method === 'GET' && path === '/account') {
    if (!user) return done(resp(401, page('Account', `<h1>Sign in required</h1><p><a href="/login">Sign in</a></p>`), 'text/html', secHeaders(t), timed()));
    const mine = t.orders.filter(o => o.userId === user.id);
    const rows = mine.map(o => `<li>Order ${o.id} — ₹${o.total} — ${esc(o.status)}</li>`).join('') || '<li>No orders.</li>';
    return done(resp(200, page('Account', `<h1>${esc(user.fullName)}</h1><p>${esc(user.email)}</p><p>${esc(user.address)}</p><h2>Your orders</h2><ul>${rows}</ul>
      <p>Order API: <code>/api/order?id=&lt;id&gt;</code></p>`, user), 'text/html', secHeaders(t), timed()));
  }

  // ---- order API: IDOR + excessive data exposure ----
  if (req.method === 'GET' && path === '/api/order') {
    if (!user) return done(json(401, { error: 'authentication required' }, {}, timed()));
    const o = t.orders.find(x => String(x.id) === String(q.id));
    if (!o) return done(json(404, { error: 'order not found' }, {}, timed()));
    if (o.userId !== user.id) {
      if (t.fixes.idor) return done(json(403, { error: 'forbidden: not your order' }, {}, timed(10)));
      emit('web.idor', { orderId: o.id, owner: o.userId, viewer: user.id });
    }
    return done(json(200, orderDto(t, o), {}, timed()));
  }

  // ---- support tickets: stored XSS ----
  if (path === '/support') {
    if (req.method === 'GET')
      return done(resp(200, page('Support', `<h1>Support</h1><form method="post" action="/support/ticket">
        <p><input name="subject" placeholder="Subject" style="width:100%"></p>
        <p><textarea name="body" placeholder="Describe your issue" style="width:100%"></textarea></p>
        <button>Submit ticket</button></form><p><a href="/support/ticket?id=9001">View ticket 9001</a></p>`, user), 'text/html', secHeaders(t), timed()));
  }
  if (req.method === 'POST' && path === '/support/ticket') {
    const b = parseBody(req.body, req.headers['content-type']);
    const id = t.nextTicketId++;
    t.tickets.push({ id, userId: user?.id ?? 2, subject: b.subject || '(no subject)', body: b.body || '', status: 'Open', createdAt: new Date().toISOString() });
    return done(resp(201, page('Support', `<h1>Ticket ${id} created</h1><p><a href="/support/ticket?id=${id}">View ticket</a></p>`, user), 'text/html', secHeaders(t), timed()));
  }
  if (req.method === 'GET' && path === '/support/ticket') {
    const tk = t.tickets.find(x => String(x.id) === String(q.id));
    if (!tk) return done(resp(404, page('Support', `<h1>404</h1><p>No such ticket.</p>`, user), 'text/html', secHeaders(t), timed()));
    const bodyHtml = t.fixes.storedXss ? esc(tk.body) : tk.body;   // the vulnerability: stored body rendered raw
    if (!t.fixes.storedXss && /<\s*(script|img|svg|iframe)|on\w+\s*=/i.test(tk.body))
      emit('web.storedXss', { ticketId: tk.id, sink: 'ticket.body' });
    return done(resp(200, page('Ticket ' + tk.id, `<h1>${esc(tk.subject)}</h1><div class="ticket-body">${bodyHtml}</div><p><small>Status: ${esc(tk.status)}</small></p>`, user), 'text/html', secHeaders(t), timed()));
  }

  // ---- document download: path traversal + sensitive file exposure ----
  if (req.method === 'GET' && path === '/download') {
    const file = q.file ?? '';
    const traversal = /\.\.(\/|\\|%2f|%5c)/i.test(file) || file.startsWith('/') || /%2e%2e/i.test(file);
    if (traversal) {
      if (t.fixes.pathTraversal) return done(resp(403, 'Forbidden: path outside document root.', 'text/plain', secHeaders(t), timed()));
      const hostPath = normaliseTraversal(file);
      const content = t.files['HOST:' + hostPath];
      if (content) { emit('web.pathTraversal', { param: 'file', payload: file, resolved: hostPath }); return done(resp(200, content, 'text/plain', secHeaders(t), timed(25))); }
      return done(resp(404, 'Not found.', 'text/plain', secHeaders(t), timed()));
    }
    const clean = file.replace(/^\/+/, '');
    const sensitive = /^(backups\/|\.env$|\.git\/)/.test(clean);
    if (sensitive) {
      if (t.fixes.fileExposure) return done(resp(404, 'Not found.', 'text/plain', secHeaders(t), timed()));
      const content = t.files[clean];
      if (content) { emit('web.fileExposure', { path: clean }); return done(resp(200, content, 'text/plain', secHeaders(t), timed(18))); }
    }
    const content = t.files[clean];
    if (content == null) return done(resp(404, 'Not found.', 'text/plain', secHeaders(t), timed()));
    return done(resp(200, content, clean.endsWith('.pdf') ? 'text/plain' : 'text/plain', secHeaders(t), timed()));
  }

  // ---- admin SSO (broken JWT) ----
  if (path.startsWith('/admin')) {
    const admin = adminFromJwt(t, req, emit);
    if (!admin) return done(resp(403, page('Admin', `<h1>403</h1><p>Admin SSO token required (cookie <code>ac_admin</code>).</p>`, user), 'text/html', secHeaders(t), timed()));
    if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) {
      return done(resp(200, page('Admin', `<h1>Admin console</h1><p>Signed in as ${esc(admin.username)}.</p>
        <ul><li><a href="/admin/tickets">All support tickets</a></li><li><code>/admin/ping?host=</code> — host health check</li><li><code>/admin/fetch?url=</code> — partner integration fetch</li></ul>`, user), 'text/html', secHeaders(t), timed()));
    }
    if (req.method === 'GET' && path === '/admin/tickets') {
      const rows = t.tickets.map(tk => {
        const b = t.fixes.storedXss ? esc(tk.body) : tk.body;
        if (!t.fixes.storedXss && /<\s*(script|img|svg|iframe)|on\w+\s*=/i.test(tk.body)) emit('web.storedXss', { ticketId: tk.id, sink: 'admin.ticket.body' });
        return `<li><b>${esc(tk.subject)}</b><br>${b}</li>`;
      }).join('');
      return done(resp(200, page('Admin · Tickets', `<h1>All tickets</h1><ul>${rows}</ul>`, user), 'text/html', secHeaders(t), timed()));
    }
    // command injection in host health check
    if (req.method === 'GET' && path === '/admin/ping') {
      const host = q.host ?? '';
      const meta = /[;|&`]|\$\(/.test(host);
      if (meta && !t.fixes.cmdInjection) {
        emit('web.cmdInjection', { param: 'host', payload: host });
        return done(resp(200, `$ ping -c1 ${host}\nPING resolved... 1 packet transmitted\n--- injected command output ---\nuid=0(root) gid=0(root)\nCMD FLAG: ${t.flags.cmd}\n`, 'text/plain', secHeaders(t), timed(35)));
      }
      if (meta && t.fixes.cmdInjection) return done(resp(400, 'Invalid host.', 'text/plain', secHeaders(t), timed()));
      return done(resp(200, `$ ping -c1 ${esc(host)}\n64 bytes from ${esc(host)}: icmp_seq=1 ttl=117 time=12.3 ms\n`, 'text/plain', secHeaders(t), timed()));
    }
    // SSRF in partner integration fetch
    if (req.method === 'GET' && path === '/admin/fetch') {
      const url = q.url ?? '';
      const internal = /169\.254\.169\.254|localhost|127\.0\.0\.1|\[::1\]|metadata|0\.0\.0\.0|\.internal/i.test(url);
      if (t.fixes.ssrf) {
        if (!/^https?:\/\/partners\.aerocart\.example\//i.test(url)) return done(resp(400, 'Blocked: URL not on the integration allowlist.', 'text/plain', secHeaders(t), timed(10)));
        return done(resp(200, 'partner ok', 'text/plain', secHeaders(t), timed()));
      }
      if (internal) { emit('web.ssrf', { url }); return done(resp(200, metadataResponse(t), 'text/plain', secHeaders(t), timed(40))); }
      return done(resp(200, `Fetched ${esc(url)} (synthetic partner response)`, 'text/plain', secHeaders(t), timed()));
    }
  }

  return done(resp(404, page('Not found', `<h1>404</h1><p>No route for <code>${esc(req.method)} ${esc(req.path)}</code>.</p>`, user), 'text/html', secHeaders(t), timed()));
}

// Emit web.jwtForged when a valid admin token is presented that the server never issued.
function adminFromJwt(t: TargetState, req: HttpRequest, emit: (type: string, data?: any) => void): { username: string } | null {
  const tok = req.cookies['ac_admin'];
  if (!tok) return null;
  const secret = t.fixes.jwtAuth ? strongSecret(t) : t.jwtSecret;
  const payload = verifyJwt(tok, secret);
  if (!payload || payload.role !== 'admin') return null;
  if (t.fixes.jwtAuth && !payload.srv) return null; // after the fix, only server-minted tokens carry the server marker
  if (!payload.srv) emit('web.jwtForged', { tokenRole: payload.role, user: payload.user });
  return { username: payload.user || 'admin' };
}
const strongSecret = (t: TargetState) => 'rotated-' + crypto.createHash('sha256').update(t.seed + ':rotated').digest('hex');

export function issueAdminToken(t: TargetState): string { return signJwt({ user: 'admin', role: 'admin', srv: true, iat: Math.floor(Date.now() / 1000) }, t.fixes.jwtAuth ? strongSecret(t) : t.jwtSecret); }

function orderDto(t: TargetState, o: NcOrder) {
  const owner = t.users.find(u => u.id === o.userId);
  return { id: o.id, status: o.status, placedAt: o.placedAt, total: o.total, items: o.items, shipTo: o.shipTo,
    customer: owner ? { id: owner.id, fullName: owner.fullName, email: owner.email, phone: owner.phone } : null };
}

function normaliseTraversal(file: string): string {
  let f = file.replace(/%2e/gi, '.').replace(/%2f/gi, '/').replace(/%5c/gi, '/').replace(/\\/g, '/');
  // Resolve ../ against an assumed document root of /var/www/aerocart/docs/
  const base = '/var/www/aerocart/docs/'.split('/').filter(Boolean);
  for (const seg of f.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') base.pop();
    else base.push(seg);
  }
  return '/' + base.join('/');
}

// Security headers are deliberately weak (misconfiguration folded into the report, not a graded finding).
function secHeaders(t: TargetState): Record<string, string> {
  return { 'server': 'AeroCart/1.4', 'x-powered-by': 'Express' };
}
