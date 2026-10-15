// F2 · Kerberos pre-authentication failures. Ground truth: Daniel Okafor
// changed his password yesterday; the mail app on his phone, on the staff
// Wi-Fi, still has the old one and retries every ten minutes. Benign.

import { E } from '../../engine/format.js';
import { account, hostNamed, ORG } from '../../engine/env.js';
import { defineScenario, ran, single } from '../lib.js';

const U = account('d.okafor');
const WS = hostNamed(U.host);
const PHONE = '10.40.0.57';

export default defineScenario({
  code: 'F2', level: 'foundations', benign: true,
  title: 'Repeated Kerberos pre-authentication failures for one account', rule: 'AUTH-0047', severity: 'low', queue: 'authentication',
  blurb: 'A domain controller rule reports repeated Kerberos pre-authentication failures for one user.',
  sources: ['winsec', 'dns', 'proxy', 'edr', 'firewall', 'email'], sourceGroups: ['windows'],
  skills: ['kno.auth-protocols', 'log.windows-auth', 'tri.false-positive'],
  entities: { ips: [PHONE] },
  alertTags: ['stale_krb'],
  build(x) {
    const n = x.n(9, 6);
    for (let i = 0; i < n; i++) {
      x.add('stale_krb', E.winsec(x.T(-(n - i) * 170 - 20), 'DC01', 4771, 'Kerberos pre-authentication failed', {
        target_user: U.sam, src_ip: PHONE, status: '0x18', failure_reason: 'Pre-authentication information was invalid (0x18)', ticket_encryption: 'pre-auth type 2',
      }));
    }
    for (const off of [-1500, -900, -240]) {
      x.add('user_ok', E.winsec(x.T(off), 'DC01', 4768, 'A Kerberos authentication ticket (TGT) was requested', { target_user: U.sam, src_ip: WS.ip, ticket_encryption: '0x12', status: '0x0' }));
    }
    // Look-alike: a mistyped account name from another host (0x6, unknown principal).
    x.add('decoy_typo', E.winsec(x.T(-700), 'DC01', 4771, 'Kerberos pre-authentication failed', { target_user: 'd.okafur', src_ip: hostNamed('WS-OPS-018').ip, status: '0x6', failure_reason: 'Client not found in Kerberos database (0x6)' }));
  },
  alert: ({ tagged, utc }) => {
    const f = tagged('stale_krb');
    return {
      description: `${f.length} Kerberos pre-authentication failures (4771) for ${U.sam} in the last 30 minutes.`,
      entity: { host: null, ip: PHONE, user: U.sam },
      details: [['Account', U.sam], ['Failures', String(f.length)], ['Client address', PHONE], ['First failure', utc(f[0].ts)], ['Rule logic', 'Six or more 4771 events for one account within 60 minutes']],
      guidance: ['Read the failure code.', 'Identify what is at the client address.', 'Compare with the account\'s successful sign-ins.'],
    };
  },
  assetRecords: { [PHONE]: { facts: [['Network', `Staff Wi-Fi (10.40.0.0/24)`], ['DHCP lease', `Device ${U.sam.replace('.', '')}-iPhone, owner ${U.sam}`], ['Managed', 'No (personal device, mail app only)']], notes: ['Personal devices on the staff Wi-Fi may use company mail through the mobile mail app.'] } },
  accountNotes: { 'd.okafor': ['Password last set yesterday at 17:40.'] },
  triage: {
    checks: [
      { id: 'asset', label: 'Client address looked up in the asset inventory', test: ran('asset', PHONE) },
      { id: 'dir', label: 'Account looked up in the directory', test: ran('user', U.sam) },
    ],
    fields: [
      single('failure_code', 'What failure code 0x18 means', 6, [['badpw', 'Wrong password'], ['unknown', 'The account does not exist'], ['expired', 'The account has expired'], ['clock', 'Clock skew between client and server']], 'badpw', { hint: 'Kerberos codes 0x18 and 0x6 mean different things.', explain: '0x18 is a bad password; 0x6 would mean the account name does not exist.', skills: ['kno.auth-protocols'] }),
      single('source', 'What is sending the failures', 4, [['phone', 'The user\'s own mobile device'], ['dc', 'The domain controller'], ['external', 'An external attacker'], ['task', 'A scheduled task on a server']], 'phone', { hint: 'Look the client address up in the asset inventory.', explain: 'The client address is a staff Wi-Fi lease belonging to the user\'s phone.', skills: ['inv.pivot'] }),
      single('regular', 'What the timing shows', 4, [['interval', 'Failures repeat at a fixed interval'], ['burst', 'A rapid burst of attempts'], ['random', 'Random, human-paced attempts'], ['once', 'A single failure']], 'interval', { hint: 'Compare the times of the failures.', explain: 'A fixed interval points to an app retrying, not a person typing.', skills: ['log.windows-auth'] }),
    ],
    verdict: { accept: { btp: 1, fp: 0.4 }, explain: 'Real failures, with a harmless cause: an old saved password.' },
    severity: { accept: 'low', explain: 'One account, the owner\'s own device, and the laptop signs in fine.' },
    evidence: { tags: ['stale_krb', 'user_ok'], explain: 'Failures from the phone while the laptop succeeds.' },
  },
  closure: {
    disposition: { options: [['benign', 'Benign: old password saved on a device'], ['spray', 'Password spraying'], ['compromise', 'Account compromise'], ['unknown', 'Unknown']], accept: 'benign', explain: 'Wrong-password failures from the owner\'s phone at a fixed interval.' },
    rootCause: { options: [['phone', 'Old password saved on a mobile mail app'], ['attacker', 'An attacker guessing passwords'], ['dc', 'A faulty domain controller'], ['policy', 'An expired account']], accept: 'phone', explain: 'The phone mail app kept the old password after the change.' },
    actions: { options: [['advise', 'Advise the user to update the password on the phone'], ['note', 'Note the device in the ticket'], ['disable', 'Disable the account'], ['block', 'Block the phone\'s address at the firewall'], ['reset', 'Reset the password again']], set: ['advise', 'note'], explain: 'The failures stop once the phone has the new password.' },
  },
  truth: { summary: `${U.name} changed his password yesterday. The mail app on his phone, on the staff Wi-Fi at ${PHONE}, still had the old one and retried about every ten minutes, failing with Kerberos code 0x18 (wrong password). His laptop kept signing in normally. One failure with code 0x6 from another host is a mistyped account name and unrelated.`, timeline: [[-1500, 'Laptop signs in normally.'], [-1400, 'Phone mail app starts failing with the old password.'], [5, 'AUTH-0047 fires.']] },
  test: { tools: { l1_triage: [['asset', PHONE], ['user', U.sam]] } },
});
