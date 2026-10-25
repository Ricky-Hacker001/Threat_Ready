import { DocumentKind, DocumentStatus, LIMITS, UploadContentType } from './enums.js';
import { z } from './zod.js';

export const CreateUploadRequest = z
  .object({
    kind: DocumentKind,
    contentType: UploadContentType,
    sizeBytes: z.number().int().positive().max(LIMITS.uploadMaxBytes),
  })
  .openapi('CreateUploadRequest');
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export const CreateTextDocumentRequest = z
  .object({
    kind: z.literal('jd'),
    text: z.string().trim().min(LIMITS.jdMinChars).max(LIMITS.documentTextMaxChars),
  })
  .openapi('CreateTextDocumentRequest');
export type CreateTextDocumentRequest = z.infer<typeof CreateTextDocumentRequest>;

/** Same bounds as extraction and pasting: shorter text cannot be analysed (JD_TOO_SHORT / RESUME_UNREADABLE). */
export const UpdateDocumentTextRequest = z
  .object({ text: z.string().trim().min(LIMITS.jdMinChars).max(LIMITS.documentTextMaxChars) })
  .openapi('UpdateDocumentTextRequest');
export type UpdateDocumentTextRequest = z.infer<typeof UpdateDocumentTextRequest>;

export const DocumentView = z
  .object({
    id: z.uuid(),
    kind: DocumentKind,
    status: DocumentStatus,
    source: z.enum(['upload', 'pasted']),
    contentType: z.string().nullable(),
    sizeBytes: z.number().int().nullable(),
    pageCount: z.number().int().nullable(),
    /** Redacted text: contact details are replaced with markers before it is stored. */
    extractedText: z.string().nullable(),
    editedByUser: z.boolean(),
    redactions: z.record(z.string(), z.number().int()),
    warnings: z.array(z.string()),
    failureCode: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('DocumentView');
export type DocumentView = z.infer<typeof DocumentView>;

/** One row of GET /v1/documents: no text, so the list stays small. */
export const DocumentSummary = z
  .object({
    id: z.uuid(),
    kind: DocumentKind,
    status: DocumentStatus,
    source: z.enum(['upload', 'pasted']),
    contentType: z.string().nullable(),
    sizeBytes: z.number().int().nullable(),
    pageCount: z.number().int().nullable(),
    /** The original file was deleted by the 30-day retention (or there never was one: pasted text). */
    fileDeleted: z.boolean(),
    /** Used by an interview that has not finished; it can be deleted once that interview ends. */
    inUse: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .openapi('DocumentSummary');
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const DocumentList = z.object({ items: z.array(DocumentSummary) }).openapi('DocumentList');
export type DocumentList = z.infer<typeof DocumentList>;

/** Presigned POST: the browser uploads straight to S3, into a quarantine prefix. */
export const SignedUpload = z
  .object({
    url: z.string(),
    fields: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
    maxBytes: z.number().int(),
  })
  .openapi('SignedUpload');
export type SignedUpload = z.infer<typeof SignedUpload>;

export const CreateUploadResponse = z
  .object({ document: DocumentView, upload: SignedUpload })
  .openapi('CreateUploadResponse');
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;
