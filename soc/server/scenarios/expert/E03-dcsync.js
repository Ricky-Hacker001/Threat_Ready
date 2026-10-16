// E3 · Directory replication request from a non-DC host (DCSync with a
// stolen domain admin account). Domain compromise.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom, ORG } from '../../engine/env.js';
import { defineScenario, single, ran, link } from '../lib.js';

const DA = account('adm.rkhan');
const WS = hostNamed('WS-SAL-001');
const DC2 = hostNamed('DC02');
const GC = '1131f6aa-9c07-11d1-f79f-00c04fc2dcd2';
const GCA = '1131f6ad-9c07-11d1-f79f-00c04fc2dcd2';

export default defineScenario({
  code: 'E3', level: 'expert',
  title: 'Directory replication requested by a non-domain-controller host', rule: 'AD-0662', severity: 'critical', queue: 'identity',
  blurb: 'A domain controller rule reports directory replication requested by a host that is not a domain controller.',
  sources: ['winsec', 'edr', 'proxy', 'dns', 'firewall', 'email'], sourceGroups: ['windows', 'endpoint'],
  skills: ['kno.auth-protocols', 'kno.attack-mapping', 'res.containment', 'res.recovery'],
  alertTags: ['dcsync'],
  build(x) {
    x.add('decoy_repl', E.winsec(x.T(-900), 'DC01', 4662, 'An operation was performed on an object', { subject_user: dom('DC02$'), object_name: `DC=corp,DC=aerofreight,DC=example`, access: `Control Access {${GC}} {${GCA}}`, src_ip: DC2.ip }));
    x.add('logon', E.winsec(x.T(-70), 'DC01', 4624, 'An account was successfully logged on', { target_user: dom(DA.sam), logon_type: 3, auth_package: 'Kerberos', src_ip: WS.ip, workstation: WS.name }));
    x.add('tool', E.procCreate(x.T(-15), WS.name, { user: dom(DA.sam), image: 'C:\\Users\\Public\\m64.exe', command_line: `"C:\\Users\\Public\\m64.exe" "lsadump::dcsync /domain:${ORG.adDomain} /all /csv" exit`, pid: 5520, parent_image: 'C:\\Windows\\System32\\cmd.exe', ppid: 5400, signature: 'Not signed' }));
    x.add('dcsync', E.winsec(x.T(-10), 'DC01', 4662, 'An operation was performed on an object', { subject_user: dom(DA.sam), object_name: 'DC=corp,DC=aerofreight,DC=example', access: `Control Access {${GC}} {${GCA}}`, src_ip: WS.ip }));
    x.add('tgt_odd', E.winsec(x.T(90), 'DC01', 4769, 'A Kerberos service ticket was requested', { target_user: `${DA.sam}@${ORG.adDomain.toUpperCase()}`, service: 'cifs/DC01', src_ip: WS.ip, ticket_encryption: '0x17', status: '0x0', privileges: 'TGT lifetime 87600 hours (10 years)' }));
  },
  alert: () => ({
    description: `Directory replication rights (Get-Changes, Get-Changes-All) used by ${DA.sam} from ${WS.ip}.`,
    entity: { host: 'DC01', ip: WS.ip, user: DA.sam },
    details: [['Requester address', WS.ip], ['Account', DA.sam], ['Rights', 'DS-Replication-Get-Changes and Get-Changes-All'], ['Rule logic', '4662 with replication GUIDs from an address that is not a domain controller']],
    guidance: ['Identify the requesting host and account.', 'Decide what was taken.', 'Look for use of what was taken.'],
  }),
  accountNotes: { 'adm.rkhan': ['Tier-0 account. Should only log on to DC01, DC02 and JUMP01.'] },
  triage: {
    checks: [{ id: 'asset', label: 'Requesting address looked up in the asset inventory', test: ran('asset', [WS.ip, WS.name]) }],
    verdict: { accept: 'tp', explain: 'Only domain controllers replicate.' },
    severity: { accept: 'critical', explain: 'Every password hash in the domain may be stolen.' },
    evidence: { tags: ['dcsync'], explain: 'The replication request.' },
  },
  l2: {
    fields: [
      single('technique', 'Technique', 8, [['dcsync', 'DCSync (T1003.006)'], ['ntds', 'NTDS.dit theft (T1003.003)'], ['lsass', 'LSASS dump (T1003.001)'], ['kerberoast', 'Kerberoasting (T1558.003)']], 'dcsync', { explain: 'Replication rights used to pull hashes over the network.', skills: ['kno.attack-mapping'] }),
      link(single('why_not_dc', 'Why this request is wrong', 6, [['workstation', 'The requester is a workstation using a user account'], ['dc02', 'DC02 replicated at an odd time'], ['volume', 'Too many objects'], ['none', 'It is normal']], 'workstation', { hint: 'Compare the requester with the DC02 replication earlier.', explain: 'The legitimate replication comes from the DC02$ computer account.', skills: ['kno.auth-protocols'] }), 'dcsync'),
      single('stolen', 'What was taken', 8, [['all', 'All account hashes, including krbtgt'], ['one', 'One user\'s hash'], ['none', 'Nothing']], 'all', { hint: 'Read the command line of the tool.', explain: '/all in the command line.', skills: ['inv.scope'] }),
      link(single('golden', 'Is a forged ticket in use', 6, [['yes', 'Yes: a ticket with a 10-year lifetime'], ['no', 'No'], ['unknown', 'Cannot tell']], 'yes', { hint: 'Look at Kerberos activity from the workstation after the replication.', explain: 'A ticket lifetime of 10 years is a golden ticket sign.', skills: ['kno.auth-protocols'] }), 'tgt_odd'),
    ],
  },
  response: {
    scope: { hosts: [WS.name], accounts: [DA.sam, 'krbtgt'] },
    contained: (st) => st.offline(WS.name) && st.disabled.has(DA.sam),
    objectives: [
      { id: 'contain_ws', label: `Isolate ${WS.name}`, points: 3, containment: true, eval: (st) => (st.offline(WS.name) ? 1 : 0), explain: 'The attacker\'s host.' },
      { id: 'creds', label: 'Disable the stolen domain admin account', points: 3, containment: true, eval: (st) => (st.disabled.has(DA.sam) ? 1 : st.reset.has(DA.sam) ? 0.5 : 0), explain: 'It is the account doing the work.' },
      { id: 'krbtgt', label: 'Reset krbtgt twice', points: 4, containment: true, skills: ['res.recovery'], eval: (st) => Math.min(2, st.resetCount.get('krbtgt') || 0) / 2, explain: 'One reset leaves forged tickets valid; two invalidate them.' },
      { id: 'evidence', label: 'Collect the tool from the workstation', points: 2, skills: ['doc.evidence'], eval: (st) => (st.evidence.has(WS.name) ? 1 : 0), explain: 'm64.exe and memory are the evidence.' },
    ],
  },
  closure: {
    disposition: { options: [['domain', 'Domain compromise'], ['contained', 'Contained single-host incident'], ['fp', 'False positive'], ['admin', 'Administrator testing']], accept: 'domain', explain: 'All hashes were taken.' },
    rootCause: { options: [['stolen_da', 'A stolen domain admin account used from a workstation'], ['dc_bug', 'A domain controller bug'], ['repl', 'A misconfigured replication partner'], ['backup', 'A backup product']], accept: 'stolen_da', explain: 'Tier-0 account on a Sales workstation.' },
    actions: { options: [['krbtgt2', 'Reset krbtgt twice, with replication between resets'], ['priv', 'Reset all privileged accounts'], ['ir', 'Run full incident response'], ['krbtgt1', 'Reset krbtgt once'], ['only_da', 'Reset only the admin account']], set: ['krbtgt2', 'priv', 'ir'], explain: 'One reset leaves forged tickets valid.', skills: ['res.recovery'] },
  },
  truth: { summary: `An attacker with the stolen domain admin account ${DA.sam} ran a DCSync from ${WS.name} and pulled the password hashes for krbtgt and every account. A ticket with a ten-year lifetime followed. The replication from DC02$ earlier is normal.`, timeline: [[-900, 'Normal replication from DC02.'], [-70, 'Admin account logs on to DC01 from a workstation.'], [-10, 'DCSync.'], [90, 'Forged ticket used.']] },
  test: { tools: { l1_triage: [['asset', WS.name]] }, response: [['isolate_host', WS.name], ['disable_account', DA.sam], ['reset_credentials', 'krbtgt'], ['reset_credentials', 'krbtgt'], ['acquire_evidence', WS.name]] },
});
