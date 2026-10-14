import { Worker } from 'node:worker_threads';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

export type ExtractFailure = 'ENCRYPTED' | 'UNREADABLE' | 'UNSUPPORTED' | 'TOO_MANY_PAGES' | 'TIMEOUT';

export class ExtractError extends Error {
  constructor(
    readonly code: ExtractFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface Extracted {
  text: string;
  pageCount: number | null;
}

/** Magic-byte check: the declared type must match the bytes (never trust the extension). */
export function sniff(buf: Buffer): 'pdf' | 'docx' | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    // OOXML packages contain [Content_Types].xml and a word/ part near the start of the zip directory.
    const head = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString('latin1');
    if (head.includes('[Content_Types].xml') || head.includes('word/')) return 'docx';
  }
  return null;
}

export async function extractFromBuffer(buf: Buffer, kind: 'pdf' | 'docx', maxPages: number): Promise<Extracted> {
  if (kind === 'pdf') {
    let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
    try {
      pdf = await getDocumentProxy(new Uint8Array(buf), { disableFontFace: true, useSystemFonts: false });
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (name === 'PasswordException' || /password/i.test((err as Error).message)) throw new ExtractError('ENCRYPTED', 'pdf is password protected');
      throw new ExtractError('UNREADABLE', 'pdf could not be opened');
    }
    if (pdf.numPages > maxPages) throw new ExtractError('TOO_MANY_PAGES', `pdf has ${pdf.numPages} pages`);
    const { text } = await extractText(pdf, { mergePages: true });
    return { text: String(text), pageCount: pdf.numPages };
  }
  try {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value, pageCount: null };
  } catch {
    throw new ExtractError('UNREADABLE', 'docx could not be read');
  }
}

/**
 * Extracts text in a worker thread with a 20 s time limit and a 256 MB heap, so a hostile file
 * (zip bomb, pathological PDF) cannot stall or exhaust the worker process. Files are never
 * executed or rendered server-side.
 */
export function extractInWorker(buf: Buffer, kind: 'pdf' | 'docx', maxPages: number, timeoutMs = 20_000): Promise<Extracted> {
  const isTs = import.meta.url.endsWith('.ts');
  const url = new URL(`./extract.worker.${isTs ? 'ts' : 'js'}`, import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, {
      workerData: { bytes: new Uint8Array(buf), kind, maxPages },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      execArgv: isTs ? ['--import', 'tsx'] : [],
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new ExtractError('TIMEOUT', 'extraction timed out'));
    }, timeoutMs);
    worker.once('message', (m: { ok: boolean; text?: string; pageCount?: number | null; code?: ExtractFailure; message?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.ok) resolve({ text: m.text ?? '', pageCount: m.pageCount ?? null });
      else reject(new ExtractError(m.code ?? 'UNREADABLE', m.message ?? 'extraction failed'));
    });
    worker.once('error', () => {
      clearTimeout(timer);
      reject(new ExtractError('UNREADABLE', 'extraction worker crashed'));
    });
  });
}
