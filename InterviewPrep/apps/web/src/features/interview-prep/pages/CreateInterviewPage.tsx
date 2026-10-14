import type { DocumentView } from '@threatready/contracts';
import { ArrowLeft, ArrowRight, ClipboardPaste, FileUp, Lock, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../../lib/api';
import { ErrorAlert } from '../../../ui/components';
import { DocumentStep, PasteJd } from '../components/DocumentStep';
import { Stepper } from '../components/Stepper';

/** Screen B, steps 1 and 2. Step 3 (confirm and configure) runs on the session once analysis finishes. */
export default function CreateInterviewPage() {
  const [step, setStep] = useState<1 | 2>(1);
  const [resume, setResume] = useState<DocumentView | null>(null);
  const [jd, setJd] = useState<DocumentView | null>(null);
  const [jdMode, setJdMode] = useState<'paste' | 'upload'>('paste');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const navigate = useNavigate();

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

      <div className="card stack lg fade-in" style={{ marginTop: 24 }} key={step}>
        {step === 1 ? (
          <>
            <DocumentStep kind="resume" document={resume} onChange={setResume} />
            <div className="row between wrap">
              <span className="hint row tight"><Lock className="icon sm" aria-hidden /> Your original file stays in private storage and is deleted 30 days after analysis.</span>
              <button className="btn primary" type="button" disabled={resume?.status !== 'extracted'} onClick={() => setStep(2)}>
                Continue <ArrowRight className="icon sm arrow" aria-hidden />
              </button>
            </div>
          </>
        ) : (
          <>
            {!jd && (
              <div className="segmented" role="tablist" aria-label="How to add the job description" style={{ alignSelf: 'flex-start' }}>
                <button role="tab" aria-selected={jdMode === 'paste'} type="button" onClick={() => setJdMode('paste')}>
                  <ClipboardPaste className="icon sm" aria-hidden /> Paste text
                </button>
                <button role="tab" aria-selected={jdMode === 'upload'} type="button" onClick={() => setJdMode('upload')}>
                  <FileUp className="icon sm" aria-hidden /> Upload file
                </button>
              </div>
            )}
            {jd || jdMode === 'upload' ? <DocumentStep kind="jd" document={jd} onChange={setJd} /> : <PasteJd onCreated={setJd} />}
            {jd?.status === 'extracted' && (
              <div className="card flat stack fade-in" style={{ background: 'var(--surface-2)' }}>
                <div className="row">
                  <span className="icon-tile info"><Lock className="icon" aria-hidden /></span>
                  <div>
                    <strong style={{ fontSize: 14.5 }}>How your data is used</strong>
                    <p className="muted" style={{ fontSize: 13 }}>Required before we analyse your documents.</p>
                  </div>
                </div>
                <ul className="subtle" style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, display: 'grid', gap: 4 }}>
                  <li>The redacted text of your resume and this job description is sent once to our AI provider, Anthropic (United States), to extract your profile and the role’s requirements.</li>
                  <li>During the interview, your typed answers are sent to the same provider to choose follow-up questions and to score your report.</li>
                  <li>The provider does not use this data for training and deletes it within 30 days. Contact details are removed before anything is sent.</li>
                  <li>Your files stay in private storage in India (Mumbai) and are deleted 30 days after analysis. You can delete documents at any time.</li>
                </ul>
                <label className="check">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span style={{ fontSize: 14 }}>I agree to this processing of my resume, the job description and my answers for this interview.</span>
                </label>
              </div>
            )}
            {error != null && <ErrorAlert error={error} title="Could not start the analysis" />}
            <div className="row between">
              <button className="btn ghost" type="button" onClick={() => setStep(1)}>
                <ArrowLeft className="icon sm" aria-hidden /> Back
              </button>
              <button className="btn primary lg" type="button" disabled={jd?.status !== 'extracted' || !consent || busy} onClick={() => void analyse()}>
                {busy ? <span className="spinner" /> : <><Sparkles className="icon sm" aria-hidden /> Analyse resume and job</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
