/** Site-to-site IPsec negotiation between the HQ appliance and the lab Branch firewall. Deterministic. */
import type { AddressObject, BranchConfig, IpsecPolicy, RootState } from '../state/types';
import { addrNetworks } from './objects';
import { cidr, isIPv4 } from '../lib/ip';

export interface TunnelStatus {
  state: 'up' | 'down' | 'disabled';
  stage: 'none' | 'peer' | 'phase1' | 'auth' | 'phase2' | 'up';
  reason: string;
  transcript: string[];
  peerPolicy?: IpsecPolicy;
}

export function branchBuiltIns(b: BranchConfig): AddressObject[] {
  return [
    { id: 'br-x0', name: 'X0 Subnet', zone: 'LAN', type: 'network', ip: b.lanIp, ip2: b.lanMask, fqdn: '', comment: 'Default' },
    { id: 'br-lan', name: 'LAN Subnets', zone: 'LAN', type: 'network', ip: b.lanIp, ip2: b.lanMask, fqdn: '', comment: 'Default' },
    { id: 'br-x1', name: 'X1 IP', zone: 'WAN', type: 'host', ip: b.wanIp, ip2: '255.255.255.255', fqdn: '', comment: 'Default' },
  ];
}

export function branchNetworks(b: BranchConfig, name: string): string[] {
  const a = [...b.addresses, ...branchBuiltIns(b)].find((x) => x.name === name);
  if (!a) return [];
  if (a.type === 'network' && isIPv4(a.ip) && isIPv4(a.ip2)) return [cidr(a.ip, a.ip2)];
  if (a.type === 'host') return [`${a.ip}/32`];
  return [];
}

const fmt = (n: string[]) => (n.length ? n.join(', ') : '(none)');

/** The HQ public address the peer must point at: X1 normally, X3 when SD-WAN has moved traffic. */
function hqWanIp(s: RootState): string | null {
  const x1 = s.config.interfaces.find((i) => i.name === 'X1');
  if (x1 && x1.zone === 'WAN' && x1.mode === 'static' && x1.enabled && s.lab.isp.X1 !== 'down') return x1.ip;
  return null;
}

export function tunnelStatus(s: RootState, policyId: string): TunnelStatus {
  const hq = s.config.ipsec.find((p) => p.id === policyId);
  const t: string[] = [];
  if (!hq || hq.kind !== 'site') return { state: 'disabled', stage: 'none', reason: 'policy not found', transcript: t };
  if (!hq.enabled) return { state: 'disabled', stage: 'none', reason: 'policy is disabled', transcript: t };
  const br = s.config.branch;
  const hqIp = hqWanIp(s);
  t.push(`IKE Initiator: Start ${hq.exchange === 'ikev2' ? 'IKEv2' : hq.exchange === 'main' ? 'Main Mode' : 'Aggressive Mode'} negotiation with ${hq.gateway}`);
  if (!hqIp) return { state: 'down', stage: 'peer', reason: 'HQ WAN (X1) has no usable static address or ISP-1 is down', transcript: [...t, 'IKE: no route to peer — local WAN not available'] };
  if (hq.gateway !== br.wanIp) return { state: 'down', stage: 'peer', reason: `peer gateway ${hq.gateway} does not answer (Branch WAN is ${br.wanIp})`, transcript: [...t, `IKE: Retransmitting IKE request to ${hq.gateway} — no response`] };

  const peer = br.ipsec.find((p) => p.enabled && p.gateway === hqIp);
  if (!peer) {
    return {
      state: 'down', stage: 'peer',
      reason: br.ipsec.some((p) => p.enabled) ? `Branch policy points at ${br.ipsec.find((p) => p.enabled)?.gateway}, not HQ ${hqIp}` : 'Branch firewall has no enabled VPN policy for HQ',
      transcript: [...t, `IKE Responder (${br.hostname}): No matching VPN policy for peer ${hqIp}`],
    };
  }
  if (peer.exchange !== hq.exchange) {
    return { state: 'down', stage: 'phase1', reason: `exchange mode mismatch (HQ ${hq.exchange}, Branch ${peer.exchange})`, transcript: [...t, 'IKE Responder: Exchange mode mismatch — negotiation aborted'], peerPolicy: peer };
  }
  t.push('IKE: Received responder SA proposal');
  const p1 = (p: IpsecPolicy) => `${p.p1.dh}/${p.p1.enc}/${p.p1.auth}`;
  if (p1(hq) !== p1(peer)) {
    return {
      state: 'down', stage: 'phase1', reason: `Phase 1 proposal mismatch (HQ ${p1(hq)}, Branch ${p1(peer)})`,
      transcript: [...t, `IKE Responder: No matching Phase 1 proposal — HQ offered ${p1(hq)}, Branch accepts ${p1(peer)}`], peerPolicy: peer,
    };
  }
  t.push(`IKE: Phase 1 proposal agreed (${p1(hq)})`);
  if (!hq.secret || hq.secret !== peer.secret) {
    return {
      state: 'down', stage: 'auth', reason: 'pre-shared key mismatch',
      transcript: [...t, 'IKE: Received notify AUTHENTICATION_FAILED — IKE authentication failed (pre-shared key mismatch)'], peerPolicy: peer,
    };
  }
  t.push('IKE: Peer authenticated with pre-shared key');
  const p2 = (p: IpsecPolicy) => `${p.p2.proto}/${p.p2.enc}/${p.p2.auth}/PFS ${p.p2.pfs ? p.p2.pfsGroup : 'off'}`;
  if (p2(hq) !== p2(peer)) {
    return {
      state: 'down', stage: 'phase2', reason: `Phase 2 proposal mismatch (HQ ${p2(hq)}, Branch ${p2(peer)})`,
      transcript: [...t, `IKE Responder: No matching Phase 2 proposal — NO_PROPOSAL_CHOSEN (HQ ${p2(hq)}, Branch ${p2(peer)})`], peerPolicy: peer,
    };
  }
  const hqLocal = addrNetworks(s.config, hq.localNet);
  const hqRemote = addrNetworks(s.config, hq.remoteNet);
  const brLocal = branchNetworks(br, peer.localNet);
  const brRemote = branchNetworks(br, peer.remoteNet);
  if (fmt(hqLocal) !== fmt(brRemote) || fmt(hqRemote) !== fmt(brLocal)) {
    return {
      state: 'down', stage: 'phase2', reason: `Phase 2 network mismatch (HQ ${fmt(hqLocal)} ↔ ${fmt(hqRemote)}; Branch ${fmt(brLocal)} ↔ ${fmt(brRemote)})`,
      transcript: [...t, `IKE Responder: Traffic selectors unacceptable — TS_UNACCEPTABLE (HQ local ${fmt(hqLocal)}, Branch expects ${fmt(brRemote)})`], peerPolicy: peer,
    };
  }
  t.push(`IKE: Phase 2 SA established — ${fmt(hqLocal)} ↔ ${fmt(hqRemote)} (${p2(hq)})`);
  return { state: 'up', stage: 'up', reason: 'IKE and IPsec SAs established', transcript: t, peerPolicy: peer };
}

/** Status from the Branch side (for the peer page). */
export function branchTunnelStatus(s: RootState): TunnelStatus | null {
  const hq = s.config.ipsec.find((p) => p.kind === 'site');
  return hq ? tunnelStatus(s, hq.id) : null;
}
