import { useState } from 'react';
import { Download, Play, Square, Trash2 } from 'lucide-react';
import type { PacketMonitorState } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { Row, Section, Toggle } from '../../components/ui';
import { localTime } from '../../engine/objects';

export function PacketMonitorPage() {
  const { state, config, update, emit, addAudit } = useStore();
  const pm = state.pm;
  const [f, setF] = useState<PacketMonitorState['filter']>(pm.filter);
  const [sel, setSel] = useState<string | null>(null);
  useDraft('pm', { ...f, capturing: pm.capturing, packets: pm.packets.length });
  const setPm = (p: Partial<PacketMonitorState>) => update((s) => ({ ...s, pm: { ...s.pm, ...p } }));
  const start = () => { setPm({ filter: f, capturing: true }); emit('pm', { action: 'start', ...f }); addAudit([{ category: 'System', action: 'Packet capture started', detail: `src ${f.src || 'any'}, dst ${f.dst || 'any'}, port ${f.dstPort || 'any'}` }]); };
  const stop = () => { setPm({ capturing: false }); emit('pm', { action: 'stop', packets: pm.packets.length }); };
  const exportCap = () => {
    const lines = ['time,ingress,egress,src,srcPort,dst,dstPort,proto,status,reason,rule,nat', ...pm.packets.map((p) => [new Date(p.ts).toISOString(), p.ingress, p.egress, p.src, p.srcPort, p.dst, p.dstPort, p.proto, p.status, p.reason, p.rule, p.nat].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'threatwall-lab-capture.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    emit('pm-export', { packets: pm.packets.length, dropped: pm.packets.filter((p) => p.status === 'dropped').length, forwarded: pm.packets.filter((p) => p.status === 'forwarded').length });
    addAudit([{ category: 'System', action: 'Packet capture exported', detail: `${pm.packets.length} packets` }]);
  };
  const p = pm.packets.find((x) => x.id === sel);
  return (
    <div className="tw-page">
      <Section title="Monitor Filter">
        <div className="tw-form">
          <Row label="Source IP Address(es)" htmlFor="pm-src"><input id="pm-src" className="tw-input mono" value={f.src} onChange={(e) => setF({ ...f, src: e.target.value.trim() })} placeholder="any" /></Row>
          <Row label="Destination IP Address(es)" htmlFor="pm-dst"><input id="pm-dst" className="tw-input mono" value={f.dst} onChange={(e) => setF({ ...f, dst: e.target.value.trim() })} placeholder="any" /></Row>
          <Row label="Destination Port(s)" htmlFor="pm-port"><input id="pm-port" className="tw-input mono" style={{ width: 90 }} value={f.dstPort} onChange={(e) => setF({ ...f, dstPort: e.target.value.trim() })} placeholder="any" /></Row>
          <Row label="Ether Type" htmlFor="pm-eth"><select id="pm-eth" className="tw-select" value={f.etherType} onChange={(e) => setF({ ...f, etherType: e.target.value as typeof f.etherType })}><option>IP</option><option>ARP</option><option>Any</option></select></Row>
          <Row label="Monitor Dropped / Forwarded / Consumed">
            <div className="tw-checks">
              <Toggle id="pm-dropped" checked={f.dropped} onChange={(v) => setF({ ...f, dropped: v })} label="Dropped" /> Dropped
              <Toggle checked={f.forwarded} onChange={(v) => setF({ ...f, forwarded: v })} label="Forwarded" /> Forwarded
              <Toggle checked={f.consumed} onChange={(v) => setF({ ...f, consumed: v })} label="Consumed" /> Consumed
            </div>
          </Row>
        </div>
      </Section>
      <div className="tw-toolbar">
        {pm.capturing
          ? <button className="tw-tool" data-guide="pm-stop" onClick={stop}><Square size={14} /> Stop Capture</button>
          : <button className="tw-tool" data-guide="pm-start" onClick={start}><Play size={14} /> Start Capture</button>}
        <span className={`tw-pill ${pm.capturing ? 'ok' : 'muted'}`}>{pm.capturing ? 'capturing' : 'stopped'}</span>
        <span className="muted">{pm.packets.length} packet(s) in buffer · send lab traffic while capturing</span>
        <span className="spacer" />
        <button className="tw-tool" data-guide="pm-export" disabled={!pm.packets.length} onClick={exportCap}><Download size={14} /> Export</button>
        <button className="tw-tool" onClick={() => { setPm({ packets: [] }); setSel(null); }}><Trash2 size={14} /> Clear</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Captured packets">
          <thead><tr><th>#</th><th>Time</th><th>Ingress</th><th>Egress</th><th>Source</th><th>Destination</th><th>Protocol</th><th>Status</th><th>Reason</th></tr></thead>
          <tbody>
            {pm.packets.map((x, n) => (
              <tr key={x.id} className={`${sel === x.id ? 'selected' : ''}${x.status === 'dropped' ? ' alert' : ''}`} onClick={() => setSel(x.id)} style={{ cursor: 'pointer' }} data-guide={`pkt:${x.status}`}>
                <td>{n + 1}</td><td className="nowrap">{localTime(x.ts, config.system.timezone).label}</td><td>{x.ingress}</td><td>{x.egress}</td>
                <td className="mono">{x.src}:{x.srcPort}</td><td className="mono">{x.dst}:{x.dstPort}</td><td>{x.proto}</td>
                <td>{x.status === 'dropped' ? <span className="tw-pill bad">DROPPED</span> : x.status === 'consumed' ? <span className="tw-pill info">CONSUMED</span> : <span className="tw-pill ok">FORWARDED</span>}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 240 }}>{x.reason || (x.rule ? `rule ${x.rule}` : '')}</td>
              </tr>
            ))}
            {!pm.packets.length ? <tr><td colSpan={9} className="muted">No packets. Set a filter, Start Capture, then send traffic from Lab Tools.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {p ? (
        <Section title="Packet detail">
          <div className="tw-term" style={{ margin: '0 14px 10px' }}>{[
            `Flow:        ${p.flowLabel}`, `Ingress:     ${p.ingress}`, `Egress:      ${p.egress}`, `Source:      ${p.src}:${p.srcPort}`, `Destination: ${p.dst}:${p.dstPort} (${p.proto})`,
            `Status:      ${p.status.toUpperCase()}`, ...(p.reason ? [`Drop code:   ${p.reason}`] : []), `Access rule: ${p.rule || '—'}`, `NAT policy:  ${p.nat || '—'}`,
          ].join('\n')}</div>
        </Section>
      ) : null}
    </div>
  );
}
