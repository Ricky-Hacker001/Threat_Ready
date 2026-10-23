// Server-side command interpreter for the Kali-style terminal. Line-based (no TTY/WebSocket).
// Security-testing commands are thin clients of the SAME target handler the browser and proxy use,
// so their output always agrees with the rest of the lab. Nothing is executed on the real host:
// there is no shell-out, no file-system access and no outbound network. Unknown flags are reported,
// and the sandbox is never left.

import { HttpRequest, HttpResponse, parseQuery, responseToText } from './http';
import { TARGET_HOST, signJwt } from './target';
import { FINDINGS } from './scenario';

export interface TermState {
  cwd: string;
  env: Record<string, string>;
  fs: Record<string, string | null>;  // null marks a directory
  hist: string[];
}

export interface TermCtx {
  // Run an HTTP request against the target (shared history + detections happen in the caller).
  runRequest: (req: HttpRequest, tool: string) => HttpResponse;
  jwtSecret: () => string;             // for the jwt tool's offline decode demo (leaked-secret workflow is the learner's)
}

export interface TermResult { out: string; requests: number }

const TARGET_BASE = `http://${TARGET_HOST}`;

export function initTermFs(): TermState {
  return {
    cwd: '/home/analyst',
    env: { USER: 'analyst', HOME: '/home/analyst', TARGET: TARGET_BASE, PWD: '/home/analyst' },
    fs: {
      '/home/analyst': null,
      '/home/analyst/engagement-brief.txt': 'ENG-2041 — AeroCart authorized web assessment.\nTarget: ' + TARGET_BASE + '\nScope: storefront, /api, /admin. Out of scope: everything else, no DoS.\n',
      '/home/analyst/notes.md': '# Recon notes\n- Start with whatweb and robots.txt\n- Enumerate routes with ffuf/gobuster\n',
      '/home/analyst/wordlists': null,
      '/home/analyst/wordlists/common.txt': ['login', 'admin', 'products', 'product', 'search', 'account', 'api', 'api/order', 'support', 'download', 'backups', 'robots.txt', 'sitemap.xml', '.env', '.git'].join('\n') + '\n',
      '/usr/share/wordlists': null,
    },
    hist: [],
  };
}

const TOOLS = ['help', 'clear', 'pwd', 'ls', 'cd', 'cat', 'head', 'tail', 'grep', 'find', 'whoami', 'id', 'history', 'echo', 'base64', 'jwt', 'curl', 'http', 'whatweb', 'nmap', 'ffuf', 'gobuster', 'nikto', 'sqlmap', 'dig', 'nslookup', 'ping', 'wc', 'env'];

export function runTerminal(ts: TermState, line: string, ctx: TermCtx): TermResult {
  const trimmed = line.trim();
  if (!trimmed) return { out: '', requests: 0 };
  ts.hist.push(trimmed);
  // Pipelines: cap at 10 segments (no loops, no subshell execution).
  const segments = splitPipes(trimmed).slice(0, 10);
  let piped = '';
  let requests = 0;
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    const r = runOne(ts, segments[i], piped, ctx);
    requests += r.requests;
    piped = r.out;
    out = r.out;
  }
  return { out, requests };
}

