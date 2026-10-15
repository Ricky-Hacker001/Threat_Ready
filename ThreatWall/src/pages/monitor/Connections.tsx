import { useStore } from '../../state/store';
import { localTime } from '../../engine/objects';

/** Recent connections the firewall forwarded (from the lab's traffic logs). */
export function ConnectionsPage() {
  const { state, config } = useStore();
  const rows = state.pm.packets.filter((p) => p.status === 'forwarded' || p.status === 'consumed').slice(0, 200);
  return (
    <div className="tw-page">
      <div className="tw-toolbar"><span className="muted">Connections seen by the packet engine (most recent first). Start Packet Monitor capture to record more detail.</span></div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Connections">
          <thead><tr><th>Time</th><th>Source</th><th>Src Port</th><th>Destination</th><th>Dst Port</th><th>Protocol</th><th>In</th><th>Out</th><th>Rule</th><th>NAT</th></tr></thead>
          <tbody>
            {rows.map((p) => <tr key={p.id}><td>{localTime(p.ts, config.system.timezone).label}</td><td className="mono">{p.src}</td><td>{p.srcPort}</td><td className="mono">{p.dst}</td><td>{p.dstPort}</td><td>{p.proto}</td><td>{p.ingress}</td><td>{p.egress}</td><td>{p.rule}</td><td>{p.nat}</td></tr>)}
            {!rows.length ? <tr><td colSpan={10} className="muted">No connections yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
