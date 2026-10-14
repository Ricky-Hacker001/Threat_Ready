import { parentPort, workerData } from 'node:worker_threads';
import { extractFromBuffer } from './extractors.js';

/** Runs in a worker thread with a memory limit and a timeout enforced by the parent (ADD §9). */
const { bytes, kind, maxPages } = workerData as { bytes: Uint8Array; kind: 'pdf' | 'docx'; maxPages: number };
extractFromBuffer(Buffer.from(bytes), kind, maxPages)
  .then((r) => parentPort!.postMessage({ ok: true, ...r }))
  .catch((err: unknown) => parentPort!.postMessage({ ok: false, code: (err as { code?: string }).code ?? 'UNREADABLE', message: (err as Error).message }));
