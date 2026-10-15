// I11 · Member added to local Administrators out of hours: a compromised
// helpdesk account adds itself and creates a scheduled task.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single, host, order, link } from '../lib.js';

const HD = account('e.morales');
const WSX = hostNamed('WS-OPS-018');
const SRV = hostNamed('APP01');
const CHG = 'CHG-4525';

export default defineScenario({
  code: 'I11', level: 'intermediate',
  title: 'User added to local Administrators outside business hours', rule: 'WIN-0473', severity: 'high', queue: 'identity',
  blurb: 'A Windows rule reports a user added to a server\'s local Administrators group out of hours.',
  sources: ['winsec', 'proxy', 'dns', 'edr', 'firewall', 'email'], sourceGroups: ['windows'],
  skills: ['log.windows-auth', 'inv.timeline', 'inv.pivot', 'res.containment'],
  entities: { ids: [CHG] },
  alertTags: ['add_admin'],
  build(x) {
    for (let i = 0; i < 3; i++) x.add('fails', E.winsec(x.T(-370 + i * 6), SRV.name, 4625, 'An account failed to log on', { target_user: dom(HD.sam), logon_type: 3, auth_package: 'NTLM', src_ip: WSX.ip, workstation: WSX.name, status: '0xC000006D', failure_reason: 'Unknown user name or bad password (0xC000006A)' }));
    x.add('logon', E.winsec(x.T(-300), SRV.name, 4624, 'An account was successfully logged on', { target_user: dom(HD.sam), logon_type: 3, auth_package: 'NTLM', src_ip: WSX.ip, workstation: WSX.name, logon_id: '0x93D1A2' }));
    x.add('add_admin', E.winsec(x.T(-10), SRV.name, 4732, 'A member was added to a security-enabled local group', { subject_user: dom(HD.sam), target_user: dom(HD.sam), object_name: 'Administrators' }));
    x.add('task', E.winsec(x.T(110), SRV.name, 4698, 'A scheduled task was created', { subject_user: dom(HD.sam), object_name: '\\Microsoft\\Windows\\Maint\\Updater', process: 'C:\\ProgramData\\upd.exe', service_account: 'SYSTEM' }));
    x.add('decoy_approved', E.winsec(x.T(-1500), 'FS02', 4732, 'A member was added to a security-enabled local group', { subject_user: dom('r.khan'), target_user: dom('svc_migrate'), object_name: 'Administrators' }));
  },
  alert: () => ({
    description: `${HD.sam} was added to the local Administrators group on ${SRV.name} outside business hours.`,
    entity: { host: SRV.name, ip: SRV.ip, user: HD.sam },
    details: [['Host', SRV.name], ['Group', 'Administrators'], ['Member added', HD.sam], ['Rule logic', '4732 into Administrators between 19:00 and 07:00']],
    guidance: ['Compare who made the change with who was added.', 'Find the approval.', 'Find where the session came from and what happened next.'],
  }),
  accountNotes: { 'e.morales': ['Helpdesk. Works 09:00-17:00 from WS-IT-005.'] },
  changes: [{ id: CHG, title: 'Grant svc_migrate local admin on FS02 for the Projects migration', scope: 'FS02', owner: 'IT Infrastructure (r.khan)', status: 'Completed', start: -40, end: -10, detail: 'Approved by the change board.' }],
  triage: {
    checks: [
      { id: 'dir', label: 'Account looked up in the directory', test: ran('user', HD.sam) },
      { id: 'chg', label: 'Change calendar consulted', test: ran('change') },
    ],
    fields: [
      single('who', 'Who made the change', 4, [['self', 'The same account added itself'], ['admin', 'A domain administrator added it'], ['system', 'The system account'], ['gpo', 'Group Policy']], 'self', { hint: 'Compare subject_user and target_user on the 4732.', explain: 'Subject and member are the same helpdesk account.', skills: ['log.windows-auth'] }),
      single('approval', 'Approval for this change', 4, [['none', 'None'], ['chg', 'The FS02 migration change'], ['ticket', 'A helpdesk ticket']], 'none', { hint: 'The change calendar has one admin change today; check its scope.', explain: 'The only approved admin change is for FS02 and svc_migrate.', skills: ['tri.false-positive'] }),
    ],
    verdict: { accept: 'tp', explain: 'An account granting itself admin at night without approval.' },
    severity: { accept: 'high', explain: 'Admin rights on a server.' },
    evidence: { tags: ['add_admin'], explain: 'The group change.' },
  },
  l2: {
    fields: [
      link(host('source', 'Where the session came from', 6, WSX.name, { hint: 'Find the logon before the change.', explain: 'From an Operations workstation, not the helpdesk PC.', skills: ['inv.pivot'] }), 'logon'),
      link(single('before', 'What came before the logon', 4, [['fails', 'Failed logons from the same host'], ['vpn', 'A VPN connection'], ['nothing', 'Nothing']], 'fails', { hint: 'Search the same source before the success.', explain: 'Three password failures first.', skills: ['inv.timeline'] }), 'fails'),
      link(single('after', 'What happened after', 8, [['task', 'A scheduled task running a new program as SYSTEM'], ['logoff', 'The user logged off'], ['nothing', 'Nothing'], ['reboot', 'The server rebooted']], 'task', { hint: 'Search the host after the group change.', explain: 'Persistence: a scheduled task running C:\\ProgramData\\upd.exe as SYSTEM.', skills: ['kno.malware'] }), 'task'),
      order('timeline', 'Order of events', 6, [['fails', 'Failed logons'], ['logon', 'Successful logon'], ['add', 'Added to Administrators'], ['task', 'Scheduled task created']], ['fails', 'logon', 'add', 'task'], { explain: 'From the timestamps.', skills: ['inv.timeline'] }),
    ],
  },
  closure: {
    disposition: { options: [['incident', 'True positive: compromised account with persistence'], ['admin', 'Benign administration'], ['fp', 'False positive'], ['unknown', 'Unknown']], accept: 'incident', explain: 'Self-granted admin plus a SYSTEM task.' },
    rootCause: { options: [['compromised', 'A compromised helpdesk account'], ['mistake', 'A helpdesk mistake'], ['gpo', 'A Group Policy change'], ['update', 'A software update']], accept: 'compromised', explain: 'Password guessed from another workstation.' },
    actions: { options: [['disable', 'Disable the helpdesk account'], ['remove', 'Remove it from Administrators'], ['task', 'Delete the task and collect upd.exe'], ['investigate', `Investigate ${WSX.name}`], ['escalate', 'Escalate'], ['remove_only', 'Only remove the group membership']], set: ['disable', 'remove', 'task', 'investigate', 'escalate'], explain: 'The task would keep the attacker in.', skills: ['res.containment'] },
  },
  truth: { summary: `The helpdesk account ${HD.sam} was compromised. At night, from ${WSX.name}, it guessed its way in to ${SRV.name}, added itself to the local Administrators group and created a scheduled task running C:\\ProgramData\\upd.exe as SYSTEM. The earlier admin change on FS02 is approved under ${CHG}.`, timeline: [[-1500, 'Approved admin change on FS02.'], [-370, 'Failed logons.'], [-300, 'Successful logon.'], [-10, 'Added to Administrators.'], [110, 'Scheduled task created.']] },
  test: { tools: { l1_triage: [['user', HD.sam], ['change', '']] } },
});
