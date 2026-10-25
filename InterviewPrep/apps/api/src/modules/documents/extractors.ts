import { Worker } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
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

/**
 * DOCX bombs (audit 2026-10-23 TR-06): a 250 KB upload whose document.xml inflates to 100 MB drove the
 * process past 600 MB. Before mammoth unpacks anything, the zip's central directory is checked against
 * these limits, and every entry is inflated for real with an output cap, because sizes in the headers
 * can lie. A real resume is far below them (document.xml is rarely over 2 MB; images do not compress).
 */
export const DOCX_LIMITS = { maxEntries: 500, maxEntryBytes: 10 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024, maxRatio: 100 };

export function checkDocxArchive(buf: Buffer, limits = DOCX_LIMITS): void {
  const bad = (why: string): never => {
    throw new ExtractError('UNREADABLE', `docx refused: ${why}`);
  };
  // End of central directory record: the last signature in the file, as JSZip (mammoth's unzipper)
  // finds it, within the last 22 bytes plus at most a 64 KB comment.
  let eocd = -1;
  for (let i = buf.length - 4; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) bad('no zip directory');
  if (eocd + 22 > buf.length || eocd + 22 + buf.readUInt16LE(eocd + 20) > buf.length) bad('truncated zip directory');
  const entries = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  // Any 0xFFFF / 0xFFFFFFFF field sends JSZip to a ZIP64 record this scan does not read; a resume is
  // never multi-disk or ZIP64.
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== entries) bad('multi-disk zip');
  if (entries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) bad('zip64');
  if (entries > limits.maxEntries) bad('too many entries');
  // The scan must see exactly the entries mammoth will read (audit fix-up of TR-06). JSZip shifts every
  // offset when the directory does not end right at this record, and reads every consecutive directory
  // record whatever the declared count says, so the directory must end here and hold exactly `entries`.
  if (dirOffset + dirSize !== eocd) bad('directory out of place');
  let p = dirOffset;
  let found = 0;
  let total = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    if (++found > entries) bad('directory holds more entries than it declares');
    if (p + 46 > eocd) bad('corrupt directory');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const declared = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) bad('corrupt directory');
    if (compressed === 0xffffffff || declared === 0xffffffff || local === 0xffffffff) bad('zip64');
    if (declared > limits.maxEntryBytes || total + declared > limits.maxTotalBytes) bad('too large when unpacked');
    if (declared > 1024 * 1024 && declared > compressed * limits.maxRatio) bad('compression ratio');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) bad('corrupt entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > buf.length) bad('entry out of range');
    let actual: number;
    if (method === 0) {
      actual = compressed;
    } else if (method === 8) {
      const budget = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - total);
      try {
        actual = inflateRawSync(buf.subarray(start, start + compressed), { maxOutputLength: Math.max(1, budget) }).length;
      } catch {
        return bad('entry inflates past the limit or is corrupt');
      }
    } else {
      return bad('unsupported compression');
    }
    if (actual !== declared) bad('entry size does not match its header');
    total += actual;
    p = next;
  }
  if (found !== entries || p !== eocd) bad('directory does not match its declared size');
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
  checkDocxArchive(buf);
  try {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value, pageCount: null };
  } catch {
    throw new ExtractError('UNREADABLE', 'docx could not be read');
  }
}

/**
 * Extracts text in a worker thread with a 20 s time limit and capped heap, so a hostile file
 * (zip bomb, pathological PDF) cannot stall or exhaust the worker process. Files are never
 * executed or rendered server-side. Buffers live outside the heap limit, which is why DOCX archives
 * are also checked by checkDocxArchive before they are unpacked.
 */
export function extractInWorker(buf: Buffer, kind: 'pdf' | 'docx', maxPages: number, timeoutMs = 20_000): Promise<Extracted> {
  const isTs = import.meta.url.endsWith('.ts');
  const url = new URL(`./extract.worker.${isTs ? 'ts' : 'js'}`, import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, {
      workerData: { bytes: new Uint8Array(buf), kind, maxPages },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16 },
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
