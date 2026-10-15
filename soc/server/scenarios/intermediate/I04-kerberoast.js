// I4 · Many Kerberos service-ticket requests with RC4 (Kerberoasting).

import { E } from '../../engine/format.js';
import { account, hostNamed, ORG } from '../../engine/env.js';
import { defineScenario, ran, single, host, accounts, link } from '../lib.js';

const U = account('t.nguyen');
const WS = hostNamed(U.host);
const SVCS = ['svc_sql', 'svc_backup', 'svc_web', 'svc_scan', 'svc_inventory', 'svc_finrpt', 'svc_migrate'];
const SPN = { svc_sql: 'MSSQLSvc/SQL01:1433', svc_backup: 'BackupAgent/BKP01', svc_web: 'HTTP/WEB01', svc_scan: 'ScanAgent/SCAN01', svc_inventory: 'HTTP/INV01', svc_finrpt: 'HTTP/FIN-APP02', svc_migrate: 'MigSvc/MIG01' };

export default defineScenario({
  code: 'I4', level: 'intermediate',
  title: 'Many Kerberos service tickets requested with RC4 encryption by one account', rule: 'AUTH-0090', severity: 'high', queue: 'authentication',
  blurb: 'A domain controller rule reports a burst of RC4 service-ticket requests from one account.',
  sources: ['winsec', 'dns', 'proxy', 'edr', 'firewall', 'email'], sourceGroups: ['windows'],
  skills: ['kno.auth-protocols', 'kno.attack-mapping', 'inv.scope', 'log.windows-auth'],
  alertTags: ['roast'],
  build(x) {
    const n = Math.min(SVCS.length, x.n(7, 6));
    SVCS.slice(0, n).forEach((s, i) => x.add('roast', E.winsec(x.T(-45 + i * 5), 'DC01', 4769, 'A Kerberos service ticket was requested', {
      target_user: `${U.sam}@${ORG.adDomain.toUpperCase()}`, service: SPN[s], service_name: s, src_ip: WS.ip, ticket_encryption: '0x17', status: '0x0',
    })));
    for (let i = 0; i < 6; i++) x.add('decoy_backup', E.winsec(x.T(-600 + i * 3), 'DC01', 4769, 'A Kerberos service ticket was requested', { target_user: `svc_backup@${ORG.adDomain.toUpperCase()}`, service: `cifs/${['FS01', 'APP01', 'SQL01', 'JUMP01', 'FS02', 'APP02'][i]}`, src_ip: hostNamed('BKP01').ip, ticket_encryption: '0x12', status: '0x0' }));
  },
  alert: ({ tagged }) => ({
    description: `${tagged('roast').length} service tickets with RC4 encryption (0x17) requested by ${U.sam} within one minute.`,
    entity: { host: null, ip: WS.ip, user: U.sam },
    details: [['Account', U.sam], ['Client address', WS.ip], ['Tickets', String(tagged('roast').length)], ['Encryption', '0x17 (RC4-HMAC)'], ['Rule logic', '5+ 4769 with encryption 0x17 from one account within 5 minutes']],
    guidance: ['Compare the encryption type with normal tickets.', 'List the service accounts targeted.'],
  }),
  accountNotes: { svc_backup: ['Member of Backup Operators: can read every file on every server.'], svc_sql: ['Password last set 4 years ago.'] },
  triage: {
    checks: [{ id: 'asset', label: 'Client address looked up in the asset inventory', test: ran('asset', [WS.ip, WS.name]) }],
    fields: [single('enc', 'Ticket encryption requested', 6, [['rc4', '0x17, RC4'], ['aes', '0x12, AES-256'], ['des', '0x3, DES'], ['none', 'Not recorded']], 'rc4', { hint: 'Compare with the other 4769 events in the feed.', explain: 'RC4 tickets are the ones that crack easily offline; normal tickets here use AES (0x12).', skills: ['kno.auth-protocols'] })],
    verdict: { accept: 'tp', explain: 'A workstation asking for RC4 tickets for every service account is Kerberoasting.' },
    severity: { accept: 'high', explain: 'Service-account secrets are being harvested.' },
    evidence: { tags: ['roast'], explain: 'The RC4 ticket requests.' },
  },
  l2: {
    fields: [
      single('technique', 'Technique', 6, [['kerberoast', 'Kerberoasting (T1558.003)'], ['asrep', 'AS-REP roasting (T1558.004)'], ['golden', 'Golden ticket (T1558.001)'], ['pth', 'Pass the hash (T1550.002)']], { kerberoast: 1, asrep: 0.3 }, { hint: 'Which ticket type was requested, and for whom?', explain: 'TGS requests for service accounts, with RC4, by a normal user.', skills: ['kno.attack-mapping'] }),
      link(host('source', 'Source host', 4, WS.name, { hint: 'Look up the client address.', explain: 'The client address is the user\'s workstation.', skills: ['inv.pivot'] }), 'roast'),
      accounts('targets', 'Service accounts targeted', 8, SVCS.slice(0, 6), { hint: 'List service_name on every RC4 request.', explain: 'Every account named in the RC4 requests.', skills: ['inv.scope'] }),
      single('priority', 'Which to reset first', 6, [['svc_backup', 'svc_backup: privileged group'], ['svc_sql', 'svc_sql: oldest password'], ['svc_web', 'svc_web: internet-facing'], ['any', 'Order does not matter']], { svc_backup: 1, svc_sql: 0.5 }, { hint: 'Look each target up in the directory.', explain: 'Reset the most powerful account first: Backup Operators can read everything.', skills: ['res.containment'] }),
      single('used_yet', 'Have the service accounts been used elsewhere yet', 6, [['no', 'No sign of use from unusual hosts yet'], ['yes', 'Yes, from the workstation'], ['dc', 'Yes, on the domain controller']], 'no', { hint: 'Search 4624 for the targeted accounts from unusual sources.', explain: 'Only their normal logons appear.', skills: ['inv.search'] }),
    ],
  },
  closure: {
    disposition: { options: [['incident', 'True positive: credential theft in progress'], ['benign', 'Benign scanner'], ['fp', 'False positive'], ['unknown', 'Unknown']], accept: 'incident', explain: 'Kerberoasting from a user workstation.' },
    rootCause: { options: [['compromised_ws', 'A compromised workstation used for Kerberoasting'], ['admin', 'An administrator testing'], ['app', 'An application using legacy encryption'], ['dc', 'A domain controller fault']], accept: 'compromised_ws', explain: 'Nothing on that workstation should request service tickets this way.' },
    actions: { options: [['reset_svc', 'Reset every targeted service-account password to a long random value, svc_backup first'], ['escalate', `Escalate ${WS.name} for investigation`], ['rc4', 'Plan to disable RC4 in the domain'], ['disable_all', 'Disable all service accounts now'], ['reset_user', `Reset only ${U.sam}'s password`]], set: ['reset_svc', 'escalate', 'rc4'], explain: 'Disabling service accounts stops the business; the user\'s password is not what was stolen.', skills: ['res.containment', 'res.recovery'] },
  },
  truth: { summary: `${WS.name}, used by ${U.name}, is compromised. Within a minute it requested RC4 service tickets for every service account with a service principal name, so they can be cracked offline. No targeted account had been used elsewhere yet. The burst of AES tickets from BKP01 earlier is the normal backup schedule.`, timeline: [[-600, 'Normal backup ticket burst (AES).'], [-45, 'RC4 ticket requests begin.']] },
  test: { tools: { l1_triage: [['asset', WS.ip]] } },
});
