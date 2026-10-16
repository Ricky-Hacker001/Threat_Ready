/**
 * Lab Tools: the "physical world" around the simulated firewall.
 *  - PC Console: ADMIN-PC cable, adapter settings and a small Windows-style command prompt (simulated; nothing runs on the host OS).
 *  - Traffic Tester: send a simulated flow from any lab host and see the verdict and trace.
 *  - Lab Hosts: who is where, with what address.
 *  - Lab Controls: ISP links, switch trunk, HA unit power, client CA trust, NetExtender, user logins, lab clock.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Cable, FlaskConical, Send, X } from 'lucide-react';
import { useStore } from '../state/store';
import { ui, useDraft, useUi } from '../state/ui';
import type { Proto, RootState } from '../state/types';
import { HOSTS, APPS, SITES, hostById } from '../engine/world';
import { hostNet, pcLease, ifaceUp, hostIface, haActiveUnit } from '../engine/network';
import { evaluate, VERDICT_LABEL, type FlowResult, type FlowSpec } from '../engine/traffic';
import { DAY_NAMES, labNow, localTime, tsAt, findAddress } from '../engine/objects';
import { isIPv4, isMask, inSubnet } from '../lib/ip';
import { hashPassword, labTotp } from '../lib/hash';
import { LAB } from '../state/baseline';

export const LAB_TABS = [
  { id: 'pc', label: 'PC Console' },
  { id: 'traffic', label: 'Traffic Tester' },
  { id: 'hosts', label: 'Lab Hosts' },
  { id: 'controls', label: 'Lab Controls' },
] as const;

export function LabTools() {
  const u = useUi();
  return (
    <section className={`tw-lab${u.labOpen ? ' open' : ''}`} aria-label="Lab Tools">
      <div className="tw-lab-bar">
        <button className="tw-lab-toggle" data-guide="labtools" onClick={() => (u.labOpen ? ui.closeLab() : ui.openLab())} aria-expanded={u.labOpen}>
          <FlaskConical size={14} /> Lab Tools {u.labOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        {u.labOpen ? (
          <div className="tw-lab-tabs" role="tablist">
            {LAB_TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={u.labTab === t.id} data-guide={`labtab:${t.id}`} className={u.labTab === t.id ? 'on' : ''} onClick={() => ui.setLabTab(t.id)}>{t.label}</button>
            ))}
          </div>
        ) : <span className="tw-lab-sub">PC console · traffic tester · lab hosts · lab controls (simulated)</span>}
        {u.labOpen ? <button className="tw-lab-x" onClick={() => ui.closeLab()} aria-label="Close Lab Tools"><X size={15} /></button> : null}
      </div>
      {u.labOpen ? (
        <div className="tw-lab-body">
          {u.labTab === 'pc' && <PcConsole />}
          {u.labTab === 'traffic' && <TrafficTester />}
          {u.labTab === 'hosts' && <LabHosts />}
          {u.labTab === 'controls' && <LabControlsTab />}
        </div>
      ) : null}
    </section>
  );
}

/* =============================== PC Console =============================== */

const PROMPT = 'C:\\Users\\admin>';

