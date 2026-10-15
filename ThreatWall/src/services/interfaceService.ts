import type { FirewallConfig, LabSession, NetInterface } from '../state/types';
import { isIPv4, isMask, isUsableHost, inSubnet, subnetsOverlap, cidr, UNSET_IP } from '../lib/ip';
import type { AuditInput } from '../state/store';

export interface FieldIssues {
  errors: Record<string, string>;
  warnings: string[];
}

const configured = (i: NetInterface) => i.mode === 'static' && i.ip !== UNSET_IP;

export function assignmentLabel(i: NetInterface): string {
  if (!i.zone || i.mode === 'unassigned') return '';
  return i.mode === 'static' ? 'Static IP' : 'DHCP';
}

export function statusLabel(i: NetInterface): string {
  if (!i.enabled) return 'Disabled';
  if (i.link === 'up') return i.speed || 'Link up';
  if (i.link === 'down') return 'Link down';
  return 'No link';
}

export function validateInterface(cfg: FirewallConfig, draft: NetInterface): FieldIssues {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  const zone = cfg.zones.find((z) => z.name === draft.zone);

  if (!draft.zone) {
    return { errors, warnings };
  }
  if (!zone) errors.zone = 'Choose a zone that exists.';

  if (draft.mode === 'static') {
    if (!isIPv4(draft.ip) || draft.ip === UNSET_IP) errors.ip = 'Enter a valid IPv4 address, e.g. 192.168.10.1.';
    if (!isMask(draft.mask) || draft.mask === UNSET_IP) errors.mask = 'Enter a valid subnet mask, e.g. 255.255.255.0.';
    if (!errors.ip && !errors.mask && !isUsableHost(draft.ip, draft.mask)) {
      errors.ip = `${draft.ip} is the network or broadcast address of ${cidr(draft.ip, draft.mask)}. Use a host address.`;
    }
    if (!errors.ip && !errors.mask) {
      const clash = cfg.interfaces.find(
        (o) => o.name !== draft.name && configured(o) && subnetsOverlap(o.ip, o.mask, draft.ip, draft.mask),
      );
      if (clash) errors.ip = `Overlaps ${clash.name} (${cidr(clash.ip, clash.mask)}). Each interface needs its own subnet.`;
    }

    const isWan = zone?.securityType === 'Untrusted' && draft.zone === 'WAN';
    const gwSet = draft.gateway && draft.gateway !== UNSET_IP;
    if (gwSet && !isIPv4(draft.gateway)) errors.gateway = 'Enter a valid gateway address.';
    else if (gwSet && !errors.ip && !errors.mask) {
      if (!inSubnet(draft.gateway, draft.ip, draft.mask)) errors.gateway = `The gateway must be inside ${cidr(draft.ip, draft.mask)}.`;
      else if (draft.gateway === draft.ip) errors.gateway = 'The gateway cannot be the interface’s own address.';
    }
    if (isWan && !gwSet) errors.gateway = 'A WAN interface needs the ISP’s default gateway.';

    draft.dns.forEach((d, idx) => {
      if (d && d !== UNSET_IP && !isIPv4(d)) errors[`dns${idx}`] = 'Enter a valid DNS server address.';
    });
    if (isWan && draft.dns.every((d) => !d || d === UNSET_IP)) {
      warnings.push('No DNS servers set. The firewall will not resolve names (task 1.2 will fail).');
    }
  }

  if (zone && (zone.securityType === 'Untrusted') && (draft.mgmt.https || draft.mgmt.http || draft.mgmt.ssh || draft.mgmt.snmp)) {
    warnings.push(`Management (${['https', 'http', 'ssh', 'snmp'].filter((k) => draft.mgmt[k as keyof typeof draft.mgmt]).join(', ').toUpperCase()}) on an untrusted zone exposes the login page to the internet.`);
  }
  if (draft.mgmt.http) warnings.push('HTTP management sends the admin password unencrypted. Use HTTPS.');

  return { errors, warnings };
}

/** Would saving this draft cut the learner's own browser session? */
export function sessionImpact(session: LabSession, before: NetInterface, after: NetInterface): LabSession['disconnected'] {
  if (before.name !== session.connectedVia) return null;
  const stillReachable =
    after.enabled && after.zone !== null && after.mode === 'static' && after.ip === session.connectedIp && after.mgmt.https;
  if (stillReachable) return null;
  let reason = '';
  if (!after.enabled || after.zone === null) reason = `${after.name} was disabled or unassigned.`;
  else if (after.ip !== session.connectedIp) reason = `${after.name} changed from ${session.connectedIp} to ${after.ip}.`;
  else if (!after.mgmt.https) reason = `HTTPS management was turned off on ${after.name}.`;
  else reason = `${after.name} no longer answers on ${session.connectedIp}.`;
  return { reason, previousIp: session.connectedIp, expectedIp: after.mgmt.https && after.mode === 'static' ? after.ip : '' };
}

