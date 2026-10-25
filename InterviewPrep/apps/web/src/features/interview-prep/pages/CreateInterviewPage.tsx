import { useQuery } from '@tanstack/react-query';
import type { DocumentView, PlatformApps } from '@threatready/contracts';
import { ArrowLeft, ArrowRight, ClipboardPaste, FileUp, Lock, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../../../lib/api';
import { Busy, CardSkeleton, ErrorAlert, focusMainHeading, usePageTitle } from '../../../ui/components';
import { DocumentStep, PasteJd } from '../components/DocumentStep';
import { Stepper } from '../components/Stepper';

type Patch = { step?: 1 | 2; resume?: string | null; jd?: string | null };
const usable = (d: DocumentView | null) => (d?.status === 'extracted' ? d : null);

/**
 * The consent notice's facts from the deployment (GET /v1/platform `dataHandling`): where documents are
 * stored (null: not configured, so the copy names no place rather than guessing one) and how many days an
 * uploaded file is kept. An API that predates them gets the neutral wording and the 30-day default.
 */
const dataHandling = (p: PlatformApps | undefined) => {
  const location = p?.dataHandling?.storageLocation?.trim();
  const days = p?.dataHandling?.fileRetentionDays;
  return { location: location || null, retentionDays: typeof days === 'number' && days > 0 ? days : 30 };
};

/** How documents are kept and removed: only what the product actually does. */
function DataUseStorage({ location, retentionDays, canListDocuments }: { location: string | null; retentionDays: number; canListDocuments: boolean }) {
  return (
    <>
      {location ? `Your documents are stored in ${location}. ` : ''}
      The original files are kept in private storage and deleted automatically after {retentionDays} days. The redacted text, and the profile built from it, stay with your account for your interviews and reports.{' '}
      {canListDocuments
        ? 'You can delete your documents at any time from your interview history; deleting one removes its file and its extracted text.'
        : 'You can delete a document on this page with Delete or Replace; that removes its file and its text.'}
    </>
  );
}

/**
 * Screen B, steps 1 and 2. Step 3 (confirm and configure) runs on the session once analysis finishes.
 * The step and the ids of extracted documents live in the URL (?step=2&resume=…&jd=…), so a reload or
 * Back keeps the candidate's place instead of orphaning the uploads.
 */
export default function CreateInterviewPage() {
  const [params, setParams] = useSearchParams();
  const [resume, setResume] = useState<DocumentView | null>(null);
  const [jd, setJd] = useState<DocumentView | null>(null);
  const [restoring, setRestoring] = useState(() => Boolean(params.get('resume') || params.get('jd')));
  const [jdMode, setJdMode] = useState<'paste' | 'upload'>('paste');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const navigate = useNavigate();
  const platform = useQuery({ queryKey: ['platform'], queryFn: api.platform, staleTime: 300_000 });
  // Only promise deletion "at any time" when the history page can list documents (newer API).
  const documents = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments, retry: false, staleTime: 60_000 });
  const step: 1 | 2 = params.get('step') === '2' && (resume || restoring) ? 2 : 1;
  usePageTitle(step === 1 ? 'New interview: resume' : 'New interview: job description');

  const patch = useCallback(
    (next: Patch, push = false) =>
      setParams(
        (p) => {
          const q = new URLSearchParams(p);
          for (const [k, v] of Object.entries(next)) {
            if (v == null || (k === 'step' && v === 1)) q.delete(k);
            else q.set(k, String(v));
          }
          return q;
        },
        { replace: !push },
      ),
    [setParams],
  );

  // After a reload: bring back the documents named in the URL; drop any that are gone or unusable.
  useEffect(() => {
    const ids = { resume: params.get('resume'), jd: params.get('jd') };
    if (!ids.resume && !ids.jd) return;
    let on = true;
    void Promise.all([ids.resume ? api.document(ids.resume).catch(() => null) : null, ids.jd ? api.document(ids.jd).catch(() => null) : null]).then(([r, j]) => {
      if (!on) return;
      setResume(usable(r));
      setJd(usable(j));
      if (!usable(r) || (ids.jd && !usable(j))) patch({ resume: usable(r)?.id ?? null, jd: usable(j)?.id ?? null, ...(usable(r) ? {} : { step: 1 as const }) });
      setRestoring(false);
    });
    return () => {
      on = false;
    };
    // Runs once, on arrival: later changes are written to the URL by the handlers below.
  }, []);

  const onResume = (d: DocumentView | null) => {
    setResume(d);
    patch({ resume: usable(d)?.id ?? null });
  };
  const onJd = (d: DocumentView | null) => {
    setJd(d);
    patch({ jd: usable(d)?.id ?? null });
  };
  const goTo = (n: 1 | 2) => {
    patch({ step: n }, true);
    focusMainHeading();
  };

  async function analyse() {
    if (!resume || !jd) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.createSession(resume.id, jd.id);
      navigate(`/interview-prep/sessions/${s.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  const analyseBlocker = jd?.status !== 'extracted' ? 'Add the job description to continue.' : !consent ? 'Agree to the data use above to continue.' : null;

  return (
    <div className="page" style={{ maxWidth: 940 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow"><Sparkles className="icon sm" aria-hidden /> New interview</div>
          <h1>{step === 1 ? 'Start with your resume' : 'Add the job you are targeting'}</h1>
          <p className="subtle" style={{ marginTop: 8 }}>
            {step === 1
              ? 'Alex reads your resume to ask about your real experience, not generic questions.'
              : 'We extract the role, required and preferred skills, responsibilities and expected seniority.'}
          </p>
        </div>
      </div>
      <Stepper current={step} />

      {restoring ? (
        <div style={{ marginTop: 24 }}><CardSkeleton lines={5} /></div>
      ) : (
        <div className="card stack lg fade-in" style={{ marginTop: 24 }} key={step}>
          {step === 1 ? (
            <>
              <DocumentStep kind="resume" document={resume} onChange={onResume} />
              <div className="row between wrap">
                <span className="hint row tight"><Lock className="icon sm" aria-hidden /> The original file is kept in private storage and deleted automatically after {dataHandling(platform.data).retentionDays} days, or as soon as you delete it.</span>
                <button className="btn primary" type="button" disabled={resume?.status !== 'extracted'} onClick={() => goTo(2)}>
                  Continue <ArrowRight className="icon sm arrow" aria-hidden />
                </button>
              </div>
            </>
          ) : (
            <>
              {!jd && (
                <div className="segmented" role="group" aria-label="How to add the job description" style={{ alignSelf: 'flex-start' }}>
                  <button aria-pressed={jdMode === 'paste'} type="button" onClick={() => setJdMode('paste')}>
                    <ClipboardPaste className="icon sm" aria-hidden /> Paste text
                  </button>
                  <button aria-pressed={jdMode === 'upload'} type="button" onClick={() => setJdMode('upload')}>
                    <FileUp className="icon sm" aria-hidden /> Upload file
                  </button>
                </div>
              )}
              {jd || jdMode === 'upload' ? <DocumentStep kind="jd" document={jd} onChange={onJd} /> : <PasteJd onCreated={onJd} />}
              {jd?.status === 'extracted' && (
                <div className="card flat stack fade-in" style={{ background: 'var(--surface-2)' }}>
                  <div className="row">
                    <span className="icon-tile info"><Lock className="icon" aria-hidden /></span>
                    <div>
                      <strong style={{ fontSize: 14.5 }}>How your data is used</strong>
                      <p className="subtle" style={{ fontSize: 13 }}>Required before we analyse your documents.</p>
                    </div>
                  </div>
                  <ul className="subtle" style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, display: 'grid', gap: 4 }}>
                    <li>The redacted text of your resume and this job description is sent once to our AI provider, Anthropic (United States), to extract your profile and the role’s requirements.</li>
                    <li>During the interview, your answers are sent to the same provider to choose follow-up questions and to score your report. That covers typed answers and spoken answers, which your browser turns into text first (on this device, or through your browser’s own speech service); ThreatReady and the provider receive only the text.</li>
                    <li>The provider does not use this data for training and deletes it within 30 days. The email addresses, phone numbers and ID numbers we detect are removed before anything is sent; check each document’s extracted text and use Correct text for anything we missed.</li>
                    <li><DataUseStorage {...dataHandling(platform.data)} canListDocuments={documents.isSuccess && Array.isArray(documents.data?.items)} /></li>
                  </ul>
                  <label className="check">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    <span style={{ fontSize: 14 }}>I agree to this processing of my resume, the job description and my answers for this interview.</span>
                  </label>
                </div>
              )}
              {error != null && <ErrorAlert error={error} title="Could not start the analysis" />}
              <div className="row between wrap">
                <button className="btn ghost" type="button" onClick={() => goTo(1)}>
                  <ArrowLeft className="icon sm" aria-hidden /> Back
                </button>
                <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
                  {analyseBlocker && <span id="analyse-blocker" className="hint">{analyseBlocker}</span>}
                  <button className="btn primary lg" type="button" disabled={Boolean(analyseBlocker) || busy} aria-describedby={analyseBlocker ? 'analyse-blocker' : undefined} onClick={() => void analyse()}>
                    {busy ? <Busy label="Starting the analysis…" /> : <><Sparkles className="icon sm" aria-hidden /> Analyse resume and job</>}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
