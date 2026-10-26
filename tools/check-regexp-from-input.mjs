#!/usr/bin/env node
/**
 * ReDoS lint: finds regular expressions that are built from something other than a literal.
 * Dependency-free (node:fs / node:path only) so it runs in every package and in CI without installs.
 *
 *   node tools/check-regexp-from-input.mjs                 # every server source dir (see DEFAULT_TARGETS)
 *   node tools/check-regexp-from-input.mjs server          # one dir or file (relative to the cwd), repeatable
 *   node tools/check-regexp-from-input.mjs --allowlist tools/regexp-allowlist.txt src
 *   node tools/check-regexp-from-input.mjs --json ...      # machine-readable findings
 *
 * Exit 1 when at least one finding is not allowlisted. Findings are printed as `file:line: rule — detail`.
 *
 * Heuristic (deliberately narrow, to keep false positives low):
 *   R1  `new RegExp(x)` / `RegExp(x)` whose FIRST argument is not a string literal ('…' / "…"), a template
 *       literal WITHOUT `${…}`, or a regex literal (/…/). An interpolated template (`^${name}=`) counts as
 *       non-literal because the interpolated value may come from a request. Comments and string contents
 *       are masked before matching, so `// new RegExp(x)` is ignored.
 *   R2  A regex-taking string method whose REGEX ARGUMENT is a variable with an input-ish name:
 *       `.match(p)`, `.matchAll(p)`, `.search(p)`, `.split(p)`, `.replace(p, …)`, `.replaceAll(p, …)`
 *       with p ∈ {pattern, input, query, q, needle, userInput} (also `req.query.x`-style member chains that
 *       END in one of those names, e.g. `body.pattern`). `.split('x')` or `.replace(/re/g, …)` are literals
 *       and never flagged.
 *   R3  `p.test(…)` / `p.exec(…)` where the RECEIVER (the regex) is one of those names. The argument of
 *       `.test()` is the subject string, not the regex, so `SAFE_RE.test(input)` is NOT flagged.
 *
 * Not detected (by design — a scanner without a parser cannot see data flow): a regex compiled from a
 * variable with another name, regexes built in a helper and returned, or `RegExp` reached via an alias.
 * Review any new `new RegExp(` by hand; the allowlist documents the reviewed sites.
 *
 * Allowlist file: one entry per line, `path:line  justification`, `#` comments. Paths are relative to the
 * repo root (parent of tools/), forward slashes. An entry whose line no longer produces a finding is
 * reported as "stale" (informational, exit code unaffected) so the list does not rot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ALLOWLIST = path.join(REPO_ROOT, 'tools', 'regexp-allowlist.txt');
/** Every server-side source directory (anything that handles a request), plus the gateway/launcher. */
export const DEFAULT_TARGETS = [
  'threatready-lab-001/server',
  'attack-reasoning/server',
  'red_team_lab/web/server',
  'soc/server',
  'InterviewPrep/apps/api/src',
  'Threatready-landing-page-main/apps/api/src',
  'deploy/*.mjs',
];
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const INPUT_NAMES = ['pattern', 'input', 'query', 'q', 'needle', 'userInput'];

// ---------- file discovery ----------
function* walk(target) {
  const st = fs.statSync(target, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) { if (EXTENSIONS.has(path.extname(target))) yield target; return; }
  for (const ent of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) yield* walk(path.join(target, ent.name)); }
    else if (ent.isFile() && EXTENSIONS.has(path.extname(ent.name))) yield path.join(target, ent.name);
  }
}
/** Expands a `dir/*.ext` glob (one level, `*` only) or returns the path as is. */
function expand(spec) {
  const base = path.basename(spec);
  if (!base.includes('*')) return [spec];
  const dir = path.dirname(spec);
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp('^' + base.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('.*') + '$');
  return fs.readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n));
}

// ---------- masking: blank out comments and string/template/regex contents, keep positions ----------
const REGEX_PREFIX = /[(,=:[!&|?{};+\-*%<>~^]$|^$|\b(return|typeof|case|in|of|do|else|yield|await|throw|void|delete|new)$/;
export function mask(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let lastCode = ''; // last significant code token (for regex-literal detection)
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      blank(i + 1, j); i = j + 1; lastCode = c; continue;
    }
    if (c === '`') {
      // Keep `${` / `}` markers so callers can tell an interpolated template from a constant one.
      let j = i + 1, depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '}') { depth--; j++; continue; }
        j++;
      }
      for (let k = i + 1; k < j; k++) {
        const ch = src[k];
        const keep = (ch === '$' && src[k + 1] === '{') || (ch === '{' && src[k - 1] === '$') || ch === '}' || ch === '\n';
        if (!keep) out[k] = ' ';
      }
      i = j + 1; lastCode = '`'; continue;
    }
    if (c === '/' && REGEX_PREFIX.test(lastCode)) {
      // regex literal: scan to the closing unescaped `/` outside a character class
      let j = i + 1, inClass = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true; else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j++;
      }
      blank(i + 1, j); i = j + 1; lastCode = '/'; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    // accumulate identifier tokens; single punctuation otherwise
    if (/[A-Za-z0-9_$]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++; lastCode = src.slice(i, j); i = j; continue; }
    lastCode = c; i++;
  }
  return out.join('');
}

