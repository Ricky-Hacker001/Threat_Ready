// F1 · Account locked out. Ground truth: Leah Morgan changed her password
// through self-service this morning; her laptop kept a mapped drive with the
// old password, which retried until the account locked. Benign.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, host, single } from '../lib.js';

const U = account('l.morgan');
const WS = hostNamed(U.host);

export default defineScenario({
  code: 'F1', level: 'foundations', benign: true,
  title: 'User account locked out', rule: 'AUTH-0040', severity: 'low', queue: 'authentication',
  blurb: 'A directory rule reports that a user account was locked out after repeated failures.',
  sources: ['winsec', 'dns', 'proxy', 'edr', 'firewall', 'email'], sourceGroups: ['windows'],
  skills: ['log.windows-auth', 'tri.false-positive', 'inv.pivot'],
  alertTags: ['stale_fail', 'lockout'],
  build(x) {
    x.add('pwd_change', E.winsec(x.T(-22 * 60), 'DC01', 4723, "An attempt was made to change an account's password", { subject_user: dom(U.sam), target_user: dom(U.sam), workstation: WS.name, src_ip: WS.ip }));
    const n = x.n(5, 4);
    for (let i = 0; i < n; i++) {
      x.add('stale_fail', E.winsec(x.T(-300 + i * (240 / n)), 'DC01', 4625, 'An account failed to log on', {
        target_user: dom(U.sam), logon_type: 3, auth_package: 'NTLM', src_ip: WS.ip, workstation: WS.name,
        status: '0xC000006D', failure_reason: 'Unknown user name or bad password (0xC000006A)',
      }));
    }
    x.add('lockout', E.winsec(x.T(-20), 'DC01', 4740, 'A user account was locked out', { target_user: dom(U.sam), workstation: WS.name, subject_user: dom('DC01$') }));
    x.add('unlock', E.winsec(x.T(180), 'DC01', 4767, 'A user account was unlocked', { subject_user: dom('e.morales'), target_user: dom(U.sam) }));
    x.add('ok_after', E.winsec(x.T(240), WS.name, 4624, 'An account was successfully logged on', { target_user: dom(U.sam), logon_type: 2, auth_package: 'Kerberos', src_ip: '127.0.0.1' }));
  },
  alert: ({ tagged, utc }) => {
    const f = tagged('stale_fail');
    return {
      description: `Account ${U.sam} was locked out on DC01 after ${f.length} failed logons.`,
      entity: { host: null, ip: null, user: U.sam },
      details: [['Account', `AEROFREIGHT\\${U.sam}`], ['Failed logons before lockout', String(f.length)], ['Lockout recorded', utc(tagged('lockout')[0].ts)], ['Rule logic', 'Event 4740 (account locked out) for any user account']],
      guidance: ['Identify the computer that sent the bad passwords.', 'Read why the logons failed.', 'Check what changed for this account recently.'],
    };
  },
  accountNotes: { 'l.morgan': ['Password last set today at 08:52 through self-service password reset.'] },
  triage: {
    checks: [
      { id: 'dir', label: 'Locked account looked up in the directory', test: ran('user', 'l.morgan') },
      { id: 'asset', label: 'Computer that caused the lockout looked up in the asset inventory', test: ran('asset', [WS.name, WS.ip]) },
    ],
    checksExplain: 'Context first: the owner and a recent password change explain most lockouts.',
    fields: [
      host('source_host', 'Computer that sent the bad passwords', 4, WS.name, { hint: 'Look at the caller computer on the 4740 and the workstation on the failures.', explain: '4740 names the computer that sent the bad password; every failure carries the same workstation.', skills: ['inv.pivot', 'log.windows-auth'] }),
      single('fail_reason', 'Why the logons failed', 6, [
        ['bad_pw', 'Bad password (0xC000006A)'], ['unknown', 'Unknown user name (0xC0000064)'], ['disabled', 'Account disabled (0xC0000072)'], ['hours', 'Logon outside allowed hours (0xC000006F)'],
      ], 'bad_pw', { hint: 'Look at the sub-status in failure_reason on the 4625s.', explain: 'Every failure carries sub-status 0xC000006A: the user name is right, the password is wrong.', skills: ['log.windows-auth'] }),
    ],
    verdict: { accept: { btp: 1, fp: 0.4 }, explain: 'The rule worked: the account really did lock. The cause is the user\'s own laptop still using the old password, which makes it a benign true positive.' },
    severity: { accept: 'low', explain: 'One user, her own device, and no success from anywhere else.' },
    evidence: { tags: ['stale_fail', 'pwd_change'], explain: 'The password change and the failures from the same laptop together prove the cause.' },
  },
  closure: {
    disposition: { options: [['benign_stale', 'Benign: stale credential after a password change'], ['guessing', 'Password guessing against the account'], ['service', 'Misconfigured service account'], ['unknown', 'Unknown; monitor']], accept: 'benign_stale', explain: 'The failures come from the user\'s own laptop with the right user name and the old password, minutes after she changed it.' },
    rootCause: { options: [['old_pw', 'A device or session still using the old password'], ['attacker', 'An attacker guessing passwords'], ['policy', 'A lockout policy that is too strict'], ['dc', 'A domain controller replication fault']], accept: 'old_pw', explain: 'A mapped drive kept retrying with the cached old password.' },
    actions: {
      options: [['reconnect', 'Ask the user to sign out and reconnect mapped drives'], ['unlock_check', 'Confirm the account was unlocked after an identity check'], ['reset_again', 'Reset the password again'], ['isolate', `Isolate ${WS.name}`], ['block', `Block ${WS.name} at the firewall`]],
      set: ['reconnect', 'unlock_check'], explain: 'A second reset fixes nothing while the old session keeps retrying, and the laptop is not a threat.',
    },
  },
  truth: {
    summary: `${U.name} changed her password through self-service at the start of the day. Her laptop ${WS.name} kept a mapped drive connected with the old password, which retried until the account locked. The helpdesk unlocked it after the alert and she signed in normally. Nothing malicious happened.`,
    timeline: [[-22 * 60, 'Password changed through self-service.'], [-300, 'Mapped drive starts retrying with the old password.'], [-20, 'Account locked out (4740).'], [180, 'Helpdesk unlocks the account.']],
  },
  test: { tools: { l1_triage: [['user', 'l.morgan'], ['asset', WS.name]] } },
});