function PcConsole() {
  const { state, session, patchSession, sendFlow, emit } = useStore();
  const pc = session.pc;
  const [lines, setLines] = useState<string[]>(['ADMIN-PC command console [ThreatReady lab simulation]', 'Type help for the commands this lab supports.', '']);
  const [cmd, setCmd] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const [form, setForm] = useState({ mode: pc.mode, ip: pc.mode === 'static' ? pc.ip : '', mask: pc.mode === 'static' ? pc.mask : '255.255.255.0', gateway: pc.mode === 'static' ? pc.gateway : '', dns: pc.mode === 'static' ? pc.dns : '' });
  const [formErr, setFormErr] = useState('');
  useDraft('pc-form', form);
  const termRef = useRef<HTMLDivElement>(null);
  useEffect(() => { termRef.current?.scrollTo(0, termRef.current.scrollHeight); }, [lines]);

  const out = (...l: string[]) => setLines((x) => [...x, ...l].slice(-400));

  const lease = (st: RootState) => pcLease(st);

  const plug = () => {
    const cabled = !pc.cabled;
    let next = { ...pc, cabled };
    if (!cabled) next = { ...next, ...(pc.mode === 'dhcp' ? { ip: '', mask: '', gateway: '', dns: '' } : {}) };
    else if (pc.mode === 'dhcp') {
      const l = lease({ ...state, session: { ...session, pc: next } });
      if (l) next = { ...next, ip: l.ip, mask: l.mask, gateway: l.gateway, dns: l.dns };
    }
    patchSession({ pc: next });
    emit('pc', { action: 'cable', cabled });
    out(cabled ? `[Ethernet cable connected: ADMIN-PC ↔ firewall ${'X0'}]` : '[Ethernet cable unplugged]', '');
  };

  const applyAdapter = (e: FormEvent) => {
    e.preventDefault();
    setFormErr('');
    if (form.mode === 'dhcp') {
      let next = { ...pc, mode: 'dhcp' as const, ip: '', mask: '', gateway: '', dns: '' };
      const l = pc.cabled ? lease({ ...state, session: { ...session, pc: next } }) : null;
      if (l) next = { ...next, ip: l.ip, mask: l.mask, gateway: l.gateway, dns: l.dns };
      patchSession({ pc: next });
      emit('pc', { action: 'adapter', mode: 'dhcp', ip: next.ip });
      out(`[Adapter set to obtain an address automatically${l ? ` — got ${l.ip}` : ' — no DHCP answer'}]`, '');
      return;
    }
    if (!isIPv4(form.ip)) return setFormErr('Enter a valid IPv4 address.');
    if (!isMask(form.mask)) return setFormErr('Enter a valid subnet mask.');
    if (form.gateway && !isIPv4(form.gateway)) return setFormErr('Default gateway must be an IPv4 address.');
    if (form.gateway && !inSubnet(form.gateway, form.ip, form.mask)) return setFormErr('The default gateway is not in the same subnet as the IP address.');
    if (form.dns && !isIPv4(form.dns)) return setFormErr('DNS server must be an IPv4 address.');
    patchSession({ pc: { ...pc, mode: 'static', ip: form.ip, mask: form.mask, gateway: form.gateway, dns: form.dns } });
    emit('pc', { action: 'adapter', mode: 'static', ip: form.ip, mask: form.mask, gateway: form.gateway, dns: form.dns });
    out(`[Adapter set to static ${form.ip} ${form.mask}, gateway ${form.gateway || 'none'}, DNS ${form.dns || 'none'}]`, '');
  };

  const run = (raw: string) => {
    const line = raw.trim();
    out(`${PROMPT}${line}`);
    if (!line) return;
    setHist((h) => [...h, line].slice(-50));
    setHi(-1);
    const [c0, ...args] = line.split(/\s+/);
    const c = c0.toLowerCase();
    const a = args.join(' ');
    const rec = (data: Record<string, unknown>) => emit('console', { cmd: c, arg: a, ...data });

    if (c === 'cls' || c === 'clear') { setLines([]); return; }
    if (c === 'help' || c === '?') {
      out('  ipconfig [/all]        show the adapter address', '  ipconfig /release      give the DHCP address back', '  ipconfig /renew        ask the DHCP server for an address',
        '  ping <host|ip>         ICMP echo (4 packets)', '  nslookup <name>        resolve a name with the PC’s DNS server', '  curl <url>             fetch a web page (http/https)',
        '  cls                    clear the screen', '  Commands are simulated by the lab. Nothing runs on your computer.', '');
      rec({ ok: true });
      return;
    }
    if (c === 'ipconfig') {
      const sw = a.toLowerCase();
      if (sw === '/release') {
        if (!pc.cabled) { out('', 'An error occurred while releasing interface Ethernet : The media is disconnected.', ''); rec({ ok: false }); return; }
        if (pc.mode !== 'dhcp') { out('', 'The operation failed as no adapter is in the state permissible for this operation.', ''); rec({ ok: false }); return; }
        patchSession({ pc: { ...pc, ip: '', mask: '', gateway: '', dns: '' } });
        out('', 'Ethernet adapter Ethernet:', '   IPv4 Address released.', ''); rec({ ok: true });
        return;
      }
      if (sw === '/renew') {
        if (!pc.cabled) { out('', 'An error occurred while renewing interface Ethernet : The media is disconnected.', ''); rec({ ok: false }); return; }
        if (pc.mode !== 'dhcp') { out('', 'The operation failed as no adapter is in the state permissible for this operation.', '(The adapter has a static address. Switch it to DHCP first.)', ''); rec({ ok: false }); return; }
        const l = lease(state);
        if (!l) {
          patchSession({ pc: { ...pc, ip: '', mask: '', gateway: '', dns: '' } });
          out('', 'An error occurred while renewing interface Ethernet : unable to contact your DHCP server. Request has timed out.', '');
          rec({ ok: false });
          return;
        }
        patchSession({ pc: { ...pc, ip: l.ip, mask: l.mask, gateway: l.gateway, dns: l.dns } });
        out('', 'Ethernet adapter Ethernet:', `   IPv4 Address. . . . . . . . . . . : ${l.ip}`, `   Subnet Mask . . . . . . . . . . . : ${l.mask}`, `   Default Gateway . . . . . . . . . : ${l.gateway}`, '');
        rec({ ok: true, ip: l.ip });
        return;
      }
      out('', 'Ethernet adapter Ethernet:', '');
      if (!pc.cabled) out('   Media State . . . . . . . . . . . : Media disconnected', '');
      else if (!pc.ip) out('   Autoconfiguration IPv4 Address. . : 169.254.31.7', '   Subnet Mask . . . . . . . . . . . : 255.255.0.0', '   Default Gateway . . . . . . . . . :', '   (No DHCP answer — this is an APIPA address, not usable on the network.)', '');
      else {
        if (sw === '/all') out(`   Physical Address. . . . . . . . . : ${pc.mac.toUpperCase().replace(/:/g, '-')}`, `   DHCP Enabled. . . . . . . . . . . : ${pc.mode === 'dhcp' ? 'Yes' : 'No'}`);
        out(`   IPv4 Address. . . . . . . . . . . : ${pc.ip}`, `   Subnet Mask . . . . . . . . . . . : ${pc.mask}`, `   Default Gateway . . . . . . . . . : ${pc.gateway}`);
        if (sw === '/all') out(`   DNS Servers . . . . . . . . . . . : ${pc.dns || '(none)'}`);
        out('');
      }
      rec({ ok: !!(pc.cabled && pc.ip), ip: pc.ip });
      return;
    }
    if (c === 'ping') {
      if (!a) { out('Usage: ping <host or IP>', ''); return; }
      const r = sendFlow({ from: 'admin', to: a, proto: 'ICMP', port: 0, label: `ping ${a}` }, { tag: 'console' });
      if (r.verdict === 'dns-failure') out(`Ping request could not find host ${a}. Please check the name and try again.`, `   (${r.reason})`, '');
      else if (r.verdict === 'no-address') out('PING: transmit failed. General failure.', `   (${r.reason})`, '');
      else {
        out('', `Pinging ${a}${isIPv4(a) ? '' : ` [${r.dstIp}]`} with 32 bytes of data:`);
        const ms = r.egress === 'firewall' || r.verdict === 'consumed' ? '<1ms' : `${r.egress === 'X3' ? 28 : 12}ms`;
        for (let i = 0; i < 4; i++) out(r.ok ? `Reply from ${r.dstIp}: bytes=32 time${ms.startsWith('<') ? ms : `=${ms}`} TTL=${r.verdict === 'consumed' ? 64 : 117}` : r.verdict === 'invalid-route' ? `Reply from ${pc.ip}: Destination host unreachable.` : 'Request timed out.');
        out('', `Ping statistics for ${r.dstIp || a}:`, `    Packets: Sent = 4, Received = ${r.ok ? 4 : r.verdict === 'invalid-route' ? 4 : 0}, Lost = ${r.ok ? 0 : r.verdict === 'invalid-route' ? 0 : 4} (${r.ok ? 0 : r.verdict === 'invalid-route' ? 0 : 100}% loss)`);
        if (!r.ok) out(`   (Lab: ${VERDICT_LABEL[r.verdict]} — ${r.reason})`);
        out('');
      }
      rec({ ok: r.ok, verdict: r.verdict, dst: r.dstIp });
      return;
    }
    if (c === 'nslookup') {
      if (!a) { out('Usage: nslookup <name>', ''); return; }
      const server = pc.dns || '(none)';
      const r = evaluate(state, { from: 'admin', to: a, proto: 'UDP', port: 53 }).result;
      const dnsStep = r.trace.find((t) => t.stage === 'DNS');
      out(`Server:  ${server}`, `Address:  ${server}`, '');
      if (isIPv4(a)) {
        const site = SITES.find((x) => x.ip === a);
        out(site ? `Name:    ${site.name}` : `*** ${server} can't find ${a}: Non-existent domain`, site ? `Address:  ${a}` : '', '');
        rec({ ok: !!site });
        return;
      }
      const ok = !!dnsStep?.ok && !!r.dstIp;
      if (ok) out('Non-authoritative answer:', `Name:    ${a}`, `Address:  ${r.dstIp}`, '');
      else out(`DNS request timed out.`, `*** Request to ${server} timed-out`, `   (Lab: ${dnsStep?.detail ?? r.reason})`, '');
      rec({ ok, ip: r.dstIp });
      return;
    }
    if (c === 'curl') {
      const m = /^(https?):\/\/([^/:\s]+)(?::(\d+))?/i.exec(a) ?? /^()([^/:\s]+)(?::(\d+))?/.exec(a);
      if (!a || !m) { out('Usage: curl https://www.search.example', ''); return; }
      const https = (m[1] || 'http').toLowerCase() === 'https';
      const port = m[3] ? Number(m[3]) : https ? 443 : 80;
      const r = sendFlow({ from: 'admin', to: m[2], proto: 'TCP', port, tls: https, label: `curl ${a}` }, { tag: 'console' });
      if (r.ok) out(`HTTP/1.1 200 OK   (${r.dstName} ${r.dstIp}${r.certIssuer ? `, certificate issued by ${r.certIssuer}` : ''})`, '');
      else if (r.blockPage) out('HTTP/1.1 403 Forbidden', r.blockPage, '');
      else out(`curl: (${r.verdict === 'dns-failure' ? 6 : r.verdict === 'cert-error' ? 60 : 28}) ${r.verdict === 'dns-failure' ? `Could not resolve host: ${m[2]}` : r.verdict === 'cert-error' ? 'SSL certificate problem: unable to get local issuer certificate' : 'Connection timed out'}`, `   (Lab: ${VERDICT_LABEL[r.verdict]} — ${r.reason})`, '');
      rec({ ok: r.ok, verdict: r.verdict });
      return;
    }
    out(`'${c0}' is not recognized in this lab. Type help.`, '');
  };

  return (
    <div className="tw-pc">
      <div className="tw-pc-side">
        <div className="tw-pc-card">
          <div className="tw-pc-title"><Cable size={14} /> ADMIN-PC <span className="mono muted">{pc.mac}</span></div>
          <button className={`tw-btn${pc.cabled ? '' : ' tw-btn-primary'}`} data-guide="pc-cable" onClick={plug}>
            {pc.cabled ? 'Unplug cable from X0' : 'Plug cable into firewall X0'}
          </button>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{pc.cabled ? `Link up · ${pc.ip ? `${pc.ip} (${pc.mode === 'dhcp' ? 'DHCP' : 'static'})` : 'no IP address'}` : 'No link'}</div>
        </div>
        <form className="tw-pc-card" onSubmit={applyAdapter} data-guide="pc-form">
          <div className="tw-pc-title">Adapter IPv4 settings</div>
          <label className="tw-radio"><input type="radio" data-guide="pc-mode-dhcp" checked={form.mode === 'dhcp'} onChange={() => setForm({ ...form, mode: 'dhcp' })} /> Obtain an address automatically (DHCP)</label>
          <label className="tw-radio"><input type="radio" data-guide="pc-mode-static" checked={form.mode === 'static'} onChange={() => setForm({ ...form, mode: 'static' })} /> Use the following address</label>
          {form.mode === 'static' ? (
            <div className="tw-pc-grid">
              <label htmlFor="pc-ip">IP address</label><input id="pc-ip" data-guide="pc-ip" className="tw-input mono" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value.trim() })} />
              <label htmlFor="pc-mask">Subnet mask</label><input id="pc-mask" data-guide="pc-mask" className="tw-input mono" value={form.mask} onChange={(e) => setForm({ ...form, mask: e.target.value.trim() })} />
              <label htmlFor="pc-gw">Default gateway</label><input id="pc-gw" data-guide="pc-gw" className="tw-input mono" value={form.gateway} onChange={(e) => setForm({ ...form, gateway: e.target.value.trim() })} />
              <label htmlFor="pc-dns">DNS server</label><input id="pc-dns" data-guide="pc-dns" className="tw-input mono" value={form.dns} onChange={(e) => setForm({ ...form, dns: e.target.value.trim() })} />
            </div>
          ) : null}
          {formErr ? <div className="tw-err-text" role="alert">{formErr}</div> : null}
          <button className="tw-btn" data-guide="pc-apply" type="submit">Apply adapter settings</button>
        </form>
      </div>
      <div className="tw-term-wrap" onClick={() => document.getElementById('pc-cmd')?.focus()}>
        <div className="tw-term" ref={termRef} aria-live="polite">{lines.join('\n')}</div>
        <form className="tw-term-in" onSubmit={(e) => { e.preventDefault(); run(cmd); setCmd(''); }}>
          <span className="mono">{PROMPT}</span>
          <input id="pc-cmd" data-guide="pc-cmd" className="mono" value={cmd} autoComplete="off" spellCheck={false} aria-label="Command"
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' && hist.length) { e.preventDefault(); const i = hi < 0 ? hist.length - 1 : Math.max(0, hi - 1); setHi(i); setCmd(hist[i]); }
              if (e.key === 'ArrowDown' && hi >= 0) { e.preventDefault(); const i = hi + 1; if (i >= hist.length) { setHi(-1); setCmd(''); } else { setHi(i); setCmd(hist[i]); } }
            }} />
        </form>
      </div>
    </div>
  );
}

