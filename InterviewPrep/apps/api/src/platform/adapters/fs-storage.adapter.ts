import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PortError } from '@threatready/shared';
import type { SignedPost, StoragePort, UploadRule } from '../ports/storage.port.js';

export interface UploadPolicy {
  key: string;
  contentType: string;
  maxBytes: number;
  exp: number;
}

/**
 * Local-development StoragePort (ADD LLD-2). Mimics S3 presigned POST and GET with HMAC-signed
 * tokens served by DevStorageController. Refused in production by config validation.
 */
export class FilesystemStorageAdapter implements StoragePort {
  constructor(
    private readonly root: string,
    private readonly apiBaseUrl: string,
    private readonly secret: string,
  ) {}

  /**
   * The signed policy travels in the URL's query string, not the multipart body, so the upload
   * endpoint verifies the signature and expiry before it reads a single byte of the file.
   */
  async putUrl(key: string, rule: UploadRule): Promise<SignedPost> {
    const policy: UploadPolicy = { key, contentType: rule.contentType, maxBytes: rule.maxBytes, exp: Date.now() + rule.ttlSec * 1000 };
    const encoded = Buffer.from(JSON.stringify(policy)).toString('base64url');
    const query = new URLSearchParams({ policy: encoded, signature: this.sign(encoded), expires: String(policy.exp) });
    return {
      url: `${this.apiBaseUrl}/v1/dev-storage/upload?${query}`,
      fields: { key, 'Content-Type': rule.contentType },
      expiresAt: new Date(policy.exp),
    };
  }

  async getUrl(key: string, ttlSec: number): Promise<string> {
    const payload = Buffer.from(JSON.stringify({ key, exp: Date.now() + ttlSec * 1000 })).toString('base64url');
    return `${this.apiBaseUrl}/v1/dev-storage/object?t=${payload}&s=${this.sign(payload)}`;
  }

  verify<T>(payload: string, signature: string): T {
    if (typeof payload !== 'string' || typeof signature !== 'string' || payload.length > 4096 || signature.length > 128) throw new PortError('auth', 'bad signature', { retryable: false });
    const expected = Buffer.from(this.sign(payload));
    const got = Buffer.from(signature);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new PortError('auth', 'bad signature', { retryable: false });
    let value: T & { exp: number };
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as T & { exp: number };
    } catch {
      throw new PortError('auth', 'bad signature', { retryable: false });
    }
    if (typeof value?.exp !== 'number' || value.exp < Date.now()) throw new PortError('auth', 'expired', { retryable: false });
    return value;
  }

  async move(from: string, to: string): Promise<void> {
    await mkdir(path.dirname(this.file(to)), { recursive: true });
    await rename(this.file(from), this.file(to)).catch((cause) => {
      throw new PortError('not_found', 'object missing', { retryable: false, cause });
    });
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const s = await stat(this.file(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer> {
    const head = await this.head(key);
    if (!head) throw new PortError('not_found', 'object missing', { retryable: false });
    if (head.size > maxBytes) throw new PortError('bad_request', 'object larger than allowed', { retryable: false });
    return readFile(this.file(key));
  }

  async put(key: string, body: Buffer): Promise<void> {
    await mkdir(path.dirname(this.file(key)), { recursive: true });
    await writeFile(this.file(key), body);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  private file(key: string): string {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) throw new PortError('bad_request', 'invalid key', { retryable: false });
    return resolved;
  }
}
