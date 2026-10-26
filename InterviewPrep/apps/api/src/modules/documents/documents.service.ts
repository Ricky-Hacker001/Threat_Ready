import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  LIMITS,
  type CreateTextDocumentRequest,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type DocumentKind,
  type DocumentView,
} from '@threatready/contracts';
import { interviewSessions, jobDescriptions, resumes } from '@threatready/db';
import { DomainError, opaqueObjectKey, PortError, type ErrorCode } from '@threatready/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { Database, type Tx } from '../../platform/db/database.js';
import { logger } from '../../platform/logging/logger.js';
import { JOBS, QUEUE_PORT, type QueuePort } from '../../platform/ports/queue.port.js';
import { CLEAN_PREFIX, QUARANTINE_PREFIX, STORAGE_PORT, type StoragePort } from '../../platform/ports/storage.port.js';
import type { Principal } from '../../platform/authz/principal.js';
import { PARSER_VERSION } from '../ai/prompts/documents.prompts.js';
import { ExtractError, extractInWorker, sniff } from './extractors.js';
import { normaliseText, redact } from './redaction.js';

type DocRow = typeof resumes.$inferSelect;
const UPLOAD_TTL_SEC = 300;
const MIN_TEXT_CHARS = 200;

export const tableFor = (kind: DocumentKind) => (kind === 'resume' ? resumes : jobDescriptions);

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function toDocumentView(row: DocRow, kind: DocumentKind): DocumentView {
  return {
    id: row.id,
    kind,
    status: row.status,
    source: row.source,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    pageCount: row.pageCount,
    extractedText: row.status === 'extracted' ? row.extractedText : null,
    editedByUser: row.editedByUser,
    redactions: row.redactions,
    warnings: row.warnings,
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
  };
}

function failure(kind: DocumentKind, f: 'TOO_LARGE' | 'UNSUPPORTED' | 'UNREADABLE' | 'NOT_FOUND' | 'TOO_SHORT'): ErrorCode {
  if (kind === 'resume') {
    return ({ TOO_LARGE: 'RESUME_TOO_LARGE', UNSUPPORTED: 'RESUME_UNSUPPORTED_TYPE', UNREADABLE: 'RESUME_UNREADABLE', NOT_FOUND: 'RESUME_NOT_FOUND', TOO_SHORT: 'RESUME_UNREADABLE' } as const)[f];
  }
  return ({ TOO_LARGE: 'RESUME_TOO_LARGE', UNSUPPORTED: 'RESUME_UNSUPPORTED_TYPE', UNREADABLE: 'JD_UNREADABLE', NOT_FOUND: 'JD_NOT_FOUND', TOO_SHORT: 'JD_TOO_SHORT' } as const)[f];
}

/** Turns raw extracted text into stored text: normalise, length-check, redact. */
export function prepareText(kind: DocumentKind, raw: string): { text: string; redactions: Record<string, number>; warnings: string[] } {
  const { text, truncated } = normaliseText(raw, LIMITS.documentTextMaxChars);
  if (text.length < MIN_TEXT_CHARS) throw new DomainError(failure(kind, 'TOO_SHORT'), { details: { reason: 'too_little_text' } });
  const r = redact(text, { redactNameLine: kind === 'resume' });
  const warnings: string[] = [];
  if (truncated) warnings.push(`Only the first ${LIMITS.documentTextMaxChars.toLocaleString('en-IN')} characters were kept.`);
  if (Object.keys(r.counts).length) warnings.push('Contact details and personal identifiers were removed before analysis.');
  return { text: r.text, redactions: r.counts, warnings };
}

