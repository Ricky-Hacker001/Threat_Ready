import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import type { PathProfile, SdwanGroup, SlaProbe } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Dialog, Note, Row, Section, Toggle } from '../../components/ui';
import { WAN_LATENCY, probeStatus, sdwanChoose, wanLinkUp, wanPathUp } from '../../engine/network';
import { saveProbe, saveProfile, saveSdGroup, validateProbe, validateProfile, validateSdGroup } from '../../services/vpnService';

const wans = (cfg: ReturnType<typeof useStore>['config']) => cfg.interfaces.filter((i) => i.zone === 'WAN').map((i) => i.name);

/* ---------- Groups ---------- */
export function SdwanGroupsPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [edit, setEdit] = useState<SdwanGroup | null>(null);
  return (
    <div className="tw-page">
      <div className="tw-toolbar"><span className="muted">An SD-WAN group lists the WAN links that can carry the same traffic, in priority order.</span><span className="spacer" />
        <button className="tw-tool" data-guide="add-sdgroup" onClick={() => setEdit({ id: '', name: '', members: [] })}><Plus size={15} /> Add</button></div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="SD-WAN groups">
          <thead><tr><th>Name</th><th>Members (priority order)</th><th>Configure</th></tr></thead>
          <tbody>{config.sdwan.groups.map((g) => <tr key={g.id}><td><b>{g.name}</b></td><td>{g.members.join(' → ')}</td><td><button className="tw-rowbtn" aria-label={`Edit ${g.name}`} onClick={() => setEdit({ ...g })}><Pencil size={15} /></button></td></tr>)}
            {!config.sdwan.groups.length ? <tr><td colSpan={3} className="muted">No groups.</td></tr> : null}</tbody>
        </table>
      </div>
      {edit && <GroupDialog initial={edit} onClose={() => setEdit(null)} onSave={(g) => { const r = saveSdGroup(config, g); commit(r.next, r.audit); toast(<>SD-WAN group <b>{g.name}</b> saved.</>); setEdit(null); }} />}
    </div>
  );
}

