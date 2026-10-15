import { useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { AddressGroup, AddressObject } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Tabs } from '../../components/ui';
import { builtInAddresses, builtInGroups, describeAddress } from '../../engine/objects';
import {
  addressCatalog, blankAddress, deleteAddresses, referencesOf, saveAddrGroup, saveAddress, validateAddrGroup, validateAddress,
} from '../../services/objectService';

type Tab = 'objects' | 'groups';
type View = 'all' | 'custom' | 'default';
const TYPE_LABEL: Record<AddressObject['type'], string> = { host: 'Host', range: 'Range', network: 'Network', fqdn: 'FQDN' };

export function AddressesPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('objects');
  const [view, setView] = useState<View>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ a: AddressObject; original: string | null } | null>(null);
  const [gedit, setGedit] = useState<{ g: AddressGroup; original: string | null } | null>(null);
  const [del, setDel] = useState<string[] | null>(null);

  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const objs = [
    ...(view !== 'custom' ? builtInAddresses(config).map((a) => ({ a, builtIn: true })) : []),
    ...(view !== 'default' ? config.addresses.map((a) => ({ a, builtIn: false })) : []),
  ].filter(({ a }) => match(a.name) || match(describeAddress(a)));
  const groups = [
    ...(view !== 'custom' ? builtInGroups(config).map((g) => ({ g: { id: g.name, name: g.name, members: g.members, comment: 'Default' }, builtIn: true })) : []),
    ...(view !== 'default' ? config.addressGroups.map((g) => ({ g, builtIn: false })) : []),
  ].filter(({ g }) => match(g.name) || g.members.some(match));

  const doDelete = () => {
    if (!del) return;
    const r = deleteAddresses(config, del);
    setDel(null);
    if (r.error) { toast(r.error, 'bad'); return; }
    commit(r.next, r.audit);
    setSel(new Set());
    toast(`${del.length} item(s) deleted.`);
  };

  const toggle = (n: string, on: boolean) => setSel((s) => { const x = new Set(s); if (on) x.add(n); else x.delete(n); return x; });

  return (
    <div className="tw-page">
      <Tabs<Tab> tabs={[{ id: 'objects', label: 'Address Objects' }, { id: 'groups', label: 'Address Groups' }]} value={tab} onChange={(t) => { setTab(t); setSel(new Set()); }} />
      <div className="tw-toolbar">
        <div className="tw-search"><Search size={14} color="var(--text-3)" /><input placeholder="Search..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search addresses" /></div>
        <select className="tw-select" value={view} onChange={(e) => setView(e.target.value as View)} aria-label="View" style={{ width: 150 }}>
          <option value="all">View: All</option><option value="custom">View: Custom</option><option value="default">View: Default</option>
        </select>
        <span className="spacer" />
        {tab === 'objects'
          ? <button className="tw-tool" data-guide="add-address" onClick={() => setEdit({ a: blankAddress(), original: null })}><Plus size={15} /> Add</button>
          : <button className="tw-tool" data-guide="add-group" onClick={() => setGedit({ g: { id: '', name: '', members: [], comment: '' }, original: null })}><Plus size={15} /> Add</button>}
        <button className="tw-tool" disabled={!sel.size} onClick={() => setDel([...sel])}><Trash2 size={14} /> Delete</button>
        <button className="tw-tool" onClick={() => { setQ(''); setSel(new Set()); }}><RefreshCw size={14} /> Refresh</button>
      </div>

      {tab === 'objects' ? (
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="Address objects">
            <thead><tr><th className="cb" /><th>#</th><th>Name</th><th>Details</th><th>Type</th><th>IP Version</th><th>Zone</th><th>References</th><th>Class</th><th>Configure</th></tr></thead>
            <tbody>
              {objs.map(({ a, builtIn }, n) => {
                const refs = referencesOf(config, a.name);
                return (
                  <tr key={a.id} className={sel.has(a.name) ? 'selected' : ''} data-guide={`row:${a.name}`}>
                    <td className="cb"><input type="checkbox" disabled={builtIn} checked={sel.has(a.name)} onChange={(e) => toggle(a.name, e.target.checked)} aria-label={`Select ${a.name}`} /></td>
                    <td>{n + 1}</td>
                    <td><b>{a.name}</b></td>
                    <td className="mono">{describeAddress(a)}</td>
                    <td>{TYPE_LABEL[a.type]}</td>
                    <td>{a.type === 'fqdn' ? 'IPv4' : 'IPv4'}</td>
                    <td>{a.zone}</td>
                    <td title={refs.join('\n') || undefined}>{refs.length || '—'}</td>
                    <td>{builtIn ? 'Default' : 'Custom'}</td>
                    <td>
                      {builtIn ? <span className="muted">—</span> : <>
                        <button className="tw-rowbtn" aria-label={`Edit ${a.name}`} onClick={() => setEdit({ a: { ...a }, original: a.name })}><Pencil size={15} /></button>
                        <button className="tw-rowbtn" aria-label={`Delete ${a.name}`} onClick={() => setDel([a.name])}><Trash2 size={15} /></button>
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="Address groups">
            <thead><tr><th className="cb" /><th>#</th><th>Name</th><th>Members</th><th>References</th><th>Class</th><th>Configure</th></tr></thead>
            <tbody>
              {groups.map(({ g, builtIn }, n) => (
                <tr key={g.name} className={sel.has(g.name) ? 'selected' : ''} data-guide={`row:${g.name}`}>
                  <td className="cb"><input type="checkbox" disabled={builtIn} checked={sel.has(g.name)} onChange={(e) => toggle(g.name, e.target.checked)} aria-label={`Select ${g.name}`} /></td>
                  <td>{n + 1}</td>
                  <td><b>{g.name}</b></td>
                  <td>{g.members.join(', ') || '—'}</td>
                  <td>{referencesOf(config, g.name).length || '—'}</td>
                  <td>{builtIn ? 'Default' : 'Custom'}</td>
                  <td>{builtIn ? <span className="muted">—</span> : <>
                    <button className="tw-rowbtn" aria-label={`Edit ${g.name}`} onClick={() => setGedit({ g: { ...g }, original: g.name })}><Pencil size={15} /></button>
                    <button className="tw-rowbtn" aria-label={`Delete ${g.name}`} onClick={() => setDel([g.name])}><Trash2 size={15} /></button>
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="tw-table-foot">Total: {tab === 'objects' ? objs.length : groups.length} item(s)</div>

      {edit && <AddressDialog initial={edit.a} original={edit.original} onClose={() => setEdit(null)} onSave={(a) => {
        const r = saveAddress(config, a, edit.original);
        commit(r.next, r.audit);
        toast(<>Address object <b>{a.name}</b> saved.</>);
        setEdit(null);
      }} />}
      {gedit && <GroupDialog initial={gedit.g} original={gedit.original} onClose={() => setGedit(null)} onSave={(g) => {
        const r = saveAddrGroup(config, g, gedit.original);
        commit(r.next, r.audit);
        toast(<>Address group <b>{g.name}</b> saved.</>);
        setGedit(null);
      }} />}
      {del && <Confirm title="Delete" danger confirmLabel="Delete" message={`Delete ${del.join(', ')}?`} onCancel={() => setDel(null)} onConfirm={doDelete} />}
    </div>
  );
}

function AddressDialog({ initial, original, onClose, onSave }: { initial: AddressObject; original: string | null; onClose: () => void; onSave: (a: AddressObject) => void }) {
  const { config } = useStore();
  const [a, setA] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('addr', a);
  const errors = validateAddress(config, a, original);
  const e = tried ? errors : {};
  const set = <K extends keyof AddressObject>(k: K, v: AddressObject[K]) => setA((p) => ({ ...p, [k]: v }));
  return (
    <Dialog title={original ? `Edit Address Object - ${original}` : 'Address Object Settings'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="addr-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(a); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 14 }}>
        <Row label="Name" htmlFor="ad-name" error={e.name}><input id="ad-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={a.name} onChange={(ev) => set('name', ev.target.value)} /></Row>
        <Row label="Zone Assignment" htmlFor="ad-zone" error={e.zone}>
          <select id="ad-zone" className="tw-select" value={a.zone} onChange={(ev) => set('zone', ev.target.value)}>
            {config.zones.map((z) => <option key={z.name}>{z.name}</option>)}
          </select>
        </Row>
        <Row label="Type" htmlFor="ad-type">
          <select id="ad-type" className="tw-select" value={a.type} onChange={(ev) => set('type', ev.target.value as AddressObject['type'])}>
            <option value="host">Host</option><option value="range">Range</option><option value="network">Network</option><option value="fqdn">FQDN</option>
          </select>
        </Row>
        {a.type === 'host' && <Row label="IP Address" htmlFor="ad-ip" error={e.ip}><input id="ad-ip" className={`tw-input mono${e.ip ? ' invalid' : ''}`} value={a.ip} onChange={(ev) => set('ip', ev.target.value.trim())} /></Row>}
        {a.type === 'range' && <>
          <Row label="Starting IP Address" htmlFor="ad-ip" error={e.ip}><input id="ad-ip" className={`tw-input mono${e.ip ? ' invalid' : ''}`} value={a.ip} onChange={(ev) => set('ip', ev.target.value.trim())} /></Row>
          <Row label="Ending IP Address" htmlFor="ad-ip2" error={e.ip2}><input id="ad-ip2" className={`tw-input mono${e.ip2 ? ' invalid' : ''}`} value={a.ip2} onChange={(ev) => set('ip2', ev.target.value.trim())} /></Row>
        </>}
        {a.type === 'network' && <>
          <Row label="Network" htmlFor="ad-ip" error={e.ip}><input id="ad-ip" className={`tw-input mono${e.ip ? ' invalid' : ''}`} value={a.ip} onChange={(ev) => set('ip', ev.target.value.trim())} /></Row>
          <Row label="Netmask/Prefix Length" htmlFor="ad-ip2" error={e.ip2}><input id="ad-ip2" className={`tw-input mono${e.ip2 ? ' invalid' : ''}`} value={a.ip2} onChange={(ev) => set('ip2', ev.target.value.trim())} /></Row>
        </>}
        {a.type === 'fqdn' && <Row label="FQDN Hostname" htmlFor="ad-fqdn" error={e.fqdn}><input id="ad-fqdn" className={`tw-input wide mono${e.fqdn ? ' invalid' : ''}`} value={a.fqdn} onChange={(ev) => set('fqdn', ev.target.value.trim())} /></Row>}
        <Row label="Comment" htmlFor="ad-comment"><input id="ad-comment" className="tw-input wide" value={a.comment} onChange={(ev) => set('comment', ev.target.value)} /></Row>
      </div>
      <Note kind="info">Naming convention used in this lab: <b>H_</b> host, <b>N_</b> network, <b>R_</b> range, <b>FQDN_</b> name, <b>G_</b> group.</Note>
    </Dialog>
  );
}

function GroupDialog({ initial, original, onClose, onSave }: { initial: AddressGroup; original: string | null; onClose: () => void; onSave: (g: AddressGroup) => void }) {
  const { config } = useStore();
  const [g, setG] = useState(initial);
  const [tried, setTried] = useState(false);
  const [pickL, setPickL] = useState<string[]>([]);
  const [pickR, setPickR] = useState<string[]>([]);
  useDraft('addrgroup', g);
  const errors = validateAddrGroup(config, g, original);
  const e = tried ? errors : {};
  const avail = addressCatalog(config).map((x) => x.name).filter((n) => n !== g.name && n !== original && !g.members.includes(n));
  return (
    <Dialog title={original ? `Edit Address Group - ${original}` : 'Address Group Settings'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="grp-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(g); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 14 }}>
        <Row label="Name" htmlFor="ag-name" error={e.name}><input id="ag-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={g.name} onChange={(ev) => setG({ ...g, name: ev.target.value })} /></Row>
      </div>
      <div className="tw-dual">
        <div>
          <div className="tw-dual-h">Not in group</div>
          <select id="ag-avail" multiple size={10} value={pickL} onChange={(ev) => setPickL([...ev.target.selectedOptions].map((o) => o.value))} aria-label="Available addresses">
            {avail.map((n) => <option key={n}>{n}</option>)}
          </select>
        </div>
        <div className="tw-dual-btns">
          <button className="tw-btn" data-guide="ag-add" disabled={!pickL.length} onClick={() => { setG({ ...g, members: [...g.members, ...pickL] }); setPickL([]); }} aria-label="Add to group"><ChevronRight size={15} /></button>
          <button className="tw-btn" disabled={!pickR.length} onClick={() => { setG({ ...g, members: g.members.filter((m) => !pickR.includes(m)) }); setPickR([]); }} aria-label="Remove from group"><ChevronLeft size={15} /></button>
        </div>
        <div>
          <div className="tw-dual-h">In group</div>
          <select id="ag-members" multiple size={10} value={pickR} onChange={(ev) => setPickR([...ev.target.selectedOptions].map((o) => o.value))} aria-label="Group members">
            {g.members.map((n) => <option key={n}>{n}</option>)}
          </select>
        </div>
      </div>
      {e.members ? <Note kind="bad">{e.members}</Note> : null}
    </Dialog>
  );
}
