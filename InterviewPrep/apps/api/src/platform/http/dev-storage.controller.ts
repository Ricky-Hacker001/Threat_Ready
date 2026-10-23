import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { DomainError } from '@threatready/shared';
import type { Request, Response } from 'express';
import multer from 'multer';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { FilesystemStorageAdapter, type UploadPolicy } from '../adapters/fs-storage.adapter.js';
import { CACHE_PORT, type CachePort } from '../ports/cache.port.js';
import { STORAGE_PORT } from '../ports/storage.port.js';
import { Public } from './route.decorator.js';

const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
/** Multipart framing allowance over the policy's file size before the body is even read. */
const MULTIPART_OVERHEAD = 64 * 1024;
/** Unauthenticated uploads per client IP per window: a signed link is per document, 10 per user-hour. */
const UPLOAD_RATE = { limit: 20, windowSec: 600 };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } }).single('file');

/**
 * Local-development stand-in for S3 presigned POST/GET. Registered only when STORAGE_DRIVER=fs, which
 * production accepts only with ALLOW_EPHEMERAL_STORAGE=true (the Render demo), so this endpoint IS
 * internet-reachable there. Access is by HMAC-signed policy, like S3.
 *
 * Order of checks on upload: IP rate limit, then the signed policy and its expiry from the query
 * string, then a Content-Length sanity check, and only then is the multipart body read into memory.
 * Nothing is buffered for a request that cannot pass.
 */
@Controller('v1/dev-storage')
export class DevStorageController {
  constructor(
    @Inject(STORAGE_PORT) private readonly storage: FilesystemStorageAdapter,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** A bad or expired signature is a 403, like S3's AccessDenied. */
  private verified<T>(payload: unknown, signature: unknown): T {
    try {
      return this.storage.verify<T>(String(payload ?? ''), String(signature ?? ''));
    } catch {
      throw new DomainError('AUTH_FORBIDDEN', { message: 'Invalid or expired link' });
    }
  }

  /** The visitor's IP: the trusted gateway header when configured, else Express's req.ip (trust proxy 1). */
  private clientIp(req: Request): string {
    const header = this.cfg.CLIENT_IP_HEADER ? req.headers[this.cfg.CLIENT_IP_HEADER.toLowerCase()] : undefined;
    const fromHeader = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
    return fromHeader || req.ip || req.socket?.remoteAddress || 'unknown';
  }

  @Post('upload')
  @Public()
  async upload(@Req() req: Request, @Res() res: Response) {
    const count = await this.cache.incr(`rl:ip:${this.clientIp(req)}:dev_upload`, UPLOAD_RATE.windowSec);
    if (count > UPLOAD_RATE.limit * this.cfg.RATE_LIMIT_SCALE) {
      res.setHeader('Retry-After', String(UPLOAD_RATE.windowSec));
      throw new DomainError('RATE_LIMITED');
    }
    const policy = this.verified<UploadPolicy>(req.query.policy, req.query.signature);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > Math.min(policy.maxBytes, MAX_UPLOAD_BYTES) + MULTIPART_OVERHEAD) throw new DomainError('RESUME_TOO_LARGE');

    await new Promise<void>((resolve, reject) => upload(req, res, (err: unknown) => (err ? reject(new DomainError('RESUME_TOO_LARGE')) : resolve())));
    const body = (req.body ?? {}) as Record<string, string>;
    const file = (req as Request & { file?: { buffer: Buffer; size: number } }).file;
    if (!file || body.key !== policy.key) throw new DomainError('VALIDATION_FAILED');
    if (body['Content-Type'] !== policy.contentType) throw new DomainError('RESUME_UNSUPPORTED_TYPE');
    if (file.size > policy.maxBytes) throw new DomainError('RESUME_TOO_LARGE');
    await this.storage.put(policy.key, file.buffer);
    res.status(204).end();
  }

  @Get('object')
  @Public()
  async object(@Query('t') t: string, @Query('s') s: string, @Res() res: Response) {
    const { key } = this.verified<{ key: string }>(t ?? '', s ?? '');
    const buf = await this.storage.read(key, 20 * 1024 * 1024);
    res.setHeader('Content-Type', key.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="threatready-interview-report.pdf"');
    res.send(buf);
  }
}