function GroupDialog({ initial, onClose, onSave }: { initial: SdwanGroup; onClose: () => void; onSave: (g: SdwanGroup) => void }) {
  const { config } = useStore();
  const [g, setG] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('sdgroup', g);
  const errors = validateSdGroup(config, g);
  const e = tried ? errors : {};
  return (
    <Dialog title={initial.id ? `Edit SD-WAN Group - ${initial.name}` : 'Add SD-WAN Group'} size="sm" onClose={onClose} footer={<><button className="tw-btn" onClick={onClose}>Cancel</button><button className="tw-btn tw-btn-primary" data-guide="sdgroup-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(g); }}>Save</button></>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="sg2-name" error={e.name}><input id="sg2-name" className="tw-input" value={g.name} onChange={(ev) => setG({ ...g, name: ev.target.value })} /></Row>
        <Row label="Members" error={e.members} hint="Tick in priority order: the first healthy member is used.">
          <div className="tw-checks" id="sg2-members">{wans(config).map((w) => <label key={w}><input type="checkbox" data-guide={`sdm-${w}`} checked={g.members.includes(w)} onChange={(ev) => setG({ ...g, members: ev.target.checked ? [...g.members, w] : g.members.filter((x) => x !== w) })} /> {w}</label>)}</div>
        </Row>
      </div>
      {wans(config).length < 2 ? <Note kind="warn">Only one WAN interface exists. Configure X3 in the WAN zone first.</Note> : null}
    </Dialog>
  );
}

/* ---------- Probes ---------- */
export function SlaProbesPage() {
  const { state, config, commit } = useStore();
  const toast = useToast();
  const [edit, setEdit] = useState<SlaProbe | null>(null);
  return (
    <div className="tw-page">
      <div className="tw-toolbar"><span className="muted">A probe pings a target through each link. Link up ≠ internet up: only a probe sees an upstream ISP failure.</span><span className="spacer" />
        <button className="tw-tool" data-guide="add-probe" onClick={() => setEdit({ id: '', name: '', target: '', ifaces: [], intervalSec: 3, enabled: true })}><Plus size={15} /> Add</button></div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="SLA probes">
          <thead><tr><th>Name</th><th>Target</th><th>Interfaces</th><th>Interval</th><th>Status</th><th>Configure</th></tr></thead>
          <tbody>{config.sdwan.probes.map((p) => <tr key={p.id}><td><b>{p.name}</b></td><td className="mono">{p.target}</td><td>{p.ifaces.join(', ')}</td><td>{p.intervalSec}s</td>
            <td>{p.ifaces.map((i) => { const st = probeStatus(state, p.name, i); return <span key={i} className={`tw-pill ${st === 'up' ? 'ok' : 'bad'}`} style={{ marginRight: 4 }}>{i} {st}</span>; })}</td>
            <td><button className="tw-rowbtn" aria-label={`Edit ${p.name}`} onClick={() => setEdit({ ...p })}><Pencil size={15} /></button></td></tr>)}
            {!config.sdwan.probes.length ? <tr><td colSpan={6} className="muted">No probes.</td></tr> : null}</tbody>
        </table>
      </div>
      {edit && <ProbeDialog initial={edit} onClose={() => setEdit(null)} onSave={(p) => { const r = saveProbe(config, p); commit(r.next, r.audit); toast(<>Probe <b>{p.name}</b> saved.</>); setEdit(null); }} />}
    </div>
  );
}

function ProbeDialog({ initial, onClose, onSave }: { initial: SlaProbe; onClose: () => void; onSave: (p: SlaProbe) => void }) {
  const { config } = useStore();
  const [p, setP] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('probe', p);
  const errors = validateProbe(config, p);
  const e = tried ? errors : {};
  return (
    <Dialog title={initial.id ? `Edit Probe - ${initial.name}` : 'Add SLA Probe'} size="sm" onClose={onClose} footer={<><button className="tw-btn" onClick={onClose}>Cancel</button><button className="tw-btn tw-btn-primary" data-guide="probe-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(p); }}>Save</button></>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="pr-name" error={e.name}><input id="pr-name" className="tw-input" value={p.name} onChange={(ev) => setP({ ...p, name: ev.target.value })} /></Row>
        <Row label="Probe Type"><span className="val">Ping (ICMP)</span></Row>
        <Row label="Probe Target" htmlFor="pr-target" error={e.target}><input id="pr-target" className="tw-input mono" value={p.target} onChange={(ev) => setP({ ...p, target: ev.target.value.trim() })} /></Row>
        <Row label="Probe from" error={e.ifaces}><div className="tw-checks" id="pr-ifaces">{wans(config).map((w) => <label key={w}><input type="checkbox" data-guide={`pri-${w}`} checked={p.ifaces.includes(w)} onChange={(ev) => setP({ ...p, ifaces: ev.target.checked ? [...p.ifaces, w] : p.ifaces.filter((x) => x !== w) })} /> {w}</label>)}</div></Row>
        <Row label="Interval (seconds)" htmlFor="pr-int" error={e.intervalSec}><input id="pr-int" className="tw-input" style={{ width: 80 }} value={String(p.intervalSec)} onChange={(ev) => setP({ ...p, intervalSec: Number(ev.target.value.replace(/\D/g, '')) || 0 })} /></Row>
        <Row label="Enable"><Toggle checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} label="Enable probe" /></Row>
      </div>
    </Dialog>
  );
}

/* ---------- Path selection profiles ---------- */
export function PathProfilesPage() {
  const { state, config, commit } = useStore();
  const toast = useToast();
  const [edit, setEdit] = useState<PathProfile | null>(null);
  return (
    <div className="tw-page">
      <div className="tw-toolbar"><span className="muted">A profile picks the first group member that meets the SLA, using the probe’s results.</span><span className="spacer" />
        <button className="tw-tool" data-guide="add-pathprof" onClick={() => setEdit({ id: '', name: '', group: config.sdwan.groups[0]?.name ?? '', probe: config.sdwan.probes[0]?.name ?? '', maxLatencyMs: 50, maxLossPct: 5, backup: '', enabled: true })}><Plus size={15} /> Add</button></div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Path selection profiles">
          <thead><tr><th>Name</th><th>Group</th><th>Probe</th><th>SLA</th><th>Backup</th><th>Selected path now</th><th>Configure</th></tr></thead>
          <tbody>{config.sdwan.profiles.map((p) => { const c = sdwanChoose(state, p.name); return <tr key={p.id}><td><b>{p.name}</b></td><td>{p.group}</td><td>{p.probe}</td><td>≤{p.maxLatencyMs} ms, ≤{p.maxLossPct}% loss</td><td>{p.backup || '—'}</td>
            <td>{c.iface ? <span className="tw-pill ok">{c.iface}</span> : <span className="tw-pill bad">none</span>} <span className="muted" style={{ fontSize: 11.5 }}>{c.reason}</span></td>
            <td><button className="tw-rowbtn" aria-label={`Edit ${p.name}`} onClick={() => setEdit({ ...p })}><Pencil size={15} /></button></td></tr>; })}
            {!config.sdwan.profiles.length ? <tr><td colSpan={7} className="muted">No profiles.</td></tr> : null}</tbody>
        </table>
      </div>
      {edit && <PathDialog initial={edit} onClose={() => setEdit(null)} onSave={(p) => { const r = saveProfile(config, p); commit(r.next, r.audit); toast(<>Profile <b>{p.name}</b> saved.</>); setEdit(null); }} />}
    </div>
  );
}

function PathDialog({ initial, onClose, onSave }: { initial: PathProfile; onClose: () => void; onSave: (p: PathProfile) => void }) {
  const { config } = useStore();
  const [p, setP] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('pathprof', p);
  const errors = validateProfile(config, p);
  const e = tried ? errors : {};
  return (
    <Dialog title={initial.id ? `Edit Path Selection Profile - ${initial.name}` : 'Add Path Selection Profile'} size="sm" onClose={onClose} footer={<><button className="tw-btn" onClick={onClose}>Cancel</button><button className="tw-btn tw-btn-primary" data-guide="pathprof-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(p); }}>Save</button></>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="pp-name" error={e.name}><input id="pp-name" className="tw-input" value={p.name} onChange={(ev) => setP({ ...p, name: ev.target.value })} /></Row>
        <Row label="SD-WAN Group" htmlFor="pp-group" error={e.group}><select id="pp-group" className="tw-select" value={p.group} onChange={(ev) => setP({ ...p, group: ev.target.value })}><option value="">— select —</option>{config.sdwan.groups.map((g) => <option key={g.id}>{g.name}</option>)}</select></Row>
        <Row label="SLA Probe" htmlFor="pp-probe" error={e.probe}><select id="pp-probe" className="tw-select" value={p.probe} onChange={(ev) => setP({ ...p, probe: ev.target.value })}><option value="">— select —</option>{config.sdwan.probes.map((g) => <option key={g.id}>{g.name}</option>)}</select></Row>
        <Row label="Max latency (ms)" htmlFor="pp-lat" error={e.maxLatencyMs}><input id="pp-lat" className="tw-input" style={{ width: 80 }} value={String(p.maxLatencyMs)} onChange={(ev) => setP({ ...p, maxLatencyMs: Number(ev.target.value.replace(/\D/g, '')) || 0 })} /></Row>
        <Row label="Max packet loss (%)" htmlFor="pp-loss"><input id="pp-loss" className="tw-input" style={{ width: 80 }} value={String(p.maxLossPct)} onChange={(ev) => setP({ ...p, maxLossPct: Number(ev.target.value.replace(/\D/g, '')) || 0 })} /></Row>
        <Row label="Backup interface" htmlFor="pp-backup"><select id="pp-backup" className="tw-select" value={p.backup} onChange={(ev) => setP({ ...p, backup: ev.target.value })}><option value="">None</option>{wans(config).map((w) => <option key={w}>{w}</option>)}</select></Row>
      </div>
    </Dialog>
  );
}

/* ---------- NETWORK › System › Failover & LB ---------- */
export function FailoverPage() {
  const { state, config } = useStore();
  return (
    <div className="tw-page">
      <Section title="WAN link health">
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="WAN health">
            <thead><tr><th>Interface</th><th>Address</th><th>Gateway</th><th>Physical link</th><th>Upstream (probe view)</th><th>Typical latency</th></tr></thead>
            <tbody>{config.interfaces.filter((i) => i.zone === 'WAN').map((i) => <tr key={i.name}><td><b>{i.name}</b></td><td className="mono">{i.mode === 'static' ? `${i.ip}/${i.mask}` : i.mode}</td><td className="mono">{i.gateway}</td>
              <td>{wanLinkUp(state, i.name) ? <span className="tw-pill ok">up</span> : <span className="tw-pill bad">down</span>}</td>
              <td>{wanPathUp(state, i.name) ? <span className="tw-pill ok">reachable</span> : <span className="tw-pill bad">unreachable</span>}</td><td>{WAN_LATENCY[i.name] ?? '—'} ms</td></tr>)}</tbody>
          </table>
        </div>
      </Section>
      <Note kind="info">Without SD-WAN, internet traffic always uses the first WAN default route — even when its ISP is down but the cable is up. Task 3.5 adds probe-based failover.</Note>
    </div>
  );
}
