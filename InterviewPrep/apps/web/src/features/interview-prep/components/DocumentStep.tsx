import type { DocumentKind, DocumentView, UploadContentType } from '@threatready/contracts';
import { AlertCircle, AlertTriangle, Check, CloudUpload, FileText, Pencil, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api, ApiError, uploadToStorage } from '../../../lib/api';
import { Busy, ErrorAlert, useToast } from '../../../ui/components';

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, UploadContentType> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const FAILURE_HELP: Record<string, string> = {
  RESUME_UNSUPPORTED_TYPE: 'The file content is not a PDF or DOCX document. Export it again as PDF or DOCX.',
  RESUME_UNREADABLE: 'We could not read text from the file. If it is a scan or a password-protected PDF, upload a text-based copy.',
  JD_UNREADABLE: 'We could not read text from the file. Try pasting the job description instead.',
  JD_TOO_SHORT: 'Very little text was found. Paste the job description instead.',
  STORAGE_OBJECT_NOT_FOUND: 'The upload did not complete. Choose the file again.',
};

/** Client-side checks mirror the server's; the server re-checks size, type and magic bytes. */
export function validateFile(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!TYPES[ext]) return 'Upload a PDF or DOCX file.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_BYTES) return 'The file is larger than 5 MB.';
  return null;
}

const formatSize = (b: number | null) => (b == null ? '' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

type Phase = { name: 'idle' } | { name: 'uploading'; pct: number } | { name: 'extracting' } | { name: 'done' } | { name: 'failed' };

const EXTRACT_STEPS = ['Upload received', 'Checking the file type', 'Extracting text', 'Removing contact details'];

function ExtractionChecklist() {
  const [i, setI] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setI((n) => Math.min(n + 1, EXTRACT_STEPS.length - 1)), 900);
    return () => clearInterval(t);
  }, []);
  return (
    <ul className="checklist" aria-live="polite">
      {EXTRACT_STEPS.map((s, n) => (
        <li key={s} className={n < i ? 'done' : n === i ? 'active' : ''}>
          <span className="ck">{n < i ? <Check className="icon sm" aria-hidden /> : n === i ? <span className="spinner" aria-hidden style={{ width: 12, height: 12 }} /> : null}</span>
          {s}
        </li>
      ))}
    </ul>
  );
}

