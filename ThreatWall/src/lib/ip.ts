/** IPv4 helpers used by validation and the simulation engine. Pure functions, no DOM. */

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

export const isIPv4 = (s: string): boolean => IPV4_RE.test(s.trim());
export const isMac = (s: string): boolean => MAC_RE.test(s.trim());
export const normalizeMac = (s: string): string => s.trim().toLowerCase().replace(/-/g, ':');

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

export function isMask(s: string): boolean {
  if (!isIPv4(s)) return false;
  const n = ipToInt(s);
  // contiguous ones followed by zeros
  const inv = ~n >>> 0;
  return (inv & (inv + 1)) === 0;
}

export function maskToPrefix(mask: string): number {
  let n = ipToInt(mask);
  let bits = 0;
  while (n & 0x80000000) { bits++; n = (n << 1) >>> 0; }
  return bits;
}

export function prefixToMask(prefix: number): string {
  return intToIp(prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
}

export function networkOf(ip: string, mask: string): string {
  return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
}

export function broadcastOf(ip: string, mask: string): string {
  return intToIp(((ipToInt(ip) & ipToInt(mask)) | (~ipToInt(mask) >>> 0)) >>> 0);
}

export function sameSubnet(a: string, b: string, mask: string): boolean {
  return networkOf(a, mask) === networkOf(b, mask);
}

export function inSubnet(ip: string, net: string, mask: string): boolean {
  return networkOf(ip, mask) === networkOf(net, mask);
}

/** A usable host address in its subnet (not the network or broadcast address, for masks shorter than /31). */
export function isUsableHost(ip: string, mask: string): boolean {
  const p = maskToPrefix(mask);
  if (p >= 31) return true;
  return ip !== networkOf(ip, mask) && ip !== broadcastOf(ip, mask);
}

export function subnetsOverlap(ipA: string, maskA: string, ipB: string, maskB: string): boolean {
  const shorter = maskToPrefix(maskA) <= maskToPrefix(maskB) ? maskA : maskB;
  return networkOf(ipA, shorter) === networkOf(ipB, shorter);
}

export const cidr = (ip: string, mask: string): string => `${networkOf(ip, mask)}/${maskToPrefix(mask)}`;

/** Parse "a.b.c.d/nn" into ip + mask. */
export function parseCidr(s: string): { ip: string; mask: string } | null {
  const [ip, p] = s.trim().split('/');
  if (!isIPv4(ip ?? '') || p === undefined || !/^\d+$/.test(p) || Number(p) > 32) return null;
  return { ip, mask: prefixToMask(Number(p)) };
}

export const UNSET_IP = '0.0.0.0';