/* =============================== Traffic Tester =============================== */

export const SERVICES_PRESET: { id: string; label: string; proto: Proto; port: number }[] = [
  { id: 'https', label: 'HTTPS (TCP 443)', proto: 'TCP', port: 443 },
  { id: 'http', label: 'HTTP (TCP 80)', proto: 'TCP', port: 80 },
  { id: 'dns', label: 'DNS (UDP 53)', proto: 'UDP', port: 53 },
  { id: 'ssh', label: 'SSH (TCP 22)', proto: 'TCP', port: 22 },
  { id: 'icmp', label: 'Ping (ICMP)', proto: 'ICMP', port: 0 },
  { id: '8443', label: 'TCP 8443', proto: 'TCP', port: 8443 },
  { id: 'rdp', label: 'RDP (TCP 3389)', proto: 'TCP', port: 3389 },
  { id: 'smb', label: 'SMB (TCP 445)', proto: 'TCP', port: 445 },
  { id: 'custom', label: 'Custom…', proto: 'TCP', port: 0 },
];

export interface TesterForm { from: string; to: string; svc: string; proto: Proto; port: string; app: string; payload: string; user: string; when: string; day: string; time: string }
const blankTester = (): TesterForm => ({ from: 'admin', to: 'www.search.example', svc: 'https', proto: 'TCP', port: '', app: '', payload: 'clean', user: '', when: 'now', day: '2', time: '10:00' });

