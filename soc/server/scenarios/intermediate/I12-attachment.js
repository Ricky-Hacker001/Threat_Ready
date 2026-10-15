// I12 · Malicious attachment delivered to several users: one opened it,
// the macro was blocked by policy, nothing ran.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom, BINARIES as B } from '../../engine/env.js';
import { fakeSha256 } from '../../engine/rng.js';
import { defineScenario, ran, single, accounts, link } from '../lib.js';

const R = ['p.nair', 'd.okafor', 'm.castillo'].map(account);
const U1 = R[1];
const WS1 = hostNamed(U1.host);
const FILE = 'Payment_Advice.xlsm';
const HASH = fakeSha256('I12-payment-advice');
const SENDER_DOMAIN = 'remit-advice.example';
const DL = 'paydocs-cdn.example';

export default defineScenario({
  code: 'I12', level: 'intermediate',
  title: 'Attachment flagged malicious after delivery', rule: 'MAIL-0230', severity: 'high', queue: 'email',
  blurb: 'The mail gateway re-scanned a delivered attachment and now flags it as malicious.',
  sources: ['email', 'edr', 'proxy', 'dns', 'winsec', 'firewall'], sourceGroups: ['email', 'endpoint'],
  skills: ['kno.phishing', 'inv.scope', 'log.endpoint', 'res.proportionality'],
  entities: { domains: [SENDER_DOMAIN, DL] },
  alertTags: ['verdict'],
  build(x) {
    R.forEach((u, i) => x.add('deliver', E.email(x.T(-25 * 60 + i * 3), { msg_id: `<pa${i}@${SENDER_DOMAIN}>`, from: `accounts@${SENDER_DOMAIN}`, from_name: 'Remittance Team', to: u.email, subject: 'Payment advice - October', src_ip: '198.51.100.233', spf: 'softfail', dkim: 'none', dmarc: 'fail', attachment: FILE, attachment_sha256: HASH, size: 88210, verdict: 'clean', action: 'DELIVERED' })));
    x.add('open', E.procCreate(x.T(-600), WS1.name, { user: dom(U1.sam), image: B.excel.path, command_line: `"${B.excel.path}" "C:\\Users\\${U1.sam}\\Downloads\\${FILE}"`, pid: 8840, parent_image: B.outlook.path, ppid: 3410, sha256: B.excel.sha256, signature: 'Valid (Microsoft Corporation)' }));
    x.add('macro_blocked', E.edr(x.T(-598), WS1.name, 1121, 'Office macro blocked by policy (internet origin)', { user: dom(U1.sam), image: B.excel.path, pid: 8840, target_filename: `C:\\Users\\${U1.sam}\\Downloads\\${FILE}`, details: 'policy=BlockMacrosFromInternet result=blocked' }));
    x.add('verdict', E.email(x.T(-5), { direction: 'inbound', msg_id: `<pa0@${SENDER_DOMAIN}>`, from: `accounts@${SENDER_DOMAIN}`, to: R[0].email, subject: 'Payment advice - October', attachment: FILE, attachment_sha256: HASH, verdict: 'malicious (retro-scan)', action: 'FLAGGED' }));
  },
  alert: () => ({
    description: `The gateway re-scan flags ${FILE} as malicious; it was delivered to ${R.length} mailboxes.`,
    entity: { host: null, ip: null, user: `${R.length} mailboxes` },
    details: [['Attachment', FILE], ['SHA-256', HASH], ['Sender', `accounts@${SENDER_DOMAIN}`], ['Delivered', '25 minutes before the verdict']],
    guidance: ['Find every recipient.', 'Find who opened it and whether anything ran.'],
  }),
  sandbox: { [HASH]: { verdict: 'malicious', score: 92, facts: [['Type', 'Excel macro downloader']], behaviours: [`Macro downloads a payload from ${DL}`], network: [DL], dropped: [] } },
  intel: { [HASH]: { verdict: 'malicious', detections: '31/72', facts: [['Type', 'Macro downloader']], notes: [`Contacts ${DL}.`] } },
  triage: {
    checks: [{ id: 'hash', label: 'Attachment hash checked in threat intelligence', test: ran('reputation', HASH) }],
    verdict: { accept: 'tp', explain: 'A real malicious attachment; one user opened it, so L2 must verify the host.' },
    severity: { accept: 'medium', explain: 'Delivered and opened once, blocked by policy.' },
    evidence: { tags: ['deliver'], explain: 'The deliveries.' },
  },
  l2: {
    fields: [
      accounts('recipients', 'Recipients', 6, R.map((u) => u.sam), { hint: 'Search email by attachment name or hash.', explain: 'Three mailboxes.', skills: ['inv.scope'] }),
      link(accounts('opened', 'Who opened it', 6, [U1.sam], { hint: 'Search process events for the file name.', explain: 'Only one user opened it.', skills: ['log.endpoint'] }), 'open'),
      link(single('ran', 'Did the macro run', 8, [['no', 'No: macro blocked, no child process'], ['yes', 'Yes: it downloaded a payload'], ['unknown', 'Cannot tell']], 'no', { hint: 'Look at what Excel did after opening the file.', explain: 'Policy blocked the macro; Excel started no child process.', skills: ['log.endpoint'] }), 'macro_blocked'),
      single('ioc_hit', 'Did any host contact the download domain', 6, [['no', 'No host contacted it'], ['one', 'The user who opened it'], ['all', 'Every recipient']], 'no', { hint: 'Use the sandbox or intel result to search the proxy and DNS.', explain: 'No DNS or proxy traffic to the domain.', skills: ['inv.ioc'] }),
    ],
  },
  closure: {
    disposition: { options: [['contained', 'True positive, contained by policy'], ['compromise', 'Host compromise'], ['fp', 'False positive'], ['spam', 'Spam']], accept: 'contained', explain: 'Nothing executed.' },
    rootCause: { options: [['phish', 'Malicious attachment in a phishing email; macro policy blocked it'], ['partner', 'Compromised partner'], ['usb', 'USB'], ['web', 'Drive-by download']], accept: 'phish', explain: 'A macro downloader sent by email.' },
    actions: { options: [['purge', 'Purge the email from all 3 mailboxes'], ['block', 'Block the sender and the download domain'], ['verify', `Confirm ${WS1.name} is clean`], ['close', 'Close'], ['isolate_all', 'Isolate all three laptops'], ['reimage', `Re-image ${WS1.name}`]], set: ['purge', 'block', 'verify', 'close'], explain: 'Nothing executed, so isolation and re-imaging are over-response.' },
  },
  truth: { summary: `${FILE} reached three users. Only ${U1.name} opened it. Office blocked the macro because the file came from the internet, Excel started no child process and no host contacted ${DL}.`, timeline: [[-25 * 60, 'Delivered to three mailboxes.'], [-600, 'One user opens it; macro blocked.'], [-5, 'Gateway re-scan flags it.']], iocs: [{ type: 'sha256', value: HASH, note: FILE }, { type: 'domain', value: DL, note: 'Download domain' }] },
  test: { tools: { l1_triage: [['reputation', HASH]] } },
});
