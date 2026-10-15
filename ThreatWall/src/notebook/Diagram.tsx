/**
 * Flow diagrams for the learning notebook. Plain SVG, light "paper" palette, legible in print.
 * Diagrams are declared as data (nodes + edges) so each one stays short and readable.
 */
import type { ReactElement } from 'react';

type Tone = 'fw' | 'host' | 'net' | 'bad' | 'ok' | 'warn' | 'step' | 'plain';
interface N { id: string; x: number; y: number; w?: number; h?: number; label: string; sub?: string; tone?: Tone }
interface E { from: string; to: string; label?: string; dash?: boolean; tone?: 'bad' | 'ok' | 'plain' }

const TONE: Record<Tone, { fill: string; stroke: string; text: string }> = {
  fw: { fill: '#e6faf7', stroke: '#0f766e', text: '#0b3b37' },
  host: { fill: '#f1f5f9', stroke: '#475569', text: '#1e293b' },
  net: { fill: '#eef2ff', stroke: '#4f46e5', text: '#1e1b4b' },
  bad: { fill: '#fef2f2', stroke: '#b91c1c', text: '#7f1d1d' },
  ok: { fill: '#f0fdf4', stroke: '#15803d', text: '#14532d' },
  warn: { fill: '#fffbeb', stroke: '#b45309', text: '#78350f' },
  step: { fill: '#ffffff', stroke: '#0f766e', text: '#0f172a' },
  plain: { fill: '#ffffff', stroke: '#94a3b8', text: '#334155' },
};
const EDGE = { plain: '#475569', ok: '#15803d', bad: '#b91c1c' };

