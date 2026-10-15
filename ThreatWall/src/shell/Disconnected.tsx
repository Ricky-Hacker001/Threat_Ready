import { PlugZap, Terminal } from 'lucide-react';
import { useStore } from '../state/store';
import { ui } from '../state/ui';
import { networkOf } from '../lib/ip';

/**
 * Shown over the GUI when the browser can no longer reach the management address — for example after re-addressing X0
 * (task 1.1). Nothing is fixed for the learner: they correct the PC in Lab Tools and browse to the new address.
 */
export function Disconnected({ detail }: { detail: string }) {
  const { config, session, commit, patchSession } = useStore();
  const d = session.disconnected;
  const iface = config.interfaces.find((i) => i.name === session.connectedVia);
  const expected = d?.expectedIp ?? '';
  const pcInSubnet = !!expected && !!iface && !!session.pc.ip && networkOf(session.pc.ip, iface.mask) === networkOf(expected, iface.mask);
  const noMgmtLeft = !config.interfaces.some((i) => i.zone && i.zone !== 'WAN' && i.mode === 'static' && i.mgmt.https && i.enabled);

  const consoleRecover = () => {
    if (!iface) return;
    const fixed = { ...iface, mgmt: { ...iface.mgmt, https: true }, enabled: true };
    commit({ ...config, interfaces: config.interfaces.map((i) => (i.name === iface.name ? fixed : i)) }, [
      { category: 'Network', action: `Interface ${iface.name} modified (serial console)`, detail: 'HTTPS management re-enabled from the console' },
    ]);
    if (d) patchSession({ disconnected: { ...d, expectedIp: fixed.ip } });
  };

  return (
    <div className="tw-disc" role="alertdialog" aria-labelledby="tw-disc-title">
      <div className="tw-disc-card">
        <PlugZap size={30} color="var(--tw-bad)" />
        <h2 id="tw-disc-title">Connection to {session.connectedIp} lost</h2>
        <p style={{ margin: '0 0 8px' }}>{d?.reason ?? ''} {detail}</p>
        <p style={{ margin: '0 0 8px' }}>
          Your browser manages the firewall through that address, so the page stopped answering the moment the change was saved. This is expected
          — it is how a real appliance behaves.
        </p>
        {expected ? (
          <ol style={{ margin: '0 0 10px', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>
              {pcInSubnet ? <>ADMIN-PC ({session.pc.ip}) is already in the new subnet.</> : <>Give ADMIN-PC an address in the new subnet (Lab Tools › PC Console). DHCP only helps if the scope was moved too; otherwise set a static address and gateway <b className="mono">{expected}</b>.</>}
            </li>
            <li>Type <b className="mono">https://{expected}</b> in the address bar and press Enter.</li>
          </ol>
        ) : null}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="tw-btn tw-btn-primary" onClick={() => ui.openLab('pc')}><Terminal size={13} style={{ verticalAlign: -2 }} /> Open PC Console</button>
          {noMgmtLeft && iface ? <button className="tw-btn" onClick={consoleRecover}>Connect serial console and re-enable HTTPS on {iface.name}</button> : null}
        </div>
      </div>
    </div>
  );
}
