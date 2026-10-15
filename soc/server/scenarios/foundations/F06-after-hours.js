// F6 · Login outside business hours. Ground truth: a night-shift operations
// controller connects every night from home. Benign.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom, VPN_POOL } from '../../engine/env.js';
import { defineScenario, ran, single } from '../lib.js';

const U = account('r.santos');
const TERM = hostNamed('OPS-TERM01');
const HOME = '203.0.113.88';
const VPNIP = `${VPN_POOL}.61`;

export default defineScenario({
  code: 'F6', level: 'foundations', benign: true,
  title: 'Remote access login outside business hours', rule: 'AUTH-0071', severity: 'low', queue: 'remote access',
  blurb: 'A rule reports a remote access login outside business hours.',
  sources: ['vpn', 'winsec', 'proxy', 'dns', 'firewall'], sourceGroups: ['vpn', 'windows'],
  skills: ['tri.false-positive', 'inv.pivot', 'tri.verdict'],
  entities: { ips: [HOME] },
  alertTags: ['vpn_on', 'logon'],
  build(x) {
    x.add('vpn_mfa', E.vpn(x.T(-125), { event: 'mfa_push', user: U.sam, src_ip: HOME, src_country: 'GB', reason: 'approved', device_id: 'dev-rsantos' }));
    x.add('vpn_on', E.vpn(x.T(-120), { event: 'connect', user: U.sam, src_ip: HOME, src_country: 'GB', assigned_ip: VPNIP, client: 'SecureLink 6.2.1', device_id: 'dev-rsantos', pop: 'LON' }));
    x.add('logon', E.winsec(x.T(-2), TERM.name, 4624, 'An account was successfully logged on', { target_user: dom(U.sam), logon_type: 10, auth_package: 'Kerberos', src_ip: VPNIP, workstation: U.host }));
    for (let i = 0; i < x.n(6, 3); i++) x.add('work', E.proxy(x.T(30 + i * 90), { src_ip: TERM.ip, user: dom(U.sam), method: 'GET', url: 'https://tracking.balticcarrierlines.example/api/containers/status', dest_ip: '203.0.113.180', category: 'Business/Logistics', bytes_out: 820, bytes_in: 14200 }));
  },
  alert: ({ tagged, utc }) => ({
    description: `${U.sam} connected through the VPN at ${utc(tagged('vpn_on')[0].ts)} and logged on to ${TERM.name}, outside business hours (08:00-18:00).`,
    entity: { host: TERM.name, ip: HOME, user: U.sam },
    details: [['Account', U.sam], ['Source address', HOME], ['Country', 'GB'], ['Target', TERM.name], ['Rule logic', 'Remote access logon between 18:00 and 08:00 local time']],
    guidance: ['Find out who the user is and how they normally work.', 'Compare with previous sessions.', 'Check how the login was authenticated.'],
  }),
  accountNotes: { 'r.santos': [`Remote access history: the last 14 VPN sessions were nightly between 21:55 and 06:10 from ${HOME} (GB).`] },
  triage: {
    checks: [{ id: 'dir', label: 'User looked up in the directory', test: ran('user', U.sam) }],
    fields: [
      single('baseline', 'How this compares with normal', 6, [['same', 'Same time and source as every recent night'], ['new_country', 'A new country'], ['new_device', 'A new device'], ['first', 'The first remote login ever']], 'same', { hint: 'The directory lists previous remote sessions.', explain: 'The directory shows nightly sessions from the same home address.', skills: ['inv.pivot'] }),
      single('mfa', 'How the login was authenticated', 4, [['mfa_ok', 'MFA was approved'], ['no_mfa', 'No MFA was used'], ['mfa_denied', 'MFA was denied'], ['legacy', 'Legacy authentication']], 'mfa_ok', { hint: 'Look at the VPN events just before the connect.', explain: 'An approved MFA push precedes the connection.', skills: ['log.network'] }),
    ],
    verdict: { accept: { btp: 1, fp: 0.5 }, explain: 'The login out of office hours is real, and expected for a night-shift worker.' },
    severity: { accept: 'low', explain: 'Normal behaviour for this user.' },
    evidence: { tags: ['vpn_on', 'logon'], explain: 'The connection and the logon it led to.' },
  },
  closure: {
    disposition: { options: [['benign', 'Benign: expected shift work'], ['compromise', 'Account compromise'], ['policy', 'Policy violation'], ['unknown', 'Unknown']], accept: 'benign', explain: 'A night-shift worker on the roster connecting as every night.' },
    rootCause: { options: [['shifts', 'The rule does not know about shift workers'], ['stolen', 'Stolen credentials'], ['vpn_fault', 'A VPN fault'], ['clock', 'Wrong time zone on the server']], accept: 'shifts', explain: 'The rule fires on any out-of-hours login, including rostered night shifts.' },
    actions: { options: [['close', 'Close the ticket'], ['tune', 'Suggest excluding the night-shift roster group from the rule'], ['disable', 'Disable the account'], ['reset', 'Force a password reset']], set: ['close', 'tune'], explain: 'Tuning by roster group keeps the rule for everyone else.' },
  },
  truth: { summary: `${U.name} is a night-shift operations controller on the published roster (OPS-NIGHT). He connected from home with MFA, as he does every night, and logged on to the operations terminal server. Nothing unusual happened.`, timeline: [[-120, 'VPN connection with approved MFA.'], [-2, `Remote desktop logon to ${TERM.name}.`]] },
  test: { tools: { l1_triage: [['user', U.sam]] } },
});