/**
 * Documents module (ADD §6): upload, validation, extraction. Owns the RESUMES and JOB_DESCRIPTIONS
 * tables. Every query is scoped by user id, and runs under RLS as a backstop.
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  async createUpload(p: Principal, req: CreateUploadRequest): Promise<CreateUploadResponse> {
    const objectKey = opaqueObjectKey(QUARANTINE_PREFIX, p.orgId);
    const table = tableFor(req.kind);
    const [row] = await this.db.user(p, ({ db }) =>
      db
        .insert(table)
        .values({
          orgId: p.orgId,
          userId: p.userId,
          status: 'awaiting_upload',
          source: 'upload',
          objectKey,
          contentType: req.contentType,
          sizeBytes: req.sizeBytes,
          uploadExpiresAt: new Date(Date.now() + UPLOAD_TTL_SEC * 1000),
        })
        .returning(),
    );
    const signed = await this.storage
      .putUrl(objectKey, { contentType: req.contentType, maxBytes: LIMITS.uploadMaxBytes, ttlSec: UPLOAD_TTL_SEC })
      .catch((cause) => {
        throw new DomainError('STORAGE_UNAVAILABLE', { cause });
      });
    return {
      document: toDocumentView(row!, req.kind),
      upload: { url: signed.url, fields: signed.fields, expiresAt: signed.expiresAt.toISOString(), maxBytes: LIMITS.uploadMaxBytes },
    };
  }

  async createText(p: Principal, req: CreateTextDocumentRequest): Promise<DocumentView> {
    const prepared = prepareText('jd', req.text);
    const [row] = await this.db.user(p, ({ db }) =>
      db
        .insert(jobDescriptions)
        .values({
          orgId: p.orgId,
          userId: p.userId,
          status: 'extracted',
          source: 'pasted',
          extractedText: prepared.text,
          textHash: sha256(prepared.text),
          redactions: prepared.redactions,
          warnings: prepared.warnings,
          parserVersion: PARSER_VERSION,
        })
        .returning(),
    );
    return toDocumentView(row!, 'jd');
  }

  /** Finds a document owned by the caller in either table. A miss is 404, never 403. */
  async find(tx: Tx, p: Principal, id: string): Promise<{ row: DocRow; kind: DocumentKind }> {
    const [r] = await tx.db.select().from(resumes).where(and(eq(resumes.id, id), eq(resumes.userId, p.userId)));
    if (r) return { row: r, kind: 'resume' };
    const [j] = await tx.db.select().from(jobDescriptions).where(and(eq(jobDescriptions.id, id), eq(jobDescriptions.userId, p.userId)));
    if (j) return { row: j, kind: 'jd' };
    throw new DomainError('RESUME_NOT_FOUND', { message: 'Document not found' });
  }

  async get(p: Principal, id: string): Promise<DocumentView> {
    return this.db.user(p, async (tx) => {
      const { row, kind } = await this.find(tx, p, id);
      return toDocumentView(row, kind);
    });
  }

  async completeUpload(p: Principal, id: string): Promise<DocumentView> {
    return this.db.user(p, async (tx) => {
      const { row, kind } = await this.find(tx, p, id);
      if (row.status !== 'awaiting_upload') return toDocumentView(row, kind); // idempotent
      if (row.uploadExpiresAt && row.uploadExpiresAt.getTime() < Date.now() - 60_000) {
        // The presigned POST is dead; the upload must restart.
        const head = await this.storage.head(row.objectKey!);
        if (!head) throw new DomainError('STORAGE_UPLOAD_EXPIRED');
      }
      const head = await this.storage.head(row.objectKey!);
      if (!head) throw new DomainError('STORAGE_OBJECT_NOT_FOUND');
      if (head.size > LIMITS.uploadMaxBytes) throw new DomainError(failure(kind, 'TOO_LARGE'));
      const table = tableFor(kind);
      const [updated] = await tx.db
        .update(table)
        .set({ status: 'extracting', sizeBytes: head.size, updatedAt: new Date() })
        .where(and(eq(table.id, id), eq(table.status, 'awaiting_upload')))
        .returning();
      // Enqueued in the same transaction as the state change (L13).
      await this.queue.enqueue(JOBS.documentExtract, { documentId: id, kind }, { key: `${id}:${PARSER_VERSION}` }, tx);
      return toDocumentView(updated ?? row, kind);
    });
  }

  async updateText(p: Principal, id: string, text: string): Promise<DocumentView> {
    return this.db.user(p, async (tx) => {
      const { row, kind } = await this.find(tx, p, id);
      if (row.status !== 'extracted') throw new DomainError('DOCUMENT_NOT_READY');
      // Edited text is untrusted too: it is redacted again before it can reach a prompt.
      const prepared = prepareText(kind, text);
      const table = tableFor(kind);
      const [updated] = await tx.db
        .update(table)
        .set({
          extractedText: prepared.text,
          textHash: sha256(prepared.text),
          editedByUser: true,
          redactions: mergeCounts(row.redactions, prepared.redactions),
          warnings: [...new Set([...row.warnings, ...prepared.warnings])],
          updatedAt: new Date(),
        })
        .where(eq(table.id, id))
        .returning();
      return toDocumentView(updated!, kind);
    });
  }

  async delete(p: Principal, id: string): Promise<void> {
    const key = await this.db.user(p, async (tx) => {
      const { row, kind } = await this.find(tx, p, id);
      const col = kind === 'resume' ? interviewSessions.resumeId : interviewSessions.jobDescriptionId;
      const active = await tx.db
        .select({ id: interviewSessions.id })
        .from(interviewSessions)
        .where(
          and(
            eq(col, id),
            inArray(interviewSessions.state, ['parsing', 'profiled', 'planned', 'asking', 'awaiting_answer', 'evaluating', 'paused', 'completed', 'scoring']),
          ),
        )
        .limit(1);
      if (active.length) throw new DomainError('INTERVIEW_INVALID_STATE', { message: 'This document is used by an interview in progress' });
      const table = tableFor(kind);
      await tx.db.delete(table).where(eq(table.id, id));
      return row.objectKey;
    });
    if (key) await this.storage.delete(key).catch((err) => logger.warn({ err: { message: (err as Error).message } }, 'object delete failed'));
  }

  /** Worker: extraction job (L13 key: document id + parser version). Idempotent. */
  async runExtraction(documentId: string, kind: DocumentKind): Promise<void> {
    const table = tableFor(kind);
    const [row] = await this.db.system(({ db }) => db.select().from(table).where(eq(table.id, documentId)));
    if (!row || row.status !== 'extracting' || !row.objectKey) return;

    const fail = async (code: ErrorCode, warning?: string) => {
      await this.db.system(({ db }) =>
        db
          .update(table)
          .set({ status: 'failed', failureCode: code, warnings: warning ? [warning] : [], updatedAt: new Date() })
          .where(eq(table.id, documentId)),
      );
      await this.storage.delete(row.objectKey!).catch(() => undefined);
      logger.info({ document_id: documentId, kind, code }, 'document extraction failed');
    };

    let buf: Buffer;
    try {
      buf = await this.storage.read(row.objectKey, LIMITS.uploadMaxBytes);
    } catch (err) {
      if (err instanceof PortError && (err.kind === 'not_found' || err.kind === 'bad_request')) {
        return fail(err.kind === 'not_found' ? 'STORAGE_OBJECT_NOT_FOUND' : failure(kind, 'TOO_LARGE'));
      }
      throw err; // transient: let the queue retry
    }

    const actual = sniff(buf);
    const declared = row.contentType === 'application/pdf' ? 'pdf' : 'docx';
    if (!actual || actual !== declared) return fail(failure(kind, 'UNSUPPORTED'), 'The file content does not match a PDF or DOCX document.');

    let text: string;
    let pageCount: number | null;
    try {
      ({ text, pageCount } = await extractInWorker(buf, actual, LIMITS.maxPdfPages));
    } catch (err) {
      const code = err instanceof ExtractError ? err.code : 'UNREADABLE';
      const message = {
        ENCRYPTED: 'The PDF is password-protected. Remove the password and upload it again.',
        TOO_MANY_PAGES: `The document has more than ${LIMITS.maxPdfPages} pages.`,
        TIMEOUT: 'The document took too long to read. Try saving it again as a simpler PDF.',
        UNSUPPORTED: 'This file type is not supported.',
        UNREADABLE: 'The file appears to be damaged or empty.',
        TOO_LARGE: 'The document expands to far more than a resume or job description should. Save it again as a plain DOCX or PDF.',
      }[code];
      // A package whose declared contents are oversized is refused as too large, never inflated (A4).
      return fail(failure(kind, code === 'TOO_LARGE' ? 'TOO_LARGE' : 'UNREADABLE'), message);
    }

    let prepared: ReturnType<typeof prepareText>;
    try {
      prepared = prepareText(kind, text);
    } catch {
      return fail(
        failure(kind, 'TOO_SHORT'),
        'Very little text could be extracted. If this is a scanned document, upload a text-based PDF or DOCX, or paste the text.',
      );
    }

    const cleanKey = row.objectKey.replace(`${QUARANTINE_PREFIX}/`, `${CLEAN_PREFIX}/`);
    await this.storage.move(row.objectKey, cleanKey);
    await this.db.system(({ db }) =>
      db
        .update(table)
        .set({
          status: 'extracted',
          objectKey: cleanKey,
          extractedText: prepared.text,
          textHash: sha256(prepared.text),
          pageCount,
          redactions: prepared.redactions,
          warnings: prepared.warnings,
          parserVersion: PARSER_VERSION,
          failureCode: null,
          updatedAt: new Date(),
        })
        .where(and(eq(table.id, documentId), eq(table.status, 'extracting'))),
    );
  }

  /** Retention (ADD §9): uploaded files are deleted 30 days after parsing; text and profiles stay. */
  async purgeOldFiles(olderThan: Date): Promise<number> {
    let purged = 0;
    for (const table of [resumes, jobDescriptions]) {
      const rows = await this.db.system(({ db }) =>
        db
          .select({ id: table.id, objectKey: table.objectKey })
          .from(table)
          .where(and(or(eq(table.status, 'extracted'), eq(table.status, 'failed')))),
      );
      for (const r of rows) {
        if (!r.objectKey) continue;
        const [doc] = await this.db.system(({ db }) => db.select({ updatedAt: table.updatedAt, fileDeletedAt: table.fileDeletedAt }).from(table).where(eq(table.id, r.id)));
        if (!doc || doc.fileDeletedAt || doc.updatedAt > olderThan) continue;
        await this.storage.delete(r.objectKey).catch(() => undefined);
        await this.db.system(({ db }) => db.update(table).set({ objectKey: null, fileDeletedAt: new Date() }).where(eq(table.id, r.id)));
        purged++;
      }
    }
    return purged;
  }
}

function mergeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}
