import { useState } from 'react';
import { ArrowDown, ArrowUp, Eraser, FileText, Pencil, Plus, RefreshCw, Search, Trash2, TriangleAlert } from 'lucide-react';
import type { AccessRule } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Tabs, Toggle } from '../../components/ui';
import { AddressSelect, GroupSelect, ScheduleSelect, ServiceSelect, ZoneSelect } from '../../components/pickers';
import { autoRules, shadowedBy } from '../../engine/rules';
import { blankRule, deleteRules, moveRule, resetHits, ruleWarnings, saveRule, toggleRule, validateRule } from '../../services/policyService';

const ACTION: Record<AccessRule['action'], { label: string; cls: string }> = { allow: { label: 'Allow', cls: 'ok' }, deny: { label: 'Deny', cls: 'bad' }, discard: { label: 'Discard', cls: 'bad' } };

export function AccessRulesPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [from, setFrom] = useState('All');
  const [to, setTo] = useState('All');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ r: AccessRule; originalId: string | null } | null>(null);
  const [pending, setPending] = useState<{ r: AccessRule; originalId: string | null; pos: 'top' | 'bottom'; warnings: string[] } | null>(null);
  const [del, setDel] = useState<string[] | null>(null);
  const [clear, setClear] = useState(false);

  const all = [...config.accessRules, ...autoRules(config)];
  const rows = all.filter((r) => (from === 'All' || r.fromZone === from) && (to === 'All' || r.toZone === to))
    .filter((r) => !q || [r.name, r.src, r.dst, r.service, r.comment].some((x) => x.toLowerCase().includes(q.toLowerCase())));
  const prio = (r: AccessRule) => all.filter((x) => x.fromZone === r.fromZone && x.toZone === r.toZone).findIndex((x) => x.id === r.id) + 1;

  const doSave = (r: AccessRule, originalId: string | null, pos: 'top' | 'bottom') => {
    const res = saveRule(config, r, originalId, pos);
    commit(res.next, res.audit);
    toast(<>Access rule <b>{r.name}</b> saved.</>);
    setEdit(null);
    setPending(null);
  };

  return (
    <div className="tw-page">
      <div className="tw-toolbar">
        <label className="tw-inline">From <ZoneSelect cfg={config} id="ar-from" guide="ar-filter-from" value={from} onChange={setFrom} all="All" /></label>
        <label className="tw-inline">To <ZoneSelect cfg={config} id="ar-to" guide="ar-filter-to" value={to} onChange={setTo} all="All" /></label>
        <div className="tw-search"><Search size={14} color="var(--text-3)" /><input placeholder="Search..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search rules" /></div>
        <span className="spacer" />
        <button className="tw-tool" data-guide="add-rule" onClick={() => setEdit({ r: blankRule(from === 'All' ? 'LAN' : from, to === 'All' ? 'WAN' : to), originalId: null })}><Plus size={15} /> Add</button>
        <button className="tw-tool" disabled={!sel.size} onClick={() => setDel([...sel])}><Trash2 size={14} /> Delete</button>
        <button className="tw-tool" onClick={() => setClear(true)}><Eraser size={14} /> Clear Statistics</button>
        <button className="tw-tool" onClick={() => setQ('')}><RefreshCw size={14} /> Refresh</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Access rules">
          <thead>
            <tr>
              <th className="cb" /><th>#</th><th>Priority</th><th>Name</th><th>From</th><th>To</th><th>Source</th><th>Destination</th><th>Service</th><th>Action</th>
              <th>Users Incl.</th><th>Schedule</th><th>Hits</th><th>Enable</th><th>Comment</th><th>Configure</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, n) => {
              const auto = !!r.auto;
              const shadow = !auto && r.enabled ? shadowedBy(config, r) : null;
              const p = prio(r);
              const pairLen = config.accessRules.filter((x) => x.fromZone === r.fromZone && x.toZone === r.toZone).length;
              return (
                <tr key={r.id} className={`${sel.has(r.id) ? 'selected' : ''}${r.enabled ? '' : ' disabled'}${auto ? ' auto' : ''}`} data-guide={`rule:${r.name}`}>
                  <td className="cb"><input type="checkbox" disabled={r.builtIn} checked={sel.has(r.id)} onChange={(e) => setSel((s) => { const x = new Set(s); if (e.target.checked) x.add(r.id); else x.delete(r.id); return x; })} aria-label={`Select ${r.name}`} /></td>
                  <td>{n + 1}</td>
                  <td className="nowrap">
                    {p}
                    {!auto ? <>
                      <button className="tw-rowbtn" disabled={p <= 1} aria-label={`Move ${r.name} up`} data-guide={`up:${r.name}`} onClick={() => { const m = moveRule(config, r.id, -1); if (m) commit(m.next, m.audit); }}><ArrowUp size={13} /></button>
                      <button className="tw-rowbtn" disabled={p >= pairLen} aria-label={`Move ${r.name} down`} data-guide={`down:${r.name}`} onClick={() => { const m = moveRule(config, r.id, 1); if (m) commit(m.next, m.audit); }}><ArrowDown size={13} /></button>
                    </> : null}
                  </td>
                  <td>
                    <b>{r.name}</b>
                    {shadow ? <span className="tw-shadow" title={`Never matches: rule “${shadow.name}” above already matches all of its traffic.`}><TriangleAlert size={12} /> shadowed</span> : null}
                    {auto ? <span className="tw-pill muted" style={{ marginLeft: 6 }}>auto</span> : null}
                  </td>
                  <td>{r.fromZone}</td><td>{r.toZone}</td><td>{r.src}</td><td>{r.dst}</td><td>{r.service}</td>
                  <td><span className={`tw-pill ${ACTION[r.action].cls}`}>{ACTION[r.action].label}</span></td>
                  <td>{r.usersIncl}</td><td>{r.schedule}</td><td className="mono">{r.hits}</td>
                  <td>{auto ? <span className="muted">—</span> : <Toggle checked={r.enabled} label={`Enable ${r.name}`} onChange={(v) => { const t = toggleRule(config, r.id, v); commit(t.next, t.audit); }} />}</td>
                  <td title={r.comment || undefined}>{r.comment ? <FileText size={14} color="var(--text-3)" /> : ''}</td>
                  <td>{auto ? <span className="muted" title="Created by a VPN feature">—</span> : <>
                    <button className="tw-rowbtn" aria-label={`Edit ${r.name}`} data-guide={`edit:${r.name}`} onClick={() => setEdit({ r: { ...r }, originalId: r.id })}><Pencil size={15} /></button>
                    {!r.builtIn ? <button className="tw-rowbtn" aria-label={`Delete ${r.name}`} onClick={() => setDel([r.id])}><Trash2 size={15} /></button> : null}
                  </>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="tw-table-foot">Total: {rows.length} rule(s) · rules are evaluated top-down within each zone pair; the first match wins.</div>

      {edit && <RuleDialog initial={edit.r} originalId={edit.originalId} onClose={() => setEdit(null)} onSave={(r, pos) => {
        const w = ruleWarnings(config, r);
        if (w.length) setPending({ r, originalId: edit.originalId, pos, warnings: w });
        else doSave(r, edit.originalId, pos);
      }} />}
      {pending && <Confirm title="Review this rule" confirmLabel="Save anyway" onCancel={() => setPending(null)} onConfirm={() => doSave(pending.r, pending.originalId, pending.pos)}
        message={<>{pending.warnings.map((w) => <p key={w} style={{ margin: '4px 0' }}>• {w}</p>)}</>} />}
      {del && <Confirm title="Delete rules" danger confirmLabel="Delete" message={`Delete ${del.length} rule(s)?`} onCancel={() => setDel(null)} onConfirm={() => {
        const r = deleteRules(config, del); setDel(null);
        if (r.error) toast(r.error, 'bad'); else { commit(r.next, r.audit); setSel(new Set()); toast('Deleted.'); }
      }} />}
      {clear && <Confirm title="Clear statistics" confirmLabel="Clear" message="Reset hit counters on every access rule?" onCancel={() => setClear(false)} onConfirm={() => { const r = resetHits(config); commit(r.next, r.audit); setClear(false); }} />}
    </div>
  );
}

function RuleDialog({ initial, originalId, onClose, onSave }: { initial: AccessRule; originalId: string | null; onClose: () => void; onSave: (r: AccessRule, pos: 'top' | 'bottom') => void }) {
  const { config } = useStore();
  const [r, setR] = useState(initial);
  const [tab, setTab] = useState<'general' | 'users'>('general');
  const [pos, setPos] = useState<'top' | 'bottom'>('top');
  const [tried, setTried] = useState(false);
  useDraft('rule', r);
  const errors = validateRule(config, r, originalId);
  const e = tried ? errors : {};
  const set = <K extends keyof AccessRule>(k: K, v: AccessRule[K]) => setR((p) => ({ ...p, [k]: v }));
  return (
    <Dialog title={originalId ? `Edit Rule - ${initial.name}` : 'Add Rule'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="rule-save" onClick={() => { setTried(true); if (Object.keys(errors).length) { if (errors.usersIncl || errors.usersExcl) setTab('users'); return; } onSave(r, pos); }}>{originalId ? 'Save' : 'Add'}</button>
    </>}>
      <Tabs<'general' | 'users'> tabs={[{ id: 'general', label: 'General' }, { id: 'users', label: 'Users' }]} value={tab} onChange={setTab} variant="sub" />
      {tab === 'general' ? (
        <div className="tw-form" style={{ paddingTop: 12 }}>
          <Row label="Action">
            <div className="tw-checks" role="radiogroup" aria-label="Action">
              {(['allow', 'deny', 'discard'] as const).map((a) => <label key={a}><input type="radio" name="ar-action" data-guide={`ar-action-${a}`} checked={r.action === a} onChange={() => set('action', a)} /> {ACTION[a].label}</label>)}
            </div>
          </Row>
          <Row label="Name" htmlFor="ar-name" error={e.name}><input id="ar-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={r.name} disabled={r.builtIn} onChange={(ev) => set('name', ev.target.value)} /></Row>
          <Row label="From Zone" htmlFor="ar-fz" error={e.fromZone}><ZoneSelect cfg={config} id="ar-fz" value={r.fromZone} onChange={(v) => set('fromZone', v)} disabled={r.builtIn} /></Row>
          <Row label="To Zone" htmlFor="ar-tz" error={e.toZone}><ZoneSelect cfg={config} id="ar-tz" value={r.toZone} onChange={(v) => set('toZone', v)} disabled={r.builtIn} /></Row>
          <Row label="Source Address" htmlFor="ar-src" error={e.src}><AddressSelect cfg={config} id="ar-src" value={r.src} onChange={(v) => set('src', v)} invalid={!!e.src} /></Row>
          <Row label="Destination Address" htmlFor="ar-dst" error={e.dst}><AddressSelect cfg={config} id="ar-dst" value={r.dst} onChange={(v) => set('dst', v)} invalid={!!e.dst} /></Row>
          <Row label="Service" htmlFor="ar-svc" error={e.service}><ServiceSelect cfg={config} id="ar-svc" value={r.service} onChange={(v) => set('service', v)} invalid={!!e.service} /></Row>
          <Row label="Schedule" htmlFor="ar-sch" error={e.schedule}><ScheduleSelect cfg={config} id="ar-sch" value={r.schedule} onChange={(v) => set('schedule', v)} /></Row>
          <Row label="Comment" htmlFor="ar-comment"><input id="ar-comment" className="tw-input wide" value={r.comment} onChange={(ev) => set('comment', ev.target.value)} /></Row>
          <Row label="Enable Logging"><Toggle id="ar-log" checked={r.logging} onChange={(v) => set('logging', v)} label="Enable logging" /></Row>
          <Row label="Enable Rule"><Toggle id="ar-enable" checked={r.enabled} onChange={(v) => set('enabled', v)} label="Enable rule" /></Row>
          {!originalId ? (
            <Row label="Position" htmlFor="ar-pos">
              <select id="ar-pos" className="tw-select" value={pos} onChange={(ev) => setPos(ev.target.value as 'top' | 'bottom')}>
                <option value="top">Top of {r.fromZone}→{r.toZone}</option>
                <option value="bottom">Above the default rule (bottom of custom rules)</option>
              </select>
            </Row>
          ) : null}
        </div>
      ) : (
        <div className="tw-form" style={{ paddingTop: 12 }}>
          <Row label="Users Included" htmlFor="ar-uin" hint="Anyone not authenticated as a member is redirected to the user login page (if enabled on the interface)."><GroupSelect cfg={config} id="ar-uin" value={r.usersIncl} onChange={(v) => set('usersIncl', v)} any="All" /></Row>
          <Row label="Users Excluded" htmlFor="ar-uex"><GroupSelect cfg={config} id="ar-uex" value={r.usersExcl} onChange={(v) => set('usersExcl', v)} any="None" /></Row>
        </div>
      )}
      {r.builtIn ? <Note kind="info">Default rule: zones and name are fixed. You can change its action, objects and state.</Note> : null}
    </Dialog>
  );
}
