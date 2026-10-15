import type { FirewallConfig, Zone } from '../state/types';
import type { AuditInput } from '../state/store';

export const SECURITY_TYPES: Zone['securityType'][] = ['Trusted', 'Untrusted', 'Public', 'Encrypted', 'SSL VPN', 'Wireless'];

export function blankZone(): Zone {
  return {
    name: '', securityType: 'Trusted', interfaceTrust: true, gatewayAv: true, antiSpyware: true, ips: true, appControl: true,
    sslControl: false, sslVpnAccess: false, dpiSslClient: false, dpiSslServer: false, comment: '', builtIn: false,
  };
}

export function membersOf(cfg: FirewallConfig, zone: string): string[] {
  return cfg.interfaces.filter((i) => i.zone === zone).map((i) => i.name);
}

export function validateZone(cfg: FirewallConfig, z: Zone, originalName: string | null): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(z.name)) e.name = 'Use 1–32 letters, digits, dash or underscore, starting with a letter.';
  else if (cfg.zones.some((x) => x.name.toLowerCase() === z.name.toLowerCase() && x.name !== originalName)) e.name = `A zone named ${z.name} already exists.`;
  return e;
}

export function saveZone(cfg: FirewallConfig, z: Zone, originalName: string | null): { next: FirewallConfig; audit: AuditInput[] } {
  if (originalName === null) {
    return { next: { ...cfg, zones: [...cfg.zones, z] }, audit: [{ category: 'Object', action: `Zone ${z.name} added`, detail: `Security type ${z.securityType}` }] };
  }
  const zones = cfg.zones.map((x) => (x.name === originalName ? z : x));
  const interfaces = originalName !== z.name ? cfg.interfaces.map((i) => (i.zone === originalName ? { ...i, zone: z.name } : i)) : cfg.interfaces;
  return { next: { ...cfg, zones, interfaces }, audit: [{ category: 'Object', action: `Zone ${z.name} modified`, detail: '' }] };
}

export function deleteZones(cfg: FirewallConfig, names: string[]): { next?: FirewallConfig; audit: AuditInput[]; error?: string } {
  const builtIn = names.filter((n) => cfg.zones.find((z) => z.name === n)?.builtIn);
  if (builtIn.length) return { audit: [], error: `Built-in zones cannot be deleted: ${builtIn.join(', ')}.` };
  const used = names.filter((n) => membersOf(cfg, n).length);
  if (used.length) return { audit: [], error: `Zones still have member interfaces: ${used.map((n) => `${n} (${membersOf(cfg, n).join(', ')})`).join('; ')}. Move those interfaces first.` };
  return {
    next: { ...cfg, zones: cfg.zones.filter((z) => !names.includes(z.name)) },
    audit: names.map((n) => ({ category: 'Object' as const, action: `Zone ${n} deleted`, detail: '' })),
  };
}
