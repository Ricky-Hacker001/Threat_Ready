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
// Pre-generation is exercised by its own tests; elsewhere one start means one generation.
process.env.REASONING_PREFETCH_ENABLED = 'false';
