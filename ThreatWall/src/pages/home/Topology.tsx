import { useStore } from '../../state/store';
import { HOSTS } from '../../engine/world';
import { hostIface, hostNet, ifaceUp, hasAddress, haActiveUnit } from '../../engine/network';
import { maskToPrefix, networkOf } from '../../lib/ip';
import { ShieldMark } from '../../components/Logo';

/** Logical topology: firewall in the middle, each addressed interface with its zone, subnet and attached lab hosts. */
export function TopologyPage() {
  const { state, config } = useStore();
  const ifaces = config.interfaces.filter((i) => i.zone && i.kind !== 'mgmt');
  return (
    <div className="tw-page">
      <div className="tw-topo">
        <div className="tw-topo-fw">
          <ShieldMark size={30} />
          <div><b>{config.system.hostname}</b><div className="muted">{config.system.model} · {haActiveUnit(state) === 'secondary' ? 'HA secondary active' : 'primary'}</div></div>
        </div>
        <div className="tw-topo-grid">
          {ifaces.map((i) => {
            const up = ifaceUp(state, i);
            const hosts = HOSTS.filter((h) => hostIface(config, h)?.name === i.name);
            const wanUp = i.zone === 'WAN' ? state.lab.isp[i.name] !== 'down' : true;
            return (
              <div key={i.name} className={`tw-topo-if ${up.ok && wanUp ? 'up' : 'down'}`} data-guide={`topo:${i.name}`}>
                <div className="tw-topo-if-h"><b>{i.name}</b> <span className="tw-pill muted">{i.zone}</span>{i.kind === 'vlan' ? <span className="tw-pill info">VLAN {i.vlanId}</span> : null}</div>
                <div className="mono">{hasAddress(i) ? `${i.ip} · ${networkOf(i.ip, i.mask)}/${maskToPrefix(i.mask)}` : i.mode === 'dhcp' ? 'DHCP client' : 'no address'}</div>
                {i.zone === 'WAN' && hasAddress(i) ? <div className="muted">gateway {i.gateway} · ISP {wanUp ? 'up' : 'down'}</div> : null}
                {!up.ok ? <div className="tw-topo-bad">{up.reason}</div> : null}
                <ul>
                  {hosts.map((h) => { const n = hostNet(state, h); return <li key={h.id}>{h.name} <span className="mono muted">{n?.ip ?? 'no address'}</span></li>; })}
                  {i.zone === 'WAN' ? <li>Internet <span className="muted">(simulated, documentation ranges)</span></li> : null}
                </ul>
              </div>
            );
          })}
          <div className="tw-topo-if up">
            <div className="tw-topo-if-h"><b>Branch office</b> <span className="tw-pill muted">VPN</span></div>
            <div className="mono">{config.branch.hostname} · {config.branch.wanIp}</div>
            <ul><li>BRANCH-PC <span className="mono muted">192.168.20.10</span></li></ul>
          </div>
        </div>
      </div>
    </div>
  );
}