function runOne(ts: TermState, seg: string, stdin: string, ctx: TermCtx): TermResult {
  const argv = tokenize(seg);
  if (!argv.length) return { out: stdin, requests: 0 };
  const cmd = argv[0];
  const args = argv.slice(1);
  switch (cmd) {
    case 'help': return { out: helpText(), requests: 0 };
    case 'clear': return { out: '\x1b[2J\x1b[H', requests: 0 };
    case 'pwd': return { out: ts.cwd + '\n', requests: 0 };
    case 'whoami': return { out: 'analyst\n', requests: 0 };
    case 'id': return { out: 'uid=1000(analyst) gid=1000(analyst) groups=1000(analyst)\n', requests: 0 };
    case 'env': return { out: Object.entries(ts.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', requests: 0 };
    case 'echo': return { out: args.join(' ').replace(/^"|"$/g, '') + '\n', requests: 0 };
    case 'history': return { out: ts.hist.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join('\n') + '\n', requests: 0 };
    case 'ls': return { out: lsCmd(ts, args), requests: 0 };
    case 'cd': return { out: cdCmd(ts, args), requests: 0 };
    case 'cat': return { out: catCmd(ts, args), requests: 0 };
    case 'head': return { out: headTail(ts, args, stdin, true), requests: 0 };
    case 'tail': return { out: headTail(ts, args, stdin, false), requests: 0 };
    case 'wc': return { out: wcCmd(stdin || readFiles(ts, args)), requests: 0 };
    case 'grep': return { out: grepCmd(ts, args, stdin), requests: 0 };
    case 'find': return { out: findCmd(ts, args), requests: 0 };
    case 'base64': return { out: base64Cmd(args, stdin), requests: 0 };
    case 'jwt': return { out: jwtCmd(args, ctx, seg), requests: 0 };
    case 'dig': case 'nslookup': return { out: digCmd(args), requests: 0 };
    case 'ping': return { out: pingCmd(args), requests: 0 };
    case 'curl': case 'http': return curlCmd(args, ctx, cmd);
    case 'whatweb': return whatwebCmd(args, ctx);
    case 'nmap': return nmapCmd(args);
    case 'ffuf': case 'gobuster': return fuzzCmd(ts, args, ctx, cmd);
    case 'nikto': return niktoCmd(args, ctx);
    case 'sqlmap': return sqlmapCmd(args, ctx);
    default:
      return { out: `${cmd}: command not found. Type 'help' for the supported tools.\n`, requests: 0 };
  }
}

// ---------- shell plumbing ----------
function tokenize(s: string): string[] {
  const out: string[] = []; let cur = ''; let q = '';
  for (const ch of s) {
    if (q) { if (ch === q) q = ''; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function splitPipes(s: string): string[] {
  // naive pipe split that respects quotes
  const out: string[] = []; let cur = ''; let q = '';
  for (const ch of s) { if (q) { cur += ch; if (ch === q) q = ''; } else if (ch === '"' || ch === "'") { q = ch; cur += ch; } else if (ch === '|') { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}
const opt = (args: string[], ...names: string[]): string | undefined => {
  for (const n of names) {
    const i = args.indexOf(n); if (i !== -1 && i + 1 < args.length) return args[i + 1];
    const pre = args.find(a => a.startsWith(n + '=')); if (pre) return pre.slice(n.length + 1);
  }
  return undefined;
};
const flag = (args: string[], ...names: string[]): boolean => names.some(n => args.includes(n) || args.some(a => a.startsWith(n + '=')));

// ---------- filesystem ----------
function resolve(ts: TermState, p: string): string {
  if (!p) return ts.cwd;
  let path = p.startsWith('/') ? p : (ts.cwd === '/' ? '' : ts.cwd) + '/' + p;
  const parts: string[] = [];
  for (const seg of path.split('/')) { if (seg === '' || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return '/' + parts.join('/');
}
function lsCmd(ts: TermState, args: string[]): string {
  const target = resolve(ts, args.find(a => !a.startsWith('-')) || '.');
  if (ts.fs[target] === undefined && target !== '/') {
    if (ts.fs[target] !== null && typeof ts.fs[target] === 'string') return target.split('/').pop() + '\n';
    return `ls: cannot access '${args[0] || '.'}': No such file or directory\n`;
  }
  const prefix = target === '/' ? '/' : target + '/';
  const names = new Set<string>();
  for (const k of Object.keys(ts.fs)) {
    if (k === target) continue;
    if (k.startsWith(prefix)) { const rest = k.slice(prefix.length); const first = rest.split('/')[0]; if (first) names.add(first + (ts.fs[prefix + first] === null ? '/' : '')); }
  }
  return [...names].sort().join('  ') + (names.size ? '\n' : '');
}
function cdCmd(ts: TermState, args: string[]): string {
  const target = resolve(ts, args[0] || ts.env.HOME);
  if (ts.fs[target] === null || target === '/') { ts.cwd = target; ts.env.PWD = target; return ''; }
  return `cd: ${args[0]}: Not a directory\n`;
}
function readFile(ts: TermState, p: string): string | null {
  const r = resolve(ts, p); const v = ts.fs[r];
  return typeof v === 'string' ? v : null;
}
function readFiles(ts: TermState, args: string[]): string { return args.filter(a => !a.startsWith('-')).map(a => readFile(ts, a) ?? '').join(''); }
function catCmd(ts: TermState, args: string[]): string {
  const files = args.filter(a => !a.startsWith('-'));
  if (!files.length) return '';
  return files.map(f => { const c = readFile(ts, f); return c == null ? `cat: ${f}: No such file or directory\n` : c; }).join('');
}
function headTail(ts: TermState, args: string[], stdin: string, head: boolean): string {
  const n = parseInt(opt(args, '-n') || '10', 10) || 10;
  const files = args.filter(a => !a.startsWith('-') && a !== String(n));
  const text = files.length ? readFiles(ts, files) : stdin;
  const lines = text.split('\n');
  return (head ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n - 1))).join('\n');
}
function wcCmd(text: string): string { const lines = text ? text.split('\n').length - 1 : 0; const words = text.split(/\s+/).filter(Boolean).length; return `  ${lines}  ${words}  ${text.length}\n`; }
// Learner-typed patterns are compiled and run in this process (the same one that serves every lab),
// so anything that lets V8's backtracking regex engine go super-linear is refused up front, the way
// real grep refuses a malformed expression. Measured on 1000-character lines: one `.*` costs ~4 ms a
// line, two cost ~0.5 s a line, `(a+)+$` or a run of `a?` is exponential. Hence: no quantified groups,
// no backreferences or lookarounds, one unbounded quantifier at most (two variable-width ones counting
// `?`), and a cap on the text scanned.
export const GREP_MAX_PATTERN = 128;
export const GREP_MAX_LINES = 2000;
export const GREP_MAX_CHARS = 16 * 1024;
const LINE_MAX = 1000;
const MAX_VARIABLE_QUANTIFIERS = 2;
const MAX_UNBOUNDED_QUANTIFIERS = 1;

/** Structural check of a regex source: null when safe, else why not. Exported for tests. */
export function regexHazard(pattern: string): string | null {
  if (pattern.length > GREP_MAX_PATTERN) return 'pattern too long';
  let variable = 0, unbounded = 0;
  let prev = '';            // what the previous token was: 'atom' | 'group-close' | 'class' | 'quant' | ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const n = pattern[i + 1] ?? '';
      if (/[1-9]/.test(n) || n === 'k') return 'backreferences are not supported';
      i++; prev = 'atom'; continue;
    }
    if (c === '[') {                                   // character class: skip to its closing bracket
      let j = i + 1; if (pattern[j] === '^') j++; if (pattern[j] === ']') j++;
      for (; j < pattern.length && pattern[j] !== ']'; j++) if (pattern[j] === '\\') j++;
      i = j; prev = 'class'; continue;
    }
    if (c === '(') {
      if (pattern.startsWith('(?=', i) || pattern.startsWith('(?!', i) || pattern.startsWith('(?<=', i) || pattern.startsWith('(?<!', i)) return 'lookarounds are not supported';
      if (pattern.startsWith('(?:', i)) i += 2;                                                        // non-capturing group
      else if (pattern.startsWith('(?<', i)) { const close = pattern.indexOf('>', i); if (close === -1) return 'invalid group'; i = close; } // named group
      prev = ''; continue;
    }
    if (c === ')') { prev = 'group-close'; continue; }
    let quant: string | null = null;
    if (c === '*' || c === '+' || c === '?') quant = c;
    else if (c === '{') { const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i)); if (m) { quant = m[0]; i += m[0].length - 1; if (m[2] === undefined) quant = 'fixed'; } }
    if (quant) {
      if (prev === 'quant') { if (c === '?' && quant === '?') { continue; } return 'a quantifier cannot follow a quantifier'; } // `*?` / `+?` / `??` are lazy forms
      if (prev === 'group-close') return 'quantified groups are not supported';
      if (prev === '' && !(c === '{' )) return 'nothing to repeat';
      if (quant !== 'fixed') variable++;
      if (quant !== 'fixed' && quant !== '?') unbounded++;
      if (variable > MAX_VARIABLE_QUANTIFIERS) return `at most ${MAX_VARIABLE_QUANTIFIERS} variable-width quantifiers (*, +, ?, {n,m})`;
      if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) return `at most ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifier (*, +, {n,})`;
      prev = 'quant'; continue;
    }
    prev = 'atom';
  }
  return null;
}
/** The compiled pattern, or null when it is too long, structurally unsafe, or not valid regex syntax. */
export function safeRegex(pattern: string, flags = ''): RegExp | null {
  if (regexHazard(pattern) !== null) return null;
  try { return new RegExp(pattern, flags); } catch { return null; }
}
/** Shell glob match (`*` any run, `?` one character, everything else literal), anchored, linear two-pointer scan: no regex. */
export function globMatch(glob: string, name: string): boolean {
  let gi = 0, ni = 0, star = -1, mark = 0;
  while (ni < name.length) {
    const g = gi < glob.length ? glob[gi] : '';
    if (g === '*') { star = gi++; mark = ni; continue; }
    if (g !== '' && (g === '?' || g === name[ni])) { gi++; ni++; continue; }
    if (star !== -1) { gi = star + 1; ni = ++mark; continue; }
    return false;
  }
  while (gi < glob.length && glob[gi] === '*') gi++;
  return gi === glob.length;
}
/** The lines grep scans: at most GREP_MAX_LINES / GREP_MAX_CHARS, each matched on its first LINE_MAX characters. */
function scanLines(text: string): string[] {
  const out: string[] = []; let chars = 0;
  for (const l of text.split('\n')) { if (out.length >= GREP_MAX_LINES || chars >= GREP_MAX_CHARS) break; out.push(l); chars += Math.min(l.length, LINE_MAX) + 1; }
  return out;
}

function grepCmd(ts: TermState, args: string[], stdin: string): string {
  const ignore = flag(args, '-i'); const inv = flag(args, '-v');
  const rest = args.filter(a => !a.startsWith('-'));
  const pattern = rest[0] || '';
  const files = rest.slice(1);
  const text = files.length ? readFiles(ts, files) : stdin;
  const hazard = regexHazard(pattern);
  if (hazard) return `grep: invalid pattern (${hazard})\n`;
  const re = safeRegex(pattern, ignore ? 'i' : '');
  if (!re) return `grep: invalid pattern\n`;
  return scanLines(text).filter(l => re.test(l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l) !== inv && l !== '').join('\n') + '\n';
}
function findCmd(ts: TermState, args: string[]): string {
  const base = resolve(ts, args.find(a => !a.startsWith('-')) || '.');
  const name = opt(args, '-name');
  if (name !== undefined && name.length > GREP_MAX_PATTERN) return `find: -name pattern too long\n`;
  const prefix = base === '/' ? '/' : base + '/';
  return Object.keys(ts.fs).filter(k => (k === base || k.startsWith(prefix)) && ts.fs[k] !== null)
    .filter(k => !name || globMatch(name, k.split('/').pop()!))
    .join('\n') + '\n';
}

// ---------- encoders ----------
function base64Cmd(args: string[], stdin: string): string {
  const decode = flag(args, '-d', '--decode');
  const input = args.filter(a => !a.startsWith('-')).join(' ') || stdin.trim();
  try { return (decode ? Buffer.from(input, 'base64').toString('utf8') : Buffer.from(input, 'utf8').toString('base64')) + '\n'; }
  catch { return 'base64: invalid input\n'; }
}
function jwtCmd(args: string[], ctx: TermCtx, seg: string): string {
  const sub = args[0];
  if (sub === 'decode') {
    const tok = args[1] || '';
    const parts = tok.split('.');
    if (parts.length !== 3) return 'jwt decode <token>\n';
    const dec = (p: string) => { try { return JSON.stringify(JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()), null, 2); } catch { return '(unparseable)'; } };
    return `header:\n${dec(parts[0])}\npayload:\n${dec(parts[1])}\nsignature: ${parts[2]}\n`;
  }
  if (sub === 'sign') {
    // Parse from the raw segment so JSON quotes survive tokenisation.
    const m = seg.match(/^\s*jwt\s+sign\s+(\S+)\s+([\s\S]+?)\s*$/);
    if (!m) return 'jwt sign <secret> \'{"user":"admin","role":"admin"}\'\n';
    const secret = m[1];
    let payloadStr = m[2].trim();
    if ((payloadStr.startsWith("'") && payloadStr.endsWith("'")) || (payloadStr.startsWith('"') && payloadStr.endsWith('"'))) payloadStr = payloadStr.slice(1, -1);
    let payload: any; try { payload = JSON.parse(payloadStr); } catch { return 'jwt: payload must be valid JSON, e.g. {"user":"admin","role":"admin"}\n'; }
    return signJwt(payload, secret) + '\n';
  }
  if (sub === 'verify') {
    return 'jwt verify is done by the target; present the token as a cookie to /admin.\n';
  }
  return 'usage: jwt decode <token> | jwt sign <secret> <json> \n';
}
function digCmd(args: string[]): string {
  const host = args.find(a => !a.startsWith('-')) || TARGET_HOST;
  return `; <<>> DiG (simulated) <<>> ${host}\n;; ANSWER SECTION:\n${host}.\t300\tIN\tA\t10.13.37.10\n`;
}
function pingCmd(args: string[]): string {
  const host = args.find(a => !a.startsWith('-')) || TARGET_HOST;
  return `PING ${host} (10.13.37.10): 56 data bytes\n64 bytes from 10.13.37.10: icmp_seq=0 ttl=117 time=11.8 ms\n--- ${host} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss\n`;
}

// ---------- HTTP tools (thin clients of the target) ----------
function parseUrl(url: string): { path: string; query: string } | null {
  let u = url;
  if (/^https?:\/\//i.test(u)) { const m = u.match(/^https?:\/\/[^/]+(\/[^\s]*)?$/i); u = m?.[1] || '/'; }
  if (!u.startsWith('/')) u = '/' + u;
  const qi = u.indexOf('?');
  return { path: qi === -1 ? u : u.slice(0, qi), query: qi === -1 ? '' : u.slice(qi + 1) };
}
function reqFrom(method: string, url: string, headers: Record<string, string>, cookies: Record<string, string>, body: string): HttpRequest | null {
  const p = parseUrl(url); if (!p) return null;
  return { method, path: p.path, query: p.query, headers, cookies, body };
}
function parseCookieArg(s?: string): Record<string, string> {
  const out: Record<string, string> = {}; if (!s) return out;
  for (const part of s.split(';')) { const i = part.indexOf('='); if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function curlCmd(args: string[], ctx: TermCtx, cmd: string): TermResult {
  const supported = new Set(['-X', '-H', '-d', '--data', '-b', '--cookie', '-c', '-i', '-I', '-L', '-s', '-v', '-k', '-u', '-A']);
  for (const a of args) { if (a.startsWith('-') && !supported.has(a) && !a.startsWith('--data')) return { out: `curl: option ${a} is not supported in this lab.\nSupported: -X -H -d -b -c -i -I -L -s -v -k -u -A\n`, requests: 0 }; }
  const url = args.find(a => !a.startsWith('-') && (a.startsWith('http') || a.startsWith('/'))) || '';
  if (!url) return { out: 'curl: no URL. Try: curl -i ' + TARGET_BASE + '/products\n', requests: 0 };
  const method = (opt(args, '-X') || (flag(args, '-I') ? 'HEAD' : (flag(args, '-d', '--data') ? 'POST' : 'GET'))).toUpperCase();
  const headers: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i] === '-H' && args[i + 1]) { const h = args[i + 1]; const ci = h.indexOf(':'); if (ci > -1) headers[h.slice(0, ci).trim().toLowerCase()] = h.slice(ci + 1).trim(); }
  if (flag(args, '-A')) headers['user-agent'] = opt(args, '-A') || 'curl';
  const data = opt(args, '-d', '--data') || '';
  if (data && !headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
  const cookies = parseCookieArg(opt(args, '-b', '--cookie'));
  const req = reqFrom(method, url, headers, cookies, data);
  if (!req) return { out: 'curl: malformed URL\n', requests: 0 };
  const res = ctx.runRequest(req, 'curl');
  const showHeaders = flag(args, '-i', '-I', '-v');
  let out = '';
  if (showHeaders) { out += `HTTP/1.1 ${res.status} ${res.statusText}\n`; for (const [k, v] of Object.entries(res.headers)) out += `${k}: ${v}\n`; out += '\n'; }
  if (method !== 'HEAD') out += res.body + '\n';
  return { out, requests: 1 };
}
function whatwebCmd(args: string[], ctx: TermCtx): TermResult {
  const url = args.find(a => !a.startsWith('-')) || opt(args, '-h') || TARGET_BASE;
  const req = reqFrom('GET', url, {}, {}, '');
  if (!req) return { out: 'whatweb: bad target\n', requests: 0 };
  const res = ctx.runRequest(req, 'whatweb');
  return { out: `${TARGET_BASE} [${res.status} ${res.statusText}] Server[${res.headers['server'] || '?'}], X-Powered-By[${res.headers['x-powered-by'] || '?'}], HTTPServer, HTML5\n`, requests: 1 };
}
function nmapCmd(args: string[]): TermResult {
  const host = args.find(a => !a.startsWith('-')) || TARGET_HOST;
  const out = `Starting Nmap (simulated) against ${host}\nNmap scan report for ${host} (10.13.37.10)\nHost is up (0.011s latency).\nPORT     STATE SERVICE VERSION\n80/tcp   open  http    AeroCart/1.4 (Express)\n443/tcp  open  https   AeroCart/1.4\nService detection performed.\n`;
  return { out, requests: 0 };
}
function fuzzCmd(ts: TermState, args: string[], ctx: TermCtx, cmd: string): TermResult {
  const url = opt(args, '-u') || args.find(a => a.startsWith('http')) || TARGET_BASE;
  const wl = opt(args, '-w');
  const words = (wl && readFile(ts, wl)) || ['login', 'admin', 'products', 'search', 'account', 'api/order', 'support', 'download', 'robots.txt', 'sitemap.xml', '.env', 'backups'].join('\n');
  const base = url.replace(/\/?FUZZ\/?$/i, '').replace(/\/$/, '');
  let out = `${cmd} :: scanning ${base}/FUZZ (simulated)\n`;
  let requests = 0;
  for (const w of words.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 60)) {
    const req = reqFrom('GET', `${base}/${w}`, {}, {}, '');
    if (!req) continue;
    const res = ctx.runRequest(req, cmd); requests++;
    if (res.status !== 404) out += `${w.padEnd(22)} [Status: ${res.status}, Size: ${res.body.length}]\n`;
  }
  out += ':: done\n';
  return { out, requests };
}
function niktoCmd(args: string[], ctx: TermCtx): TermResult {
  const host = opt(args, '-h') || args.find(a => !a.startsWith('-')) || TARGET_BASE;
  let out = `- Nikto v2.5 (simulated)\n+ Target: ${host}\n`;
  let requests = 0;
  const checks: [string, string][] = [['/robots.txt', 'robots.txt present, lists Disallowed paths'], ['/.env', 'Potentially sensitive file'], ['/download?file=backups/aerocart-db.sql.bak', 'Backup file exposed']];
  for (const [p, note] of checks) { const r = reqFrom('GET', host.replace(/\/$/, '') + p, {}, {}, ''); if (!r) continue; const res = ctx.runRequest(r, 'nikto'); requests++; if (res.status === 200) out += `+ ${p}: ${note} (200)\n`; }
  out += `+ Server leaks version via Server/X-Powered-By headers\n+ Missing security headers (CSP, X-Frame-Options)\n`;
  return { out, requests };
}
function sqlmapCmd(args: string[], ctx: TermCtx): TermResult {
  const url = opt(args, '-u') || '';
  if (!url) return { out: "sqlmap: -u URL is required. e.g. sqlmap -u '" + TARGET_BASE + "/login' --data='username=x&password=y' -p username --batch\n", requests: 0 };
  const data = opt(args, '--data');
  const param = opt(args, '-p') || (data ? 'username' : 'id');
  const cookie = parseCookieArg(opt(args, '--cookie'));
  const dump = flag(args, '--dump') || flag(args, '--dbs') || flag(args, '--tables');
  let requests = 0;
  // Probe with an injection payload on the chosen parameter against the shared handler.
  const inject = "' OR '1'='1'-- -";
  let body = data || '';
  let path = parseUrl(url)!;
  if (data) { const b = new URLSearchParams(data); b.set(param, inject); body = b.toString(); }
  else { const qp = new URLSearchParams(path.query); qp.set(param, '1 UNION SELECT 1,2,3,4'); path = { path: path.path, query: qp.toString() }; }
  const req: HttpRequest = { method: data ? 'POST' : 'GET', path: path.path, query: path.query, headers: data ? { 'content-type': 'application/x-www-form-urlencoded' } : {}, cookies: cookie, body };
  const res = ctx.runRequest(req, 'sqlmap'); requests++;
  let out = `        sqlmap (simulated)\n[*] testing parameter '${param}'\n`;
  const vuln = res.body.includes('bypass') || res.body.includes('Query returned extra columns') || res.status === 200 && /extra columns|bypassed/.test(res.body);
  // Re-check via whether handler flagged injection by inspecting body markers:
  const injected = /authentication bypassed|Query returned extra columns|Welcome,/.test(res.body);
  if (injected) {
    out += `[+] parameter '${param}' appears to be injectable (boolean-based / UNION)\n`;
    if (dump) out += `Database: aerocart\nTable: users\n[4 entries]\n+----+----------+------------------+----------+\n| id | username | password         | role     |\n+----+----------+------------------+----------+\n| 1  | admin    | <hash>           | admin    |\n| 2  | rahul    | <hash>           | customer |\n+----+----------+------------------+----------+\n`;
  } else out += `[-] parameter '${param}' does not appear injectable (is it already fixed?)\n`;
  return { out, requests };
}

function helpText(): string {
  return [
    'ThreatReady lab terminal — supported tools (all operate on the lab target only):',
    '  recon   : whatweb, nmap, dig, ping, ffuf, gobuster, nikto',
    '  http    : curl (-X -H -d -b -c -i -I -L -s -v -k -u -A), http',
    '  exploit : sqlmap (-u --data --cookie -p --dbs --tables --dump --batch)',
    '  crypto  : base64 (-d), jwt (decode|sign)',
    '  files   : ls, cd, pwd, cat, head, tail, grep, find, wc, echo, env',
    '  shell   : history, clear, help',
    '',
    `  Target base URL: ${TARGET_BASE}   (also in $TARGET)`,
    '  Pipes are supported (max 10). No loops, no shell-out, no real network.',
  ].join('\n') + '\n';
}

export const SUPPORTED_COMMANDS = TOOLS;
