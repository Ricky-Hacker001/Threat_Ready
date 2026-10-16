// I7 · Large upload to personal cloud storage by a departing employee.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single, link, VERDICTS } from '../lib.js';

const U = account('r.delgado');
const WS = hostNamed(U.host);
const CLOUD = 'boxvault-personal.example';
const CLOUD_IP = '198.51.100.152';

export default defineScenario({
  code: 'I7', level: 'intermediate',
  title: 'Over 1 GB uploaded to a personal storage service', rule: 'DLP-0510', severity: 'high', queue: 'data protection',
  blurb: 'A data-loss rule reports a large upload to a personal storage service.',
  sources: ['proxy', 'dns', 'winsec', 'edr', 'firewall', 'email'], sourceGroups: ['proxy'],
  skills: ['log.network', 'inv.scope', 'tri.escalation', 'doc.evidence'],
  entities: { domains: [CLOUD], ips: [CLOUD_IP] },
  verdicts: [...VERDICTS, ['policy', 'Policy violation: a person moving data against policy']],
  alertTags: ['upload'],
  build(x) {
    const ex = x.n(7, 6);
    for (let i = 0; i < ex; i++) x.add('crm_export', E.proxy(x.T(-1700 + i * 40), { src_ip: WS.ip, user: dom(U.sam), method: 'GET', url: `https://aerofreight.my.salesforce.com/export?type=accounts&fmt=csv&part=${i + 1}`, dest_ip: '136.147.46.10', status: 200, bytes_out: 900, bytes_in: (40 + i * 25) * 1048576, category: 'Business/CRM' }));
    [600, 700, 650].forEach((mb, i) => x.add('upload', E.proxy(x.T(-900 + i * 280), { src_ip: WS.ip, user: dom(U.sam), method: 'POST', url: `https://${CLOUD}/upload`, dest_ip: CLOUD_IP, status: 200, bytes_out: Math.round(mb * x.n(100, 95) / 100) * 1048576, bytes_in: 4800, category: 'Personal Storage' })));
    x.add('decoy_share', E.proxy(x.T(-1200), { src_ip: hostNamed('WS-SAL-001').ip, user: dom('k.yamamoto'), method: 'POST', url: 'https://aerofreight.sharepoint.com/sites/Sales/_layouts/15/upload.aspx', dest_ip: '13.107.136.10', status: 200, bytes_out: 314572800, bytes_in: 2100, category: 'Business/File Sharing' }));
  },
  alert: ({ tagged }) => ({
    description: `${U.sam} uploaded ${(tagged('upload').reduce((s, e) => s + e.fields.bytes_out, 0) / 1073741824).toFixed(1)} GB to ${CLOUD} in three sessions.`,
    entity: { host: WS.name, ip: WS.ip, user: U.sam },
    details: [['User', U.sam], ['Destination', CLOUD], ['Category', 'Personal Storage'], ['Rule logic', '1 GB+ uploaded to the Personal Storage category within 1 hour']],
    guidance: ['Find out who the user is right now.', 'Find out where the data came from.'],
  }),
  accountNotes: { 'r.delgado': ['HR note: resigned; leaving date this Friday.'] },
  intel: { [CLOUD]: { verdict: 'clean', detections: '0/89', facts: [['Category', 'Consumer file storage']], notes: ['Not malicious; not an approved company service.'] } },
  triage: {
    checks: [
      { id: 'dir', label: 'User looked up in the directory', test: ran('user', U.sam) },
      { id: 'ti', label: 'Destination checked in threat intelligence', test: ran('reputation', CLOUD) },
    ],
    verdict: { accept: { policy: 1, tp: 0.6 }, explain: 'A person moving company data against policy, not an attacker or malware.' },
    severity: { accept: 'high', explain: 'Customer data leaving the company.' },
    evidence: { tags: ['upload'], explain: 'The uploads.' },
  },
  l2: {
    fields: [
      single('volume', 'How much was uploaded', 4, [['2gb', 'About 2 GB in 3 sessions'], ['200mb', 'About 200 MB'], ['20gb', 'About 20 GB'], ['none', 'Nothing completed']], '2gb', { hint: 'Sum bytes_out of the uploads.', explain: 'Three POSTs of roughly 600-700 MB each.', skills: ['log.network'] }),
      link(single('data_source', 'Where the data came from', 8, [['crm', 'Customer exports from the CRM earlier the same day'], ['share', 'The Sales file share'], ['email', 'Email attachments'], ['unknown', 'Cannot be determined']], 'crm', { hint: 'Search the user\'s proxy history before the upload.', explain: 'CRM exports minutes earlier match the volume.', skills: ['inv.pivot'] }), 'crm_export'),
      single('context', 'What the user context adds', 6, [['leaving', 'The user is leaving the company this week'], ['travel', 'The user is travelling'], ['new', 'The user is new'], ['none', 'Nothing relevant']], 'leaving', { hint: 'Look the user up in the directory.', explain: 'Resigned, last day Friday.', skills: ['tri.escalation'] }),
      single('malware', 'Malware involvement', 4, [['none', 'No malware involvement'], ['stealer', 'An info-stealer'], ['rat', 'A remote-access tool']], 'none', { hint: 'Is there any sign of a process other than the browser?', explain: 'Browser uploads by the user, nothing else.', skills: ['kno.malware'] }),
    ],
  },
  closure: {
    disposition: { options: [['policy', 'Policy violation: suspected data theft by a departing employee'], ['attack', 'External attack'], ['benign', 'Benign: approved backup'], ['fp', 'False positive']], accept: 'policy', explain: 'Insider data movement.' },
    rootCause: { options: [['departing', 'A departing employee copying customer data'], ['malware', 'Malware'], ['sync', 'Sync client misconfigured'], ['mistake', 'An accidental upload']], accept: 'departing', explain: 'Exports then uploads, days before leaving.' },
    actions: { options: [['hr_legal', 'Escalate to HR and legal'], ['preserve', 'Preserve the proxy and CRM logs'], ['block', `Block ${CLOUD} for the user`], ['manager', 'Inform the manager through HR'], ['confront', 'Contact the user directly'], ['wipe', 'Wipe the user\'s laptop'], ['delete_logs', 'Delete the logs after export']], set: ['hr_legal', 'preserve', 'block', 'manager'], explain: 'Evidence must be preserved and the employee must not be tipped off by the SOC.', skills: ['doc.evidence', 'res.proportionality'] },
  },
  truth: { summary: `${U.name}, who has resigned and leaves on Friday, exported customer lists from the CRM and uploaded about 2 GB to a personal storage account at ${CLOUD}. No malware is involved. A colleague's 300 MB upload to the company SharePoint is approved business use.`, timeline: [[-1700, 'CRM exports start.'], [-900, 'First upload to personal storage.']], iocs: [{ type: 'domain', value: CLOUD, note: 'Personal storage destination' }] },
  test: { tools: { l1_triage: [['user', U.sam], ['reputation', CLOUD]] } },
});