export function DocumentStep({
  kind,
  document,
  onChange,
}: {
  kind: DocumentKind;
  document: DocumentView | null;
  onChange: (doc: DocumentView | null) => void;
}) {
  const [phase, setPhase] = useState<Phase>(document?.status === 'extracted' ? { name: 'done' } : { name: 'idle' });
  const [error, setError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const label = kind === 'resume' ? 'resume' : 'job description';

  const poll = useCallback(async (id: string) => {
    for (let i = 0; i < 90; i++) {
      const doc = await api.document(id);
      if (doc.status === 'extracted' || doc.status === 'failed') return doc;
      await new Promise((r) => setTimeout(r, i < 10 ? 700 : 1500));
    }
    throw new ApiError('PARSE_IN_PROGRESS', 'Extraction is taking longer than expected', 0, true, null);
  }, []);

  async function handleFile(file: File) {
    setError(null);
    setLocalError(null);
    const invalid = validateFile(file);
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    setFileName(file.name);
    const ext = file.name.split('.').pop()!.toLowerCase();
    try {
      setPhase({ name: 'uploading', pct: 0 });
      const created = await api.createUpload(kind, TYPES[ext]!, file.size);
      await uploadToStorage(created.upload, file, (pct) => setPhase({ name: 'uploading', pct }));
      setPhase({ name: 'extracting' });
      await api.completeUpload(created.document.id);
      const doc = await poll(created.document.id);
      onChange(doc);
      setPhase(doc.status === 'extracted' ? { name: 'done' } : { name: 'failed' });
      if (doc.status === 'extracted') toast({ tone: 'ok', title: `${kind === 'resume' ? 'Resume' : 'Job description'} ready`, body: 'Check the extracted text below.' });
    } catch (e) {
      setError(e);
      setPhase({ name: 'idle' });
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  useEffect(() => {
    if (document?.status === 'extracted') setPhase({ name: 'done' });
  }, [document?.status]);

  async function saveEdit() {
    if (!document) return;
    setSaving(true);
    setError(null);
    try {
      onChange(await api.updateText(document.id, draft));
      setEditing(false);
      toast({ tone: 'ok', title: 'Corrections saved', body: 'Personal details in your edits were removed again.' });
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  const failed = document?.status === 'failed';
  const removed = document ? Object.values(document.redactions).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="stack lg">
      {(phase.name === 'idle' || failed) && (
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`Upload your ${label}: drag a PDF or DOCX here or press Enter to choose a file`}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault(); // Space would otherwise also scroll the page
            input.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <span className="icon-tile accent"><CloudUpload className="icon lg" aria-hidden /></span>
          <strong>{over ? 'Drop to upload' : `Drag your ${label} here, or click to browse`}</strong>
          <span className="muted">Up to 5 MB. Files stay private and contact details are removed before analysis.</span>
          <span className="formats"><span className="badge">PDF</span><span className="badge">DOCX</span></span>
          <input
            ref={input}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])}
          />
        </div>
      )}

      {localError && <p className="error-text" role="alert"><AlertCircle className="icon sm" aria-hidden /> {localError}</p>}
      {error != null && <ErrorAlert error={error} title="Upload failed" />}
      {failed && document && (
        <div className="alert warn" role="alert">
          <AlertTriangle className="icon" aria-hidden />
          <div className="stack" style={{ gap: 4 }}>
            <strong>We could not use that file</strong>
            <span>{document.warnings[0] ?? FAILURE_HELP[document.failureCode ?? ''] ?? 'Try another file.'}</span>
          </div>
        </div>
      )}

      {(phase.name === 'uploading' || phase.name === 'extracting') && (
        <div className="file-row fade-in" aria-live="polite">
          <span className="icon-tile"><FileText className="icon" aria-hidden /></span>
          <div className="grow stack" style={{ gap: 8 }}>
            <div className="row between">
              <strong style={{ fontSize: 14 }}>{fileName}</strong>
              <span className="muted tabular" style={{ fontSize: 13 }}>{phase.name === 'uploading' ? `${phase.pct}%` : 'Processing'}</span>
            </div>
            {phase.name === 'uploading' ? (
              <div className="meter thin"><i style={{ width: `${phase.pct}%`, animation: 'none' }} /></div>
            ) : (
              <ExtractionChecklist />
            )}
          </div>
        </div>
      )}

      {document?.status === 'extracted' && (
        <div className="stack fade-in">
          <div className="file-row">
            <span className="icon-tile ok"><Check className="icon" aria-hidden /></span>
            <div className="grow">
              <strong style={{ display: 'block', fontSize: 14 }}>{fileName ?? (document.source === 'pasted' ? 'Pasted text' : `Your ${label}`)}</strong>
              <span className="muted" style={{ fontSize: 13 }}>
                {[document.pageCount != null ? `${document.pageCount} page${document.pageCount === 1 ? '' : 's'}` : null, formatSize(document.sizeBytes), `${(document.extractedText?.length ?? 0).toLocaleString('en-IN')} characters`].filter(Boolean).join(' · ')}
              </span>
            </div>
            <div className="row tight wrap">
              {document.editedByUser && <span className="badge info">Edited</span>}
              {removed > 0 && (
                <span className="badge ok" title="Removed before analysis">
                  <ShieldCheck className="icon sm" aria-hidden /> {removed} personal detail{removed === 1 ? '' : 's'} removed
                </span>
              )}
              {!editing && (
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => {
                    setDraft(document.extractedText ?? '');
                    setEditing(true);
                  }}
                >
                  <Pencil className="icon sm" aria-hidden /> Correct text
                </button>
              )}
              <button className="btn ghost sm" type="button" onClick={() => { onChange(null); setPhase({ name: 'idle' }); setFileName(null); }}>
                <RefreshCw className="icon sm" aria-hidden /> Replace
              </button>
            </div>
          </div>
          {document.warnings.map((w) => (
            <p key={w} className="hint">{w}</p>
          ))}
          {editing ? (
            <div className="stack">
              <label className="field">
                <span>Extracted text — fix anything that came through wrong</span>
                <textarea className="textarea mono" rows={16} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={30000} />
              </label>
              <div className="row">
                <button className="btn primary sm" type="button" onClick={() => void saveEdit()} disabled={saving || draft.trim().length < 50}>
                  {saving ? <Busy label="Saving…" /> : 'Save corrections'}
                </button>
                <button className="btn ghost sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            // Rendered as text: React escapes it, so document content can never become markup.
            <div className="preview" tabIndex={0} aria-label={`Extracted ${label} text`}>{document.extractedText}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function PasteJd({ onCreated }: { onCreated: (doc: DocumentView) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const len = text.trim().length;
  const short = len < 200;
  return (
    <div className="stack">
      <label className="field">
        <span>Paste the job description</span>
        <textarea className="textarea" rows={12} value={text} onChange={(e) => setText(e.target.value)} maxLength={30000} placeholder="Job title, responsibilities, required and preferred skills…" />
      </label>
      <div className="meter thin" aria-hidden><i style={{ width: `${Math.min(100, (len / 200) * 100)}%`, animation: 'none' }} /></div>
      <div className="row between">
        <span className="hint">{len.toLocaleString('en-IN')} characters{short ? ` · ${200 - len} more needed` : ' · looks good'}</span>
        <button
          className="btn primary"
          type="button"
          disabled={short || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              onCreated(await api.pasteJd(text));
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Busy label="Saving…" /> : 'Use this job description'}
        </button>
      </div>
      {error != null && <ErrorAlert error={error} />}
    </div>
  );
}