function anchor(a: Required<N>, b: Required<N>): [number, number] {
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
  const dx = b.x + b.w / 2 - cx, dy = b.y + b.h / 2 - cy;
  if (!dx && !dy) return [cx, cy];
  const sx = dx ? (a.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy ? (a.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

function Flow({ nodes, edges, w = 720, h, title }: { nodes: N[]; edges: E[]; w?: number; h: number; title: string }) {
  const full = new Map(nodes.map((n) => [n.id, { w: 130, h: 46, sub: '', tone: 'plain' as Tone, ...n } as Required<N>]));
  return (
    <svg className="nb-svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title}>
      <defs>
        {(['plain', 'ok', 'bad'] as const).map((k) => (
          <marker key={k} id={`nb-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={EDGE[k]} />
          </marker>
        ))}
      </defs>
      {edges.map((e, i) => {
        const a = full.get(e.from)!, b = full.get(e.to)!;
        const [x1, y1] = anchor(a, b);
        const [x2, y2] = anchor(b, a);
        const tone = e.tone ?? 'plain';
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const lw = e.label ? e.label.length * 5.6 + 10 : 0;
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={EDGE[tone]} strokeWidth="1.6" strokeDasharray={e.dash ? '5 4' : undefined} markerEnd={`url(#nb-arrow-${tone})`} />
            {e.label ? (
              <g>
                <rect x={mx - lw / 2} y={my - 9} width={lw} height={17} rx="3" fill="#ffffff" stroke="#e2e8f0" />
                <text x={mx} y={my + 3.5} textAnchor="middle" fontSize="10" fill={EDGE[tone]}>{e.label}</text>
              </g>
            ) : null}
          </g>
        );
      })}
      {[...full.values()].map((n) => {
        const t = TONE[n.tone];
        return (
          <g key={n.id}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="7" fill={t.fill} stroke={t.stroke} strokeWidth={n.tone === 'fw' ? 2 : 1.3} />
            <text x={n.x + n.w / 2} y={n.y + (n.sub ? n.h / 2 - 2 : n.h / 2 + 4)} textAnchor="middle" fontSize="12" fontWeight="600" fill={t.text}>{n.label}</text>
            {n.sub ? <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 13} textAnchor="middle" fontSize="10" fill={t.text} opacity=".85">{n.sub}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}

/** A left-to-right, row-wrapping chain of steps (snake layout). */
function Chain({ items, cols = 4, title }: { items: [string, string?, Tone?][]; cols?: number; title: string }) {
  const bw = Math.min(150, (720 - (cols - 1) * 22) / cols), bh = 50, gx = (720 - cols * bw) / (cols - 1 || 1), gy = 40;
  const nodes: N[] = items.map(([label, sub, tone], i) => {
    const row = Math.floor(i / cols), c = i % cols;
    const col = row % 2 === 0 ? c : cols - 1 - c;
    return { id: `s${i}`, x: col * (bw + gx), y: 8 + row * (bh + gy), w: bw, h: bh, label, sub, tone: tone ?? 'step' };
  });
  const edges: E[] = items.slice(1).map((_, i) => ({ from: `s${i}`, to: `s${i + 1}` }));
  const rows = Math.ceil(items.length / cols);
  return <Flow title={title} nodes={nodes} edges={edges} h={16 + rows * bh + (rows - 1) * gy} />;
}

/** Message ladder between two or three parties (DHCP, IKE). */
function Sequence({ actors, msgs, title }: { actors: string[]; msgs: { from: number; to: number; label: string; tone?: 'ok' | 'bad' | 'plain' }[]; title: string }) {
  const w = 720, top = 48, step = 44, h = top + msgs.length * step + 16;
  const xs = actors.map((_, i) => 90 + (i * (w - 180)) / (actors.length - 1));
  return (
    <svg className="nb-svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title}>
      <defs>
        {(['plain', 'ok', 'bad'] as const).map((k) => (
          <marker key={k} id={`nb-sq-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill={EDGE[k]} />
          </marker>
        ))}
      </defs>
      {actors.map((a, i) => (
        <g key={a}>
          <rect x={xs[i] - 75} y={4} width={150} height={30} rx="6" fill={i === 0 ? TONE.host.fill : TONE.fw.fill} stroke={i === 0 ? TONE.host.stroke : TONE.fw.stroke} />
          <text x={xs[i]} y={23} textAnchor="middle" fontSize="12" fontWeight="600" fill="#0f172a">{a}</text>
          <line x1={xs[i]} y1={34} x2={xs[i]} y2={h - 6} stroke="#cbd5e1" strokeDasharray="4 4" />
        </g>
      ))}
      {msgs.map((m, i) => {
        const y = top + i * step + 14;
        const tone = m.tone ?? 'plain';
        const x1 = xs[m.from], x2 = xs[m.to];
        return (
          <g key={i}>
            <line x1={x1} y1={y} x2={x2 + (x2 > x1 ? -3 : 3)} y2={y} stroke={EDGE[tone]} strokeWidth="1.6" markerEnd={`url(#nb-sq-${tone})`} />
            <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" fontSize="11" fill={EDGE[tone] === EDGE.plain ? '#0f172a' : EDGE[tone]}>{m.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Schedule() {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const x0 = 60, x1 = 700, hx = (h: number) => x0 + ((x1 - x0) * h) / 24;
  return (
    <svg className="nb-svg" viewBox="0 0 720 250" role="img" aria-label="Office-Hours schedule: Monday to Saturday, 09:00 to 19:00">
      {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
        <g key={h}><line x1={hx(h)} y1={14} x2={hx(h)} y2={196} stroke="#e2e8f0" /><text x={hx(h)} y={212} textAnchor="middle" fontSize="10" fill="#475569">{String(h).padStart(2, '0')}:00</text></g>
      ))}
      {days.map((d, i) => (
        <g key={d}>
          <text x={8} y={32 + i * 25} fontSize="11" fill="#334155">{d}</text>
          <rect x={x0} y={20 + i * 25} width={x1 - x0} height={16} rx="3" fill="#f1f5f9" />
          {i < 6 ? <rect x={hx(9)} y={20 + i * 25} width={hx(19) - hx(9)} height={16} rx="3" fill="#99f6e4" stroke="#0f766e" /> : <text x={hx(12)} y={32 + i * 25} fontSize="10" fill="#64748b" textAnchor="middle">rule inactive all day</text>}
        </g>
      ))}
      <circle cx={hx(10)} cy={53} r="6" fill="#15803d" /><circle cx={hx(21)} cy={53} r="6" fill="#b91c1c" />
      <circle cx={70} cy={238} r="5" fill="#15803d" /><text x={80} y={242} fontSize="10.5" fill="#15803d">Tuesday 10:00: inside the window → rule active → allowed</text>
      <circle cx={400} cy={238} r="5" fill="#b91c1c" /><text x={410} y={242} fontSize="10.5" fill="#b91c1c">Tuesday 21:00: outside → rule inactive → blocked</text>
    </svg>
  );
}

function RuleOrder() {
  const col = (x: number, title: string, rows: [string, string, 'ok' | 'bad' | 'plain' | 'warn'][]) => (
    <g>
      <text x={x} y={16} fontSize="12" fontWeight="700" fill="#0f172a">{title}</text>
      {rows.map(([n, d, t], i) => {
        const tone = TONE[t === 'plain' ? 'plain' : t];
        return (
          <g key={n}>
            <rect x={x} y={26 + i * 50} width={300} height={40} rx="6" fill={tone.fill} stroke={tone.stroke} />
            <text x={x + 12} y={43 + i * 50} fontSize="12" fontWeight="600" fill={tone.text}>{i + 1}. {n}</text>
            <text x={x + 12} y={58 + i * 50} fontSize="10" fill={tone.text}>{d}</text>
          </g>
        );
      })}
    </g>
  );
  return (
    <svg className="nb-svg" viewBox="0 0 720 200" role="img" aria-label="Rule order before and after moving the block rule to the top">
      {col(10, 'Before: first match wins', [
        ['LAN-Web-Out', 'Allow HTTPS — matches the proxy request first', 'ok'],
        ['Staff-HTTPS-Legacy', 'Allow any HTTPS', 'plain'],
        ['Block-Proxy-Site', 'Deny — never reached (shadowed, 0 hits)', 'warn'],
      ])}
      {col(400, 'After: specific deny on top', [
        ['Block-Proxy-Site', 'Deny unblock-proxy.example — matches first', 'bad'],
        ['LAN-Web-Out', 'Allow web for everything else', 'plain'],
        ['Staff-HTTPS-Legacy', 'Allow any HTTPS', 'plain'],
      ])}
      <text x={360} y={190} textAnchor="middle" fontSize="10.5" fill="#475569">The firewall reads top-down and stops at the first rule that matches.</text>
    </svg>
  );
}

const D: Record<string, () => ReactElement> = {
  topology: () => (
    <Flow title="Lab network map" h={392} nodes={[
      { id: 'inet', x: 290, y: 6, w: 140, label: 'Internet', sub: 'simulated', tone: 'net' },
      { id: 'isp1', x: 110, y: 82, w: 140, label: 'ISP-1 router', sub: '203.0.113.9', tone: 'net' },
      { id: 'isp2', x: 470, y: 82, w: 140, label: 'ISP-2 router', sub: '198.51.100.33', tone: 'net' },
      { id: 'fw', x: 265, y: 166, w: 190, h: 54, label: 'KGI-HQ-FW', sub: 'ThreatWall (fictional) · HQ', tone: 'fw' },
      { id: 'rem', x: 8, y: 170, w: 150, label: 'REMOTE-LAPTOP', sub: 'SSL VPN 192.168.50.x', tone: 'host' },
      { id: 'br', x: 562, y: 170, w: 150, label: 'Branch firewall', sub: '198.51.100.20', tone: 'fw' },
      { id: 'sw', x: 110, y: 268, w: 150, label: 'LAN switch', sub: 'X0 192.168.10.1/24', tone: 'plain' },
      { id: 'dmz', x: 330, y: 268, w: 150, label: 'WEB-01 (DMZ)', sub: 'X2 · 172.16.10.100', tone: 'host' },
      { id: 'bpc', x: 562, y: 268, w: 150, label: 'BRANCH-PC', sub: '192.168.20.0/24', tone: 'host' },
      { id: 'a', x: 0, y: 340, w: 88, h: 42, label: 'ADMIN-PC', sub: '.5', tone: 'host' },
      { id: 'h', x: 96, y: 340, w: 88, h: 42, label: 'HR-PC', sub: '.21', tone: 'host' },
      { id: 'f', x: 192, y: 340, w: 88, h: 42, label: 'FIN-PC', sub: '.22', tone: 'host' },
      { id: 'p', x: 288, y: 340, w: 88, h: 42, label: 'PRINTER-01', sub: '.50', tone: 'host' },
    ]} edges={[
      { from: 'inet', to: 'isp1' }, { from: 'inet', to: 'isp2' },
      { from: 'isp1', to: 'fw', label: 'X1 WAN' }, { from: 'isp2', to: 'fw', label: 'X3 WAN-2' },
      { from: 'rem', to: 'fw', label: 'SSL VPN', dash: true }, { from: 'fw', to: 'br', label: 'IPsec', dash: true },
      { from: 'fw', to: 'sw', label: 'X0 LAN' }, { from: 'fw', to: 'dmz', label: 'X2 DMZ' }, { from: 'br', to: 'bpc' },
      { from: 'sw', to: 'a' }, { from: 'sw', to: 'h' }, { from: 'sw', to: 'f' }, { from: 'sw', to: 'p' },
    ]} />
  ),
  pipeline: () => (
    <Flow title="How a packet crosses the firewall" h={170} nodes={[
      { id: '1', x: 0, y: 8, w: 156, h: 50, label: '1 Arrives on X0', sub: 'ingress interface', tone: 'step' },
      { id: '2', x: 188, y: 8, w: 156, h: 50, label: '2 Anti-spoof', sub: 'drop if MAC ≠ known pair', tone: 'step' },
      { id: '3', x: 376, y: 8, w: 156, h: 50, label: '3 Route lookup', sub: 'which interface out?', tone: 'step' },
      { id: '4', x: 564, y: 8, w: 156, h: 50, label: '4 Zone pair', sub: 'e.g. LAN → WAN', tone: 'step' },
      { id: '5', x: 564, y: 108, w: 156, h: 50, label: '5 Access rules', sub: 'top-down, first match', tone: 'fw' },
      { id: '6', x: 376, y: 108, w: 156, h: 50, label: '6 Security services', sub: 'IPS · AV · CFS · App', tone: 'step' },
      { id: '7', x: 188, y: 108, w: 156, h: 50, label: '7 NAT', sub: 'rewrite source/destination', tone: 'step' },
      { id: '8', x: 0, y: 108, w: 156, h: 50, label: '8 Leaves on X1', sub: 'logged with the rule hit', tone: 'ok' },
    ]} edges={[{ from: '1', to: '2' }, { from: '2', to: '3' }, { from: '3', to: '4' }, { from: '4', to: '5' }, { from: '5', to: '6' }, { from: '6', to: '7' }, { from: '7', to: '8' }]} />
  ),
  dhcp: () => (
    <Sequence title="DHCP: discover, offer, request, acknowledge" actors={['ADMIN-PC', 'Firewall DHCP server']} msgs={[
      { from: 0, to: 1, label: 'DISCOVER (broadcast): is there a DHCP server?' },
      { from: 1, to: 0, label: 'OFFER: 192.168.168.100, lease 1 day' },
      { from: 0, to: 1, label: 'REQUEST: I will take 192.168.168.100' },
      { from: 1, to: 0, label: 'ACK: yours — gateway .168, DNS servers', tone: 'ok' },
      { from: 0, to: 1, label: 'ping 192.168.168.168 → reply', tone: 'ok' },
    ]} />
  ),
  dhcp2: () => (
    <Sequence title="DHCP on the office scope, with a reservation" actors={['PRINTER-01 00:1a:2b:3c:4d:50', 'Firewall DHCP (X0 scope)']} msgs={[
      { from: 0, to: 1, label: 'DISCOVER from MAC 00:1a:2b:3c:4d:50' },
      { from: 1, to: 0, label: 'OFFER: reserved 192.168.10.50 (not from the .100–.199 pool)' },
      { from: 0, to: 1, label: 'REQUEST: 192.168.10.50' },
      { from: 1, to: 0, label: 'ACK: lease 1440 min · gateway 192.168.10.1 · DNS 1.1.1.1, 8.8.8.8', tone: 'ok' },
    ]} />
  ),
  tls: () => (
    <Flow title="Why the certificate warning appears" h={250} nodes={[
      { id: 'b', x: 10, y: 20, w: 170, label: 'Browser on ADMIN-PC', sub: 'https://192.168.168.168', tone: 'host' },
      { id: 'f', x: 275, y: 20, w: 170, label: 'Firewall web GUI', sub: 'self-signed certificate', tone: 'fw' },
      { id: 'c', x: 540, y: 20, w: 170, label: 'Trusted CA store', sub: 'issuer not listed', tone: 'warn' },
      { id: 'q', x: 255, y: 112, w: 210, h: 50, label: 'Is this the box I just cabled?', sub: 'check the address in the warning', tone: 'warn' },
      { id: 'y', x: 520, y: 190, w: 190, label: 'Proceed once', sub: 'expected on a new unit', tone: 'ok' },
      { id: 'n', x: 10, y: 190, w: 190, label: 'Stop and investigate', sub: 'possible interception', tone: 'bad' },
    ]} edges={[{ from: 'b', to: 'f', label: 'TLS hello' }, { from: 'f', to: 'c', label: 'who signed it?' }, { from: 'c', to: 'q', label: 'warning' }, { from: 'q', to: 'y', label: 'yes', tone: 'ok' }, { from: 'q', to: 'n', label: 'no / unsure', tone: 'bad' }]} />
  ),
  setup: () => <Chain title="Setup Guide flow" cols={4} items={[['Factory login', 'admin / password', 'warn'], ['Welcome'], ['New password', '12+ chars, mixed'], ['Name + time zone', 'KGI-HQ-FW'], ['WAN', 'keep DHCP for now'], ['LAN', 'keep for now'], ['Apply', 'settings written'], ['Sign in again', 'new password', 'ok']]} />,
  gui: () => (
    <Flow title="The six views of the GUI" h={150} nodes={[
      { id: 'h', x: 0, y: 6, w: 228, h: 60, label: 'HOME', sub: 'Dashboard · Topology', tone: 'fw' },
      { id: 'm', x: 246, y: 6, w: 228, h: 60, label: 'MONITOR', sub: 'Charts · Logs · Packet Monitor', tone: 'fw' },
      { id: 'd', x: 492, y: 6, w: 228, h: 60, label: 'DEVICE', sub: 'Settings · Users · HA · Diagnostics', tone: 'fw' },
      { id: 'n', x: 0, y: 84, w: 228, h: 60, label: 'NETWORK', sub: 'Interfaces · DHCP · VPN · SD-WAN', tone: 'fw' },
      { id: 'o', x: 246, y: 84, w: 228, h: 60, label: 'OBJECT', sub: 'Addresses · Services · Zones · Profiles', tone: 'fw' },
      { id: 'p', x: 492, y: 84, w: 228, h: 60, label: 'POLICY', sub: 'Access · NAT · Routing · Security', tone: 'fw' },
    ]} edges={[]} />
  ),
  license: () => <Chain title="Registration and licensing" cols={4} items={[['Serial + auth code', 'from the dashboard'], ['Register', 'lab account e-mail'], ['Licence keys', 'simulated service'], ['Services active', 'IPS · GAV · CFS · VPN…', 'ok']]} />,
  backup: () => (
    <Flow title="Local backup versus exported file" h={200} nodes={[
      { id: 'c', x: 10, y: 75, w: 170, label: 'Running configuration', sub: 'what the box does now', tone: 'fw' },
      { id: 'l', x: 280, y: 10, w: 170, label: 'Local backup', sub: '“Before changes” on the box', tone: 'step' },
      { id: 'e', x: 280, y: 140, w: 170, label: 'Exported file', sub: 'kept off the appliance', tone: 'ok' },
      { id: 'r1', x: 545, y: 10, w: 170, label: 'Undo a bad change', sub: 'restore in minutes', tone: 'ok' },
      { id: 'r2', x: 545, y: 140, w: 170, label: 'Rebuild a dead unit', sub: 'only the export survives', tone: 'ok' },
    ]} edges={[{ from: 'c', to: 'l', label: 'Create Backup' }, { from: 'c', to: 'e', label: 'Export' }, { from: 'l', to: 'r1' }, { from: 'e', to: 'r2' }]} />
  ),
  session: () => <Chain title="Admin session lifecycle" cols={5} items={[['Sign in', 'admin'], ['Make changes', 'click Accept'], ['Walk away', 'no activity', 'warn'], ['10 min idle', 'auto logout', 'ok'], ['Audit log', 'who · what · when', 'fw']]} />,
  zones: () => (
    <Flow title="Interfaces, zones and management access" h={190} nodes={[
      { id: 'i', x: 0, y: 70, w: 120, label: 'Internet', sub: 'untrusted', tone: 'net' },
      { id: 'x1', x: 160, y: 60, w: 170, h: 66, label: 'X1 · WAN zone', sub: '203.0.113.10/29 · Ping only', tone: 'warn' },
      { id: 'fw', x: 370, y: 63, w: 110, h: 60, label: 'Firewall', sub: 'rules by zone', tone: 'fw' },
      { id: 'x0', x: 520, y: 60, w: 200, h: 66, label: 'X0 · LAN zone', sub: '192.168.10.1/24 · HTTPS/SSH/Ping', tone: 'ok' },
      { id: 'n', x: 520, y: 150, w: 200, h: 34, label: 'ADMIN-PC moves to 192.168.10.5', tone: 'host' },
      { id: 'm', x: 160, y: 4, w: 170, h: 34, label: 'HTTPS from internet: refused', tone: 'bad' },
    ]} edges={[{ from: 'i', to: 'x1' }, { from: 'x1', to: 'fw' }, { from: 'fw', to: 'x0' }, { from: 'x0', to: 'n', dash: true }, { from: 'i', to: 'm', tone: 'bad', dash: true }]} />
  ),
  routing: () => (
    <Flow title="Default route and DNS resolution" h={210} nodes={[
      { id: 'pc', x: 0, y: 20, w: 150, label: 'HR-PC', sub: '192.168.10.21', tone: 'host' },
      { id: 'rt', x: 190, y: 14, w: 190, h: 58, label: 'Route lookup', sub: 'not local → 0.0.0.0/0 via X1', tone: 'fw' },
      { id: 'gw', x: 420, y: 20, w: 140, label: 'ISP-1 gateway', sub: '203.0.113.9', tone: 'net' },
      { id: 'in', x: 600, y: 20, w: 120, label: 'Internet', tone: 'net' },
      { id: 'q', x: 0, y: 140, w: 150, label: 'nslookup', sub: 'www.search.example', tone: 'host' },
      { id: 'dns', x: 190, y: 140, w: 190, label: 'DNS servers in use', sub: '1.1.1.1 · 8.8.8.8', tone: 'fw' },
      { id: 'a', x: 420, y: 140, w: 300, label: 'Answer: name → address', sub: 'now the PC can connect by name', tone: 'ok' },
    ]} edges={[{ from: 'pc', to: 'rt' }, { from: 'rt', to: 'gw' }, { from: 'gw', to: 'in' }, { from: 'q', to: 'dns', label: 'query' }, { from: 'dns', to: 'a', label: 'reply', tone: 'ok' }]} />
  ),
  spoof: () => (
    <Flow title="MAC-IP anti-spoof decision" h={220} nodes={[
      { id: 'f', x: 0, y: 20, w: 190, label: 'FIN-PC', sub: '.22 · 00:1a:2b:3c:4d:22', tone: 'host' },
      { id: 'r', x: 0, y: 150, w: 190, label: 'Unknown laptop', sub: '.22 · de:ad:be:ef:00:99', tone: 'bad' },
      { id: 'c', x: 250, y: 78, w: 210, h: 60, label: 'Anti-spoof cache on X0', sub: '192.168.10.22 = …4d:22', tone: 'fw' },
      { id: 'ok', x: 530, y: 20, w: 190, label: 'Pair matches', sub: 'forwarded', tone: 'ok' },
      { id: 'no', x: 530, y: 150, w: 190, label: 'Blacklisted MAC', sub: 'dropped + alert logged', tone: 'bad' },
    ]} edges={[{ from: 'f', to: 'c' }, { from: 'r', to: 'c' }, { from: 'c', to: 'ok', tone: 'ok' }, { from: 'c', to: 'no', tone: 'bad' }]} />
  ),
  objects: () => (
    <Flow title="Objects, groups and rules" h={200} nodes={[
      { id: 'f', x: 0, y: 10, w: 170, label: 'H_FIN-PC', sub: 'host 192.168.10.22', tone: 'host' },
      { id: 'g', x: 250, y: 10, w: 170, label: 'G_Finance-PCs', sub: 'group', tone: 'step' },
      { id: 'n', x: 0, y: 80, w: 170, label: 'N_LAN-Staff', sub: 'network 192.168.10.0/24', tone: 'host' },
      { id: 'w', x: 0, y: 150, w: 170, label: 'H_WEB-01', sub: 'host 172.16.10.100 · DMZ', tone: 'host' },
      { id: 'r', x: 520, y: 70, w: 200, h: 60, label: 'Rules & NAT policies', sub: 'refer to names, never raw IPs', tone: 'fw' },
      { id: 'q', x: 250, y: 150, w: 170, label: 'FQDN_update-site', sub: 'updates.vendor.example', tone: 'host' },
    ]} edges={[{ from: 'f', to: 'g' }, { from: 'g', to: 'r' }, { from: 'n', to: 'r' }, { from: 'w', to: 'r' }, { from: 'q', to: 'r' }]} />
  ),
  ruleNat: () => (
    <Flow title="Outbound rule and NAT" h={220} nodes={[
      { id: 'pc', x: 0, y: 20, w: 150, label: 'HR-PC', sub: '192.168.10.21', tone: 'host' },
      { id: 'z', x: 180, y: 20, w: 120, label: 'LAN → WAN', sub: 'zone pair · HTTPS', tone: 'step' },
      { id: 'r', x: 330, y: 14, w: 160, h: 58, label: 'LAN-Web-Out', sub: 'HTTP/HTTPS/DNS · Allow · log', tone: 'fw' },
      { id: 'nat', x: 520, y: 14, w: 200, h: 58, label: 'NAT', sub: 'source → 203.0.113.10', tone: 'step' },
      { id: 'ok', x: 520, y: 110, w: 200, label: 'HTTPS reaches the site', tone: 'ok' },
      { id: 'ssh', x: 180, y: 150, w: 310, label: 'SSH: no allow rule matches → denied', sub: 'default LAN→WAN is disabled', tone: 'bad' },
    ]} edges={[{ from: 'pc', to: 'z' }, { from: 'z', to: 'r' }, { from: 'r', to: 'nat' }, { from: 'nat', to: 'ok', tone: 'ok' }, { from: 'z', to: 'ssh', label: 'SSH', tone: 'bad' }]} />
  ),
  schedule: () => <Schedule />,
  publish: () => (
    <Flow title="Publishing a server: inbound NAT plus an access rule" h={230} nodes={[
      { id: 'c', x: 0, y: 20, w: 150, label: 'Internet client', sub: 'INTERNET-TESTER', tone: 'net' },
      { id: 'p', x: 185, y: 14, w: 160, h: 58, label: 'Public address', sub: '203.0.113.11 : 443', tone: 'warn' },
      { id: 'n', x: 380, y: 14, w: 150, h: 58, label: 'Inbound NAT', sub: 'dest → 172.16.10.100', tone: 'step' },
      { id: 'r', x: 565, y: 14, w: 155, h: 58, label: 'WAN → DMZ rule', sub: 'HTTPS only · Allow', tone: 'fw' },
      { id: 'w', x: 565, y: 120, w: 155, label: 'WEB-01 in DMZ', sub: '172.16.10.100', tone: 'ok' },
      { id: 'x', x: 185, y: 120, w: 160, label: 'Port 80 / 22', sub: 'no NAT, no rule → drop', tone: 'bad' },
      { id: 'l', x: 380, y: 175, w: 150, label: 'LAN', sub: 'DMZ cannot start here', tone: 'host' },
    ]} edges={[{ from: 'c', to: 'p' }, { from: 'p', to: 'n' }, { from: 'n', to: 'r' }, { from: 'r', to: 'w', tone: 'ok' }, { from: 'p', to: 'x', tone: 'bad' }, { from: 'w', to: 'l', tone: 'bad', dash: true, label: 'blocked' }]} />
  ),
  ruleOrder: () => <RuleOrder />,
  vlan: () => (
    <Flow title="VLANs on one port through an 802.1Q trunk" h={250} nodes={[
      { id: 'fw', x: 270, y: 6, w: 180, h: 54, label: 'Firewall X0', sub: 'X0:V10 · X0:V20 · X0:V30', tone: 'fw' },
      { id: 'sw', x: 270, y: 100, w: 180, label: 'Switch', sub: 'trunk port: tags 10, 20, 30', tone: 'plain' },
      { id: 'a', x: 20, y: 190, w: 190, label: 'VLAN 10 · LAN', sub: 'staff · 10.10.10.0/24', tone: 'host' },
      { id: 'b', x: 265, y: 190, w: 190, label: 'VLAN 20 · Finance', sub: 'FIN-LAPTOP · 10.10.20.0/24', tone: 'ok' },
      { id: 'c', x: 510, y: 190, w: 190, label: 'VLAN 30 · Guest', sub: 'GUEST-PHONE · 10.10.30.0/24', tone: 'warn' },
      { id: 'w', x: 540, y: 100, w: 160, label: 'Internet', sub: 'Guest-Web-Out: web only', tone: 'net' },
      { id: 'k', x: 20, y: 100, w: 200, h: 40, label: 'Guest → Finance: denied + logged', tone: 'bad' },
    ]} edges={[{ from: 'fw', to: 'sw', label: 'tagged frames' }, { from: 'sw', to: 'a' }, { from: 'sw', to: 'b' }, { from: 'sw', to: 'c' }, { from: 'c', to: 'b', label: 'deny', tone: 'bad' }, { from: 'c', to: 'w', tone: 'ok' }]} />
  ),
  cfs: () => (
    <Flow title="Content filter decision" h={200} nodes={[
      { id: 'u', x: 0, y: 70, w: 160, label: 'HR-PC requests', sub: 'malware-test.example', tone: 'host' },
      { id: 'a', x: 200, y: 10, w: 160, label: 'Always-allow list?', sub: 'video.example', tone: 'step' },
      { id: 'c', x: 200, y: 130, w: 160, label: 'Category lookup', sub: '→ Malware', tone: 'step' },
      { id: 'p', x: 400, y: 130, w: 150, label: 'CFS_Staff profile', sub: 'category blocked?', tone: 'fw' },
      { id: 'b', x: 580, y: 130, w: 140, label: 'Block page', tone: 'bad' },
      { id: 'ok', x: 580, y: 10, w: 140, label: 'Allowed', tone: 'ok' },
    ]} edges={[{ from: 'u', to: 'a' }, { from: 'a', to: 'ok', label: 'listed', tone: 'ok' }, { from: 'a', to: 'c', label: 'not listed' }, { from: 'c', to: 'p' }, { from: 'p', to: 'b', label: 'yes', tone: 'bad' }, { from: 'p', to: 'ok', label: 'no', tone: 'ok' }]} />
  ),
  app: () => (
    <Flow title="Application control: identify by behaviour, not port" h={200} nodes={[
      { id: 't', x: 0, y: 70, w: 160, label: 'Traffic on TCP 443', sub: 'looks like normal HTTPS', tone: 'host' },
      { id: 'i', x: 200, y: 64, w: 170, h: 58, label: 'App identification', sub: 'signature of the app', tone: 'fw' },
      { id: 'u', x: 420, y: 10, w: 150, label: 'UltraSurf', sub: 'Proxy-Access', tone: 'warn' },
      { id: 's', x: 420, y: 130, w: 150, label: 'Social app', sub: 'Social Networking', tone: 'warn' },
      { id: 'b', x: 600, y: 10, w: 120, label: 'Block', tone: 'bad' },
      { id: 'l', x: 600, y: 130, w: 120, label: 'Allow + log', tone: 'ok' },
    ]} edges={[{ from: 't', to: 'i' }, { from: 'i', to: 'u' }, { from: 'i', to: 's' }, { from: 'u', to: 'b', tone: 'bad' }, { from: 's', to: 'l', tone: 'ok' }]} />
  ),
  auth: () => <Chain title="User-based access" cols={3} items={[['HR-PC browses', 'no user signed in', 'host'], ['LAN-Web-Out', 'requires group Staff', 'fw'], ['Redirect to login', 'firewall login page', 'warn'], ['priya signs in', 'member of Staff'], ['Rule matches', 'traffic allowed', 'ok'], ['Logs show priya', 'accountable', 'ok']]} />,
  ips: () => (
    <Flow title="IPS and Gateway AV, with a justified exclusion" h={220} nodes={[
      { id: 't', x: 0, y: 20, w: 150, label: 'HTTP traffic', sub: 'payload inspected', tone: 'host' },
      { id: 'i', x: 185, y: 14, w: 170, h: 58, label: 'IPS signatures', sub: 'High/Med: prevent · Low: detect', tone: 'fw' },
      { id: 'g', x: 390, y: 14, w: 150, h: 58, label: 'Gateway AV', sub: 'scan files in transit', tone: 'fw' },
      { id: 'ok', x: 575, y: 20, w: 145, label: 'Delivered', tone: 'ok' },
      { id: 'x', x: 185, y: 120, w: 170, label: 'Exploit / EICAR', sub: 'blocked + logged with SID', tone: 'bad' },
      { id: 'e', x: 390, y: 120, w: 330, h: 58, label: 'False positive on ERP sync', sub: 'read its SID in the log → exclude that one SID only', tone: 'warn' },
    ]} edges={[{ from: 't', to: 'i' }, { from: 'i', to: 'g' }, { from: 'g', to: 'ok', tone: 'ok' }, { from: 'i', to: 'x', tone: 'bad' }, { from: 'x', to: 'e', dash: true }]} />
  ),
  dpi: () => (
    <Flow title="DPI-SSL: decrypt, inspect, re-encrypt" h={240} nodes={[
      { id: 'pc', x: 0, y: 30, w: 150, h: 60, label: 'HR-PC', sub: 'trusts firewall CA', tone: 'host' },
      { id: 'fw', x: 220, y: 20, w: 280, h: 80, label: 'Firewall', sub: 'decrypt → IPS · AV · CFS · App → re-encrypt', tone: 'fw' },
      { id: 's', x: 570, y: 30, w: 150, h: 60, label: 'Website', sub: 'real certificate', tone: 'net' },
      { id: 'b', x: 0, y: 170, w: 150, label: 'bank.example', sub: 'Financial Services', tone: 'host' },
      { id: 'x', x: 220, y: 170, w: 280, label: 'Excluded: passed through untouched', sub: 'privacy · pinned apps keep working', tone: 'ok' },
      { id: 'bs', x: 570, y: 170, w: 150, label: 'Bank', sub: 'original certificate', tone: 'net' },
    ]} edges={[{ from: 'pc', to: 'fw', label: 'TLS #1' }, { from: 'fw', to: 's', label: 'TLS #2' }, { from: 'b', to: 'x' }, { from: 'x', to: 'bs', tone: 'ok' }]} />
  ),
  sslvpn: () => (
    <Flow title="SSL VPN with split tunnel" h={230} nodes={[
      { id: 'l', x: 0, y: 20, w: 150, label: 'REMOTE-LAPTOP', sub: 'home internet', tone: 'host' },
      { id: 'w', x: 185, y: 14, w: 160, h: 58, label: 'WAN :4433', sub: 'TLS tunnel', tone: 'warn' },
      { id: 'a', x: 380, y: 14, w: 160, h: 58, label: 'Login + TOTP', sub: 'priya · SSLVPN Services', tone: 'fw' },
      { id: 'p', x: 575, y: 14, w: 145, h: 58, label: 'Pool address', sub: '192.168.50.10–50', tone: 'step' },
      { id: 'r', x: 380, y: 130, w: 160, label: 'Client routes', sub: 'N_LAN-Staff only', tone: 'fw' },
      { id: 'h', x: 575, y: 110, w: 145, label: 'HR-PC (RDP)', sub: 'reachable', tone: 'ok' },
      { id: 'd', x: 575, y: 176, w: 145, label: 'WEB-01 (DMZ)', sub: 'not routed', tone: 'bad' },
    ]} edges={[{ from: 'l', to: 'w' }, { from: 'w', to: 'a' }, { from: 'a', to: 'p' }, { from: 'p', to: 'r' }, { from: 'r', to: 'h', tone: 'ok' }, { from: 'r', to: 'd', tone: 'bad', dash: true }]} />
  ),
  ipsec: () => (
    <Sequence title="IKEv2 negotiation between HQ and Branch" actors={['KGI-HQ-FW 203.0.113.10', 'Branch FW 198.51.100.20']} msgs={[
      { from: 0, to: 1, label: 'IKE_SA_INIT: proposals (DH 14, AES-256, SHA256)' },
      { from: 1, to: 0, label: 'IKE_SA_INIT: same proposal chosen' },
      { from: 0, to: 1, label: 'IKE_AUTH: proof of the pre-shared key + networks' },
      { from: 1, to: 0, label: 'IKE_AUTH: key matches · 192.168.20.0/24 ↔ 192.168.10.0/24' },
      { from: 0, to: 1, label: 'CHILD SA: ESP AES-256/SHA256, PFS group 14', tone: 'ok' },
      { from: 1, to: 0, label: 'Encrypted traffic flows both ways', tone: 'ok' },
    ]} />
  ),
  ipsecFix: () => (
    <Flow title="Reading the IKE log: stage, message, fix" h={200} nodes={[
      { id: 'a', x: 0, y: 6, w: 200, label: 'Authentication', sub: 'stage that failed', tone: 'step' },
      { id: 'ae', x: 260, y: 6, w: 220, label: 'AUTHENTICATION_FAILED', tone: 'bad' },
      { id: 'af', x: 540, y: 6, w: 180, label: 'Same pre-shared key', tone: 'ok' },
      { id: 'p', x: 0, y: 76, w: 200, label: 'Phase 2 proposal', tone: 'step' },
      { id: 'pe', x: 260, y: 76, w: 220, label: 'NO_PROPOSAL_CHOSEN', tone: 'bad' },
      { id: 'pf', x: 540, y: 76, w: 180, label: 'PFS + DH group match', tone: 'ok' },
      { id: 't', x: 0, y: 146, w: 200, label: 'Traffic selectors', tone: 'step' },
      { id: 'te', x: 260, y: 146, w: 220, label: 'TS_UNACCEPTABLE', tone: 'bad' },
      { id: 'tf', x: 540, y: 146, w: 180, label: 'Mirror the networks', tone: 'ok' },
    ]} edges={[{ from: 'a', to: 'ae' }, { from: 'ae', to: 'af' }, { from: 'p', to: 'pe' }, { from: 'pe', to: 'pf' }, { from: 't', to: 'te' }, { from: 'te', to: 'tf' }]} />
  ),
  sdwan: () => (
    <Flow title="SD-WAN failover by probe" h={230} nodes={[
      { id: 'pc', x: 0, y: 90, w: 140, label: 'HR-PC', sub: 'web traffic', tone: 'host' },
      { id: 'pr', x: 175, y: 84, w: 190, h: 58, label: 'Internet-Failover', sub: 'probe 1.1.1.1 every 3 s', tone: 'fw' },
      { id: 'x1', x: 410, y: 20, w: 150, label: 'X1 · ISP-1', sub: 'probe OK → preferred', tone: 'ok' },
      { id: 'x3', x: 410, y: 160, w: 150, label: 'X3 · ISP-2', sub: 'backup', tone: 'step' },
      { id: 'f', x: 590, y: 20, w: 130, label: 'ISP-1 fails', sub: 'probe lost', tone: 'bad' },
      { id: 'i', x: 590, y: 160, w: 130, label: 'Internet', sub: 'via X3 until X1 recovers', tone: 'net' },
    ]} edges={[{ from: 'pc', to: 'pr' }, { from: 'pr', to: 'x1', tone: 'ok' }, { from: 'pr', to: 'x3', dash: true }, { from: 'x1', to: 'f', tone: 'bad', dash: true }, { from: 'x3', to: 'i', tone: 'ok' }]} />
  ),
  ha: () => (
    <Flow title="High availability: active / standby" h={230} nodes={[
      { id: 'p', x: 120, y: 80, w: 190, h: 58, label: 'Primary · Active', sub: 'serves traffic', tone: 'fw' },
      { id: 's', x: 410, y: 80, w: 190, h: 58, label: 'Secondary · Standby', sub: 'serial 7C3A19E40C11', tone: 'step' },
      { id: 'i', x: 265, y: 4, w: 190, label: 'ISP / X1 monitored', tone: 'net' },
      { id: 'l', x: 265, y: 174, w: 190, label: 'LAN / X0 monitored', tone: 'host' },
      { id: 'f', x: 0, y: 174, w: 200, label: 'Primary loses power', sub: 'standby takes over', tone: 'bad' },
      { id: 'k', x: 520, y: 174, w: 200, label: 'Sessions survive', sub: 'stateful sync', tone: 'ok' },
    ]} edges={[{ from: 'p', to: 's', label: 'config + state sync' }, { from: 'i', to: 'p' }, { from: 'p', to: 'l' }, { from: 'i', to: 's', dash: true }, { from: 's', to: 'l', dash: true }, { from: 'f', to: 'p', tone: 'bad', dash: true }, { from: 's', to: 'k', tone: 'ok' }]} />
  ),
  troubleshoot: () => <Chain title="Evidence-led troubleshooting" cols={3} items={[['Reproduce', 'FIN-PC → ERP HTTPS'], ['Capture', 'dst 192.0.2.20 : 443'], ['Read the drop', 'route next hop dead', 'bad'], ['Fix the cause', 'route, not a new rule'], ['Capture again', 'FORWARDED', 'ok'], ['Write the RCA', 'cause · fix · prevention', 'fw']]} />,
  hardening: () => <Chain title="Hardening checklist" cols={4} items={[['Rename admin', 'kgi-fwadmin'], ['TOTP + lockout', '5 tries / 30 min'], ['Port 4443', 'internal-CA cert'], ['No WAN mgmt', 'Ping only on X1'], ['Syslog', '192.168.10.250:514'], ['Weekly export', 'config off-box'], ['Firmware review', 'check for updates'], ['Audit sheet green', 'every item verified', 'ok']]} />,
  incident: () => <Chain title="Incident response on the firewall" cols={3} items={[['Detect', 'SOC beacon alert', 'warn'], ['Identify', 'logs: one host every 5 min'], ['Contain (everyone)', 'deny C2 at the top', 'fw'], ['Contain (host)', 'quarantine its MAC', 'fw'], ['Preserve evidence', 'capture + exported logs'], ['Report', 'timeline · actions · cause', 'ok']]} />,
};

export function NotebookDiagram({ id }: { id: string }) {
  const f = D[id];
  return f ? f() : null;
}
export const DIAGRAM_IDS = Object.keys(D);
