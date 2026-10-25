import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isBrave } from '../hooks/useVoice';
import type { Briefing, Difficulty, DurationMin, InterviewConfig, InterviewMode, InterviewType, SkillLevel, Track } from '@threatready/contracts';
import {
  BadgeCheck,
  Blocks,
  Briefcase,
  Check,
  Clock,
  Code2,
  GraduationCap,
  Info,
  Layers,
  ListChecks,
  MessageCircle,
  Network,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Target,
  Undo2,
  UserRound,
  Volume2,
  Mic,
  Keyboard,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../../lib/api';
import { titleCase } from '../../../lib/format';
import { Busy, CardSkeleton, ErrorAlert, useToast } from '../../../ui/components';

const TYPES: { id: InterviewType; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'technical', label: 'Technical', hint: 'Concepts and practical application', icon: Blocks },
  { id: 'behavioral', label: 'Behavioral', hint: 'Real situations, actions and outcomes', icon: MessageCircle },
  { id: 'system_design', label: 'System Design', hint: 'Requirements, components, trade-offs', icon: Network },
  { id: 'coding_discussion', label: 'Coding Discussion', hint: 'Code you wrote and how to improve it', icon: Code2 },
  { id: 'cybersecurity_scenario', label: 'Cybersecurity Scenario', hint: 'Investigate realistic incidents', icon: ShieldAlert },
  { id: 'mixed', label: 'Mixed', hint: 'A balance of everything above', icon: Layers },
];
const DIFFICULTIES: { id: Difficulty; hint: string }[] = [
  { id: 'beginner', hint: 'Fundamentals' },
  { id: 'intermediate', hint: 'Practical depth' },
  { id: 'advanced', hint: 'Trade-offs and failure modes' },
];
const DURATIONS: { id: DurationMin; hint: string }[] = [
  { id: 15, hint: 'Quick practice' },
  { id: 30, hint: 'Standard round' },
  { id: 45, hint: 'Full round' },
];
const TRACKS: { id: Track; label: string }[] = [
  { id: 'general', label: 'General / role-based' },
  { id: 'soc_analyst', label: 'SOC Analyst' },
  { id: 'cloud_security', label: 'Cloud Security' },
  { id: 'application_security', label: 'Application Security' },
  { id: 'network_security', label: 'Network Security' },
  { id: 'devsecops', label: 'DevSecOps' },
];
const LEVELS: SkillLevel[] = ['aware', 'working', 'proficient', 'expert'];

/** Arrow keys, Home and End move between the radios of a group and select, like native radio buttons. */
function radioKeys(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const group = e.currentTarget.closest('[role="radiogroup"]');
  const radios = group ? [...group.querySelectorAll<HTMLElement>('[role="radio"]:not([aria-disabled="true"])')] : [];
  const i = radios.indexOf(e.currentTarget);
  if (i < 0) return;
  e.preventDefault();
  const n = radios.length;
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + n) % n;
  radios[next]!.focus();
  radios[next]!.click();
}

interface Draft {
  config: InterviewConfig | null;
  removeC: string[];
  removeJ: string[];
  levels: Record<string, SkillLevel>;
}
/** The configure choices, kept for this tab so a reload doesn't throw them away. */
function loadDraft(key: string): Draft | null {
  try {
    const d = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as Draft | null;
    if (!d?.config) return null;
    // A draft from a browser with voice, reopened in one without it, falls back to text.
    if (d.config.voiceAnswers && !voiceSupported()) d.config = { ...d.config, voiceAnswers: false };
    return d;
  } catch {
    return null;
  }
}

/** Browser speech recognition (Chrome, Edge, Safari) is required for voice answers; Brave has none. */
const voiceSupported = () => typeof window !== 'undefined' && !isBrave && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
const voiceHint = () => (voiceSupported() ? 'Alex speaks; you answer out loud, like a real interview' : isBrave ? 'Brave blocks speech recognition. For voice answers use Chrome, Edge or Safari' : 'Speaking answers isn’t supported in this browser (try Chrome, Edge or Safari)');

