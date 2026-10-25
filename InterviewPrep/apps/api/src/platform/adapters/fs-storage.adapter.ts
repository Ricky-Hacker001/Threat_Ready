import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PortError } from '@threatready/shared';
import type { SignedPost, StoragePort, UploadRule } from '../ports/storage.port.js';

/**
 * Upload policies and download tokens are signed with the purpose in the MAC input (`put.` / `get.`)
 * and carry it in the payload, so a download link can never be replayed as an upload policy or the
 * reverse (audit 2026-10-23 TR-35).
 */
export interface UploadPolicy {
  typ: 'put';
  key: string;
  contentType: string;
  maxBytes: number;
  exp: number;
}

export interface DownloadToken {
  typ: 'get';
  key: string;
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
    const policy: UploadPolicy = { typ: 'put', key, contentType: rule.contentType, maxBytes: rule.maxBytes, exp: Date.now() + rule.ttlSec * 1000 };
    const encoded = Buffer.from(JSON.stringify(policy)).toString('base64url');
    const query = new URLSearchParams({ policy: encoded, signature: this.sign('put', encoded), expires: String(policy.exp) });
    return {
      url: `${this.apiBaseUrl}/v1/dev-storage/upload?${query}`,
      fields: { key, 'Content-Type': rule.contentType },
      expiresAt: new Date(policy.exp),
    };
  }

  async getUrl(key: string, ttlSec: number): Promise<string> {
    const token: DownloadToken = { typ: 'get', key, exp: Date.now() + ttlSec * 1000 };
    const payload = Buffer.from(JSON.stringify(token)).toString('base64url');
    return `${this.apiBaseUrl}/v1/dev-storage/object?t=${payload}&s=${this.sign('get', payload)}`;
  }

  verify<T>(payload: string, signature: string, typ: 'put' | 'get'): T {
    if (typeof payload !== 'string' || typeof signature !== 'string' || payload.length > 4096 || signature.length > 128) throw new PortError('auth', 'bad signature', { retryable: false });
    const expected = Buffer.from(this.sign(typ, payload));
    const got = Buffer.from(signature);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new PortError('auth', 'bad signature', { retryable: false });
    let value: T & { exp: number; typ?: unknown };
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as T & { exp: number; typ?: unknown };
    } catch {
      throw new PortError('auth', 'bad signature', { retryable: false });
    }
    if (value?.typ !== typ) throw new PortError('auth', 'wrong token type', { retryable: false });
    if (typeof value.exp !== 'number' || value.exp < Date.now()) throw new PortError('auth', 'expired', { retryable: false });
    return value;
  }

  /** Where uploads stream to before they are moved into place (same filesystem, so the move is a rename). */
  incomingDir(): string {
    return path.join(path.resolve(this.root), '.incoming');
  }

  /**
   * Removes partial uploads left in incomingDir() (a connection cut off, a body refused part-way)
   * older than `olderThan`. Returns how many were removed.
   */
  async sweepIncoming(olderThan: Date): Promise<number> {
    const dir = this.incomingDir();
    const names = await readdir(dir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      const s = await stat(file).catch(() => null);
      if (!s?.isFile() || s.mtime >= olderThan) continue;
      await rm(file, { force: true }).catch(() => undefined);
      removed++;
    }
    return removed;
  }

  /** Moves a fully received upload from incomingDir() to its key. */
  async putFile(key: string, tmpPath: string): Promise<void> {
    if (path.dirname(path.resolve(tmpPath)) !== this.incomingDir()) throw new PortError('bad_request', 'invalid upload path', { retryable: false });
    await mkdir(path.dirname(this.file(key)), { recursive: true });
    await rename(tmpPath, this.file(key));
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

  private sign(typ: 'put' | 'get', payload: string): string {
    return createHmac('sha256', this.secret).update(`${typ}.${payload}`).digest('base64url');
  }

  private file(key: string): string {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) throw new PortError('bad_request', 'invalid key', { retryable: false });
    return resolved;
  }
}
