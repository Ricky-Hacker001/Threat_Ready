// E10 · Admin RDP sessions at night from the jump server. Most of it is the
// approved maintenance in CHG-4540; one hop uses another administrator's
// account to reach the finance server, outside the change. Split verdict.

import { E } from '../../engine/format.js';
import { hostNamed, dom, VPN_POOL } from '../../engine/env.js';
import { defineScenario, ran, single, multi, account as acct, link } from '../lib.js';

const JUMP = hostNamed('JUMP01');
const SQL = hostNamed('SQL01');
const APP = hostNamed('APP01');
const FIN = hostNamed('FIN01');
const CHG = 'CHG-4540';
const HOME = '198.51.100.31';
const VPNIP = `${VPN_POOL}.37`;

const rdp = (x, tag, at, host, user, lid) => x.add(tag, E.winsec(x.T(at), host.name, 4624, 'An account was successfully logged on', { target_user: dom(user), logon_type: 10, auth_package: 'Negotiate', src_ip: JUMP.ip, workstation: 'JUMP01', logon_id: lid }));

export default defineScenario({
  code: 'E10', level: 'expert',
  title: 'Administrator RDP sessions at night from the jump server', rule: 'WIN-0624', severity: 'medium', queue: 'authentication',
  blurb: 'A Windows rule reports remote desktop logons by administrators outside business hours.',
  sources: ['winsec', 'vpn', 'edr', 'fileaudit', 'firewall', 'dns'], sourceGroups: ['windows', 'identity'],
  skills: ['log.windows-auth', 'tri.verdict', 'inv.timeline', 'res.proportionality'],
  entities: { ids: [CHG], ips: [HOME] },
  history: 2 * 3600,
  alertTags: ['in_scope', 'hop'],
  build(x) {
    x.add('vpn', E.vpn(x.T(-95 * 60), { event: 'connect', user: 'r.khan', src_ip: HOME, src_country: 'GB', assigned_ip: VPNIP, client: 'GlobalConnect 6.1', device_id: 'dev-rkhan-lt', pop: 'LON' }));
    x.add('jump', E.winsec(x.T(-93 * 60), JUMP.name, 4624, 'An account was successfully logged on', { target_user: dom('adm.rkhan'), logon_type: 10, auth_package: 'Kerberos', src_ip: VPNIP, workstation: 'WS-IT-002', logon_id: '0x3A1F0' }));
    rdp(x, 'in_scope', -90 * 60, SQL, 'adm.rkhan', '0x51C2');
    x.add('in_scope', E.winsys(x.T(-80 * 60), SQL.name, 7036, 'The service entered the stopped state', { service_name: 'MSSQLSERVER', state: 'stopped', user: dom('adm.rkhan') }));
    x.add('in_scope', E.winsys(x.T(-62 * 60), SQL.name, 7036, 'The service entered the running state', { service_name: 'MSSQLSERVER', state: 'running', user: dom('adm.rkhan') }));
    rdp(x, 'in_scope', -58 * 60, APP, 'adm.rkhan', '0x61D4');
    x.add('in_scope', E.winsys(x.T(-50 * 60), APP.name, 7036, 'The service entered the stopped state', { service_name: 'TMSAppService', state: 'stopped', user: dom('adm.rkhan') }));
    x.add('in_scope', E.winsys(x.T(-38 * 60), APP.name, 7036, 'The service entered the running state', { service_name: 'TMSAppService', state: 'running', user: dom('adm.rkhan') }));
    x.add('explicit', E.winsec(x.T(-31 * 60), JUMP.name, 4648, 'A logon was attempted using explicit credentials', { subject_user: dom('adm.rkhan'), target_user: dom('adm.vhale'), target_server: FIN.name, process: 'C:\\Windows\\System32\\mstsc.exe', logon_id: '0x3A1F0' }));
    rdp(x, 'hop', -30 * 60, FIN, 'adm.vhale', '0x7E21');
    x.add('payroll', E.winsec(x.T(-26 * 60), FIN.name, 5140, 'A network share object was accessed', { subject_user: dom('adm.vhale'), share_name: '\\\\*\\Payroll$', src_ip: JUMP.ip, logon_id: '0x7E21' }));
    x.add('payroll', E.fileaudit(x.T(-25 * 60), { server: FIN.name, user: dom('adm.vhale'), share: 'Payroll$', path: 'E:\\Payroll\\Exports\\payroll-run-2026-10.csv', access: 'ReadData', process: 'C:\\Windows\\explorer.exe', src_ip: JUMP.ip }));
    x.add('payroll', E.fileaudit(x.T(-24 * 60), { server: FIN.name, user: dom('adm.vhale'), share: 'Payroll$', path: 'E:\\Payroll\\Exports\\bank-details-master.xlsx', access: 'ReadData', process: 'C:\\Windows\\explorer.exe', src_ip: JUMP.ip }));
    x.add('hop', E.winsec(x.T(-4), FIN.name, 4624, 'An account was successfully logged on', { target_user: dom('adm.vhale'), logon_type: 10, auth_package: 'Negotiate', src_ip: JUMP.ip, workstation: 'JUMP01', logon_id: '0x7E99' }));
    x.add('decoy_backup', E.winsec(x.T(-70 * 60), 'BKP01', 4624, 'An account was successfully logged on', { target_user: dom('svc_backup'), logon_type: 5, auth_package: 'Negotiate', src_ip: '127.0.0.1' }));
  },
  alert: ({ tagged }) => ({
    description: `${tagged(['in_scope', 'hop']).filter((e) => e.fields.event_id === 4624).length} RDP logons from JUMP01 outside business hours.`,
    entity: { host: JUMP.name, ip: JUMP.ip, user: 'adm.rkhan' },
    details: [['Source', 'JUMP01'], ['Logon type', '10 (RemoteInteractive)'], ['Targets', `${SQL.name}, ${APP.name}, ${FIN.name}`], ['Rule logic', 'Privileged RDP logon between 20:00 and 06:00']],
    guidance: ['Check the change calendar.', 'Compare every hop with the approved scope.', 'Check every account used, not just the first.'],
  }),
  changes: [{ id: CHG, title: 'SQL Server cumulative update and TMS restart', scope: `${SQL.name} and ${APP.name} only, via JUMP01, by adm.rkhan`, owner: 'IT Infrastructure (r.khan)', status: 'Approved, in progress', start: -100, end: 60, detail: 'Stop MSSQLSERVER, patch, restart; restart TMSAppService on APP01. No other servers.' }],
  accountNotes: { 'adm.vhale': ['Not named in any change today.'] },
  triage: {
    checks: [
      { id: 'chg', label: 'Change calendar checked', test: ran('change') },
      { id: 'dir', label: 'Second admin account looked up in the directory', test: ran('user', 'adm.vhale') },
    ],
    fields: [
      single('split', 'What the night sessions contain', 8, [['split', `Approved maintenance on ${SQL.name} and ${APP.name}, plus a hop to ${FIN.name} outside the change`], ['all_ok', 'All approved maintenance'], ['all_bad', 'All malicious'], ['none', 'Nothing unusual']], 'split', { hint: 'Compare each RDP target and account with the change scope.', explain: `The change covers ${SQL.name} and ${APP.name} by adm.rkhan. ${FIN.name} with adm.vhale is in neither.`, skills: ['tri.verdict', 'inv.pivot'] }),
    ],
    verdict: { label: `Verdict for the hop to ${FIN.name}`, accept: { tp: 1, unknown: 0.7 }, explain: 'Another administrator\'s account, typed in on the jump host, used on a finance server outside the change, while that administrator is on leave.' },
    severity: { accept: 'high', explain: 'Payroll and bank data were opened.' },
    evidence: { tags: ['hop', 'explicit'], explain: 'The FIN01 logon and the explicit-credential event that links it to the maintenance session.' },
  },
  l2: {
    fields: [
      link(acct('who', 'Account whose session launched the hop', 6, 'adm.rkhan', { hint: 'Read the 4648 on JUMP01: the subject is the session, the target is the credential used.', explain: 'adm.rkhan\'s session typed adm.vhale\'s credentials.', skills: ['log.windows-auth'] }), 'explicit'),
      link(multi('data', 'What was opened on FIN01', 6, [['payroll', 'The payroll export'], ['bank', 'The bank details master file'], ['sql', 'The SQL database'], ['mail', 'Mailboxes']], ['payroll', 'bank'], { hint: 'Search file auditing on FIN01.', explain: 'Both files on Payroll$.', skills: ['inv.pivot'] }), 'payroll'),
      single('in_scope', `The sessions on ${SQL.name} and ${APP.name}`, 6, [['approved', 'Approved maintenance: close as benign'], ['malicious', 'Malicious too'], ['unknown', 'Cannot tell']], 'approved', { explain: 'Service stops and restarts exactly as the change describes.', skills: ['tri.false-positive'] }),
      single('active', 'Is the hop still active?', 4, [['yes', 'Yes, a new FIN01 logon minutes ago'], ['no', 'No, it ended'], ['unknown', 'Unknown']], 'yes', { hint: 'Look at the latest FIN01 logons.', explain: 'A second logon just happened.', skills: ['inv.timeline'] }),
      single('decoy', 'The backup service logon on BKP01', 4, [['benign', 'Routine scheduled job'], ['related', 'Part of the hop'], ['unknown', 'Unknown']], 'benign', { explain: 'Batch logon by the backup service, unrelated.', skills: ['tri.false-positive'] }),
    ],
  },
  response: {
    scope: { accounts: ['adm.vhale'], sessions: [FIN.name], hosts: [] },
    contained: (st) => st.disabled.has('adm.vhale') && st.ended.has(FIN.name),
    objectives: [
      { id: 'disable', label: 'Disable adm.vhale', points: 3, containment: true, eval: (st) => (st.disabled.has('adm.vhale') ? 1 : st.reset.has('adm.vhale') ? 0.5 : 0), explain: 'The owner is on leave; nobody should be using it.' },
      { id: 'end', label: `End the remote sessions on ${FIN.name}`, points: 3, containment: true, eval: (st) => (st.ended.has(FIN.name) ? 1 : 0), explain: 'The hop is still active.' },
      { id: 'evidence', label: 'Acquire evidence from JUMP01', points: 2, skills: ['doc.evidence'], eval: (st) => (st.evidence.has(JUMP.name) ? 1 : 0), explain: 'Shows who typed the credentials and how.' },
      { id: 'ir', label: 'Escalate to the incident response lead', points: 2, eval: (st) => (st.notified.has('ir_lead') ? 1 : 0), explain: 'An administrator\'s session misused another admin\'s account; this needs IR and possibly HR.' },
      { id: 'keep', label: 'Leave the approved maintenance running', points: 2, skills: ['res.proportionality'], eval: (st) => (st.disabled.has('adm.vhale') && !st.disabled.has('adm.rkhan') && !st.offline(SQL.name) && !st.offline(APP.name) ? 1 : 0), explain: 'Stopping the patching mid-way risks the TMS for nothing.' },
    ],
  },
  closure: {
    disposition: { options: [['split', `Split: approved maintenance closed as benign; ${FIN.name} hop escalated as an incident`], ['all_benign', 'All benign'], ['all_incident', 'All an incident'], ['fp', 'False positive']], accept: 'split', explain: 'Separate the approved work from the out-of-scope hop.' },
    rootCause: { options: [['misuse', 'Another admin\'s credentials used from inside the maintenance session'], ['change', 'The change was too broad'], ['brute', 'Password guessing'], ['vpn', 'VPN vulnerability']], accept: 'misuse', explain: '4648 on JUMP01 within adm.rkhan\'s session.' },
    actions: { options: [['vault', 'Check out admin credentials through the vault with session recording'], ['scope', 'Restrict adm.vhale to Finance IT workstations'], ['ban_rdp', 'Ban RDP for all administrators'], ['cancel', 'Cancel all night changes']], set: ['vault', 'scope'], explain: 'Targeted controls; blanket bans stop maintenance.', skills: ['doc.root-cause'] },
  },
  truth: { summary: `adm.rkhan connected over VPN and worked through JUMP01 on ${SQL.name} and ${APP.name} exactly as approved in ${CHG}. From the same JUMP01 session, adm.vhale's credentials were typed into mstsc to reach ${FIN.name}, outside the change, where the payroll export and bank details file were opened. adm.vhale's owner is on leave. Who typed the credentials is for incident response to establish.`, timeline: [[-95 * 60, 'VPN connect.'], [-90 * 60, `Maintenance on ${SQL.name}.`], [-58 * 60, `Maintenance on ${APP.name}.`], [-31 * 60, 'Explicit credentials for adm.vhale on JUMP01.'], [-30 * 60, `RDP to ${FIN.name}.`], [-25 * 60, 'Payroll files opened.']], iocs: [] },
  test: { tools: { l1_triage: [['change', SQL.name], ['user', 'adm.vhale']] }, response: [['disable_account', 'adm.vhale'], ['end_session', FIN.name], ['acquire_evidence', JUMP.name], ['notify', 'ir_lead']] },
});
