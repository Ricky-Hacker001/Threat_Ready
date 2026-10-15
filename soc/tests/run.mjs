// Test runner. `node --test tests/*.test.mjs` relies on the shell to expand
// the glob, which Windows cmd.exe does not do, and Node only accepts glob
// patterns itself from version 21. Listing the files here works with every
// supported Node version on every platform.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f));
if (!files.length) {
  console.error('No test files found in', dir);
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
