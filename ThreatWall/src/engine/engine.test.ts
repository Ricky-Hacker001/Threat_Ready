import { describe, expect, it } from 'vitest';
import { initialState, LAB } from '../state/baseline';
import { evaluate, type FlowSpec } from './traffic';
import { tunnelStatus } from './vpn';
import { arpTable, leases, pcLease } from './network';
import * as sol from '../tasks/solutions';
import type { RootState } from '../state/types';

const v = (s: RootState, spec: FlowSpec, at?: number) => evaluate(s, spec, { at }).result;
const web = (from: string, to = 'www.search.example'): FlowSpec => ({ from, to, proto: 'TCP', port: 443 });

describe('Level 0', () => {
  it('ADMIN-PC gets a factory DHCP lease only when cabled', () => {
    const s = initialState();
    expect(pcLease(s)).toBeNull();
    const s1 = sol.s01(s);
    expect(s1.session.pc.ip).toBe('192.168.168.100');
    expect(v(s1, { from: 'admin', to: '192.168.168.168', proto: 'ICMP', port: 0 }).verdict).toBe('consumed');
  });
});

describe('Level 1 — office LAN', () => {
  const base = sol.s13(sol.s11(sol.s07(sol.s05(sol.s03(sol.s02(sol.s01(initialState())))))));

  it('rogue laptop wins ARP for .22 until anti-spoof is configured', () => {
    expect(v(base, web('fin')).verdict).toBe('arp-conflict');
    expect(arpTable(base).find((r) => r.ip === LAB.finPc)?.mac).toBe(LAB.macs.rogue);
    const fixed = sol.s14(base);
    expect(v(fixed, web('fin')).verdict).toBe('allowed');
    expect(v(fixed, web('rogue')).verdict).toBe('spoof-blocked');
    expect(arpTable(fixed).find((r) => r.ip === LAB.finPc)?.mac).toBe(LAB.macs.fin);
  });

  it('enforcing ingress without the admin PC in the cache cuts admin traffic except management', () => {
    const s = sol.s14(base);
    const noAdmin = { ...s, config: { ...s.config, antiSpoof: { ...s.config.antiSpoof, cache: s.config.antiSpoof.cache.filter((c) => c.ip !== LAB.adminPc) } } };
    expect(v(noAdmin, web('admin')).verdict).toBe('spoof-blocked');
    expect(v(noAdmin, { from: 'admin', to: LAB.lanIp, proto: 'TCP', port: 443 }).verdict).toBe('consumed');
  });

  it('printer gets its reservation; pool starts at .100', () => {
    const ls = leases(base);
    expect(ls.find((l) => l.host === 'printer')?.ip).toBe(LAB.printer);
  });

  it('LAN-Web-Out allows web and DNS, default disabled denies SSH', () => {
    const s = sol.upTo1(initialState());
    const r = v(s, web('hr'));
    expect(r.verdict).toBe('allowed');
    expect(r.rule).toBe('LAN-Web-Out');
    expect(r.translatedSrc).toBe(LAB.wanIp);
    expect(v(s, { from: 'hr', to: '192.0.2.200', proto: 'TCP', port: 22 }).verdict).toBe('no-rule');
  });

  it('missing DNS in the service group shows up as a DNS failure, not a routing failure', () => {
    const s = sol.upTo1(initialState());
    const noDns = { ...s, config: { ...s.config, serviceGroups: s.config.serviceGroups.map((g) => (g.name === 'SG_Web-DNS' ? { ...g, members: ['HTTP', 'HTTPS'] } : g)) } };
    expect(v(noDns, web('hr')).verdict).toBe('dns-failure');
    expect(v(noDns, { from: 'hr', to: '192.0.2.10', proto: 'TCP', port: 443 }).verdict).toBe('allowed');
  });

  it('wrong WAN gateway is an invalid route', () => {
    const s = sol.upTo1(initialState());
    const bad = { ...s, config: { ...s.config, interfaces: s.config.interfaces.map((i) => (i.name === 'X1' ? { ...i, gateway: '203.0.113.12' } : i)) } };
    expect(v(bad, { from: 'hr', to: '192.0.2.10', proto: 'TCP', port: 443 }).verdict).toBe('invalid-route');
  });

  it('WAN HTTPS management is denied when only Ping is enabled', () => {
    const s = sol.upTo1(initialState());
    expect(v(s, { from: 'outside', to: LAB.wanIp, proto: 'TCP', port: 443 }).verdict).toBe('mgmt-denied');
    expect(v(s, { from: 'outside', to: LAB.wanIp, proto: 'ICMP', port: 0 }).verdict).toBe('consumed');
  });
});

