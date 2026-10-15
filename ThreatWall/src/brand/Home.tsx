import { useEffect, useState } from 'react';
import { ArrowRight, FileDown, FileText, NotebookText, RotateCcw } from 'lucide-react';
import { NOTEBOOK_PDF } from '../notebook/lessons';
import { useStore } from '../state/store';
import { ui } from '../state/ui';
import { TASKS } from '../tasks';
import { LEVELS } from '../tasks/types';
import { BadgeShield, BADGE_DISCLAIMER, BrandFooter, BrandRow, PRODUCT, COMPANY, TAGLINE } from './Brand';
import { lastRoute, levelSummary, nextTask } from './progress';

/** ThreatReady home: who is learning, where they are, what is next. Lives outside the simulated appliance. */
export function Home() {
  const { state, setProgress, resetLab } = useStore();
  const p = state.progress;
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    ui.setRoute('start');
    document.title = `${PRODUCT} | ${COMPANY}`;
  }, []);

  const next = nextTask(p);
  const done = TASKS.filter((t) => p.tasks[t.id]?.status === 'completed').length;
  const started = Object.values(p.tasks).some((t) => t.startedAt);
  const levels = LEVELS.map((lv) => levelSummary(p, lv.id));

  const enterLab = () => {
    if (next) setProgress((x) => ({ ...x, current: next.id, panelOpen: true }));
    window.location.hash = `/${lastRoute()}`;
  };

  return (
    <div className="tr-page">
      <div className="tr-wrap">
        <BrandRow right={<>
          <a className="tr-btn ghost" href="#/notebook"><NotebookText size={14} /> Learning notebook</a>
          <a className="tr-btn ghost" href="#/record"><FileText size={14} /> Training record</a>
        </>} />

        <header className="tr-hero">
          <h1>{PRODUCT}</h1>
          <p>{TAGLINE} You configure a fictional firewall, ThreatWall, in a lab that runs entirely in your browser: cabling, interfaces, rules, VPNs, high availability and a final incident.</p>
          <label className="tr-name">
            Learner name
            <input value={p.learner} placeholder="Shown on your training record" maxLength={60}
              onChange={(e) => { const v = e.target.value; setProgress((x) => ({ ...x, learner: v })); }} />
          </label>
        </header>

        <section className="tr-section" aria-labelledby="h-continue">
          <h2 id="h-continue">{started ? 'Continue where you left off' : 'Start the lab'}</h2>
          <div className="tr-card tr-continue">
            <div>
              {next ? (
                <>
                  <div className="t">Task {next.id} — {next.title}</div>
                  <div className="s">{LEVELS[next.level].name} · ~{next.minutes} min · {p.tasks[next.id]?.status === 'stale' ? 'needs re-verify' : p.tasks[next.id]?.status === 'in-progress' ? `step ${(p.tasks[next.id]?.step ?? 0) + 1} of ${next.steps.length}` : 'not started'}</div>
                </>
              ) : (
                <>
                  <div className="t">All {TASKS.length} tasks verified</div>
                  <div className="s">The lab stays open. Re-checks run every time you change the configuration.</div>
                </>
              )}
            </div>
            <button className="tr-btn primary" data-guide="start-lab" onClick={enterLab}>
              {next ? (started ? 'Continue' : 'Start lab') : 'Open the lab'} <ArrowRight size={15} />
            </button>
          </div>
        </section>

        <section className="tr-section" aria-labelledby="h-notebook">
          <h2 id="h-notebook">Learning notebook</h2>
          <div className="tr-card tr-continue">
            <NotebookText size={34} color="var(--tr-teal)" aria-hidden="true" />
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="t">Every task explained, with flow diagrams</div>
              <div className="s">What each feature really is, what happens inside the firewall, why every step matters, common mistakes and self-check questions. Read it here or download it as a PDF.</div>
            </div>
            <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <a className="tr-btn" href="#/notebook" data-guide="open-notebook">Read online</a>
              <a className="tr-btn primary" href={NOTEBOOK_PDF} download><FileDown size={15} /> Download PDF</a>
            </span>
          </div>
        </section>

        <section className="tr-section" aria-labelledby="h-new">
          <h2 id="h-new">New here?</h2>
          <div className="tr-new">
            <div className="tr-card"><h3>How the lab works</h3><p>The screen is the browser on a lab PC. The training panel on the right gives one action at a time and moves on when the saved configuration or a simulated test proves it.</p></div>
            <div className="tr-card"><h3>Guided or Practice</h3><p>Guided shows the values and points at the next control. Practice hides them until you ask for a hint. Switch at any time in the panel.</p></div>
            <div className="tr-card"><h3>Lab Tools</h3><p>The bottom drawer holds the PC console, the traffic tester, lab hosts and lab controls such as ISP failure or HA unit power.</p></div>
          </div>
        </section>

        <section className="tr-section" aria-labelledby="h-levels">
          <h2 id="h-levels">Levels</h2>
          <div className="tr-levels">
            {levels.map((l) => (
              <div key={l.level} className={`tr-card tr-level${l.state === 'locked' ? ' locked' : ''}`}>
                <div className="top">
                  <BadgeShield level={l.level} size={34} earned={l.state === 'complete'} />
                  <div>
                    <h3>{LEVELS[l.level].name}</h3>
                    <div className="tag">{LEVELS[l.level].tagline}</div>
                  </div>
                </div>
                <div className="state">
                  <span className="tr-dot" style={{ background: l.state === 'complete' ? 'var(--tr-pass)' : l.state === 'locked' ? 'var(--tr-text-3)' : 'var(--tr-teal)' }} />
                  {l.state === 'complete' ? 'Complete' : l.state === 'locked' ? 'Locked' : l.state === 'in-progress' ? 'In progress' : 'Open'}
                  {l.stale ? <span style={{ color: 'var(--tr-warn)' }}>· {l.stale} to re-verify</span> : null}
                </div>
                <div className="bar" aria-hidden="true"><div style={{ width: `${(l.done / l.total) * 100}%` }} /></div>
                <div>{l.done} of {l.total} tasks verified</div>
                <div className="meta">~{l.minutes} min · tasks {l.first}–{l.last}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="tr-section" aria-labelledby="h-record">
          <h2 id="h-record">Your record</h2>
          <div className="tr-card">
            <div className="tr-record">
              <div className="tr-badges">
                {levels.map((l) => (
                  <div key={l.level} className={`tr-badge-slot${l.state === 'complete' ? '' : ' off'}`}>
                    <BadgeShield level={l.level} size={36} earned={l.state === 'complete'} />
                    <span>Level {l.level}<br />{l.state === 'complete' ? 'Earned' : 'Not yet'}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{done} of {TASKS.length} tasks verified</div>
                <a className="tr-btn" href="#/record" style={{ marginTop: 8 }}><FileText size={14} /> Open training record</a>
              </div>
            </div>
            <div className="tr-note">{BADGE_DISCLAIMER}</div>
          </div>
        </section>

        <section className="tr-section" aria-labelledby="h-reset">
          <h2 id="h-reset">Start over</h2>
          <div className="tr-card tr-continue">
            <div className="s">Reset restores the appliance to factory defaults and clears all progress, notes and badges in this browser.</div>
            {confirmReset ? (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button className="tr-btn ghost" onClick={() => setConfirmReset(false)}>Cancel</button>
                <button className="tr-btn danger" data-guide="home-reset-confirm" onClick={() => { resetLab(); ui.closeLab(); setConfirmReset(false); }}>Yes, reset everything</button>
              </span>
            ) : (
              <button className="tr-btn danger" onClick={() => setConfirmReset(true)}><RotateCcw size={14} /> Reset lab</button>
            )}
          </div>
        </section>

        <div className="tr-honesty">
          <div>All traffic, hosts and attacks are simulated in your browser. Websites are fictional <span className="tr-mono">.example</span> domains and public addresses come from documentation ranges.</div>
          <div>ThreatWall is a fictional appliance used for training.</div>
          <div>Progress is stored in this browser only. Clearing site data or pressing Reset starts again.</div>
        </div>

        <BrandFooter />
      </div>
    </div>
  );
}
