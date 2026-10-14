import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { DomainError } from '@threatready/shared';
import type { Request, Response } from 'express';
import multer from 'multer';
import { FilesystemStorageAdapter, type UploadPolicy } from '../adapters/fs-storage.adapter.js';
import { STORAGE_PORT } from '../ports/storage.port.js';
import { Public } from './route.decorator.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 10 } }).single('file');

/**
 * Local-development stand-in for S3 presigned POST/GET. Registered only when STORAGE_DRIVER=fs,
 * which configuration refuses in production. Access is by HMAC-signed policy, like S3.
 */
@Controller('v1/dev-storage')
export class DevStorageController {
  constructor(@Inject(STORAGE_PORT) private readonly storage: FilesystemStorageAdapter) {}

  /** A bad or expired signature is a 403, like S3's AccessDenied. */
  private verified<T>(payload: string, signature: string): T {
    try {
      return this.storage.verify<T>(payload, signature);
    } catch {
      throw new DomainError('AUTH_FORBIDDEN', { message: 'Invalid or expired link' });
    }
  }

  @Post('upload')
  @Public()
  async upload(@Req() req: Request, @Res() res: Response) {
    await new Promise<void>((resolve, reject) => upload(req, res, (err: unknown) => (err ? reject(new DomainError('RESUME_TOO_LARGE')) : resolve())));
    const body = req.body as Record<string, string>;
    const policy = this.verified<UploadPolicy>(body.policy ?? '', body.signature ?? '');
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
