// E12 · Critical: credential-dumping tool on a finance server. It is the
// authorised red-team exercise RT-2026-04, but one action falls outside the
// agreed scope: the dumped service credential is used on the production
// payroll database and data is exported.

import { E } from '../../engine/format.js';
import { hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single, multi, link } from '../lib.js';

const APP = hostNamed('FIN-APP02');
const DB = hostNamed('PAY-DB01');
const RT = 'RT-2026-04';
const OP = 'rt.operator1';
const SVC = 'svc_finrpt';
const EXPORT = 'C:\\Temp\\pr_full.csv';

export default defineScenario({
  code: 'E12', level: 'expert',
  title: 'Credential-dumping tool detected on a finance server', rule: 'EDR-0102', severity: 'critical', queue: 'endpoint',
  blurb: 'An endpoint rule reports a process reading LSASS memory on a finance application server.',
  sources: ['edr', 'winsec', 'firewall', 'dns', 'proxy', 'email'], sourceGroups: ['endpoint', 'windows'],
  skills: ['log.endpoint', 'tri.verdict', 'tri.escalation', 'res.proportionality'],
  entities: { ids: [RT] },
  history: 40 * 60,
  alertTags: ['procdump'],
  build(x) {
    x.add('rt_logon', E.winsec(x.T(-30 * 60), APP.name, 4624, 'An account was successfully logged on', { target_user: dom(OP), logon_type: 10, auth_package: 'Negotiate', src_ip: '10.10.0.70', workstation: 'JUMP01', logon_id: '0x9A10' }));
    for (let p = 0; p < x.n(12, 8); p++) x.add('decoy_scan', E.fw(x.T(-24 * 60 + p * 6), { action: 'allow', src_ip: APP.ip, src_port: 51000 + p, dest_ip: `10.10.0.${44 + (p % 6)}`, dest_port: [135, 445, 1433, 3389, 5985, 80][p % 6], zone: 'SERVERS', rule: 'SERVERS-INTERNAL' }));
    x.add('procdump', E.procCreate(x.T(-15 * 60), APP.name, { user: dom(OP), image: 'C:\\Tools\\procdump64.exe', command_line: 'procdump64.exe -accepteula -ma lsass.exe C:\\Tools\\l.dmp', pid: 5120, parent_image: 'C:\\Windows\\System32\\cmd.exe', ppid: 5010, signature: 'Valid (Microsoft Corporation)' }));
    x.add('procdump', E.edr(x.T(-15 * 60 + 1), APP.name, 10, 'ProcessAccess', { user: dom(OP), image: 'C:\\Tools\\procdump64.exe', target_image: 'C:\\Windows\\System32\\lsass.exe', granted_access: '0x1fffff', pid: 5120 }));
    x.add('oos_logon', E.winsec(x.T(-3 * 60), DB.name, 4624, 'An account was successfully logged on', { target_user: dom(SVC), logon_type: 3, auth_package: 'NTLM', src_ip: APP.ip, workstation: APP.name, logon_id: '0xB771' }));
    x.add('oos_logon', E.winsec(x.T(-3 * 60 + 2), APP.name, 4648, 'A logon was attempted using explicit credentials', { subject_user: dom(OP), target_user: dom(SVC), target_server: DB.name, process: 'C:\\Windows\\System32\\cmd.exe', logon_id: '0x9A10' }));
    x.add('export', E.procCreate(x.T(-60), DB.name, { user: dom(SVC), image: 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\bcp.exe', command_line: `bcp "SELECT * FROM Payroll.dbo.Employees" queryout ${EXPORT} -c -T`, pid: 6610, parent_image: 'C:\\Windows\\System32\\wsmprovhost.exe', ppid: 6600 }));
    x.add('export', E.edr(x.T(-55), DB.name, 11, 'FileCreate', { user: dom(SVC), image: 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\bcp.exe', target_filename: EXPORT, file_size: 8_412_337 }));
    x.add('svc_normal', E.winsec(x.T(-20 * 60), DB.name, 4624, 'An account was successfully logged on', { target_user: dom(SVC), logon_type: 3, auth_package: 'Kerberos', src_ip: APP.ip, workstation: APP.name, logon_id: '0xA002' }));
  },
  alert: () => ({
    description: `procdump64.exe on ${APP.name} read LSASS memory as ${OP}.`,
    entity: { host: APP.name, ip: APP.ip, user: OP },
    details: [['Host', `${APP.name} (finance application server)`], ['Command', 'procdump64.exe -ma lsass.exe'], ['User', OP], ['Rule logic', 'Process access to lsass.exe with full rights']],
    guidance: ['Check the change calendar before reacting.', 'Read the exercise scope line by line.', 'Check everything the operator did after the dump.'],
  }),
  changes: [{ id: RT, title: 'Authorised red-team exercise (internal)', scope: `In scope: ${APP.name} and the finance application tier; credential dumping on in-scope hosts; internal port scanning. Operator account ${OP} only. OUT OF SCOPE: ${DB.name} (production payroll), any use of harvested credentials, any data export.`, owner: 'CISO office (exercise control: IR lead)', status: 'Approved, in progress', start: -3 * 24 * 60, end: 4 * 24 * 60, detail: 'SOC is not pre-warned of individual actions. Report suspected out-of-scope activity to exercise control (IR lead) immediately; do not disable the operator account without exercise control.' }],
  accountNotes: { [SVC]: ['Normal pattern: Kerberos network logons from FIN-APP02 to PAY-DB01 for reporting queries. Never runs bcp.'] },
  triage: {
    checks: [
      { id: 'chg', label: 'Change calendar checked', test: ran('change') },
      { id: 'dir', label: 'Operator account looked up in the directory', test: ran('user', OP) },
    ],
    fields: [
      single('split', 'What the activity contains', 8, [['split', `In-scope exercise work on ${APP.name}, plus use of a dumped credential on ${DB.name}`], ['all_ok', 'All authorised exercise work'], ['all_attack', 'A real attacker, not the exercise'], ['nothing', 'Nothing unusual']], 'split', { hint: `Read the ${RT} scope and compare every action after the dump.`, explain: `The dump on ${APP.name} is allowed. ${DB.name}, harvested credentials and exports are explicitly excluded.`, skills: ['tri.verdict', 'inv.pivot'] }),
    ],
    verdict: { label: `Verdict for the LSASS dump on ${APP.name}`, accept: { btp: 1, tp: 0.3 }, explain: 'The dump itself is inside the agreed scope: a benign true positive.' },
    severity: { accept: 'high', explain: 'Out-of-scope access to production payroll, with an export.' },
    route: { explain: 'The out-of-scope action needs Tier 2 and exercise control, even though the alerted dump is authorised.' },
    evidence: { tags: ['procdump', 'oos_logon'], explain: 'The authorised dump, and the out-of-scope logon that used what it harvested.' },
  },
  l2: {
    fields: [
      multi('in_scope', 'Activities inside the agreed scope', 6, [['dump', `LSASS dump on ${APP.name}`], ['scan', 'Port scan of the finance application tier'], ['db', `Logon to ${DB.name} as ${SVC}`], ['export', 'Payroll table export']], ['dump', 'scan'], { hint: 'Compare each action with the scope text.', explain: 'Only the dump and the scan.', skills: ['tri.false-positive'] }),
      link(single('cred', `Where the ${SVC} credential came from`, 6, [['dump', `Harvested by the LSASS dump on ${APP.name}`], ['kerberos', 'Its normal Kerberos ticket'], ['phish', 'Phishing'], ['vault', 'The password vault']], 'dump', { hint: 'Compare the auth package and the 4648 with the account\'s normal pattern.', explain: `NTLM from explicit credentials typed in ${OP}'s session, minutes after the dump; normal use is Kerberos.`, skills: ['log.windows-auth'] }), 'oos_logon'),
      link(single('export', `What happened on ${DB.name}`, 8, [['export', `The employee payroll table exported to ${EXPORT}`], ['query', 'A normal reporting query'], ['nothing', 'Nothing'], ['delete', 'Data deleted']], 'export', { hint: `Search process creation on ${DB.name}.`, explain: 'bcp queryout of the whole Employees table, about 8 MB.', skills: ['log.endpoint'] }), 'export'),
      single('who', 'Who most likely did it', 4, [['operator', 'The red-team operator, beyond the agreed scope'], ['external', 'An unrelated external attacker'], ['dba', 'A database administrator'], ['unknown', 'Cannot tell yet']], { operator: 1, unknown: 0.5 }, { explain: `Same session (${OP}, logon 0x9A10) minutes after the dump. Still unauthorised: exercise control decides what happens next.`, skills: ['inv.timeline'] }),
      single('decoy', 'The port scan from FIN-APP02', 4, [['in_scope', 'In scope: internal scanning is allowed'], ['oos', 'Out of scope'], ['attack', 'A separate attack']], 'in_scope', { explain: 'Listed in the scope.', skills: ['tri.false-positive'] }),
    ],
  },
  response: {
    scope: { accounts: [SVC, OP], hosts: [] },
    notify: {},
    contained: (st) => st.notified.has('ir_lead') && (st.reset.has(SVC) || st.disabled.has(SVC)),
    objectives: [
      { id: 'ir', label: 'Report to exercise control (IR lead)', points: 3, containment: true, eval: (st) => (st.notified.has('ir_lead') ? 1 : 0), explain: 'The scope document names exercise control as the first call.' },
      { id: 'cred', label: `Reset the harvested ${SVC} credential`, points: 3, containment: true, eval: (st) => (st.reset.has(SVC) ? 1 : st.disabled.has(SVC) ? 0.75 : 0), explain: 'It is in the operator\'s hands and opens production payroll. A reset keeps reporting working after the job is updated.' },
      { id: 'evidence', label: `Acquire evidence from ${DB.name}`, points: 2, skills: ['doc.evidence'], eval: (st) => (st.evidence.has(DB.name) ? 1 : 0), explain: 'Proves exactly what was exported.' },
      { id: 'remove', label: 'Remove the exported file after evidence is taken', points: 2, eval: (st) => {
        const ev = st.evidence.get(DB.name);
        const cl = st.cleaned.get(DB.name);
        if (cl === undefined) return 0;
        return ev !== undefined && ev <= cl ? 1 : 0.5;
      }, explain: 'Payroll data should not sit in C:\\Temp.' },
      { id: 'keep', label: 'Keep payroll and the exercise running', points: 2, skills: ['res.proportionality'], eval: (st) => (st.notified.has('ir_lead') && !st.offline(DB.name) && !st.offline(APP.name) && !st.disabled.has(OP) ? 1 : 0), explain: 'Isolating production payroll or killing the operator account without exercise control causes more harm than it prevents.' },
    ],
  },
  closure: {
    disposition: { options: [['split', 'Split: in-scope exercise activity benign; out-of-scope payroll access escalated to exercise control'], ['all_benign', 'All authorised exercise activity'], ['incident', 'Real intrusion'], ['fp', 'False positive']], accept: 'split', explain: 'The scope document decides each action separately.' },
    rootCause: { options: [['scope', 'The operator used harvested credentials beyond the agreed scope'], ['real', 'A real attacker'], ['policy', 'The exercise was not approved'], ['tool', 'A tool misfired']], accept: 'scope', explain: 'Scope breach by the exercise.' },
    actions: { options: [['guardrails', 'Add technical guardrails for out-of-scope hosts in future exercises'], ['tiering', `Stop ${SVC} credentials being cached on ${APP.name}`], ['ban', 'Ban red-team exercises'], ['ignore', 'Suppress alerts from the operator account']], set: ['guardrails', 'tiering'], explain: 'Suppressing the operator\'s alerts would have hidden this.', skills: ['doc.root-cause'] },
  },
  truth: { summary: `${RT} is an approved red-team exercise. ${OP}'s LSASS dump on ${APP.name} and the internal scan are in scope. Using the dumped ${SVC} credential to log on to ${DB.name} and exporting the payroll Employees table to ${EXPORT} are explicitly out of scope. The right call is a split: benign for the dump, escalation to exercise control for the payroll access.`, timeline: [[-30 * 60, 'Operator logs on to FIN-APP02.'], [-24 * 60, 'In-scope port scan.'], [-15 * 60, 'LSASS dump.'], [-3 * 60, `${SVC} used on ${DB.name}.`], [-60, 'Payroll export.']], iocs: [] },
  test: { tools: { l1_triage: [['change', RT], ['user', OP]] }, response: [['notify', 'ir_lead'], ['reset_credentials', SVC], ['acquire_evidence', DB.name], ['remove_artifacts', DB.name]] },
});
