// Building blocks shared by scenarios.

import { E } from './format.js';

// One beacon check-in. What gets logged depends on the response state in
// force at that moment: allowed, denied at the proxy, blocked on an
// isolated host, or nothing at all once the implant has been removed.
export function beacon({ ts, r, k, state, host, ip, user, procUser, domain, destIp, image, pid, ua, dnsEvery = 5 }) {
  if (state.eradicated(host)) return [];
  if (state.offline(host)) {
    return [E.edr(ts, host, 3, 'NetworkConnect blocked (host isolated)', { user: procUser, image, pid, dest_ip: destIp, dest_port: 443, dest_host: domain })];
  }
  const out = [];
  const byDomain = state.domainBlocked(domain);
  const byIp = state.ipBlocked(destIp);
  if (k % dnsEvery === 0) {
    out.push(E.dns(ts - r.int(15, 60), { client_ip: ip, query: domain, rcode: byDomain ? 'REFUSED' : 'NOERROR', answer: byDomain ? undefined : destIp }));
  }
  const denied = byDomain || byIp;
  out.push(E.proxy(ts, {
    src_ip: ip, user, method: 'CONNECT', url: `${domain}:443`, dest_ip: destIp,
    status: byDomain ? 403 : byIp ? 503 : 200,
    bytes_out: denied ? 0 : r.int(480, 760), bytes_in: denied ? 0 : r.int(900, 2400),
    category: 'Uncategorized', action: denied ? 'DENIED' : 'ALLOWED',
    rule: byDomain ? 'SOC-Blocklist-Domain' : byIp ? 'SOC-Blocklist-IP' : undefined, ua,
  }));
  return out;
}

export function intervalStats(events) {
  const ts = events.map((e) => e.ts).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 1000);
  if (!gaps.length) return { n: ts.length, mean: 0, sd: 0 };
  const mean = gaps.reduce((s, x) => s + x, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((s, x) => s + (x - mean) ** 2, 0) / gaps.length);
  return { n: ts.length, mean, sd, first: ts[0], last: ts[ts.length - 1] };
}

export const utc = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
export const daysAgo = (t0, d) => `${new Date(t0 - d * 86400000).toISOString().slice(0, 10)} (${d} days before this alert)`;
