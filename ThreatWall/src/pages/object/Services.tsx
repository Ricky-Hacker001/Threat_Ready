import { useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { Proto, Schedule, ServiceGroup, ServiceObject } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Tabs } from '../../components/ui';
import { DAY_NAMES } from '../../engine/objects';
import {
  blankSchedule, blankService, deleteSchedules, deleteServices, referencesOf, saveSchedule, saveService, saveSvcGroup, validateSchedule, validateService, validateSvcGroup,
} from '../../services/objectService';

type Tab = 'objects' | 'groups';
const portLabel = (s: ServiceObject) => (s.protocol === 'ICMP' || s.protocol === 'ESP' ? '—' : s.portStart === s.portEnd ? String(s.portStart) : `${s.portStart}-${s.portEnd}`);

export function ServicesPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('objects');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ s: ServiceObject; original: string | null } | null>(null);
  const [gedit, setGedit] = useState<{ g: ServiceGroup; original: string | null } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const m = (s: string) => s.toLowerCase().includes(q.toLowerCase());

  return (
    <div className="tw-page">
      <Tabs<Tab> tabs={[{ id: 'objects', label: 'Service Objects' }, { id: 'groups', label: 'Service Groups' }]} value={tab} onChange={setTab} />
      <div className="tw-toolbar">
        <div className="tw-search"><Search size={14} color="var(--text-3)" /><input placeholder="Search..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search services" /></div>
        <span className="spacer" />
        {tab === 'objects'
          ? <button className="tw-tool" data-guide="add-service" onClick={() => setEdit({ s: blankService(), original: null })}><Plus size={15} /> Add</button>
          : <button className="tw-tool" data-guide="add-svcgroup" onClick={() => setGedit({ g: { id: '', name: '', members: [], builtIn: false }, original: null })}><Plus size={15} /> Add</button>}
        <button className="tw-tool" onClick={() => setQ('')}><RefreshCw size={14} /> Refresh</button>
      </div>
      <div className="tw-table-wrap">
        {tab === 'objects' ? (
          <table className="tw-table" aria-label="Service objects">
            <thead><tr><th>#</th><th>Name</th><th>Protocol</th><th>Port Range</th><th>References</th><th>Class</th><th>Configure</th></tr></thead>
            <tbody>
              {config.services.filter((s) => m(s.name)).map((s, n) => (
                <tr key={s.id} data-guide={`row:${s.name}`}>
                  <td>{n + 1}</td><td><b>{s.name}</b></td><td>{s.protocol}</td><td className="mono">{portLabel(s)}</td>
                  <td>{referencesOf(config, s.name).length || '—'}</td><td>{s.builtIn ? 'Default' : 'Custom'}</td>
                  <td>{s.builtIn ? <span className="muted">—</span> : <>
                    <button className="tw-rowbtn" aria-label={`Edit ${s.name}`} onClick={() => setEdit({ s: { ...s }, original: s.name })}><Pencil size={15} /></button>
                    <button className="tw-rowbtn" aria-label={`Delete ${s.name}`} onClick={() => setDel(s.name)}><Trash2 size={15} /></button>
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="tw-table" aria-label="Service groups">
            <thead><tr><th>#</th><th>Name</th><th>Members</th><th>References</th><th>Class</th><th>Configure</th></tr></thead>
            <tbody>
              {config.serviceGroups.filter((g) => m(g.name) || g.members.some(m)).map((g, n) => (
                <tr key={g.id} data-guide={`row:${g.name}`}>
                  <td>{n + 1}</td><td><b>{g.name}</b></td><td>{g.members.join(', ')}</td><td>{referencesOf(config, g.name).length || '—'}</td><td>{g.builtIn ? 'Default' : 'Custom'}</td>
                  <td>{g.builtIn ? <span className="muted">—</span> : <>
                    <button className="tw-rowbtn" aria-label={`Edit ${g.name}`} onClick={() => setGedit({ g: { ...g }, original: g.name })}><Pencil size={15} /></button>
                    <button className="tw-rowbtn" aria-label={`Delete ${g.name}`} onClick={() => setDel(g.name)}><Trash2 size={15} /></button>
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {edit && <ServiceDialog initial={edit.s} original={edit.original} onClose={() => setEdit(null)} onSave={(s) => { const r = saveService(config, s, edit.original); commit(r.next, r.audit); toast(<>Service <b>{s.name}</b> saved.</>); setEdit(null); }} />}
      {gedit && <SvcGroupDialog initial={gedit.g} original={gedit.original} onClose={() => setGedit(null)} onSave={(g) => { const r = saveSvcGroup(config, g, gedit.original); commit(r.next, r.audit); toast(<>Service group <b>{g.name}</b> saved.</>); setGedit(null); }} />}
      {del && <Confirm title="Delete service" danger confirmLabel="Delete" message={`Delete ${del}?`} onCancel={() => setDel(null)} onConfirm={() => {
        const r = deleteServices(config, [del]); setDel(null);
        if (r.error) toast(r.error, 'bad'); else { commit(r.next, r.audit); toast('Deleted.'); }
      }} />}
    </div>
  );
}

function ServiceDialog({ initial, original, onClose, onSave }: { initial: ServiceObject; original: string | null; onClose: () => void; onSave: (s: ServiceObject) => void }) {
  const { config } = useStore();
  const [s, setS] = useState({ ...initial, start: initial.portStart ? String(initial.portStart) : '', end: initial.portEnd ? String(initial.portEnd) : '' });
  const [tried, setTried] = useState(false);
  const obj: ServiceObject = { id: s.id, name: s.name, protocol: s.protocol, portStart: Number(s.start) || 0, portEnd: Number(s.end || s.start) || 0, builtIn: false };
  useDraft('service', obj);
  const errors = validateService(config, obj, original);
  const e = tried ? errors : {};
  const ports = s.protocol === 'TCP' || s.protocol === 'UDP';
  return (
    <Dialog title={original ? `Edit Service - ${original}` : 'Service Object Settings'} size="sm" onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="svc-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(obj); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 14 }}>
        <Row label="Name" htmlFor="sv-name" error={e.name}><input id="sv-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={s.name} onChange={(ev) => setS({ ...s, name: ev.target.value })} /></Row>
        <Row label="Protocol" htmlFor="sv-proto">
          <select id="sv-proto" className="tw-select" value={s.protocol} onChange={(ev) => setS({ ...s, protocol: ev.target.value as Proto })}>
            <option>TCP</option><option>UDP</option><option>ICMP</option><option>ESP</option>
          </select>
        </Row>
        {ports && <>
          <Row label="Port Range Start" htmlFor="sv-start" error={e.portStart}><input id="sv-start" className={`tw-input${e.portStart ? ' invalid' : ''}`} inputMode="numeric" value={s.start} onChange={(ev) => setS({ ...s, start: ev.target.value.replace(/\D/g, '') })} style={{ width: 100 }} /></Row>
          <Row label="Port Range End" htmlFor="sv-end" error={e.portEnd} hint="Leave empty for a single port."><input id="sv-end" className={`tw-input${e.portEnd ? ' invalid' : ''}`} inputMode="numeric" value={s.end} onChange={(ev) => setS({ ...s, end: ev.target.value.replace(/\D/g, '') })} style={{ width: 100 }} /></Row>
        </>}
      </div>
    </Dialog>
  );
}

function SvcGroupDialog({ initial, original, onClose, onSave }: { initial: ServiceGroup; original: string | null; onClose: () => void; onSave: (g: ServiceGroup) => void }) {
  const { config } = useStore();
  const [g, setG] = useState(initial);
  const [tried, setTried] = useState(false);
  const [pickL, setPickL] = useState<string[]>([]);
  const [pickR, setPickR] = useState<string[]>([]);
  useDraft('svcgroup', g);
  const errors = validateSvcGroup(config, g, original);
  const e = tried ? errors : {};
  const avail = [...config.serviceGroups.map((x) => x.name), ...config.services.map((x) => x.name)].filter((n) => n !== g.name && n !== original && !g.members.includes(n));
  return (
    <Dialog title={original ? `Edit Service Group - ${original}` : 'Service Group Settings'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="sg-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(g); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 14 }}>
        <Row label="Name" htmlFor="sg-name" error={e.name}><input id="sg-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={g.name} onChange={(ev) => setG({ ...g, name: ev.target.value })} /></Row>
      </div>
      <div className="tw-dual">
        <div><div className="tw-dual-h">Not in group</div>
          <select id="sg-avail" multiple size={10} value={pickL} onChange={(ev) => setPickL([...ev.target.selectedOptions].map((o) => o.value))} aria-label="Available services">{avail.map((n) => <option key={n}>{n}</option>)}</select></div>
        <div className="tw-dual-btns">
          <button className="tw-btn" data-guide="sg-add" disabled={!pickL.length} onClick={() => { setG({ ...g, members: [...g.members, ...pickL] }); setPickL([]); }} aria-label="Add to group"><ChevronRight size={15} /></button>
          <button className="tw-btn" disabled={!pickR.length} onClick={() => { setG({ ...g, members: g.members.filter((m) => !pickR.includes(m)) }); setPickR([]); }} aria-label="Remove from group"><ChevronLeft size={15} /></button>
        </div>
        <div><div className="tw-dual-h">In group</div>
          <select id="sg-members" multiple size={10} value={pickR} onChange={(ev) => setPickR([...ev.target.selectedOptions].map((o) => o.value))} aria-label="Group members">{g.members.map((n) => <option key={n}>{n}</option>)}</select></div>
      </div>
      {e.members ? <Note kind="bad">{e.members}</Note> : null}
      <Note kind="info">Tip: DNS needs both TCP and UDP port 53. Use the built-in group <b>DNS (Name Service)</b> rather than one protocol.</Note>
    </Dialog>
  );
}

/* ============================== Schedules ============================== */

export function SchedulesPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [edit, setEdit] = useState<{ s: Schedule; original: string | null } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  return (
    <div className="tw-page">
      <div className="tw-toolbar">
        <span className="muted">Schedules are evaluated in the firewall’s time zone ({config.system.timezone}).</span>
        <span className="spacer" />
        <button className="tw-tool" data-guide="add-schedule" onClick={() => setEdit({ s: blankSchedule(), original: null })}><Plus size={15} /> Add</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Schedules">
          <thead><tr><th>#</th><th>Name</th><th>Days</th><th>Start</th><th>End</th><th>References</th><th>Class</th><th>Configure</th></tr></thead>
          <tbody>
            {config.schedules.map((s, n) => (
              <tr key={s.id} data-guide={`row:${s.name}`}>
                <td>{n + 1}</td><td><b>{s.name}</b></td><td>{s.days.map((d) => DAY_NAMES[d]).join(', ')}</td><td className="mono">{s.start}</td><td className="mono">{s.end}</td>
                <td>{referencesOf(config, s.name).length || '—'}</td><td>{s.builtIn ? 'Default' : 'Custom'}</td>
                <td>{s.builtIn ? <span className="muted">—</span> : <>
                  <button className="tw-rowbtn" aria-label={`Edit ${s.name}`} onClick={() => setEdit({ s: { ...s }, original: s.name })}><Pencil size={15} /></button>
                  <button className="tw-rowbtn" aria-label={`Delete ${s.name}`} onClick={() => setDel(s.name)}><Trash2 size={15} /></button>
                </>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <ScheduleDialog initial={edit.s} original={edit.original} onClose={() => setEdit(null)} onSave={(s) => { const r = saveSchedule(config, s, edit.original); commit(r.next, r.audit); toast(<>Schedule <b>{s.name}</b> saved.</>); setEdit(null); }} />}
      {del && <Confirm title="Delete schedule" danger confirmLabel="Delete" message={`Delete ${del}?`} onCancel={() => setDel(null)} onConfirm={() => {
        const r = deleteSchedules(config, [del]); setDel(null);
        if (r.error) toast(r.error, 'bad'); else { commit(r.next, r.audit); toast('Deleted.'); }
      }} />}
    </div>
  );
}

function ScheduleDialog({ initial, original, onClose, onSave }: { initial: Schedule; original: string | null; onClose: () => void; onSave: (s: Schedule) => void }) {
  const { config } = useStore();
  const [s, setS] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('schedule', s);
  const errors = validateSchedule(config, s, original);
  const e = tried ? errors : {};
  return (
    <Dialog title={original ? `Edit Schedule - ${original}` : 'Add Schedule'} size="sm" onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="sch-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(s); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 14 }}>
        <Row label="Name" htmlFor="sc-name" error={e.name}><input id="sc-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={s.name} onChange={(ev) => setS({ ...s, name: ev.target.value })} /></Row>
        <Row label="Days" error={e.days}>
          <div className="tw-checks" id="sc-days">
            {DAY_NAMES.map((d, i) => (
              <label key={d}><input type="checkbox" data-guide={`sc-day-${d}`} checked={s.days.includes(i)} onChange={(ev) => setS({ ...s, days: ev.target.checked ? [...s.days, i] : s.days.filter((x) => x !== i) })} /> {d}</label>
            ))}
          </div>
        </Row>
        <Row label="Start Time" htmlFor="sc-start" error={e.start}><input id="sc-start" className={`tw-input mono${e.start ? ' invalid' : ''}`} value={s.start} onChange={(ev) => setS({ ...s, start: ev.target.value.trim() })} placeholder="09:00" style={{ width: 90 }} /></Row>
        <Row label="End Time" htmlFor="sc-end" error={e.end}><input id="sc-end" className={`tw-input mono${e.end ? ' invalid' : ''}`} value={s.end} onChange={(ev) => setS({ ...s, end: ev.target.value.trim() })} placeholder="19:00" style={{ width: 90 }} /></Row>
      </div>
    </Dialog>
  );
}
