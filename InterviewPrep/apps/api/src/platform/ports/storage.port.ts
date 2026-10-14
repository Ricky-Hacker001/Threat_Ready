export interface UploadRule {
  contentType: string;
  maxBytes: number;
  ttlSec: number;
}

export interface SignedPost {
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

/**
 * ADD §6 StoragePort (putUrl, getUrl, move, delete), plus head/read/put for the worker, which
 * reads uploaded files and writes report PDFs. Buckets stay private; only short-lived URLs leave.
 */
export interface StoragePort {
  putUrl(key: string, rule: UploadRule): Promise<SignedPost>;
  getUrl(key: string, ttlSec: number, downloadName?: string): Promise<string>;
  move(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ size: number; contentType?: string } | null>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export const STORAGE_PORT = Symbol('StoragePort');

export const QUARANTINE_PREFIX = 'quarantine';
export const CLEAN_PREFIX = 'documents';
export const REPORTS_PREFIX = 'reports';
