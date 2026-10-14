import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PortError } from '@threatready/shared';
import type { SignedPost, StoragePort, UploadRule } from '../ports/storage.port.js';

/**
 * Private bucket in ap-south-1 (L10): Block Public Access on, KMS default encryption, versioning
 * for reports, lifecycle on quarantine/ (configured in OpenTofu). Credentials come from the task
 * role; there is no key in configuration.
 */
export class S3StorageAdapter implements StoragePort {
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.s3 = new S3Client({ region });
  }

  async putUrl(key: string, rule: UploadRule): Promise<SignedPost> {
    try {
      const { url, fields } = await createPresignedPost(this.s3, {
        Bucket: this.bucket,
        Key: key,
        Expires: rule.ttlSec,
        Conditions: [
          ['content-length-range', 1, rule.maxBytes],
          ['eq', '$Content-Type', rule.contentType],
        ],
        Fields: { 'Content-Type': rule.contentType },
      });
      return { url, fields, expiresAt: new Date(Date.now() + rule.ttlSec * 1000) };
    } catch (cause) {
      throw new PortError('unavailable', 's3 presign failed', { cause });
    }
  }

  async getUrl(key: string, ttlSec: number, downloadName?: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName.replace(/[^\w.-]/g, '_')}"` : undefined,
      }),
      { expiresIn: Math.min(Math.max(ttlSec, 60), 300) },
    );
  }

  async move(from: string, to: string): Promise<void> {
    await this.wrap(async () => {
      await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${encodeURIComponent(from)}` }));
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: from }));
    });
  }

  async delete(key: string): Promise<void> {
    await this.wrap(() => this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })));
  }

  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType };
    } catch (err) {
      if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') return null;
      throw new PortError('unavailable', 's3 head failed', { cause: err });
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer> {
    return this.wrap(async () => {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if ((r.ContentLength ?? 0) > maxBytes) throw new PortError('bad_request', 'object larger than allowed', { retryable: false });
      const bytes = await r.Body!.transformToByteArray();
      return Buffer.from(bytes);
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.wrap(() => this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType })));
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PortError) throw err;
      if ((err as { name?: string }).name === 'NoSuchKey') throw new PortError('not_found', 's3 object missing', { retryable: false, cause: err });
      throw new PortError('unavailable', 's3 call failed', { cause: err });
    }
  }
}
