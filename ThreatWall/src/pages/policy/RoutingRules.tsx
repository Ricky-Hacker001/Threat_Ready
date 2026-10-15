import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { RoutePolicy } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Toggle } from '../../components/ui';
import { AddressSelect, IfaceSelect, ServiceSelect } from '../../components/pickers';
import { builtInRoutes } from '../../engine/network';
import { blankRoute, deleteRoute, saveRoute, validateRoute } from '../../services/policyService';

export function RoutingRulesPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [edit, setEdit] = useState<{ r: RoutePolicy; originalId: string | null } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const bi = builtInRoutes(config);
  let n = 0;
  return (
    <div className="tw-page">
      <div className="tw-toolbar">
        <span className="muted">Route policies (Classic mode: POLICY › Rules and Policies › Route Policy). The most specific destination wins; connected and default routes are built from the interfaces.</span>
        <span className="spacer" />
        <button className="tw-tool" data-guide="add-route" onClick={() => setEdit({ r: blankRoute(), originalId: null })}><Plus size={15} /> Add</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Route policies">
          <thead><tr><th>#</th><th>Name</th><th>Source</th><th>Destination</th><th>Service</th><th>Interface / Path</th><th>Gateway</th><th>Metric</th><th>Hits</th><th>Enable</th><th>Class</th><th>Configure</th></tr></thead>
          <tbody>
            {config.routes.map((r) => (
              <tr key={r.id} className={r.enabled ? '' : 'disabled'} data-guide={`route:${r.name}`}>
                <td>{++n}</td><td><b>{r.name}</b></td><td>{r.src}</td><td>{r.dst}</td><td>{r.service}</td>
                <td>{r.type === 'sdwan' ? `SD-WAN: ${r.pathProfile}` : r.iface}</td><td className="mono">{r.type === 'sdwan' ? '—' : r.gateway}</td><td>{r.metric}</td><td className="mono">{r.hits}</td>
                <td><Toggle checked={r.enabled} label={`Enable ${r.name}`} onChange={(v) => { const s = saveRoute(config, { ...r, enabled: v }, r.id); commit(s.next, s.audit); }} /></td>
                <td>Custom</td>
                <td>
                  <button className="tw-rowbtn" aria-label={`Edit ${r.name}`} onClick={() => setEdit({ r: { ...r }, originalId: r.id })}><Pencil size={15} /></button>
                  <button className="tw-rowbtn" aria-label={`Delete ${r.name}`} onClick={() => setDel(r.id)}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
            {bi.map((r) => (
              <tr key={r.name} data-guide={`route:${r.name}`}>
                <td>{++n}</td><td><b>{r.name}</b></td><td>{r.src}</td><td>{r.dst}</td><td>Any</td><td>{r.iface}</td><td className="mono">{r.gateway}</td><td>{r.metric}</td><td className="mono">—</td>
                <td><span className="muted">auto</span></td><td>Default</td><td><span className="muted">—</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!bi.some((r) => r.name.startsWith('Default Route')) ? <Note kind="warn">No default route: no WAN interface has a static address and gateway. Internet traffic has nowhere to go (task 1.1 sets X1).</Note> : null}
      {edit && <RouteDialog initial={edit.r} originalId={edit.originalId} onClose={() => setEdit(null)} onSave={(r) => { const s = saveRoute(config, r, edit.originalId); commit(s.next, s.audit); toast(<>Route <b>{r.name}</b> saved.</>); setEdit(null); }} />}
      {del && <Confirm title="Delete route" danger confirmLabel="Delete" message="Delete this route policy?" onCancel={() => setDel(null)} onConfirm={() => { const s = deleteRoute(config, del); commit(s.next, s.audit); setDel(null); }} />}
    </div>
  );
}

function RouteDialog({ initial, originalId, onClose, onSave }: { initial: RoutePolicy; originalId: string | null; onClose: () => void; onSave: (r: RoutePolicy) => void }) {
  const { config } = useStore();
  const [r, setR] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('route', r);
  const errors = validateRoute(config, r, originalId);
  const e = tried ? errors : {};
  const set = <K extends keyof RoutePolicy>(k: K, v: RoutePolicy[K]) => setR((p) => ({ ...p, [k]: v }));
  return (
    <Dialog title={originalId ? `Edit Route - ${initial.name}` : 'Add Route Policy'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="route-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(r); }}>{originalId ? 'Save' : 'Add'}</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="rt-name" error={e.name}><input id="rt-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={r.name} onChange={(ev) => set('name', ev.target.value)} /></Row>
        <Row label="Source" htmlFor="rt-src" error={e.src}><AddressSelect cfg={config} id="rt-src" value={r.src} onChange={(v) => set('src', v)} /></Row>
        <Row label="Destination" htmlFor="rt-dst" error={e.dst}><AddressSelect cfg={config} id="rt-dst" value={r.dst} onChange={(v) => set('dst', v)} /></Row>
        <Row label="Service" htmlFor="rt-svc" error={e.service}><ServiceSelect cfg={config} id="rt-svc" value={r.service} onChange={(v) => set('service', v)} /></Row>
        <Row label="Route Type" htmlFor="rt-type">
          <select id="rt-type" className="tw-select" value={r.type} onChange={(ev) => set('type', ev.target.value as RoutePolicy['type'])}>
            <option value="standard">Standard Route</option><option value="sdwan">SD-WAN Route</option>
          </select>
        </Row>
        {r.type === 'standard' ? <>
          <Row label="Interface" htmlFor="rt-if" error={e.iface}><IfaceSelect cfg={config} id="rt-if" value={r.iface} onChange={(v) => set('iface', v)} onlyAddressed /></Row>
          <Row label="Gateway" htmlFor="rt-gw" error={e.gateway} hint="Next-hop router on that interface. Empty = directly connected."><input id="rt-gw" className={`tw-input mono${e.gateway ? ' invalid' : ''}`} value={r.gateway === '0.0.0.0' ? '' : r.gateway} onChange={(ev) => set('gateway', ev.target.value.trim())} /></Row>
        </> : (
          <Row label="Path Selection Profile" htmlFor="rt-pp" error={e.pathProfile}>
            <select id="rt-pp" className="tw-select" value={r.pathProfile} onChange={(ev) => set('pathProfile', ev.target.value)}>
              <option value="">— select —</option>
              {config.sdwan.profiles.map((p) => <option key={p.id}>{p.name}</option>)}
            </select>
          </Row>
        )}
        <Row label="Metric" htmlFor="rt-metric" error={e.metric}><input id="rt-metric" className="tw-input" style={{ width: 80 }} value={String(r.metric)} onChange={(ev) => set('metric', Number(ev.target.value.replace(/\D/g, '')) || 0)} /></Row>
        <Row label="Comment" htmlFor="rt-comment"><input id="rt-comment" className="tw-input wide" value={r.comment} onChange={(ev) => set('comment', ev.target.value)} /></Row>
      </div>
    </Dialog>
  );
}
