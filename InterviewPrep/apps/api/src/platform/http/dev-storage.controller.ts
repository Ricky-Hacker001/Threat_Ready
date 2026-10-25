import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { jobDescriptions, resumes } from '@threatready/db';
import { DomainError, PortError } from '@threatready/shared';
import { and, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import multer from 'multer';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { FilesystemStorageAdapter, type DownloadToken, type UploadPolicy } from '../adapters/fs-storage.adapter.js';
import { Database } from '../db/database.js';
import { CACHE_PORT, type CachePort } from '../ports/cache.port.js';
import { STORAGE_PORT } from '../ports/storage.port.js';
import { Public } from './route.decorator.js';
import { clientKeyOf, rateLimitedError } from './route.guard.js';

const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
/** Multipart framing allowance over the policy's file size before the body is even read. */
const MULTIPART_OVERHEAD = 64 * 1024;
/** Window for counting failed signature checks per client address. */
const FAILURE_WINDOW_SEC = 600;
/** An upload that has not finished in this time is cut off, so stalled connections cannot hold the slots. */
const UPLOAD_TIMEOUT_MS = 120_000;

type MulterFile = { path: string; size: number };

/**
 * Local-development stand-in for S3 presigned POST/GET. Registered only when STORAGE_DRIVER=fs, which
 * production accepts only with ALLOW_EPHEMERAL_STORAGE=true (the Render demo), so this endpoint IS
 * internet-reachable there. Access is by HMAC-signed policy, like S3.
 *
 * Order of checks on upload, all before a byte of the body is read:
 *  1. the signed policy and its expiry from the query string. Only failures count against the
 *     client's address (INTERVIEW_UPLOAD_FAILURES_PER_IP per 10 minutes): learners behind one NAT
 *     upload with their own links and never share a budget (audit 2026-10-23 IP-REG4);
 *  2. the link is still unused: its document is awaiting its upload (single use, TR-35), and no other
 *     upload with the same link is running;
 *  3. a declared Content-Length within the policy (413 at once). A chunked body (an edge proxy may
 *     re-frame one) is bounded the same way while it streams: multer stops at the policy's size;
 *  4. a free upload slot (INTERVIEW_UPLOAD_CONCURRENCY, else 503 with Retry-After).
 * The body then streams to disk with multer limits taken from the policy, never into memory.
 */
@Controller('v1/dev-storage')
export class DevStorageController {
  private readonly uploading = new Set<string>();
  private active = 0;

  constructor(
    @Inject(STORAGE_PORT) private readonly storage: FilesystemStorageAdapter,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * A bad or expired signature is a 403, like S3's AccessDenied. Repeated failures from one address
   * become 429 for the rest of the window.
   */
  private async verified<T>(req: Request, payload: unknown, signature: unknown, typ: 'put' | 'get'): Promise<T> {
    try {
      return this.storage.verify<T>(String(payload ?? ''), String(signature ?? ''), typ);
    } catch {
      const limit = this.cfg.INTERVIEW_UPLOAD_FAILURES_PER_IP * this.cfg.RATE_LIMIT_SCALE;
      if (limit > 0) {
        const key = `rl:ip:${clientKeyOf(this.cfg, req.headers, req.ip)}:dev_storage_bad`;
        const count = await this.cache.incr(key, FAILURE_WINDOW_SEC);
        if (count > limit) throw rateLimitedError((await this.cache.ttl(key)) ?? FAILURE_WINDOW_SEC, 'storage_link');
      }
      throw new DomainError('AUTH_FORBIDDEN', { message: 'Invalid or expired link' });
    }
  }

  /** Single use: the link is good only while its document is still waiting for the file. */
  private async awaitingUpload(key: string): Promise<boolean> {
    return this.db.system(async ({ db }) => {
      for (const table of [resumes, jobDescriptions]) {
        const [row] = await db
          .select({ id: table.id })
          .from(table)
          .where(and(eq(table.objectKey, key), eq(table.status, 'awaiting_upload')))
          .limit(1);
        if (row) return true;
      }
      return false;
    });
  }

  @Post('upload')
  @Public()
  async upload(@Req() req: Request, @Res() res: Response) {
    const policy = await this.verified<UploadPolicy>(req, req.query.policy, req.query.signature, 'put');
    if (typeof policy.key !== 'string' || typeof policy.contentType !== 'string' || !Number.isFinite(policy.maxBytes) || policy.maxBytes <= 0) {
      throw new DomainError('AUTH_FORBIDDEN', { message: 'Invalid or expired link' });
    }
    const maxBytes = Math.min(policy.maxBytes, MAX_UPLOAD_BYTES);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes + MULTIPART_OVERHEAD) throw new DomainError('RESUME_TOO_LARGE');
    if (this.uploading.has(policy.key) || !(await this.awaitingUpload(policy.key))) throw new DomainError('STORAGE_UPLOAD_CONFLICT');
    const slots = this.cfg.INTERVIEW_UPLOAD_CONCURRENCY;
    if (slots > 0 && this.active >= slots) {
      throw new DomainError('STORAGE_UNAVAILABLE', { message: 'Uploads are busy; try again in a few seconds', retryAfterSec: 5, details: { reason: 'busy' } });
    }

    this.uploading.add(policy.key);
    this.active += 1;
    let file: MulterFile | undefined;
    try {
      const incoming = this.storage.incomingDir();
      await mkdir(incoming, { recursive: true });
      const parse = multer({
        storage: multer.diskStorage({ destination: incoming, filename: (_req, _file, cb) => cb(null, randomUUID()) }),
        limits: { fileSize: maxBytes, files: 1, fields: 4, fieldSize: 1024, fieldNameSize: 100, parts: 6, headerPairs: 50 },
      }).single('file');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          req.destroy();
          reject(new DomainError('STORAGE_UPLOAD_EXPIRED', { message: 'The upload took too long; start it again' }));
        }, UPLOAD_TIMEOUT_MS);
        // Bodies without a Content-Length (chunked) are counted as they arrive: past the policy size the
        // answer is 413 at once and the connection is closed, instead of multer draining the rest.
        let received = 0;
        const onData = (c: Buffer) => {
          received += c.length;
          if (received <= maxBytes + MULTIPART_OVERHEAD) return;
          req.off('data', onData);
          clearTimeout(timer);
          res.setHeader('Connection', 'close');
          res.once('finish', () => req.destroy());
          reject(new DomainError('RESUME_TOO_LARGE'));
        };
        req.on('data', onData);
        parse(req, res, (err: unknown) => {
          req.off('data', onData);
          clearTimeout(timer);
          if (!err) return resolve();
          const code = (err as { code?: string }).code;
          reject(new DomainError(code === 'LIMIT_FILE_SIZE' ? 'RESUME_TOO_LARGE' : 'VALIDATION_FAILED', { message: code === 'LIMIT_FILE_SIZE' ? undefined : 'The upload form is not valid' }));
        });
      });
      const body = (req.body ?? {}) as Record<string, string>;
      file = (req as Request & { file?: MulterFile }).file;
      if (!file || body.key !== policy.key) throw new DomainError('VALIDATION_FAILED');
      if (body['Content-Type'] !== policy.contentType) throw new DomainError('RESUME_UNSUPPORTED_TYPE');
      if (file.size > maxBytes) throw new DomainError('RESUME_TOO_LARGE');
      await this.storage.putFile(policy.key, file.path);
      file = undefined; // moved into place
    } finally {
      this.uploading.delete(policy.key);
      this.active -= 1;
      if (file) await rm(file.path, { force: true }).catch(() => undefined);
    }
    res.status(204).end();
  }

  @Get('object')
  @Public()
  async object(@Req() req: Request, @Query('t') t: string, @Query('s') s: string, @Res() res: Response) {
    const { key } = await this.verified<DownloadToken>(req, t ?? '', s ?? '', 'get');
    let buf: Buffer;
    try {
      buf = await this.storage.read(key, 20 * 1024 * 1024);
    } catch (err) {
      // The file is gone (instance restart wiped local storage, or retention removed it): a 404, not a 500.
      if (err instanceof PortError && err.kind === 'not_found') throw new DomainError('STORAGE_OBJECT_NOT_FOUND');
      throw err;
    }
    res.setHeader('Content-Type', key.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="threatready-interview-report.pdf"');
    res.send(buf);
  }
}
