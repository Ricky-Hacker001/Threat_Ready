import { useEffect } from 'react';
import { ArrowLeft, Download, Home as HomeIcon, NotebookText, Printer } from 'lucide-react';
import { useStore } from '../state/store';
import { ui } from '../state/ui';
import { TASKS } from '../tasks';
import { LEVELS } from '../tasks/types';
import { runChecks } from '../tasks/runtime';
import { tunnelStatus } from '../engine/vpn';
import { BadgeShield, BADGE_DISCLAIMER, BrandFooter, BrandRow, COMPANY, PRODUCT } from './Brand';
import { lastRoute, levelSummary, nextTask } from './progress';

const fmtDur = (ms: number) => { const m = Math.round(ms / 60000); return m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const fmtDate = (t: number) => new Date(t).toLocaleString();

/**
 * Training record, generated from the live lab. Honesty rules: every check is re-run now, failures are shown as failures,
 * strengths are only claimed from evidence, and a level with nothing to show says "Not enough evidence yet".
 */
export function Record() {
  const { state, config } = useStore();
  const p = state.progress;

  useEffect(() => {
    ui.setRoute('record');
    document.title = `Training record · ${PRODUCT} | ${COMPANY}`;
  }, []);

  const rows = TASKS.map((t) => {
    const tp = p.tasks[t.id];
    const checks = runChecks(t, state);
    const status = tp?.status ?? 'locked';
    return { t, tp, checks, status, ok: checks.every((c) => c.ok) && status === 'completed', fails: tp?.failures.length ?? 0 };
  });
  const verified = rows.filter((r) => r.ok).length;
  const stale = rows.filter((r) => r.status === 'stale');
  const totalFails = rows.reduce((a, r) => a + r.fails, 0);
  const started = Math.min(...rows.map((r) => r.tp?.startedAt ?? Infinity));
  const finished = Math.max(...rows.map((r) => r.tp?.completedAt ?? 0));
  const levels = LEVELS.map((lv) => levelSummary(p, lv.id));
  const vpn = config.ipsec.find((x) => x.kind === 'site');
  const notes = Object.entries(p.notes).filter(([, v]) => v.trim());
  const complete = verified === TASKS.length;
  const next = nextTask(p);

  // Strengths: only what the record proves.
  const strengths: string[] = [];
  levels.filter((l) => l.state === 'complete' && l.fails === 0).forEach((l) => strengths.push(`${LEVELS[l.level].name}: every task verified with no failed attempts.`));
  const firstTry = rows.filter((r) => r.ok && r.fails === 0);
  if (firstTry.length >= 3) strengths.push(`${firstTry.length} tasks verified at the first attempt (${firstTry.slice(0, 6).map((r) => r.t.id).join(', ')}${firstTry.length > 6 ? ', …' : ''}).`);

  // Gaps: broken checks first, then the tasks that took the most corrections.
  const struggled = rows.filter((r) => r.fails >= 2).sort((a, b) => b.fails - a.fails).slice(0, 5);

  const learnNext: string[] = [];
  stale.forEach((r) => learnNext.push(`Re-verify ${r.t.id} ${r.t.title}: ${r.checks.filter((c) => !c.ok).map((c) => c.label).join('; ') || 'a check no longer passes'}.`));
  struggled.forEach((r) => { if (r.t.mistakes[0]) learnNext.push(`${r.t.id}: review the common mistake “${r.t.mistakes[0]}”`); });
  if (next && next.id !== stale[0]?.t.id) learnNext.push(`Continue the track with ${next.id} ${next.title} (${LEVELS[next.level].name}).`);

  const exportJson = () => {
    const body = JSON.stringify({
      product: PRODUCT, generated: new Date().toISOString(), learner: p.learner || null, firewall: config.system.hostname, mode: p.mode,
      simulated: true, note: 'Generated from a browser simulation. Internal record, not a certification.',
      summary: { verified, total: TASKS.length, needReverify: stale.length, failedAttempts: totalFails },
      levels: levels.map((l) => ({ level: l.level, name: LEVELS[l.level].name, state: l.state, verified: l.done, total: l.total, failedAttempts: l.fails })),
      tasks: rows.map((r) => ({
        id: r.t.id, title: r.t.title, status: r.status, verified: r.ok, startedAt: r.tp?.startedAt, completedAt: r.tp?.completedAt,
        failedAttempts: r.fails, failures: r.tp?.failures.map((f) => ({ step: f.stepId, reason: f.reason, at: new Date(f.at).toISOString() })) ?? [],
        checks: r.checks.map((c) => ({ label: c.label, ok: c.ok, detail: c.detail })),
      })),
      notes: p.notes,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `threatready-firewall-record-${(p.learner || config.system.hostname).replace(/[^\w-]+/g, '_')}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <div className="tr-page">
      <div className="tr-wrap">
        <BrandRow right={<span className="tr-noprint" style={{ display: 'flex', gap: 8 }}>
          <a className="tr-btn ghost" href="#/start"><HomeIcon size={14} /> Home</a>
          <a className="tr-btn ghost" href="#/notebook"><NotebookText size={14} /> Learning notebook</a>
          <a className="tr-btn ghost" href={`#/${lastRoute()}`} data-guide="record-back"><ArrowLeft size={14} /> Back to lab</a>
        </span>} />

        <header className="tr-hero" style={{ marginBottom: 14 }}>
          <h1>Training record</h1>
          <p>{p.learner ? <b style={{ color: 'var(--tr-text)' }}>{p.learner}</b> : <span className="tr-empty">Learner name not set</span>} · {PRODUCT} · generated {fmtDate(Date.now())} · every check re-run against the current lab configuration</p>
          <p className={`tr-status ${complete ? 'pass' : 'prog'}`}>
            {complete ? `Track complete: ${verified} of ${TASKS.length} tasks verified` : `In progress: ${verified} of ${TASKS.length} tasks verified${stale.length ? ` · ${stale.length} need re-verify` : ''}`}
          </p>
          <div className="tr-noprint" style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="tr-btn" onClick={() => window.print()}><Printer size={14} /> Print or save as PDF</button>
            <button className="tr-btn" data-guide="report-export" onClick={exportJson}><Download size={14} /> Download my record (JSON)</button>
          </div>
        </header>

        <section className="tr-section">
          <h2>Summary</h2>
          <div className="tr-kv">
            <div><b>{verified}/{TASKS.length}</b><span>tasks verified now</span></div>
            <div><b>{totalFails}</b><span>failed attempts recorded</span></div>
            <div><b>{stale.length}</b><span>need re-verify</span></div>
            <div><b>{Number.isFinite(started) && finished ? fmtDur(finished - started) : '—'}</b><span>first to last completed task</span></div>
            <div><b>{p.mode === 'practice' ? 'Practice' : 'Guided'}</b><span>mode at record time</span></div>
            <div><b>{vpn && tunnelStatus(state, vpn.id).state === 'up' ? 'Up' : 'Down'}</b><span>HQ↔Branch tunnel</span></div>
          </div>
        </section>

        <section className="tr-section">
          <h2>Results by level</h2>
          <div className="tr-card" style={{ padding: 0 }}>
            <table className="tr-table">
              <thead><tr><th>Level</th><th>Result</th><th>Verified</th><th>Failed attempts</th><th>Badge</th></tr></thead>
              <tbody>
                {levels.map((l) => {
                  const touched = rows.some((r) => r.t.level === l.level && r.tp?.startedAt);
                  return (
                    <tr key={l.level}>
                      <td><b>{LEVELS[l.level].name}</b></td>
                      <td>{l.state === 'complete' ? <span className="tr-pill pass">● Complete</span> : !touched ? <span className="tr-pill none">Not enough evidence yet</span> : l.stale ? <span className="tr-pill warn">▲ {l.stale} need re-verify</span> : <span className="tr-pill warn">◐ In progress</span>}</td>
                      <td>{l.done} of {l.total}</td>
                      <td>{touched ? l.fails : '—'}</td>
                      <td><BadgeShield level={l.level} size={22} earned={l.state === 'complete'} /> {l.state === 'complete' ? 'Earned' : 'Not yet'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="tr-note">{BADGE_DISCLAIMER}</div>
        </section>

        <section className="tr-section">
          <h2>Strengths</h2>
          <div className="tr-card">{strengths.length ? <ul className="tr-list">{strengths.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="tr-empty" style={{ margin: 0 }}>Not enough evidence yet.</p>}</div>
        </section>

        <section className="tr-section">
          <h2>Gaps</h2>
          <div className="tr-card">
            {stale.length || struggled.length ? (
              <ul className="tr-list">
                {stale.map((r) => <li key={`s${r.t.id}`}><span className="tr-pill warn">▲ Re-verify</span> <b>{r.t.id}</b> {r.t.title}: a later change broke {r.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')}.</li>)}
                {struggled.map((r) => <li key={`f${r.t.id}`}><span className="tr-pill fail">✕ {r.fails} failed attempts</span> <b>{r.t.id}</b> {r.t.title}. Last: “{r.tp?.failures[r.tp.failures.length - 1]?.reason}”</li>)}
              </ul>
            ) : <p className="tr-empty" style={{ margin: 0 }}>{rows.some((r) => r.tp?.startedAt) ? 'No broken checks and no task needed more than one correction.' : 'Not enough evidence yet.'}</p>}
          </div>
        </section>

        <section className="tr-section">
          <h2>What to learn next</h2>
          <div className="tr-card">{learnNext.length ? <ul className="tr-list">{learnNext.map((s) => <li key={s}>{s}</li>)}</ul> : <p style={{ margin: 0 }}>The track is complete. Try it again in Practice mode, without values or highlights, to check what you can do unaided.</p>}</div>
        </section>

        <section className="tr-section">
          <h2>Evidence and notes</h2>
          <div className="tr-card">
            {notes.length ? <dl className="tr-evidence" style={{ margin: 0 }}>{notes.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl> : <p className="tr-empty" style={{ margin: 0 }}>No notes recorded.</p>}
            <ul className="tr-list" style={{ marginTop: 12, color: 'var(--tr-text-2)', fontSize: 13 }}>
              <li>Interfaces in use: {config.interfaces.filter((i) => i.zone).map((i) => `${i.name} (${i.zone}${i.mode === 'static' ? ` ${i.ip}` : ''})`).join(', ')}</li>
              <li>Custom access rules: {config.accessRules.filter((r) => !r.builtIn).length} ({config.accessRules.filter((r) => !r.builtIn && !r.enabled).length} disabled) · NAT policies: {config.natRules.length} · Site-to-site VPNs: {config.ipsec.filter((x) => x.kind === 'site').length}</li>
              <li>Security services: IPS {config.security.ips.enabled ? 'on' : 'off'}, GAV {config.security.gav.enabled ? 'on' : 'off'}, CFS {config.security.cfs.enabled ? 'on' : 'off'}, App Control {config.security.appControl.enabled ? 'on' : 'off'}, DPI-SSL {config.security.dpiSsl.clientEnabled ? 'on' : 'off'}, Botnet {config.security.botnet.enabled ? 'on' : 'off'}</li>
              <li>HA: {config.ha.mode === 'none' ? 'not configured' : `Active/Standby, ${config.ha.synced ? 'synchronized' : 'not synchronized'}`} · Syslog: {config.system.syslog.enabled ? `${config.system.syslog.server}:${config.system.syslog.port}` : 'off'}</li>
            </ul>
          </div>
        </section>

        <section className="tr-section">
          <h2>Task history</h2>
          <div className="tr-card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="tr-table">
              <thead><tr><th>Task</th><th>Result</th><th>Completed</th><th>Time</th><th>Failed attempts</th><th>Checks now</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.t.id}>
                    <td><b className="tr-mono">{r.t.id}</b> {r.t.title}</td>
                    <td>{r.ok ? <span className="tr-pill pass">● Verified</span> : r.status === 'stale' ? <span className="tr-pill warn">▲ Re-verify</span> : r.status === 'locked' ? <span className="tr-pill none">Locked</span> : r.tp?.startedAt ? <span className="tr-pill warn">◐ In progress</span> : <span className="tr-pill none">Not started</span>}</td>
                    <td>{r.tp?.completedAt ? fmtDate(r.tp.completedAt) : '—'}</td>
                    <td>{r.tp?.startedAt && r.tp.completedAt ? fmtDur(r.tp.completedAt - r.tp.startedAt) : '—'}</td>
                    <td>{r.fails ? <span className="tr-pill fail">{r.fails}</span> : r.tp?.startedAt ? 0 : '—'}</td>
                    <td>{r.checks.filter((c) => c.ok).length}/{r.checks.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="tr-honesty">
          <div>Generated from a browser simulation. All traffic, hosts and attacks were simulated; ThreatWall is a fictional appliance used for training.</div>
          <div>This is an internal training record, not a certification.</div>
        </div>
        <BrandFooter closing />
      </div>
    </div>
  );
}
