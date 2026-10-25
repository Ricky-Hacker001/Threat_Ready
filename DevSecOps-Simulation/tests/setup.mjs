// Test harness for the lab's TypeScript sources with Node's own test runner (no extra dependencies):
//   node --import ./tests/setup.mjs --test tests/
// Node strips the types itself; these in-process hooks add what Vite would: extensionless relative imports
// resolve to .ts files, and `import.meta.env` reads globalThis.__VITE_ENV__ (set it before importing a module;
// a `?fresh=<n>` query on the import gives a new module instance with its own state).
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

globalThis.__VITE_ENV__ ??= { BASE_URL: '/', DEV: false, PROD: true, MODE: 'test' };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith('file:') && !/\.[cm]?[jt]sx?(\?.*)?$/.test(specifier)) {
      for (const ext of ['.ts', '/index.ts']) {
        const url = new URL(specifier + ext, context.parentURL);
        if (fs.existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url.split('?')[0]) : '';
    if (!file.endsWith('.ts')) return nextLoad(url, context);
    const src = fs.readFileSync(file, 'utf8').replace(/\bimport\.meta\.env\b/g, 'globalThis.__VITE_ENV__');
    return { format: 'module', source: stripTypeScriptTypes(src, { mode: 'transform' }), shortCircuit: true };
  },
});