function TrafficTester() {
  const { state, sendFlow } = useStore();
  const u = useUi();
  const [f, setF] = useState<TesterForm>(blankTester);
  const [last, setLast] = useState<FlowResult | null>(null);
  useDraft('lt', f);
  const prefill = u.drafts['lt-prefill'] as (Partial<TesterForm> & { n: number }) | undefined;
  useEffect(() => {
    if (!prefill) return;
    setF({ ...blankTester(), ...prefill });
    ui.clearDraft('lt-prefill');
  }, [prefill]);

  const set = <K extends keyof TesterForm>(k: K, v: TesterForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const preset = SERVICES_PRESET.find((x) => x.id === f.svc) ?? SERVICES_PRESET[0];
  const proto = f.svc === 'custom' ? f.proto : preset.proto;
  const port = f.svc === 'custom' ? Number(f.port) || 0 : preset.port;
  const tz = state.config.system.timezone;
  const at = f.when === 'at' ? tsAt(Number(f.day), f.time || '00:00', tz, labNow(state)) : undefined;

  const send = (e: FormEvent) => {
    e.preventDefault();
    const app = APPS.find((x) => x.id === f.app);
    const spec: FlowSpec = {
      from: f.from, to: f.to.trim(), proto: app ? app.proto : proto, port: app ? app.port : port, app: f.app || undefined,
      payload: (f.payload as FlowSpec['payload']) || 'clean', user: f.user === '' ? undefined : f.user === '-' ? null : f.user,
    };
    setLast(sendFlow(spec, { at, tag: 'tester' }));
  };

  const users = state.config.users.local.map((x) => x.name);
  return (
    <div className="tw-tester">
      <form className="tw-tester-form" onSubmit={send}>
        <label htmlFor="lt-src">Source</label>
        <select id="lt-src" data-guide="lt-src" className="tw-select" value={f.from} onChange={(e) => set('from', e.target.value)}>
          {HOSTS.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
        <label htmlFor="lt-dst">Destination</label>
        <input id="lt-dst" data-guide="lt-dst" className="tw-input mono" list="lt-dst-list" value={f.to} onChange={(e) => set('to', e.target.value)} placeholder="name, IP or lab host" />
        <datalist id="lt-dst-list">
          {SITES.map((s) => <option key={s.name} value={s.name}>{s.category}</option>)}
          {HOSTS.filter((h) => h.segment !== 'internet').map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          <option value={LAB.publicWeb}>Published web server (public)</option>
          <option value={LAB.wanIp}>Firewall WAN X1</option>
        </datalist>
        <label htmlFor="lt-svc">Service</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <select id="lt-svc" data-guide="lt-svc" className="tw-select" value={f.svc} onChange={(e) => set('svc', e.target.value)} disabled={!!f.app}>
            {SERVICES_PRESET.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          {f.svc === 'custom' && !f.app ? (
            <>
              <select className="tw-select" aria-label="Protocol" value={f.proto} onChange={(e) => set('proto', e.target.value as Proto)} style={{ width: 70 }}>
                <option>TCP</option><option>UDP</option>
              </select>
              <input data-guide="lt-port" className="tw-input mono" aria-label="Port" value={f.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} style={{ width: 70 }} placeholder="port" />
            </>
          ) : null}
        </div>
        <label htmlFor="lt-app">Application</label>
        <select id="lt-app" data-guide="lt-app" className="tw-select" value={f.app} onChange={(e) => set('app', e.target.value)}>
          <option value="">(none — plain traffic)</option>
          {APPS.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.category})</option>)}
        </select>
        <label htmlFor="lt-payload">Payload</label>
        <select id="lt-payload" data-guide="lt-payload" className="tw-select" value={f.payload} onChange={(e) => set('payload', e.target.value)}>
          <option value="clean">Clean</option>
          <option value="exploit">Simulated exploit signature (IPS test)</option>
          <option value="eicar">EICAR test file (harmless AV test)</option>
          <option value="fp">ERP sync pattern (IPS false positive)</option>
        </select>
        <label htmlFor="lt-user">User</label>
        <select id="lt-user" data-guide="lt-user" className="tw-select" value={f.user} onChange={(e) => set('user', e.target.value)}>
          <option value="">(whoever is logged in on the host)</option>
          <option value="-">(nobody — unauthenticated)</option>
          {users.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <label htmlFor="lt-when">Lab time</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select id="lt-when" data-guide="lt-time" className="tw-select" value={f.when} onChange={(e) => set('when', e.target.value)} style={{ width: 110 }}>
            <option value="now">Lab clock</option>
            <option value="at">At…</option>
          </select>
          {f.when === 'at' ? (
            <>
              <select className="tw-select" aria-label="Day" value={f.day} onChange={(e) => set('day', e.target.value)} style={{ width: 70 }}>
                {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
              <input className="tw-input mono" type="time" aria-label="Time" value={f.time} onChange={(e) => set('time', e.target.value)} style={{ width: 96 }} />
            </>
          ) : <span className="muted" style={{ fontSize: 11.5 }}>{localTime(labNow(state), tz).label} ({tz})</span>}
        </div>
        <span />
        <button className="tw-btn tw-btn-primary" data-guide="lt-send" type="submit"><Send size={13} style={{ verticalAlign: -2 }} /> Send test traffic</button>
      </form>
      <div className="tw-tester-out" aria-live="polite">
        {last ? <FlowView r={last} tz={tz} /> : <p className="muted" style={{ margin: 0 }}>Choose a source and destination, then send. The result comes from the firewall’s saved configuration — the same engine the task checks use. Matching rules get hit counts, and logged traffic appears in MONITOR › Logs.</p>}
      </div>
    </div>
  );
}

export function FlowView({ r, tz }: { r: FlowResult; tz: string }) {
  return (
    <div className="tw-flow">
      <div className="tw-flow-head">
        <span className={`tw-verdict ${r.ok ? 'ok' : 'bad'}`}>{VERDICT_LABEL[r.verdict]}</span>
        <span className="mono">{r.srcName} {r.srcIp} → {r.dstName}{r.dstIp && r.dstIp !== r.dstName ? ` ${r.dstIp}` : ''} · {r.service}</span>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>{localTime(r.ts, tz).label}</span>
      </div>
      <p style={{ margin: '4px 0 6px' }}>{r.reason}</p>
      {r.blockPage ? <div className="tw-blockpage">{r.blockPage}</div> : null}
      <ol className="tw-trace">
        {r.trace.map((t, i) => <li key={i} className={t.ok ? 'ok' : 'bad'}><b>{t.stage}</b> {t.detail}</li>)}
      </ol>
      <div className="tw-flow-meta">
        {r.rule ? <span>Rule: <b>{r.rule}</b></span> : null}
        {r.nat ? <span>NAT: <b>{r.nat}</b></span> : null}
        {r.egress ? <span>Egress: <b>{r.egress}</b></span> : null}
        {r.servedBy === 'secondary' ? <span>Served by: <b>HA secondary</b></span> : null}
      </div>
    </div>
  );
}

/* =============================== Lab Hosts =============================== */

function LabHosts() {
  const { state } = useStore();
  const rows = useMemo(() => HOSTS.map((h) => {
    const net = hostNet(state, h);
    const iface = hostIface(state.config, h);
    const where = h.segment === 'internet' ? 'Internet' : h.segment === 'branch' ? 'Branch office LAN (behind AERO-BR-FW)' : h.segment === 'vlan' ? `VLAN ${h.vlan} on X0 (switch port)` : `${h.iface}`;
    const up = h.segment === 'iface' || h.segment === 'vlan' ? ifaceUp(state, iface) : { ok: true, reason: '' };
    return { h, net, where, up };
  }), [state]);
  return (
    <div className="tw-hosts">
      <table className="tw-table">
        <thead><tr><th>Host</th><th>Connected to</th><th>Address</th><th>Gateway</th><th>MAC</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map(({ h, net, where, up }) => (
            <tr key={h.id}>
              <td><b>{h.name}</b>{h.note ? <div className="muted" style={{ fontSize: 11 }}>{h.note}</div> : null}</td>
              <td>{where}</td>
              <td className="mono">{net ? `${net.ip}${h.addr.mode === 'dhcp' ? ' (DHCP)' : h.addr.mode === 'pc' ? ` (${state.session.pc.mode})` : ''}` : '—'}</td>
              <td className="mono">{net?.gw || '—'}</td>
              <td className="mono">{h.mac ?? (h.id === 'admin' ? state.session.pc.mac : '—')}</td>
              <td>{!up.ok ? <span className="tw-pill bad">{up.reason}</span> : net ? <span className="tw-pill ok">online</span> : <span className="tw-pill warn">no address</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 11.5 }}>Lab hosts are simulated. All addresses are private or documentation ranges (RFC 1918 / RFC 5737); nothing is sent to a real network.</p>
    </div>
  );
}

/* =============================== Lab Controls =============================== */

function Card({ title, children, guide }: { title: string; children: ReactNode; guide?: string }) {
  return <div className="tw-ctl" data-guide={guide}><div className="tw-ctl-title">{title}</div>{children}</div>;
}

function LabControlsTab() {
  const { state, lab, patchLab, emit, config } = useStore();
  const tz = config.system.timezone;
  const [nx, setNx] = useState({ user: '', pw: '', otp: '' });
  const [nxMsg, setNxMsg] = useState('');
  const [au, setAu] = useState({ host: 'hr', user: '', pw: '' });
  const [auMsg, setAuMsg] = useState('');
  const [clk, setClk] = useState({ day: '2', time: '10:00' });
  const now = labNow(state);
  useDraft('lab-nx', { user: nx.user });

  const setIsp = (iface: string, v: 'up' | 'down') => {
    patchLab({ isp: { ...lab.isp, [iface]: v } }, [{ category: 'Lab', action: `ISP on ${iface} ${v === 'down' ? 'failed' : 'restored'}`, detail: 'Lab control' }]);
    emit('lab', { action: 'isp', iface, state: v });
  };

  const nxConnect = (e: FormEvent) => {
    e.preventDefault();
    const fail = (m: string) => { setNxMsg(m); emit('lab', { action: 'netextender', ok: false, reason: m }); };
    const portal = evaluate(state, { from: 'remote-user', to: LAB.wanIp, proto: 'TCP', port: config.sslvpn.port }).result;
    if (!portal.ok) return fail(`Cannot reach the SSL VPN portal on ${LAB.wanIp}:${config.sslvpn.port} — ${portal.reason}`);
    const u = config.users.local.find((x) => x.name === nx.user.trim());
    if (!u || u.passwordHash !== hashPassword(nx.pw)) return fail('Authentication failed: wrong username or password.');
    if (!u.groups.includes('SSLVPN Services')) return fail(`${u.name} is not a member of SSLVPN Services, so SSL VPN access is refused.`);
    if (u.otp && nx.otp.trim() !== labTotp(u.name, Date.now())) return fail('One-time code required or incorrect. Use the code shown under “Authenticator”.');
    if (!config.sslvpn.pool || !findAddress(config, config.sslvpn.pool)) return fail('Connected, but the firewall has no client address pool to hand out.');
    patchLab({ remoteUserConnected: true }, [{ category: 'VPN', action: 'NetExtender connected', detail: `${u.name} from 192.0.2.80` }]);
    emit('lab', { action: 'netextender', ok: true, user: u.name });
    setNxMsg(`Connected as ${u.name}.`);
  };

  const userLogin = (e: FormEvent) => {
    e.preventDefault();
    const u = config.users.local.find((x) => x.name === au.user.trim());
    const h = hostById(au.host);
    if (!h) return;
    if (!u || u.passwordHash !== hashPassword(au.pw)) { setAuMsg('Login failed: wrong username or password.'); emit('lab', { action: 'userlogin', ok: false }); return; }
    const net = hostNet(state, h);
    if (!net) { setAuMsg(`${h.name} has no network address, so it cannot reach the login page.`); return; }
    patchLab({ authSessions: [...lab.authSessions.filter((a) => a.host !== h.id), { user: u.name, host: h.id, since: Date.now() }] }, [{ category: 'Users', action: 'User login', detail: `${u.name} on ${h.name} (${net.ip})` }]);
    emit('lab', { action: 'userlogin', ok: true, user: u.name, host: h.id });
    setAuMsg(`${u.name} logged in on ${h.name}.`);
  };

  const totpUsers = [...(config.system.otpMethod === 'totp' ? [{ id: 'admin', name: config.system.adminUser }] : []), ...config.users.local.filter((x) => x.otp)];
  return (
    <div className="tw-ctls">
      <Card title="ISP links (upstream)" guide="lab-isp">
        {['X1', 'X3'].map((i) => (
          <div key={i} className="tw-ctl-row">
            <span>{i === 'X1' ? 'ISP-1 on X1' : 'ISP-2 on X3'}</span>
            <button className={`tw-btn${lab.isp[i] === 'down' ? ' tw-btn-primary' : ''}`} data-guide={`lab-isp-${i}`} onClick={() => setIsp(i, lab.isp[i] === 'down' ? 'up' : 'down')}>
              {lab.isp[i] === 'down' ? 'Restore' : 'Fail'}
            </button>
            <span className={`tw-pill ${lab.isp[i] === 'down' ? 'bad' : 'ok'}`}>{lab.isp[i] === 'down' ? 'down' : 'up'}</span>
          </div>
        ))}
      </Card>
      <Card title="LAN switch (port facing X0)" guide="lab-trunk">
        <div className="tw-ctl-row">
          <span>802.1Q trunk (VLAN 10, 20, 30)</span>
          <button className="tw-btn" data-guide="lab-trunk-btn" onClick={() => { patchLab({ trunk: !lab.trunk }, [{ category: 'Lab', action: `Switch port ${lab.trunk ? 'set to access' : 'set to 802.1Q trunk'}`, detail: 'Lab control' }]); emit('lab', { action: 'trunk', on: !lab.trunk }); }}>
            {lab.trunk ? 'Set to access port' : 'Make trunk'}
          </button>
          <span className={`tw-pill ${lab.trunk ? 'ok' : 'warn'}`}>{lab.trunk ? 'trunk' : 'access'}</span>
        </div>
      </Card>
      <Card title="Appliance power (HA pair)" guide="lab-ha">
        {(['primary', 'secondary'] as const).map((u) => (
          <div key={u} className="tw-ctl-row">
            <span>{u === 'primary' ? 'Primary (AERO-HQ-FW)' : 'Secondary unit'}</span>
            <button className="tw-btn" data-guide={`lab-ha-${u}`} onClick={() => {
              const haPower = { ...lab.haPower, [u]: !lab.haPower[u] };
              patchLab({ haPower, haFailoverAt: u === 'primary' && !haPower.primary ? Date.now() : lab.haFailoverAt }, [{ category: 'Lab', action: `${u} unit powered ${haPower[u] ? 'on' : 'off'}`, detail: 'Lab control' }]);
              emit('lab', { action: 'ha-power', unit: u, on: haPower[u] });
            }}>{lab.haPower[u] ? 'Power off' : 'Power on'}</button>
            <span className={`tw-pill ${lab.haPower[u] ? 'ok' : 'bad'}`}>{lab.haPower[u] ? 'on' : 'off'}</span>
          </div>
        ))}
        <div className="muted" style={{ fontSize: 11.5 }}>Passing traffic now: <b>{haActiveUnit(state)}</b></div>
      </Card>
      <Card title="Client certificate trust (DPI-SSL)" guide="lab-ca">
        <div className="tw-ctl-row">
          <span>Firewall CA in the PCs’ trust store</span>
          <button className="tw-btn" data-guide="lab-ca-btn" onClick={() => { patchLab({ pcsTrustDpiCa: !lab.pcsTrustDpiCa }, [{ category: 'Lab', action: lab.pcsTrustDpiCa ? 'DPI-SSL CA removed from PCs' : 'DPI-SSL CA pushed to PCs (group policy)', detail: 'Lab control' }]); emit('lab', { action: 'ca', on: !lab.pcsTrustDpiCa }); }}>
            {lab.pcsTrustDpiCa ? 'Remove from PCs' : 'Push to PCs'}
          </button>
          <span className={`tw-pill ${lab.pcsTrustDpiCa ? 'ok' : 'warn'}`}>{lab.pcsTrustDpiCa ? 'trusted' : 'not trusted'}</span>
        </div>
      </Card>
      <Card title="NetExtender on REMOTE-LAPTOP (home)" guide="lab-nx">
        {lab.remoteUserConnected ? (
          <div className="tw-ctl-row"><span className="tw-pill ok">connected</span>
            <button className="tw-btn" onClick={() => { patchLab({ remoteUserConnected: false }, [{ category: 'VPN', action: 'NetExtender disconnected', detail: '' }]); emit('lab', { action: 'netextender-off' }); setNxMsg(''); }}>Disconnect</button></div>
        ) : (
          <form onSubmit={nxConnect} className="tw-ctl-form">
            <input className="tw-input" data-guide="lab-nx-user" placeholder="Username" value={nx.user} onChange={(e) => setNx({ ...nx, user: e.target.value })} aria-label="NetExtender username" />
            <input className="tw-input" type="password" placeholder="Password" value={nx.pw} onChange={(e) => setNx({ ...nx, pw: e.target.value })} aria-label="NetExtender password" />
            <input className="tw-input mono" placeholder="One-time code" value={nx.otp} onChange={(e) => setNx({ ...nx, otp: e.target.value })} aria-label="One-time code" style={{ width: 110 }} />
            <button className="tw-btn tw-btn-primary" data-guide="lab-nx-connect" type="submit">Connect to {LAB.wanIp}:{config.sslvpn.port}</button>
          </form>
        )}
        {nxMsg ? <div className="muted" style={{ fontSize: 12 }}>{nxMsg}</div> : null}
        {totpUsers.length ? (
          <div className="tw-totp" data-guide="lab-totp">Authenticator (lab phone): {totpUsers.map((x) => <span key={x.id}><b>{x.name}</b> <span className="mono">{labTotp(x.name, Date.now())}</span></span>)}</div>
        ) : null}
      </Card>
      <Card title="User login on a LAN host" guide="lab-auth">
        <form onSubmit={userLogin} className="tw-ctl-form">
          <select className="tw-select" value={au.host} onChange={(e) => setAu({ ...au, host: e.target.value })} aria-label="Host">
            {HOSTS.filter((h) => h.segment === 'iface' || h.segment === 'vlan').filter((h) => h.id !== 'web01').map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
          <input className="tw-input" data-guide="lab-auth-user" placeholder="Username" value={au.user} onChange={(e) => setAu({ ...au, user: e.target.value })} aria-label="Username" />
          <input className="tw-input" type="password" placeholder="Password" value={au.pw} onChange={(e) => setAu({ ...au, pw: e.target.value })} aria-label="Password" />
          <button className="tw-btn" data-guide="lab-auth-login" type="submit">Log in</button>
        </form>
        {auMsg ? <div className="muted" style={{ fontSize: 12 }}>{auMsg}</div> : null}
        {lab.authSessions.map((a) => (
          <div key={a.host} className="tw-ctl-row"><span>{a.user} on {hostById(a.host)?.name}</span>
            <button className="tw-btn" onClick={() => patchLab({ authSessions: lab.authSessions.filter((x) => x !== a) }, [{ category: 'Users', action: 'User logout', detail: `${a.user} on ${a.host}` }])}>Log out</button></div>
        ))}
      </Card>
      <Card title="Lab clock" guide="lab-clock">
        <div className="tw-ctl-row"><span>{localTime(now, tz).label} ({tz}){lab.clockOverride ? ' · overridden' : ' · real time'}</span></div>
        <div className="tw-ctl-form">
          <select className="tw-select" value={clk.day} onChange={(e) => setClk({ ...clk, day: e.target.value })} aria-label="Day" style={{ width: 70 }}>
            {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
          <input className="tw-input mono" type="time" value={clk.time} onChange={(e) => setClk({ ...clk, time: e.target.value })} aria-label="Time" style={{ width: 96 }} />
          <button className="tw-btn" onClick={() => { const t = tsAt(Number(clk.day), clk.time, tz, Date.now()); patchLab({ clockOverride: t }, [{ category: 'Lab', action: 'Lab clock set', detail: localTime(t, tz).label }]); emit('lab', { action: 'clock', at: t }); }}>Set</button>
          {lab.clockOverride ? <button className="tw-btn" onClick={() => { patchLab({ clockOverride: null }); emit('lab', { action: 'clock', at: null }); }}>Use real time</button> : null}
        </div>
      </Card>
    </div>
  );
}
