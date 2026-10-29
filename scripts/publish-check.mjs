#!/usr/bin/env node
// Publish guard for the ThreatReady repository (TR-34). Run it on the tree that is about to be pushed
// (the rsync destination, see scripts/publish.rsync-filter), on an extracted zip, and in CI:
//   node scripts/publish-check.mjs [--published] [dir]        (default: the current directory)
// In a git checkout it checks exactly what git would publish: tracked files plus untracked files
// that are not ignored. Elsewhere it walks the folder (skipping node_modules). Exit 1 on a problem.
//
// Never published: nested repositories / gitlinks (the six sub-apps are separate clones), the
// licensed 3D interviewer (any .glb), real environment files, private keys.
//
// The internal audit folder (audit/, see audit/README.md) is tracked in the source repository but must
// not leave it: a folder/zip check always refuses it, and a git checkout refuses it with --published
// (the rsync destination). Without --published a git checkout is the source repository and audit/ is
// expected there (this is what CI runs on every push).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const published = args.includes('--published');
const dirArg = args.find((a) => !a.startsWith('--'));
const root = path.resolve(dirArg ?? '.');
const BIG_FILE_BYTES = 25 * 1024 * 1024;

/** Why a path must not be published, or null. Paths are relative, with forward slashes. `audit/` only when `strict`. */
export function problemWith(rel, strict = true) {
  const base = rel.split('/').pop() ?? '';
  if (/\.glb$/i.test(base)) return 'licensed 3D model (deploy it as a Render Secret File, never commit it)';
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return 'environment file (only .env.example templates are published)';
  if (/\.(pem|p12|pfx)$/i.test(base) || /^id_(rsa|ed25519|ecdsa)/.test(base)) return 'private key or certificate bundle';
  if (strict && (rel === 'audit' || rel.startsWith('audit/'))) return 'internal audit report (describes unfixed vulnerabilities; scripts/publish.rsync-filter drops audit/)';
  return null;
}

const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const declaredSubmodules = () => {
  const file = path.join(root, '.gitmodules');
  if (!fs.existsSync(file)) return new Set();
  return new Set([...fs.readFileSync(file, 'utf8').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1]));
};

function inGit() {
  try { return path.resolve(git('rev-parse', '--show-toplevel').trim()) === root; } catch { return false; }
}

function checkGit(report) {
  const submodules = declaredSubmodules();
  for (const line of git('ls-files', '-s', '-z').split('\0').filter(Boolean)) {
    const [meta, rel] = line.split('\t');
    if (meta.startsWith('160000') && !submodules.has(rel)) report(rel, 'gitlink to a nested repository (not a declared submodule): its files are not published');
  }
  // Untracked files are listed one by one (ignore rules apply); git does not descend into an embedded
  // repository and lists it as "<dir>/" instead.
  const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  for (const entry of files) {
    const rel = entry.replace(/\/$/, '');
    const abs = path.join(root, rel);
    if (entry.endsWith('/') && fs.existsSync(path.join(abs, '.git')) && !submodules.has(rel)) {
      report(rel, 'nested git repository: `git add` would record it as an empty gitlink');
      continue;
    }
    const why = problemWith(rel, published);
    if (why) report(rel, why);
    else if (!entry.endsWith('/')) {
      try { if (fs.statSync(abs).size > BIG_FILE_BYTES) report(rel, `larger than ${BIG_FILE_BYTES / 1024 / 1024} MB`); } catch { /* deleted in the work tree */ }
    }
  }
}

/** Folder walk (no git): everything below root except node_modules; a .git below the root is a nested repository. */
function walk(dir, report) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (e.name === 'node_modules') continue;
    if (e.name === '.git') {
      if (dir !== root) report(path.relative(root, dir).split(path.sep).join('/') || '.', 'nested git repository (.git)');
      continue;
    }
    const why = problemWith(rel);
    if (why) { report(rel, why); continue; }
    if (e.isDirectory()) walk(abs, report);
  }
}

const problems = [];
const report = (rel, why) => problems.push(`${rel}: ${why}`);
if (!fs.existsSync(root)) { console.error(`publish-check: ${root} does not exist`); process.exit(2); }
const mode = inGit() ? 'git' : 'folder';
if (mode === 'git') checkGit(report); else walk(root, report);
const unique = [...new Set(problems)].sort();
if (unique.length) {
  console.error(`publish-check: ${unique.length} problem(s) in ${root} (${mode} mode):`);
  for (const p of unique) console.error(`  - ${p}`);
  console.error('Fix: publish with scripts/publish.rsync-filter (README.md, "Publishing to GitHub").');
  process.exit(1);
}
console.log(`publish-check: OK (${mode}${mode === 'git' && published ? ', published' : ''} mode, ${root})`);
