import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Note, Row, Section, Toggle } from '../../components/ui';
import { inSubnet, isIPv4 } from '../../lib/ip';
import { hasAddress } from '../../engine/network';

export function SyslogPage() {
  const { config, commit, emit } = useStore();
  const toast = useToast();
  const saved = JSON.stringify(config.system.syslog);
  const [s, setS] = useState(config.system.syslog);
  useEffect(() => { setS(JSON.parse(saved)); }, [saved]);
  useDraft('syslog', s);
  const err = s.enabled && !isIPv4(s.server) ? 'Enter the syslog server IP address.' : s.enabled && !(s.port >= 1 && s.port <= 65535) ? 'Port 1–65535.' : '';
  const reachable = isIPv4(s.server) && config.interfaces.some((i) => hasAddress(i) && i.zone !== 'WAN' && inSubnet(s.server, i.ip, i.mask));
  return (
    <div className="tw-page">
      <Section title="Syslog Servers">
        <div className="tw-form">
          <Row label="Send logs to a syslog server"><Toggle id="sl-enable" checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} label="Enable syslog" /></Row>
          <Row label="Server IP" htmlFor="sl-server" error={s.enabled && !isIPv4(s.server) ? 'Required' : undefined}><input id="sl-server" className="tw-input mono" value={s.server} onChange={(e) => setS({ ...s, server: e.target.value.trim() })} placeholder="192.168.10.250" /></Row>
          <Row label="Port" htmlFor="sl-port"><input id="sl-port" className="tw-input" style={{ width: 80 }} value={String(s.port)} onChange={(e) => setS({ ...s, port: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></Row>
          <Row label="Format"><span className="val">Default (RFC 5424)</span></Row>
        </div>
      </Section>
      <Note kind="info">Logs kept only on the firewall vanish when it is replaced or wiped — exactly when an investigator needs them. The lab syslog server is a simulated collector on the LAN.</Note>
      <div className="tw-actionbar">
        {err ? <span className="tw-err-text">{err}</span> : null}
        <button className="tw-btn" disabled={!config.system.syslog.enabled} data-guide="syslog-test" onClick={() => { const ok = reachable; emit('syslog-test', { ok, server: config.system.syslog.server }); toast(ok ? `Test message delivered to ${config.system.syslog.server}:${config.system.syslog.port} (simulated).` : 'No route to the syslog server from an internal interface.', ok ? 'ok' : 'bad'); }}><Send size={13} style={{ verticalAlign: -2 }} /> Send test message</button>
        <button className="tw-btn" disabled={saved === JSON.stringify(s)} onClick={() => setS(JSON.parse(saved))}>Cancel</button>
        <button className="tw-btn tw-btn-primary" data-guide="accept" disabled={saved === JSON.stringify(s) || !!err} onClick={() => {
          commit({ ...config, system: { ...config.system, syslog: s } }, [{ category: 'System', action: 'Syslog settings modified', detail: s.enabled ? `Sending to ${s.server}:${s.port}` : 'Syslog disabled' }]);
          toast('Syslog settings saved.');
        }}>Accept</button>
      </div>
    </div>
  );
}
