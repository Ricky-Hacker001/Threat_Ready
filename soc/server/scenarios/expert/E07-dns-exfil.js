// E7 · Slightly unusual DNS volume from one host over three weeks: low-and-
// slow DNS tunnelling from an HR workstation. No single event is alarming;
// the daily statistics are.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single, link } from '../lib.js';

const WS = hostNamed('WS-HR-003');
const U = account(WS.owner);
const TUN = 'syncstat-cloud.example';
const CDN = 'edgecache-cdn.example';
const IMG = `C:\\Users\\${U.sam}\\AppData\\Roaming\\OneDriveSync\\OneDriveSync.exe`;
const DAYS = 21;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

const label = (x, n) => Array.from({ length: n }, () => B32[x.r.int(0, 31)]).join('');
const dayOf = (t0, d) => new Date(t0 - d * 86400000).toISOString().slice(0, 10);

export default defineScenario({
  code: 'E7', level: 'expert',
  title: 'DNS query volume from one host slightly above baseline', rule: 'DNS-0520', severity: 'medium', queue: 'network',
  blurb: 'A DNS analytics rule reports one workstation sending a little more DNS data than its peers, day after day.',
  sources: ['dns', 'proxy', 'edr', 'fileaudit', 'winsec', 'firewall'], sourceGroups: ['dns', 'endpoint'],
  skills: ['log.network', 'inv.timeline', 'inv.scope', 'inv.ioc'],
  entities: { domains: [TUN, CDN] },
  history: 60 * 60,
  alertTags: ['stats'],
  build(x) {
    const t0 = x.t0;
    // Daily roll-up exported by DNS analytics a few minutes ago.
    let total = 0;
    for (let d = DAYS + 2; d >= 1; d--) {
      const ts = x.T(-600 + (DAYS + 2 - d) * 2);
      if (d <= DAYS) {
        const qc = x.r.int(1050, 1400);
        const lb = x.r.int(75000, 95000);
        total += lb;
        x.add('stats', E.dnsStats(ts, { day: dayOf(t0, d), client_ip: WS.ip, src_host: WS.name, domain: TUN, query_count: qc, label_bytes: lb, unique_labels: qc - x.r.int(0, 4) }));
      }
      x.add('decoy_cdn', E.dnsStats(ts + 1, { day: dayOf(t0, d), client_ip: WS.ip, src_host: WS.name, domain: CDN, query_count: x.r.int(2400, 3100), label_bytes: x.r.int(28000, 36000), unique_labels: x.r.int(9, 14) }));
      x.add('peer', E.dnsStats(ts + 2, { day: dayOf(t0, d), client_ip: hostNamed('WS-FIN-009').ip, src_host: 'WS-FIN-009', domain: CDN, query_count: x.r.int(2200, 3000), label_bytes: x.r.int(27000, 35000), unique_labels: x.r.int(9, 14) }));
    }
    x.total = total;
    // Live queries: one TXT query every ~70 s, a new random label each time.
    for (let t = -3300; t < 0; t += 70) {
      const q = `${label(x, 56)}.${label(x, 8)}.t.${TUN}`;
      x.add('tun_q', E.dns(x.T(t), { client_ip: WS.ip, query: q, qtype: 'TXT', answer: `"${label(x, 12)}"` }));
      if (t % 700 === -3300 % 700) x.add('tun_proc', E.edr(x.T(t), WS.name, 22, 'DNSQuery', { user: dom(U.sam), image: IMG, details: `QueryName=${q}`, signature: 'Unsigned' }));
    }
    x.add('hr_read', E.fileaudit(x.T(-50 * 60), { server: 'FS01', user: dom(U.sam), share: 'HR', path: 'D:\\Shares\\HR\\Salaries\\salary-review-2026.xlsx', access: 'ReadData', process: IMG, src_ip: WS.ip }));
    x.add('hr_read', E.fileaudit(x.T(-49 * 60), { server: 'FS01', user: dom(U.sam), share: 'HR', path: 'D:\\Shares\\HR\\Employees\\staff-records.csv', access: 'ReadData', process: IMG, src_ip: WS.ip }));
    x.add('decoy_hr', E.fileaudit(x.T(-20 * 60), { server: 'FS01', user: dom(U.sam), share: 'HR', path: 'D:\\Shares\\HR\\Policies\\leave-policy.docx', access: 'ReadData', process: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE', src_ip: WS.ip }));
  },
  alert: ({ tagged }) => {
    const s = tagged('stats');
    return {
      description: `${WS.name} has sent more DNS label data than its peers on ${s.length} consecutive days.`,
      entity: { host: WS.name, ip: WS.ip, user: U.sam },
      details: [['Host', WS.name], ['Window', `${DAYS} days`], ['Daily DNS label data', '75-95 KB to one domain'], ['Rule logic', 'Per-host daily label bytes above the peer median for 14+ days']],
      guidance: ['Read the daily statistics, not single queries.', 'Compare unique labels with query count.', 'Find the process behind the queries.'],
    };
  },
  intel: { [TUN]: { verdict: 'unknown', detections: '0/89', facts: [['Registered', '24 days ago'], ['Name servers', 'Self-hosted, single address']], notes: ['No reputation history.'] }, [CDN]: { verdict: 'clean', detections: '0/89', facts: [['Owner', 'Content delivery network used by the HR system']], notes: [] } },
  accountNotes: { [U.sam]: ['HR Advisor. Uses Microsoft OneDrive (OneDrive.exe) for file sync.'] },
  triage: {
    checks: [
      { id: 'ti', label: 'Domain checked in threat intelligence', test: ran('reputation', TUN) },
      { id: 'asset', label: 'Workstation looked up in the asset inventory', test: ran('asset', [WS.name, WS.ip]) },
    ],
    fields: [
      single('signal', 'What makes the traffic unusual', 6, [['labels', 'Almost every query has a new unique label, with large label data per day'], ['count', 'The query count is the highest on the network'], ['nxdomain', 'Most queries fail'], ['port', 'It uses a non-standard port']], 'labels', { hint: 'Compare unique_labels with query_count for each domain.', explain: 'Normal domains repeat a few names thousands of times. Here every query carries new data.', skills: ['log.network'] }),
    ],
    verdict: { accept: 'tp', explain: 'A steady flow of unique encoded labels to a three-week-old domain, from an unsigned binary posing as a sync client.' },
    severity: { accept: 'high', explain: 'Ongoing data loss from HR.' },
    evidence: { tags: ['stats'], explain: 'The daily statistics are the evidence; single events look harmless.' },
  },
  l2: {
    fields: [
      link(single('process', 'Process making the queries', 6, [['fake', 'OneDriveSync.exe, unsigned, in the user\'s AppData'], ['onedrive', 'Microsoft OneDrive (OneDrive.exe)'], ['svchost', 'The Windows DNS client'], ['browser', 'The browser']], 'fake', { hint: 'Trace the queries to the process on the endpoint (DNS query events).', explain: 'A look-alike name in AppData, unsigned. The real client is OneDrive.exe.', skills: ['log.endpoint', 'kno.malware'] }), 'tun_proc'),
      link(single('duration', 'How long it has been going on', 4, [['21', 'About three weeks'], ['1', 'Since today'], ['7', 'About a week'], ['90', 'About three months']], '21', { hint: 'Find the first day the domain appears in the statistics.', explain: 'The domain first appears 21 days ago and every day since.', skills: ['inv.timeline'] }), 'stats'),
      single('volume', 'Data sent through DNS labels over the period', 8, [['mb', 'About 1-3 MB'], ['kb', 'Under 100 KB'], ['tens', 'About 10-30 MB'], ['gb', 'Over 1 GB']], 'mb', { hint: 'Add up label_bytes for the domain across the days.', explain: 'Roughly 21 days at 75-95 KB a day: under 2 MB of encoded data, enough for a staff list and a salary sheet.', skills: ['inv.ioc'] }),
      link(single('data', 'What data was likely taken', 6, [['hr', 'HR files read by the same process'], ['none', 'Nothing; DNS cannot carry data'], ['mail', 'Mailbox content'], ['policies', 'HR policy documents opened in Word']], 'hr', { hint: 'Search file auditing for the same process.', explain: 'The same binary read the salary review and staff records. The policy document was opened by Word.', skills: ['inv.pivot'] }), 'hr_read'),
      single('decoy', `The high query count to ${CDN}`, 4, [['benign', 'Benign: many queries but only a dozen names, same as peers'], ['malicious', 'A second channel'], ['unknown', 'Cannot tell']], 'benign', { explain: 'Volume alone is not the signal; the peer workstation looks identical.', skills: ['tri.false-positive'] }),
    ],
  },
  response: {
    scope: { hosts: [WS.name], domains: [TUN] },
    contained: (st) => st.domainBlocked(TUN) && st.offline(WS.name),
    objectives: [
      { id: 'block', label: 'Block the tunnelling domain', points: 3, containment: true, eval: (st) => (st.domainBlocked(TUN) ? 1 : 0), explain: 'Stops the channel for every host at once.' },
      { id: 'isolate', label: 'Isolate the workstation', points: 3, containment: true, eval: (st) => (st.offline(WS.name) ? 1 : 0), explain: 'The implant is still running.' },
      { id: 'evidence', label: 'Acquire a forensic package before cleaning', points: 2, skills: ['doc.evidence'], eval: (st) => (st.evidence.has(WS.name) ? 1 : 0), explain: 'Needed to confirm exactly what was sent.' },
      { id: 'sweep', label: 'Sweep the fleet for the domain', points: 2, skills: ['inv.scope'], eval: (st, ctx) => (ctx.case.toolRuns.some((t) => t.tool === 'sweep' && t.input.toLowerCase().includes(TUN)) ? 1 : 0), explain: 'Low-and-slow channels are rarely on one host only.' },
      { id: 'legal', label: 'Tell the privacy officer about the HR data', points: 2, eval: (st) => (st.notified.has('legal') ? 1 : 0), explain: 'Personal data left the company; there may be a reporting duty.' },
    ],
  },
  closure: {
    disposition: { options: [['exfil', 'True positive: DNS tunnelling exfiltration over three weeks'], ['fp', 'False positive: CDN traffic'], ['beacon', 'Command and control only, no data loss'], ['user', 'User sync tool']], accept: 'exfil', explain: 'Data left through DNS labels.' },
    rootCause: { options: [['implant', 'An implant disguised as a sync client'], ['dns', 'A DNS server misconfiguration'], ['onedrive', 'OneDrive misbehaving'], ['insider', 'The user exporting data deliberately']], accept: 'implant', explain: 'Unsigned look-alike in AppData.' },
    actions: { options: [['detect', 'Add a detection on unique-label ratio per domain'], ['egress', 'Force DNS through the internal resolver and block direct DNS'], ['estimate', 'Record the estimated data loss in the case'], ['block_dns', 'Block all TXT queries company-wide']], set: ['detect', 'egress', 'estimate'], explain: 'Blocking all TXT breaks mail security and many services.', skills: ['doc.root-cause'] },
  },
  truth: { summary: `An implant named OneDriveSync.exe in ${U.name}'s AppData on ${WS.name} has been sending data out through DNS TXT queries to ${TUN} for ${DAYS} days, about 75-95 KB of encoded labels a day. It read the HR salary review and staff records. Traffic to ${CDN} is normal HR system use and looks the same on the peer workstation.`, timeline: [[-DAYS * 86400, `First queries to ${TUN}.`], [-50 * 60, 'Implant reads HR files.'], [-600, 'Daily statistics exported.']], iocs: [{ type: 'domain', value: TUN, note: 'Tunnelling domain' }] },
  test: { tools: { l1_triage: [['reputation', TUN], ['asset', WS.name]], l2_investigation: [['sweep', TUN]] }, response: [['block_domain', TUN], ['acquire_evidence', WS.name], ['isolate_host', WS.name], ['notify', 'legal']] },
});
