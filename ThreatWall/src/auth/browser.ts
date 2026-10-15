/**
 * The learner's simulated browser on ADMIN-PC. Whether a page loads is decided by the traffic engine
 * (ADMIN-PC → firewall address, TCP port), never by a UI flag.
 */
import type { RootState } from '../state/types';
import { evaluate } from '../engine/traffic';
import { isIPv4 } from '../lib/ip';
import { hasAddress } from '../engine/network';

export interface ParsedUrl { scheme: 'https' | 'http'; host: string; port: number; raw: string }

export function parseUrl(raw: string): ParsedUrl | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^(?:(https?):\/\/)?([^/:\s]+)(?::(\d{1,5}))?(\/.*)?$/i.exec(t);
  if (!m) return null;
  const scheme = (m[1]?.toLowerCase() as 'https' | 'http' | undefined) ?? 'http';
  const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
  if (port < 1 || port > 65535) return null;
  return { scheme, host: m[2].toLowerCase(), port, raw: t };
}

export type BrowserOutcome =
  | { kind: 'blank' }
  | { kind: 'firewall'; iface: string; ip: string; port: number }
  | { kind: 'error'; code: string; title: string; detail: string };

export function browse(s: RootState, url: string): BrowserOutcome {
  const u = parseUrl(url);
  if (!u) return url.trim() ? { kind: 'error', code: 'ERR_INVALID_URL', title: 'This address is not valid', detail: `“${url}” is not a web address.` } : { kind: 'blank' };
  const fwIface = s.config.interfaces.find((i) => hasAddress(i) && i.ip === u.host);
  const r = evaluate(s, { from: 'admin', to: u.host, proto: 'TCP', port: u.port }).result;
  if (!r.ok) {
    const map: Record<string, [string, string]> = {
      'no-address': ['ERR_ADDRESS_UNREACHABLE', 'ADMIN-PC has no network address'],
      'host-offline': ['ERR_CONNECTION_TIMED_OUT', 'This site can’t be reached'],
      'invalid-route': ['ERR_ADDRESS_UNREACHABLE', 'This site can’t be reached'],
      'mgmt-denied': ['ERR_CONNECTION_REFUSED', `${u.host} refused to connect`],
      'dns-failure': ['DNS_PROBE_FINISHED_NXDOMAIN', 'This site can’t be reached'],
    };
    const [code, title] = map[r.verdict] ?? ['ERR_CONNECTION_TIMED_OUT', 'This site can’t be reached'];
    return { kind: 'error', code, title, detail: r.reason };
  }
  if (!fwIface || r.verdict !== 'consumed') {
    return { kind: 'error', code: 'LAB_EXTERNAL_SITE', title: 'Outside the lab', detail: `${u.host} answered, but the lab browser only opens the firewall’s management page. Use Lab Tools › Traffic Tester or the PC console to test other destinations.` };
  }
  if (u.scheme === 'http') {
    if (fwIface.httpRedirect || fwIface.mgmt.http) {
      // management over HTTP is redirected to HTTPS in this lab
      return { kind: 'firewall', iface: fwIface.name, ip: u.host, port: s.config.system.httpsPort };
    }
    return { kind: 'error', code: 'ERR_CONNECTION_REFUSED', title: `${u.host} refused to connect`, detail: 'HTTP management is off. Use https://.' };
  }
  return { kind: 'firewall', iface: fwIface.name, ip: u.host, port: u.port };
}

export const isIp = isIPv4;
