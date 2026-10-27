import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.APP_ROLE = 'api';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://threatready:threatready@localhost:55432/threatready_test';
process.env.APP_ORIGIN = 'http://localhost:5173';
process.env.API_BASE_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.INTERNAL_API_TOKEN = 'test-internal-token-test-internal-token-0123';
// Every request resolves identity afresh, so revocation tests see it immediately.
process.env.IDENTITY_CACHE_SECONDS = '0';
process.env.STORAGE_DRIVER = 'fs';
process.env.FS_STORAGE_DIR = path.join(os.tmpdir(), `tr-test-storage-${process.pid}`);
process.env.LLM_DRIVER = 'fake';
process.env.EMAIL_DRIVER = 'log';
process.env.REPORT_EMAIL_ENABLED = 'true';
// The pool refill is exercised by its own test; elsewhere one start means at most one generation.
process.env.REASONING_POOL_ENABLED = 'false';
// The random audit of single-pass evaluations (REASONING_ESCALATION_AUDIT_RATE) would make which answers
// escalate depend on Math.random; its own tests set a rate and an injected rng.
process.env.REASONING_ESCALATION_AUDIT_RATE = '0';
// The suites open many questions per learner within a day; the production default (12, review AR-SEC-2)
// is asserted in reasoning.unit.test.ts and the bound itself in reasoning-library.e2e.test.ts.
process.env.REASONING_USER_DAILY_QUESTIONS = '40';
