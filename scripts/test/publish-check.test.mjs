// Publish guard (TR-34): the rsync filter drops what must never be published, and the checker
// catches it when it slips through. Run: node --test scripts/test/
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const CHECK = path.join(here, '..', 'publish-check.mjs');
const FILTER = path.join(here, '..', 'publish.rsync-filter');
const check = (dir, ...flags) => spawnSync(process.execPath, [CHECK, ...flags, dir], { encoding: 'utf8' });
const put = (root, rel, body = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' });
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-publish-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** A working tree shaped like this one: nested clones, the licensed model, local secrets and audit notes. */
function workingTree() {
  const root = tmp();
  put(root, 'README.md', '# ThreatReady');
  put(root, '.gitignore', 'node_modules/\ndist/\n.env\n.env.*\n!.env.example\n');
  put(root, 'InterviewPrep/apps/api/assets/interviewer.glb', 'glTF');
  put(root, 'InterviewPrep/.env', 'ANTHROPIC_API_KEY=x');
  put(root, 'InterviewPrep/.env.example', 'ANTHROPIC_API_KEY=');
  put(root, 'InterviewPrep/src/main.ts', 'export {}');
  put(root, 'audit/2026-10-23/FINDINGS.csv', 'id');
  put(root, 'soc/server/index.js', '');
  git(path.join(root, 'soc'), 'init', '-q');
  put(root, 'soc/node_modules/x/index.js', '');
  return root;
}

test('folder mode: every kind of problem is named; templates are fine', () => {
  const root = workingTree();
  const r = check(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /InterviewPrep\/apps\/api\/assets\/interviewer\.glb: licensed 3D model/);
  assert.match(r.stderr, /InterviewPrep\/\.env: environment file/);
  assert.match(r.stderr, /audit: internal audit report/);
  assert.match(r.stderr, /soc: nested git repository/);
  assert.doesNotMatch(r.stderr, /\.env\.example:/);
  assert.doesNotMatch(r.stderr, /node_modules/);
});

test('publishing through the rsync filter gives a clean repository', { skip: spawnSync('rsync', ['--version']).status !== 0 && 'rsync not installed' }, () => {
  const src = workingTree();
  const dest = tmp();
  git(dest, 'init', '-q');
  put(dest, 'stale.txt', 'removed by --delete');
  execFileSync('rsync', ['-a', '--delete', `--filter=merge ${FILTER}`, `${src}/`, `${dest}/`]);
  assert.ok(fs.existsSync(path.join(dest, '.git')), "the destination's own repository is kept");
  assert.ok(!fs.existsSync(path.join(dest, 'stale.txt')));
  assert.ok(!fs.existsSync(path.join(dest, 'soc/.git')));
  assert.ok(!fs.existsSync(path.join(dest, 'InterviewPrep/apps/api/assets/interviewer.glb')));
  assert.ok(!fs.existsSync(path.join(dest, 'InterviewPrep/.env')));
  assert.ok(fs.existsSync(path.join(dest, 'InterviewPrep/.env.example')));
  assert.ok(!fs.existsSync(path.join(dest, 'audit')));
  const r = check(dest, '--published');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK \(git, published mode/);
});

test('git mode: audit/ is expected in the source repository and refused in a published checkout', () => {
  const repo = tmp();
  git(repo, 'init', '-q');
  put(repo, 'README.md', '# ThreatReady');
  put(repo, 'audit/README.md', '# internal');
  put(repo, 'audit/docs/AUDIT_REPORT_2026-10-15.md', 'payloads');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'source tree with audit notes');
  let r = check(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK \(git mode/);
  r = check(repo, '--published');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /audit\/docs\/AUDIT_REPORT_2026-10-15\.md: internal audit report/);
  // Untracked audit material counts too: git would publish it on the next `git add -A`.
  put(repo, 'audit/new.md', 'x');
  assert.match(check(repo, '--published').stderr, /audit\/new\.md: internal audit report/);
  // The other rules apply in both modes.
  put(repo, 'InterviewPrep/.env', 'SECRET=1');
  r = check(repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /InterviewPrep\/\.env: environment file/);
  assert.doesNotMatch(r.stderr, /audit/);
});

test('folder mode (an extracted zip) always refuses audit/', () => {
  const root = tmp();
  put(root, 'README.md', '# ThreatReady');
  put(root, 'audit/README.md', '# internal');
  const r = check(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /audit: internal audit report/);
  assert.equal(check(root, '--published').status, 1);
});

test('git mode: a tracked model, an embedded repository or a gitlink fails; ignored files do not', () => {
  const repo = tmp();
  git(repo, 'init', '-q');
  put(repo, '.gitignore', '.env\n');
  put(repo, '.env', 'SECRET=1');
  put(repo, 'app/index.js', '');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'clean');
  assert.equal(check(repo).status, 0);

  put(repo, 'InterviewPrep/apps/api/assets/interviewer.glb', 'glTF');
  git(repo, 'add', '-A');
  let r = check(repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /interviewer\.glb: licensed 3D model/);
  git(repo, 'rm', '-q', '--cached', 'InterviewPrep/apps/api/assets/interviewer.glb');
  fs.rmSync(path.join(repo, 'InterviewPrep'), { recursive: true });

  const nested = path.join(repo, 'ThreatWall');
  fs.mkdirSync(nested);
  git(nested, 'init', '-q');
  put(repo, 'ThreatWall/index.html', '<!doctype html>');
  git(nested, 'add', '-A');
  git(nested, 'commit', '-qm', 'nested');
  r = check(repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ThreatWall: nested git repository/);
  git(repo, 'add', 'ThreatWall');
  r = check(repo);
  assert.match(r.stderr, /ThreatWall: gitlink to a nested repository/);
  assert.doesNotMatch(r.stderr, /\.env/);
});
