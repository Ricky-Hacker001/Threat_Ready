// I9 · DNS queries to long random subdomains: endpoint protection
// reputation lookups. Benign.

import { E } from '../../engine/format.js';
import { USERS, hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single } from '../lib.js';

const AV_DOMAIN = 'r.endpointshield.example';
const AV = 'C:\\Program Files\\EndpointShield\\AVService.exe';
const WS = hostNamed('WS-ENG-008');

export default defineScenario({
  code: 'I9', level: 'intermediate', benign: true,
  title: 'Possible DNS tunnelling: long high-entropy subdomains', rule: 'DNS-0610', severity: 'medium', queue: 'network',
  blurb: 'A DNS rule reports long, random-looking subdomains queried from a workstation.',
  sources: ['dns', 'edr', 'proxy', 'winsec', 'firewall', 'email'], sourceGroups: ['dns', 'endpoint'],
  skills: ['log.network', 'log.endpoint', 'tri.false-positive', 'inv.pivot'],
  alertTags: ['av_dns'],
  build(x) {
    const hosts = USERS.slice(0, 16).map((u) => hostNamed(u.host));
    let k = 0;
    for (let t = -1700; t < 0; t += 9) {
      const h = k % 4 === 0 ? WS : hosts[k % hosts.length];
      const q = `${x.r.hex(48 + (k % 16))}.${AV_DOMAIN}`;
      x.add('av_dns', E.dns(x.T(t), { client_ip: h.ip, query: q, qtype: 'A', answer: `127.0.0.${2 + (k % 3)}` }));
      if (h === WS && k % 8 === 0) x.add('av_proc', E.edr(x.T(t), WS.name, 22, 'DNSQuery', { user: 'NT AUTHORITY\\SYSTEM', image: AV, details: `QueryName=${q}`, signature: 'Valid (EndpointShield Ltd)' }));
      k++;
    }
    x.add('decoy_txt', E.dns(x.T(-800), { client_ip: hostNamed('WS-ENG-011').ip, query: `${x.r.hex(60)}.txt-echo.dnstest.example`, qtype: 'TXT', answer: '"ok"' }));
  },
  alert: () => ({
    description: `${WS.name} queried 40+ subdomains of 48-64 random characters under ${AV_DOMAIN}.`,
    entity: { host: WS.name, ip: WS.ip, user: null },
    details: [['Host', WS.name], ['Domain', AV_DOMAIN], ['Pattern', 'Long hex labels, A queries'], ['Rule logic', 'High-entropy labels over 40 characters, 20+ per hour from one host']],
    guidance: ['Find the process making the queries.', 'Check whether other hosts do the same.', 'Find out who owns the domain.'],
  }),
  intel: { [AV_DOMAIN]: { verdict: 'clean', detections: '0/89', facts: [['Owner', 'EndpointShield Ltd (the company\'s endpoint protection vendor)'], ['Purpose', 'File reputation lookups encoded in DNS names']], notes: ['Every protected endpoint queries this service throughout the day.'] } },
  assetNotes: { 'WS-ENG-008': ['EndpointShield endpoint protection installed (AVService.exe).'] },
  triage: {
    checks: [{ id: 'ti', label: 'Domain checked in threat intelligence', test: ran('reputation', AV_DOMAIN) }],
    fields: [
      single('process', 'Process making the queries', 8, [['av', 'The endpoint protection service AVService.exe'], ['ps', 'powershell.exe'], ['browser', 'The browser'], ['unknown', 'An unsigned binary in AppData']], 'av', { hint: 'Trace the query to the process on the endpoint (DNS query events).', explain: 'Signed AVService.exe makes the queries; tunnelling tools are rarely signed security products.', skills: ['log.endpoint'] }),
      single('spread', 'Other hosts', 4, [['most', 'Same pattern on most hosts'], ['one', 'Only this host'], ['servers', 'Only servers']], 'most', { hint: 'Search the domain across all hosts.', explain: 'Every protected host does it.', skills: ['inv.scope'] }),
    ],
    verdict: { accept: { fp: 1, btp: 0.8 }, explain: 'The rule matched reputation lookups it should exclude.' },
    severity: { accept: 'low', explain: 'Normal security-product behaviour.' },
    evidence: { tags: ['av_dns', 'av_proc'], explain: 'The queries and the process behind them.' },
  },
  review: { explain: 'The endpoint telemetry names the signed security product; Tier 1 could close this.' },
  closure: {
    disposition: { options: [['fp', 'False positive: security product reputation lookups'], ['tunnel', 'DNS tunnelling'], ['malware', 'Malware'], ['unknown', 'Unknown']], accept: 'fp', explain: 'Vendor reputation service.' },
    rootCause: { options: [['av', 'Endpoint protection encodes file hashes in DNS lookups'], ['tunnel', 'Exfiltration over DNS'], ['dga', 'Malware with a domain generation algorithm'], ['typo', 'Misconfigured DNS suffix']], accept: 'av', explain: 'Reputation lookups by design.' },
    actions: { options: [['close', 'Close the ticket'], ['exclude', `Exclude ${AV_DOMAIN} reputation lookups from the rule`], ['block', `Block ${AV_DOMAIN}`], ['isolate', `Isolate ${WS.name}`]], set: ['close', 'exclude'], explain: 'Blocking it would blind endpoint protection.' },
  },
  truth: { summary: `The company's endpoint protection (EndpointShield) looks up file reputations by encoding hashes into DNS names under ${AV_DOMAIN}. Every protected host does it all day. The single long TXT query from a developer laptop to a public DNS test service is unrelated.`, timeline: [[-1700, 'Reputation lookups throughout the window.']] },
  test: { tools: { l1_triage: [['reputation', AV_DOMAIN]] } },
});
