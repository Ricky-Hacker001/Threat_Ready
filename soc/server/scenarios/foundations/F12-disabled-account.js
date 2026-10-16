// F12 · Logon attempts on a disabled account. Ground truth: a scheduled
// task on the finance reporting server still runs as a leaver's account.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single } from '../lib.js';

const LEAVER = account('g.harlow');
const APP = hostNamed('APP02');

export default defineScenario({
  code: 'F12', level: 'foundations', benign: true,
  title: 'Logon attempt using a disabled account', rule: 'AUTH-0052', severity: 'low', queue: 'authentication',
  blurb: 'A rule reports a logon attempt using a disabled account.',
  sources: ['winsec', 'dns', 'proxy', 'edr', 'firewall', 'email'], sourceGroups: ['windows'],
  skills: ['log.windows-auth', 'inv.pivot', 'doc.root-cause'],
  alertTags: ['task_fail'],
  build(x) {
    x.add('task_fail', E.winsec(x.T(-3), APP.name, 4625, 'An account failed to log on', {
      target_user: dom(LEAVER.sam), logon_type: 4, process: 'C:\\Windows\\System32\\svchost.exe', status: '0xC000006E', failure_reason: 'Account currently disabled (0xC0000072)',
    }));
    x.add('task_fail', E.winsec(x.T(-2), APP.name, 4625, 'An account failed to log on', {
      target_user: dom(LEAVER.sam), logon_type: 4, process: 'C:\\Windows\\System32\\svchost.exe', status: '0xC000006E', failure_reason: 'Account currently disabled (0xC0000072)',
    }));
  },
  alert: () => ({
    description: `A logon was attempted on ${APP.name} with the disabled account ${LEAVER.sam}.`,
    entity: { host: APP.name, ip: APP.ip, user: LEAVER.sam },
    details: [['Host', APP.name], ['Account', LEAVER.sam], ['Rule logic', '4625 with sub-status 0xC0000072 (account disabled)']],
    guidance: ['Read why the logon failed and how it was attempted.', 'Find out who the account belongs to and what runs on the host.'],
  }),
  accountNotes: { 'g.harlow': ['Leaver: account disabled 21 days ago.', 'The same failed logon was recorded on APP02 at 02:00 on each of the last 3 nights.'] },
  assetNotes: { APP02: ['Scheduled task "NightlyReportExport" runs daily at 02:00 as AEROFREIGHT\\g.harlow (configured last year).'] },
  triage: {
    checks: [
      { id: 'dir', label: 'Account looked up in the directory', test: ran('user', LEAVER.sam) },
      { id: 'asset', label: 'Host looked up in the asset inventory', test: ran('asset', [APP.name, APP.ip]) },
    ],
    fields: [
      single('status', 'Why the logon failed', 6, [['disabled', 'Account disabled (0xC0000072)'], ['badpw', 'Bad password (0xC000006A)'], ['expired', 'Password expired (0xC0000071)'], ['locked', 'Account locked (0xC0000234)']], 'disabled', { hint: 'Read the sub-status in failure_reason.', explain: '0xC0000072 means the account is disabled.', skills: ['log.windows-auth'] }),
      single('logon_type', 'What logon type 4 means', 6, [['batch', 'Batch: a scheduled task'], ['interactive', 'Interactive (type 2)'], ['network', 'Network (type 3)'], ['rdp', 'Remote desktop (type 10)']], 'batch', { hint: 'Logon types: 2 interactive, 3 network, 4 batch, 10 remote desktop.', explain: 'Type 4 is a batch logon, used by scheduled tasks.', skills: ['log.windows-auth', 'kno.auth-protocols'] }),
    ],
    verdict: { accept: { btp: 1, fp: 0.4 }, explain: 'Real failed logons, with a housekeeping cause.' },
    severity: { accept: 'low', explain: 'Nothing succeeded; the account stays disabled.' },
    evidence: { tags: ['task_fail'], explain: 'The failed batch logon on the server.' },
  },
  closure: {
    disposition: { options: [['benign', 'Benign: leftover configuration'], ['attack', 'Attacker using a leaver\'s account'], ['fp', 'False positive'], ['unknown', 'Unknown']], accept: 'benign', explain: 'A scheduled task configured with the leaver\'s account.' },
    rootCause: { options: [['task', 'A scheduled task still configured with a leaver\'s account'], ['insider', 'The leaver trying to get back in'], ['sync', 'Directory sync error'], ['malware', 'Malware using cached credentials']], accept: 'task', explain: 'NightlyReportExport runs as the leaver.' },
    actions: { options: [['move_task', 'Raise a request to move the task to a service account'], ['tell_owner', 'Tell the report owner'], ['reenable', 'Re-enable the leaver\'s account'], ['delete_task', 'Delete the task without telling the owner']], set: ['move_task', 'tell_owner'], explain: 'Re-enabling a leaver\'s account is a risk; deleting silently breaks a business report.' },
  },
  truth: { summary: `${LEAVER.name} left three weeks ago and the account was disabled. The scheduled task NightlyReportExport on ${APP.name} still runs as that account, so it fails every night with a batch logon (type 4) and sub-status 0xC0000072.`, timeline: [[-3, 'Scheduled task fails to log on.']] },
  test: { tools: { l1_triage: [['user', LEAVER.sam], ['asset', APP.name]] } },
});
