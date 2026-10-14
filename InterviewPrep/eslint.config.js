import globals from 'globals';
import tseslint from 'typescript-eslint';

const VENDOR_SDKS = ['@anthropic-ai/sdk', '@aws-sdk/*', 'pg-boss', 'better-auth', 'better-auth/*'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'apps/web/public/**', 'packages/db/migrations/**'] },
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
  {
    // ADD §6 boundary rule: domain modules import ports, never a vendor SDK.
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: VENDOR_SDKS, message: 'Domain modules use ports; vendor SDKs belong in platform/adapters.' }] }],
    },
  },
  {
    // The browser never talks to the LLM, storage or the database directly.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@anthropic-ai/*', '@aws-sdk/*', 'pg', 'drizzle-orm', '@threatready/db'], message: 'Not allowed in the browser bundle.' }] }],
    },
  },
  {
    files: ['**/test/**', '**/scripts/**'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