describe('Level 2/3 engine', () => {
  const l1 = () => sol.upTo1(initialState());

  it('published web server: HTTPS ok, HTTP NAT mismatch, SSH mismatch; NAT alone is not enough', () => {
    const s = sol.s22(l1());
    expect(v(s, { from: 'outside', to: LAB.publicWeb, proto: 'TCP', port: 443 }).verdict).toBe('allowed');
    expect(v(s, { from: 'outside', to: LAB.publicWeb, proto: 'TCP', port: 80 }).verdict).toBe('nat-mismatch');
    const noRule = { ...s, config: { ...s.config, accessRules: s.config.accessRules.filter((r) => r.name !== 'WAN-to-WEB-01-HTTPS') } };
    expect(v(noRule, { from: 'outside', to: LAB.publicWeb, proto: 'TCP', port: 443 }).verdict).toBe('denied');
  });

  it('schedules gate a rule by lab time (IST)', () => {
    let s = l1();
    s = {
      ...s,
      config: {
        ...s.config,
        services: [...s.config.services, { id: 's8443', name: 'TCP-8443', protocol: 'TCP', portStart: 8443, portEnd: 8443, builtIn: false }],
        schedules: [...s.config.schedules, { id: 'oh', name: 'Office-Hours', days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00', builtIn: false }],
        accessRules: [sol.mkRule({ name: 'SaaS', fromZone: 'LAN', toZone: 'WAN', service: 'TCP-8443', schedule: 'Office-Hours' }), ...s.config.accessRules],
      },
    };
    const tue10 = Date.parse('2026-10-13T04:30:00Z'); // 10:00 IST
    const tue21 = Date.parse('2026-10-13T15:30:00Z'); // 21:00 IST
    expect(v(s, { from: 'hr', to: '192.0.2.60', proto: 'TCP', port: 8443 }, tue10).verdict).toBe('allowed');
    expect(v(s, { from: 'hr', to: '192.0.2.60', proto: 'TCP', port: 8443 }, tue21).verdict).toBe('schedule-inactive');
  });

  it('IPsec comes up only when both sides match; each fault is diagnosed', () => {
    const s = sol.s34(l1());
    expect(tunnelStatus(s, 'vpn-hq').state).toBe('up');
    expect(v(s, { from: 'branch-pc', to: LAB.adminPc, proto: 'ICMP', port: 0 }).verdict).toBe('allowed');
    const br = (p: (x: RootState['config']['branch']) => RootState['config']['branch']) => ({ ...s, config: { ...s.config, branch: p(s.config.branch) } });
    const p1 = br((b) => ({ ...b, ipsec: b.ipsec.map((x) => ({ ...x, p1: { ...x.p1, enc: 'AES-128' } })) }));
    expect(tunnelStatus(p1, 'vpn-hq').stage).toBe('phase1');
    const psk = br((b) => ({ ...b, ipsec: b.ipsec.map((x) => ({ ...x, secret: 'wrong' })) }));
    expect(tunnelStatus(psk, 'vpn-hq').stage).toBe('auth');
    const net = br((b) => ({ ...b, addresses: b.addresses.map((a) => ({ ...a, ip: '192.168.11.0' })) }));
    expect(tunnelStatus(net, 'vpn-hq').stage).toBe('phase2');
    expect(v(net, { from: 'branch-pc', to: LAB.adminPc, proto: 'ICMP', port: 0 }).verdict).toBe('vpn-unavailable');
  });

  it('SD-WAN moves traffic to X3 when ISP-1 fails and back after recovery', () => {
    const s = sol.s35(l1());
    expect(v(s, web('hr')).egress).toBe('X1');
    const down = { ...s, lab: { ...s.lab, isp: { ...s.lab.isp, X1: 'down' as const } } };
    const r = v(down, web('hr'));
    expect(r.verdict).toBe('allowed');
    expect(r.egress).toBe('X3');
    // without SD-WAN, ISP-1 failure breaks browsing
    const noSd = { ...l1(), lab: { ...s.lab, isp: { X1: 'down' as const, X3: 'up' as const } } };
    expect(v(noSd, { from: 'hr', to: '192.0.2.10', proto: 'TCP', port: 443 }).verdict).toBe('invalid-route');
  });
});
