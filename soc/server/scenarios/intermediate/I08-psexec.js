// I8 · New service installed on a server: PsExec lateral movement with an
// IT administrator's stolen credentials, from a non-IT workstation.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single, host, account as acct, hosts, link } from '../lib.js';

const ADMIN = account('r.khan');
const WS = hostNamed('WS-OPS-022');
const S1 = hostNamed('APP01');
const S2 = hostNamed('SQL01');

function hop(x, srv, base, tag) {
  x.add(tag === 'svc_install' ? 'net_logon' : 'hop2', E.winsec(x.T(base), srv.name, 4624, 'An account was successfully logged on', { target_user: dom(ADMIN.sam), logon_type: 3, auth_package: 'NTLM', src_ip: WS.ip, workstation: WS.name, logon_id: '0x8A21F0' }));
  x.add(tag === 'svc_install' ? 'admin_share' : 'hop2', E.winsec(x.T(base + 10), srv.name, 5145, 'A network share object was checked to see whether client can be granted desired access', { subject_user: dom(ADMIN.sam), src_ip: WS.ip, share_name: '\\\\*\\ADMIN$', relative_target: 'PSEXESVC.exe', access: 'WriteData' }));
  x.add(tag, E.winsys(x.T(base + 30), srv.name, 7045, 'A service was installed in the system', { service_name: 'PSEXESVC', image_path: '%SystemRoot%\\PSEXESVC.exe', start_type: 'demand start', account: 'LocalSystem' }));
  for (const [i, cmd] of ['whoami /all', 'net group "Domain Admins" /domain', 'ipconfig /all'].entries()) {
    x.add(tag === 'svc_install' ? 'discovery' : 'hop2', E.winsec(x.T(base + 50 + i * 4), srv.name, 4688, 'A new process has been created', { subject_user: 'NT AUTHORITY\\SYSTEM', process: `cmd.exe /c ${cmd}`, image_path: 'C:\\Windows\\PSEXESVC.exe' }));
  }
}

export default defineScenario({
  code: 'I8', level: 'intermediate',
  title: 'New service installed on a server: PSEXESVC', rule: 'WIN-0745', severity: 'high', queue: 'endpoint',
  blurb: 'A Windows System log rule reports a new service installed on a server.',
  sources: ['winsys', 'winsec', 'proxy', 'dns', 'edr', 'firewall'], sourceGroups: ['windows'],
  skills: ['log.windows-auth', 'kno.attack-mapping', 'inv.pivot', 'inv.scope'],
  alertTags: ['svc_install'],
  build(x) {
    hop(x, S1, -300, 'svc_install');
    hop(x, S2, -60, 'svc_install2');
    x.add('decoy_admin', E.winsec(x.T(-1500), 'JUMP01', 4624, 'An account was successfully logged on', { target_user: dom(ADMIN.sam), logon_type: 10, auth_package: 'Kerberos', src_ip: hostNamed(ADMIN.host).ip, workstation: ADMIN.host }));
  },
  alert: () => ({
    description: `Service PSEXESVC was installed on ${S1.name}.`,
    entity: { host: S1.name, ip: S1.ip, user: null },
    details: [['Host', S1.name], ['Service', 'PSEXESVC'], ['Image', '%SystemRoot%\\PSEXESVC.exe'], ['Rule logic', 'Event 7045 on a server']],
    guidance: ['Find the logon that came just before the install.', 'Check whether the work is approved.', 'Check other servers for the same.'],
  }),
  triage: {
    checks: [
      { id: 'asset', label: 'Source workstation looked up in the asset inventory', test: ran('asset', [WS.name, WS.ip]) },
      { id: 'chg', label: 'Change calendar consulted', test: ran('change') },
    ],
    fields: [single('service', 'What the service is', 4, [['psexec', 'The PsExec remote execution service'], ['backup', 'The backup agent'], ['update', 'Windows Update'], ['av', 'Antivirus']], 'psexec', { hint: 'PSEXESVC is a well-known name.', explain: 'PSEXESVC is created by PsExec to run commands remotely.', skills: ['kno.attack-mapping'] })],
    verdict: { accept: 'tp', explain: 'No change, and the source is not an IT machine.' },
    severity: { accept: 'high', explain: 'Remote execution on servers with an admin account.' },
    evidence: { tags: ['svc_install'], explain: 'The service install.' },
  },
  l2: {
    fields: [
      link(host('source', 'Source of the remote execution', 6, WS.name, { hint: 'Find the logon just before the service install.', explain: 'The network logon came from an Operations workstation.', skills: ['inv.pivot'] }), 'net_logon'),
      acct('account', 'Account used', 6, ADMIN.sam, { hint: 'Read target_user on that logon.', explain: 'The IT administrator\'s account.', skills: ['log.windows-auth'] }),
      single('legit', 'Is it legitimate administration', 6, [['no', 'No: the admin does not use that workstation and no change exists'], ['yes', 'Yes: routine IT work'], ['unknown', 'Cannot tell']], 'no', { hint: 'Directory and change calendar.', explain: 'The admin works from WS-IT-002 and nothing is scheduled.', skills: ['tri.verdict'] }),
      single('technique', 'Technique', 4, [['psexec', 'Lateral movement with remote service execution (T1569.002 / T1021.002)'], ['rdp', 'Remote desktop (T1021.001)'], ['wmi', 'WMI (T1047)'], ['winrm', 'WinRM (T1021.006)']], 'psexec', { explain: 'Service creation over the admin share.', skills: ['kno.attack-mapping'] }),
      link(hosts('scope', 'Servers reached', 8, [S1.name, S2.name], { hint: 'Search 7045 across all servers.', explain: 'Both servers got the service.', skills: ['inv.scope'] }), 'svc_install2'),
    ],
  },
  closure: {
    disposition: { options: [['incident', 'True positive: lateral movement'], ['admin', 'Benign administration'], ['fp', 'False positive'], ['unknown', 'Unknown']], accept: 'incident', explain: 'Stolen admin credentials used from a user workstation.' },
    rootCause: { options: [['stolen', 'Stolen administrator credentials used from a compromised workstation'], ['admin', 'An administrator working from a colleague\'s PC'], ['update', 'A software update'], ['worm', 'A self-spreading worm']], accept: 'stolen', explain: 'No reason for the admin account to be on that workstation.' },
    actions: { options: [['contain', `Contain ${WS.name}`], ['reset', 'Reset the administrator\'s password'], ['review', 'Review both servers'], ['escalate', 'Escalate to incident response'], ['delete_svc', 'Delete the PSEXESVC service and close'], ['disable_all', 'Disable all IT admin accounts']], set: ['contain', 'reset', 'review', 'escalate'], explain: 'Removing the service alone leaves the attacker; disabling all admins stops IT.', skills: ['res.containment'] },
  },
  truth: { summary: `An attacker on ${WS.name} used the stolen credentials of IT administrator ${ADMIN.name} to run PsExec against ${S1.name} and then ${S2.name}, running discovery commands. The administrator's own remote desktop logon to JUMP01 earlier is normal.`, timeline: [[-1500, 'Admin\'s normal RDP to JUMP01.'], [-300, `PsExec to ${S1.name}.`], [-60, `PsExec to ${S2.name}.`]] },
  test: { tools: { l1_triage: [['asset', WS.name], ['change', '']] } },
});