// ---------- rules ----------
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const NAME_ALT = INPUT_NAMES.join('|');
const ARG_METHODS = /\.(match|matchAll|search|split|replace|replaceAll)\(\s*((?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:PATTERN))\s*[,)]/g;
const RECV_METHODS = /(?<![\w$.])((?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:PATTERN))\s*\.\s*(test|exec)\s*\(/g;
const argRe = () => new RegExp(ARG_METHODS.source.replace('PATTERN', NAME_ALT), 'g');
const recvRe = () => new RegExp(RECV_METHODS.source.replace('PATTERN', NAME_ALT), 'g');

export function scanSource(src) {
  const findings = [];
  const code = mask(src);
  // R1: RegExp constructor / call with a non-literal first argument
  const ctor = /(?<![\w$.])(?:new\s+)?RegExp\s*\(/g;
  let m;
  while ((m = ctor.exec(code))) {
    let j = m.index + m[0].length;
    while (j < code.length && /\s/.test(code[j])) j++;
    const ch = code[j];
    if (ch === ')') continue; // RegExp() — empty, harmless
    if (ch === '\'' || ch === '"' || ch === '/') continue; // string / regex literal
    if (ch === '`') {
      const end = code.indexOf('`', j + 1);
      const body = code.slice(j + 1, end === -1 ? code.length : end);
      if (!body.includes('${')) continue; // constant template
      findings.push({ line: lineOf(code, m.index), rule: 'R1', detail: 'RegExp built from an interpolated template literal: ' + snippet(src, m.index) });
      continue;
    }
    findings.push({ line: lineOf(code, m.index), rule: 'R1', detail: 'RegExp built from a non-literal: ' + snippet(src, m.index) });
  }
  // R2: regex-taking method whose pattern argument is an input-ish variable
  const a = argRe();
  while ((m = a.exec(code))) findings.push({ line: lineOf(code, m.index), rule: 'R2', detail: `.${m[1]}(${m[2].replace(/\s+/g, '')}) — pattern argument named like user input: ` + snippet(src, m.index) });
  // R3: test/exec on a regex held in an input-ish variable
  const r = recvRe();
  while ((m = r.exec(code))) findings.push({ line: lineOf(code, m.index), rule: 'R3', detail: `${m[1].replace(/\s+/g, '')}.${m[2]}() — regex receiver named like user input: ` + snippet(src, m.index) });
  findings.sort((x, y) => x.line - y.line);
  return findings;
}
function snippet(src, idx) {
  const start = src.lastIndexOf('\n', idx) + 1;
  let end = src.indexOf('\n', idx); if (end === -1) end = src.length;
  const line = src.slice(start, end).trim();
  return line.length > 140 ? line.slice(0, 137) + '...' : line;
}

// ---------- allowlist ----------
export function readAllowlist(file) {
  const entries = new Map(); // "path:line" -> { justification, used }
  if (!file || !fs.existsSync(file)) return entries;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?):(\d+)\s+(.+)$/.exec(line);
    if (!m) { console.error(`allowlist: cannot parse "${line}" (expected path:line justification)`); process.exitCode = 1; continue; }
    entries.set(`${m[1].replace(/\\/g, '/')}:${m[2]}`, { justification: m[3], used: false });
  }
  return entries;
}

// ---------- main ----------
export function run(argv, { cwd = process.cwd(), log = console.log, err = console.error } = {}) {
  let allowlistFile = DEFAULT_ALLOWLIST;
  let json = false;
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allowlist') allowlistFile = path.resolve(cwd, argv[++i]);
    else if (a === '--no-allowlist') allowlistFile = null;
    else if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') { log(HELP); return 0; }
    else targets.push(path.resolve(cwd, a));
  }
  const specs = targets.length ? targets : DEFAULT_TARGETS.map((t) => path.join(REPO_ROOT, t));
  const files = [];
  for (const s of specs) for (const p of expand(s)) files.push(...walk(p));
  if (files.length === 0) { err(`check-regexp-from-input: no source files under ${specs.join(', ')}`); return 1; }

  const allow = readAllowlist(allowlistFile);
  const rel = (f) => path.relative(REPO_ROOT, f).split(path.sep).join('/');
  const all = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const fnd of scanSource(src)) {
      const key = `${rel(f)}:${fnd.line}`;
      const entry = allow.get(key);
      if (entry) entry.used = true;
      all.push({ file: rel(f), ...fnd, allowed: !!entry, justification: entry?.justification });
    }
  }
  const failing = all.filter((x) => !x.allowed);
  const stale = [...allow].filter(([, e]) => !e.used).map(([k]) => k);
  if (json) { log(JSON.stringify({ files: files.length, findings: all, stale }, null, 2)); return failing.length ? 1 : 0; }
  for (const x of all.filter((y) => y.allowed)) log(`${x.file}:${x.line}: allowed (${x.rule}) — ${x.justification}`);
  for (const x of failing) err(`${x.file}:${x.line}: ${x.rule} — ${x.detail}`);
  for (const k of stale) log(`note: allowlist entry ${k} matched no finding (stale line number, or the site is regex-free)`);
  log(`check-regexp-from-input: ${files.length} files, ${all.length} finding(s), ${failing.length} not allowlisted`);
  return failing.length ? 1 : 0;
}

const HELP = `usage: node tools/check-regexp-from-input.mjs [--allowlist FILE | --no-allowlist] [--json] [DIR|FILE|DIR/*.ext ...]
Defaults: targets = ${DEFAULT_TARGETS.join(', ')}; allowlist = tools/regexp-allowlist.txt`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2)) || process.exitCode || 0;
}