export function diffInterface(before: NetInterface, after: NetInterface): string {
  const parts: string[] = [];
  if (before.zone !== after.zone) parts.push(`zone ${before.zone ?? 'Unassigned'} → ${after.zone ?? 'Unassigned'}`);
  if (before.mode !== after.mode) parts.push(`mode ${before.mode} → ${after.mode}`);
  if (before.ip !== after.ip || before.mask !== after.mask) parts.push(`IP ${before.ip}/${before.mask} → ${after.ip}/${after.mask}`);
  if (before.gateway !== after.gateway) parts.push(`gateway ${before.gateway} → ${after.gateway}`);
  if (before.dns.join() !== after.dns.join()) parts.push(`DNS ${after.dns.filter((d) => d !== UNSET_IP).join(', ') || 'none'}`);
  const m = (i: NetInterface) => Object.entries(i.mgmt).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join('/') || 'none';
  if (m(before) !== m(after)) parts.push(`management ${m(before)} → ${m(after)}`);
  if (before.enabled !== after.enabled) parts.push(after.enabled ? 'enabled' : 'disabled');
  if (before.comment !== after.comment) parts.push('comment updated');
  return parts.join('; ') || 'no changes';
}

export function vlanName(parent: string, tag: number): string {
  return `${parent}:V${tag}`;
}

export function newVlanDraft(cfg: FirewallConfig, parent: string, tag: number): NetInterface {
  const p = cfg.interfaces.find((i) => i.name === parent)!;
  return {
    ...p,
    name: vlanName(parent, tag),
    kind: 'vlan',
    parent,
    vlanId: tag,
    zone: 'LAN',
    mode: 'static',
    ip: UNSET_IP,
    mask: '255.255.255.0',
    gateway: UNSET_IP,
    dns: [UNSET_IP, UNSET_IP, UNSET_IP],
    mgmt: { https: false, http: false, ping: true, ssh: false, snmp: false },
    userLogin: { http: false, https: false },
    httpRedirect: false,
    comment: '',
    enabled: true,
  };
}

export function validateVlanTag(cfg: FirewallConfig, parent: string, tag: string): string {
  if (!/^\d+$/.test(tag) || Number(tag) < 1 || Number(tag) > 4094) return 'VLAN tag must be a number from 1 to 4094.';
  if (cfg.interfaces.some((i) => i.parent === parent && i.vlanId === Number(tag))) return `VLAN ${tag} already exists on ${parent}.`;
  return '';
}

export function addVlan(cfg: FirewallConfig, draft: NetInterface): { next: FirewallConfig; audit: AuditInput[] } {
  const idx = cfg.interfaces.findIndex((i) => i.name === draft.parent);
  const list = [...cfg.interfaces];
  // keep sub-interfaces right after their parent and its existing VLANs
  let at = idx + 1;
  while (at < list.length && list[at].parent === draft.parent) at++;
  list.splice(at, 0, draft);
  return {
    next: { ...cfg, interfaces: list },
    audit: [{ category: 'Network', action: `VLAN interface ${draft.name} added`, detail: `Zone ${draft.zone}, ${draft.ip}/${draft.mask}` }],
  };
}

export function deleteVlan(cfg: FirewallConfig, name: string): { next: FirewallConfig; audit: AuditInput[] } {
  return {
    next: { ...cfg, interfaces: cfg.interfaces.filter((i) => i.name !== name) },
    audit: [{ category: 'Network', action: `VLAN interface ${name} deleted`, detail: '' }],
  };
}

export function applyInterface(cfg: FirewallConfig, draft: NetInterface): { next: FirewallConfig; audit: AuditInput[] } {
  const before = cfg.interfaces.find((i) => i.name === draft.name)!;
  const clean: NetInterface = draft.zone === null
    ? { ...draft, mode: 'unassigned', ip: UNSET_IP, mask: UNSET_IP, gateway: UNSET_IP, mgmt: { https: false, http: false, ping: false, ssh: false, snmp: false } }
    : { ...draft, gateway: draft.gateway || UNSET_IP, dns: draft.dns.map((d) => d || UNSET_IP) as NetInterface['dns'] };
  const next: FirewallConfig = { ...cfg, interfaces: cfg.interfaces.map((i) => (i.name === draft.name ? clean : i)) };
  return { next, audit: [{ category: 'Network', action: `Interface ${draft.name} modified`, detail: diffInterface(before, clean) }] };
}