export function ConfigureView({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['briefing', sessionId], queryFn: () => api.briefing(sessionId) });
  const draftKey = `tr:configure:${sessionId}`;
  const [draft] = useState(() => loadDraft(draftKey));
  const [config, setConfig] = useState<InterviewConfig | null>(draft?.config ?? null);
  const [removeC, setRemoveC] = useState<string[]>(draft?.removeC ?? []);
  const [removeJ, setRemoveJ] = useState<string[]>(draft?.removeJ ?? []);
  const [levels, setLevels] = useState<Record<string, SkillLevel>>(draft?.levels ?? {});
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const keepBtn = useRef<HTMLButtonElement>(null);
  const cancelAsked = useRef(false);

  useEffect(() => {
    if (!config) return;
    try {
      window.sessionStorage.setItem(draftKey, JSON.stringify({ config, removeC, removeJ, levels } satisfies Draft));
    } catch {
      /* storage unavailable */
    }
  }, [draftKey, config, removeC, removeJ, levels]);

  // The cancel confirmation takes focus when it opens, and gives it back to its button when dismissed.
  useEffect(() => {
    if (confirmCancel) keepBtn.current?.focus();
    else if (cancelAsked.current) cancelBtn.current?.focus();
    cancelAsked.current = confirmCancel;
  }, [confirmCancel]);

  useEffect(() => {
    if (q.data && !config) {
      const r = q.data.recommendation;
      const voice = voiceSupported();
      setConfig({ interviewType: r.interviewType, difficulty: r.difficulty, durationMin: r.durationMin, track: r.track, mode: 'realistic', focusSkillIds: [], speakQuestions: voice, voiceAnswers: voice });
    }
  }, [q.data, config]);

  const plan = useMutation({
    mutationFn: () => api.plan(sessionId, { config: config!, corrections: { removeCandidateSkills: removeC, removeRequiredSkills: removeJ, candidateSkillLevels: levels } }),
    onSuccess: (s) => {
      try {
        window.sessionStorage.removeItem(draftKey);
      } catch {
        /* storage unavailable */
      }
      qc.setQueryData(['session', sessionId], s);
      toast({ tone: 'ok', title: 'Your interview is ready', body: 'Alex has prepared questions from your resume and the role.' });
    },
  });
  const cancel = useMutation({ mutationFn: () => api.cancel(sessionId), onSuccess: (s) => qc.setQueryData(['session', sessionId], s) });

  if (q.error) return <div style={{ marginTop: 24 }}><ErrorAlert error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (q.isPending || !config) return <div style={{ marginTop: 24 }}><CardSkeleton lines={8} /></div>;
  const b = q.data;
  const rec = b.recommendation;
  const set = <K extends keyof InterviewConfig>(k: K, v: InterviewConfig[K]) => setConfig({ ...config, [k]: v });
  const isRecommended = config.interviewType === rec.interviewType && config.difficulty === rec.difficulty && config.durationMin === rec.durationMin && config.track === rec.track;
  const typeMeta = TYPES.find((t) => t.id === config.interviewType)!;

  return (
    <div className="configure" style={{ marginTop: 24 }}>
      <div className="stack lg" style={{ minWidth: 0 }}>
        <section aria-labelledby="confirm-title">
          <div className="section-title" style={{ marginTop: 0 }}>
            <h2 id="confirm-title"><ListChecks className="icon" aria-hidden /> Confirm what we extracted</h2>
            <span className="hint">Remove anything that is wrong. Alex plans the questions from what is left.</span>
          </div>
          <div className="grid cols-2 stagger" style={{ alignItems: 'start' }}>
            <CandidateCard b={b} removed={removeC} onToggle={(id) => setRemoveC(toggle(removeC, id))} levels={levels} onLevel={(id, l) => setLevels({ ...levels, [id]: l })} />
            <RoleCard b={b} removed={removeJ} onToggle={(id) => setRemoveJ(toggle(removeJ, id))} />
          </div>
        </section>

        <section className="card stack lg" aria-labelledby="cfg-title">
          <div className="card-title" style={{ marginBottom: 0 }}>
            <h2 id="cfg-title"><Target className="icon" aria-hidden /> Interview settings</h2>
            {!isRecommended && (
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => setConfig({ ...config, interviewType: rec.interviewType, difficulty: rec.difficulty, durationMin: rec.durationMin, track: rec.track })}
              >
                <RotateCcw className="icon sm" aria-hidden /> Use recommended
              </button>
            )}
          </div>

          <div className="alert info">
            <Sparkles className="icon" aria-hidden />
            <div className="stack" style={{ gap: 4 }}>
              <strong>Recommended for {b.jobProfile.title}</strong>
              <span className="subtle" style={{ fontSize: 13.5 }}>{rec.rationale.join(' ')}</span>
            </div>
          </div>

          <Group label="Interview type">
            <div className="choices">
              {TYPES.map((t) => (
                <Choice key={t.id} icon={t.icon} checked={config.interviewType === t.id} onClick={() => set('interviewType', t.id)} title={t.label} hint={t.hint} recommended={rec.interviewType === t.id} />
              ))}
            </div>
          </Group>
          <div className="grid cols-2">
            <Group label="Difficulty">
              <div className="choices cols-3">
                {DIFFICULTIES.map((d) => (
                  <Choice key={d.id} checked={config.difficulty === d.id} onClick={() => set('difficulty', d.id)} title={titleCase(d.id)} hint={d.hint} recommended={rec.difficulty === d.id} compact />
                ))}
              </div>
            </Group>
            <Group label="Duration">
              <div className="choices cols-3">
                {DURATIONS.map((m) => (
                  <Choice key={m.id} checked={config.durationMin === m.id} onClick={() => set('durationMin', m.id)} title={`${m.id} min`} hint={m.hint} recommended={rec.durationMin === m.id} compact />
                ))}
              </div>
            </Group>
          </div>

          <div className="grid cols-2" style={{ alignItems: 'start' }}>
            <label className="field">
              <span>Track</span>
              <select className="select" value={config.track} onChange={(e) => set('track', e.target.value as Track)}>
                {TRACKS.map((t) => <option key={t.id} value={t.id}>{t.label}{rec.track === t.id ? ' (recommended)' : ''}</option>)}
              </select>
            </label>
            <div className="field" role="radiogroup" aria-label="Mode">
              <span>Mode</span>
              <div className="segmented" style={{ width: '100%' }}>
                {(['realistic', 'practice'] as InterviewMode[]).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={config.mode === m} tabIndex={config.mode === m ? 0 : -1} onKeyDown={radioKeys} style={{ flex: 1 }} onClick={() => set('mode', m)}>
                    {titleCase(m)}
                  </button>
                ))}
              </div>
              <span className="hint">{config.mode === 'realistic' ? 'Scores appear only in the final report, like a real interview.' : 'Brief feedback after each answer while you practise.'}</span>
            </div>
          </div>

          <div className="field">
            <span>Focus areas <span className="muted">(optional, up to 5)</span></span>
            <div className="row wrap tight">
              {b.skills.map((s) => {
                const on = config.focusSkillIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="chip"
                    aria-pressed={on}
                    disabled={!on && config.focusSkillIds.length >= 5}
                    onClick={() => set('focusSkillIds', on ? config.focusSkillIds.filter((x) => x !== s.id) : [...config.focusSkillIds, s.id].slice(0, 5))}
                  >
                    {on && <Check className="icon sm" aria-hidden />} {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field" role="radiogroup" aria-label="Interview style">
            <span>Interview style</span>
            <div className="choices cols-3">
              <Choice icon={Mic} checked={config.voiceAnswers} onClick={() => setConfig({ ...config, speakQuestions: true, voiceAnswers: true })} title="Voice" hint={voiceHint()} recommended={voiceSupported()} disabled={!voiceSupported()} compact />
              <Choice icon={Volume2} checked={config.speakQuestions && !config.voiceAnswers} onClick={() => setConfig({ ...config, speakQuestions: true, voiceAnswers: false })} title="Spoken questions" hint="Alex speaks; you type" compact />
              <Choice icon={Keyboard} checked={!config.speakQuestions && !config.voiceAnswers} onClick={() => setConfig({ ...config, speakQuestions: false, voiceAnswers: false })} title="Text only" hint="Read and type, no audio" compact />
            </div>
            {config.voiceAnswers && (
              <span className="hint">Your speech is turned into text by your browser (on this device where supported; otherwise your browser’s speech service). The text appears on screen and you can edit it before it is sent. You can switch to typing at any time.</span>
            )}
          </div>
        </section>
      </div>

      <aside className="summary" aria-label="Interview summary">
        <div className="card accent stack">
          <div className="row">
            <span className="icon-tile accent"><typeMeta.icon className="icon" aria-hidden /></span>
            <div>
              <div className="muted" style={{ fontSize: 12.5 }}>Your interview</div>
              <strong>{typeMeta.label}</strong>
            </div>
          </div>
          <div className="summary-stats">
            <div><strong className="tabular">{config.durationMin}</strong><span>minutes</span></div>
            <div><strong>Adaptive</strong><span>questions follow your answers</span></div>
          </div>
          <ul className="summary-list">
            <li><Briefcase className="icon sm" aria-hidden /> {b.jobProfile.title}</li>
            <li><GraduationCap className="icon sm" aria-hidden /> {titleCase(config.difficulty)} difficulty</li>
            <li><ShieldAlert className="icon sm" aria-hidden /> {TRACKS.find((t) => t.id === config.track)?.label}</li>
            <li>{config.voiceAnswers ? <Mic className="icon sm" aria-hidden /> : config.speakQuestions ? <Volume2 className="icon sm" aria-hidden /> : <Keyboard className="icon sm" aria-hidden />} {config.voiceAnswers ? 'Voice interview' : config.speakQuestions ? 'Spoken questions, typed answers' : 'Text only'}</li>
            <li><Clock className="icon sm" aria-hidden /> Timer runs only while you answer</li>
            <li><BadgeCheck className="icon sm" aria-hidden /> {config.mode === 'realistic' ? 'Realistic: scores at the end' : 'Practice: feedback as you go'}</li>
            {config.focusSkillIds.length > 0 && <li><Target className="icon sm" aria-hidden /> {config.focusSkillIds.length} focus area{config.focusSkillIds.length > 1 ? 's' : ''}</li>}
          </ul>
          {plan.error && <ErrorAlert error={plan.error} title="Could not build the interview" />}
          <button className="btn primary lg" type="button" onClick={() => plan.mutate()} disabled={plan.isPending}>
            {plan.isPending ? <Busy label="Building your interview…" /> : <><Sparkles className="icon sm" aria-hidden /> Build my interview</>}
          </button>
          {cancel.error != null && <ErrorAlert error={cancel.error} title="Could not cancel the interview" />}
          {confirmCancel ? (
            <div className="alert warn wrap" role="group" aria-labelledby="cancel-q">
              <p id="cancel-q" style={{ flex: '1 1 100%', fontSize: 13.5 }}>
                <strong>Cancel this interview?</strong> This setup is discarded. It still counts as one of this month’s interviews, because your documents were already analysed. To practise again you start a new interview.
              </p>
              <button className="btn danger sm" type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {cancel.isPending ? <Busy label="Cancelling…" /> : 'Yes, cancel it'}
              </button>
              <button ref={keepBtn} className="btn ghost sm" type="button" onClick={() => setConfirmCancel(false)}>Keep it</button>
            </div>
          ) : (
            <button ref={cancelBtn} className="btn ghost sm" type="button" onClick={() => setConfirmCancel(true)}>
              Cancel this interview
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field" role="radiogroup" aria-label={label}>
      <span>{label}</span>
      {children}
    </div>
  );
}

function Choice({ checked, onClick, title, hint, recommended, icon: Icon, compact, disabled }: { checked: boolean; onClick: () => void; title: string; hint: string; recommended?: boolean; icon?: LucideIcon; compact?: boolean; disabled?: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={checked} aria-disabled={disabled || undefined} tabIndex={checked ? 0 : -1} onKeyDown={radioKeys} className="choice" onClick={disabled ? undefined : onClick} style={compact ? { padding: '12px 12px' } : undefined}>
      {checked ? (
        <span className="tick" aria-hidden><Check className="icon sm" style={{ width: 12, height: 12 }} /></span>
      ) : (
        recommended && <span className="rec"><Sparkles className="icon sm" style={{ width: 11, height: 11 }} aria-hidden /> Best fit</span>
      )}
      {Icon && <span className="choice-icon"><Icon className="icon sm" aria-hidden /></span>}
      <strong>{title}</strong>
      <small>{hint}</small>
    </button>
  );
}

function SkillRow({ label, off, onToggle, children }: { label: string; off: boolean; onToggle: () => void; children?: React.ReactNode }) {
  return (
    <div className={`skill-row ${off ? 'off' : ''}`}>
      <span className="name">{label}</span>
      {children}
      <button className="btn ghost icon-only sm" type="button" onClick={onToggle} aria-label={off ? `Restore ${label}` : `Remove ${label}`} title={off ? 'Restore' : 'Remove'}>
        {off ? <Undo2 className="icon sm" /> : <X className="icon sm" />}
      </button>
    </div>
  );
}

function CandidateCard({ b, removed, onToggle, levels, onLevel }: { b: Briefing; removed: string[]; onToggle: (id: string) => void; levels: Record<string, SkillLevel>; onLevel: (id: string, l: SkillLevel) => void }) {
  const p = b.candidateProfile;
  const label = useMemo(() => new Map(b.skills.map((s) => [s.id, s.label])), [b.skills]);
  return (
    <section className="card stack" aria-labelledby="cand-title">
      <div className="row">
        <span className="icon-tile info"><UserRound className="icon" aria-hidden /></span>
        <div style={{ minWidth: 0 }}>
          <h3 id="cand-title">From your resume</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            {[
              p.career_stage ? { student: 'Student', early_career: 'Early career', experienced: 'Experienced', senior: 'Senior' }[p.career_stage] : null,
              p.current_role,
              p.years_experience ? `${p.years_experience} yrs full-time` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Role not stated'}
          </p>
        </div>
      </div>
      {p.roles.length > 0 && (
        <div className="timeline">
          {p.roles.slice(0, 4).map((r, i) => (
            <div key={i} className="timeline-item">
              <strong>{r.title}</strong>
              <span className="muted">{r.organisation}{r.kind === 'internship' ? ' · internship' : ''}{r.start ? ` · ${r.start}–${r.end ?? ''}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {(p.education.length > 0 || p.certifications.length > 0) && (
        <div className="row wrap tight">
          {p.education.slice(0, 2).map((e) => <span key={e.qualification} className="badge"><GraduationCap className="icon sm" aria-hidden /> {e.qualification}</span>)}
          {p.certifications.slice(0, 4).map((c) => <span key={c} className="badge info"><BadgeCheck className="icon sm" aria-hidden /> {c}</span>)}
        </div>
      )}
      <div className="stack" style={{ gap: 2 }}>
        <span className="field-label">Skills Alex will verify</span>
        <p className="hint" style={{ marginBottom: 6 }}>
          Set how well you know each one. <b>Aware</b>: you know what it is. <b>Working</b>: you have used it with some help. <b>Proficient</b>: you use it on your own. <b>Expert</b>: you could design it or teach it.
        </p>
        {p.skills.length === 0 && <span className="hint">No catalogue skills were found. The interview will focus on the job's requirements.</span>}
        {p.skills.map((s) => {
          const off = removed.includes(s.skill_id);
          return (
            <SkillRow key={s.skill_id} label={label.get(s.skill_id) ?? s.skill_id} off={off} onToggle={() => onToggle(s.skill_id)}>
              <select className="select level-select" aria-label={`Level for ${label.get(s.skill_id)}`} value={levels[s.skill_id] ?? s.claimed_level} disabled={off} onChange={(e) => onLevel(s.skill_id, e.target.value as SkillLevel)}>
                {LEVELS.map((l) => <option key={l} value={l}>{titleCase(l)}</option>)}
              </select>
            </SkillRow>
          );
        })}
      </div>
      {p.parse_warnings.length > 0 && (
        <div className="alert info">
          <Info className="icon" aria-hidden />
          <span><strong>Notes from reading your resume: </strong>{p.parse_warnings.join(' ')}</span>
        </div>
      )}
    </section>
  );
}

function RoleCard({ b, removed, onToggle }: { b: Briefing; removed: string[]; onToggle: (id: string) => void }) {
  const j = b.jobProfile;
  const label = new Map(b.skills.map((s) => [s.id, s.label]));
  return (
    <section className="card stack" aria-labelledby="role-title">
      <div className="row">
        <span className="icon-tile accent"><Briefcase className="icon" aria-hidden /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 id="role-title">{j.title}</h3>
          <p className="muted" style={{ fontSize: 13 }}>{b.roleLabel}{j.expected_experience ? ` · ${j.expected_experience}` : ''}</p>
        </div>
        <span className="badge">{titleCase(j.seniority)}</span>
      </div>
      <div className="stack" style={{ gap: 2 }}>
        <span className="field-label" style={{ marginBottom: 6 }}>Required and preferred skills</span>
        {j.required_skills.map((s) => (
          <SkillRow key={s.skill_id} label={label.get(s.skill_id) ?? s.skill_id} off={removed.includes(s.skill_id)} onToggle={() => onToggle(s.skill_id)}>
            <span className={`badge ${s.weight === 'must' ? 'accent' : s.weight === 'should' ? 'warn' : ''}`}>{s.weight === 'must' ? 'Required' : s.weight === 'should' ? 'Preferred' : 'Nice to have'}</span>
          </SkillRow>
        ))}
      </div>
      {j.behavioral_competencies.length > 0 && (
        <div className="row wrap tight">
          {j.behavioral_competencies.map((c) => <span key={c} className="badge">{c}</span>)}
        </div>
      )}
      {b.focusPreview.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="field-label">Alex will focus on</span>
          <p className="hint">
            <b>Verify</b>: a skill your resume claims; Alex checks it with you. <b>Probe</b>: a skill the job needs that your resume doesn’t show; Alex explores it.
          </p>
          <div className="row wrap tight">
            {b.focusPreview.map((f) => (
              <span key={`${f.reason}${f.skillId}`} className={`badge ${f.reason === 'verify_claim' ? 'info' : 'warn'}`}>
                {f.reason === 'verify_claim' ? 'Verify' : 'Probe'} · {f.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
