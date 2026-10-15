// I3 · Many MFA push requests, then one approved. Ground truth: an attacker
// with the user's password pushed MFA until she approved, registered their
// own authenticator and connected to the VPN, then reached the file server.

import { E } from '../../engine/format.js';
import { account, hostNamed, ORG, VPN_POOL } from '../../engine/env.js';
import { defineScenario, ran, single, multi, order, link } from '../lib.js';

const U = account('l.brandt');
const FS = hostNamed('FS01');
const ATK = '198.51.100.212';
const BAD_DEV = 'dev-unknown-7f3a';
const VPNIP = `${VPN_POOL}.203`;

export default defineScenario({
  code: 'I3', level: 'intermediate',
  title: 'Multiple MFA push denials followed by an approval', rule: 'IDP-0141', severity: 'high', queue: 'identity',
  blurb: 'An identity rule reports a burst of denied MFA prompts for one user, then an approval.',
  sources: ['idp', 'vpn', 'firewall', 'proxy', 'dns', 'winsec'], sourceGroups: ['identity', 'vpn', 'firewall'],
  skills: ['kno.cloud-identity', 'log.cloud', 'inv.timeline', 'res.containment'],
  entities: { ips: [ATK], names: [BAD_DEV] },
  alertTags: ['push_deny', 'push_ok'],
  build(x) {
    const mail = `${U.sam}@${ORG.mailDomain}`;
    const n = x.n(13, 10);
    for (let i = 0; i < n; i++) x.add('push_deny', E.signin(x.T(-12 * 60 + i * 45), { user: mail, app: 'VPN SAML', result: 'interrupted', error_code: 500121, src_ip: ATK, country: 'RO', city: 'Bucharest', device_id: BAD_DEV, mfa: 'push', risk: 'medium' }));
    x.add('push_ok', E.signin(x.T(-60), { user: mail, app: 'VPN SAML', result: 'success', src_ip: ATK, country: 'RO', city: 'Bucharest', device_id: BAD_DEV, mfa: 'push', risk: 'medium', session_id: '6be21f' }));
    x.add('mfa_add', E.idpAudit(x.T(-40), { operation: 'Register security info', actor: U.sam, target: U.sam, target_type: 'User', permissions: 'Authenticator app', src_ip: ATK }));
    x.add('vpn_bad', E.vpn(x.T(-30), { event: 'connect', user: U.sam, src_ip: ATK, src_country: 'RO', assigned_ip: VPNIP, client: 'OpenConnect 9.12', device_id: BAD_DEV, pop: 'LON' }));
    x.add('smb', E.fw(x.T(-10), { src_ip: VPNIP, src_port: 51288, dest_ip: FS.ip, dest_port: 445, zone: 'VPN->SERVERS', rule: 'VPN-Users-to-FileServices', bytes: 1840022 }));
    x.add('decoy_home', E.signin(x.T(-28 * 60), { user: mail, app: 'Office 365', src_ip: '198.51.100.44', country: 'GB', city: 'London', device_id: 'dev-lbrandt', mfa: 'previously satisfied' }));
  },
  alert: ({ tagged }) => ({
    description: `${tagged('push_deny').length} MFA push requests for ${U.sam} were denied, then one was approved from the same address.`,
    entity: { host: null, ip: ATK, user: U.sam },
    details: [['User', U.sam], ['Denied pushes', String(tagged('push_deny').length)], ['Source address', ATK], ['Country', 'RO'], ['Rule logic', '5+ MFA denials (500121) followed by an approval within 30 minutes']],
    guidance: ['Work out what happened after the approval.', 'Compare the device with the user\'s registered device.'],
  }),
  intel: { [ATK]: { verdict: 'suspicious', detections: '2/89', facts: [['Network', 'VPS hosting (RO)']], notes: ['No specific reports.'] } },
  accountNotes: { 'l.brandt': ['Registered MFA device: dev-lbrandt (company phone).'] },
  triage: {
    checks: [
      { id: 'dir', label: 'User looked up in the directory', test: ran('user', U.sam) },
      { id: 'ti', label: 'Source address checked in threat intelligence', test: ran('reputation', ATK) },
    ],
    verdict: { accept: 'tp', explain: 'An approved login from an unknown device in another country after a storm of denied pushes.' },
    severity: { accept: 'high', explain: 'The attacker has a working session.' },
    evidence: { tags: ['push_deny', 'push_ok'], explain: 'The denials and the approval.' },
  },
  l2: {
    fields: [
      single('technique', 'Technique', 6, [['fatigue', 'MFA fatigue (push bombing)'], ['sim', 'SIM swapping'], ['aitm', 'Adversary-in-the-middle phishing'], ['brute', 'Password brute force']], 'fatigue', { hint: 'Count the pushes before the approval.', explain: 'Repeated pushes until the user approves one: MITRE T1621.', skills: ['kno.cloud-identity', 'kno.attack-mapping'] }),
      single('new_device', 'Device that signed in', 4, [['unknown', 'An unknown device, not the registered one'], ['registered', 'The user\'s registered phone'], ['laptop', 'The user\'s laptop']], 'unknown', { hint: 'Compare with the directory.', explain: 'The device ID is not the registered company phone.', skills: ['log.cloud'] }),
      link(single('persistence', 'How the attacker kept access', 8, [['mfa', 'Registered their own authenticator'], ['rule', 'Created a mailbox rule'], ['app', 'Consented to an application'], ['none', 'No persistence']], 'mfa', { hint: 'Search the identity audit log after the sign-in.', explain: 'With their own authenticator registered, the attacker can approve their own sign-ins.', skills: ['kno.cloud-identity'] }), 'mfa_add'),
      link(multi('reach', 'Where the attacker went next', 8, [['vpn', 'VPN connection'], ['smb', 'SMB to the file server'], ['email', 'Read email in Outlook'], ['aws', 'AWS console']], ['vpn', 'smb'], { hint: 'Follow the address into the VPN and then the VPN address.', explain: 'A VPN connection from the attacker\'s address, then SMB to the file server from the assigned VPN address.', skills: ['inv.pivot', 'inv.scope'] }), 'vpn_bad', 'smb'),
      order('timeline', 'Order of events', 6, [['deny', 'Push denials'], ['ok', 'Approval'], ['mfa', 'New MFA method registered'], ['vpn', 'VPN connection'], ['smb', 'File server access']], ['deny', 'ok', 'mfa', 'vpn', 'smb'], { explain: 'From the timestamps.', skills: ['inv.timeline'] }),
    ],
  },
  closure: {
    disposition: { options: [['incident', 'True positive: account takeover'], ['benign', 'Benign: user travelling'], ['fp', 'False positive'], ['unknown', 'Unknown']], accept: 'incident', explain: 'The attacker holds a session and their own authenticator.' },
    rootCause: { options: [['fatigue', 'Stolen password plus MFA fatigue'], ['sim', 'SIM swap'], ['token', 'Stolen session cookie'], ['insider', 'Insider misuse']], accept: 'fatigue', explain: 'The password was known; MFA was beaten by repeated prompts.' },
    actions: { options: [['revoke', 'Revoke all sessions'], ['reset', 'Reset the password'], ['remove_mfa', 'Remove the attacker\'s MFA method'], ['block', `Block ${ATK}`], ['escalate', 'Escalate to incident response for the file server access'], ['reset_only', 'Only reset the password'], ['disable_mfa', 'Disable MFA for the user']], set: ['revoke', 'reset', 'remove_mfa', 'block', 'escalate'], explain: 'A reset alone leaves the attacker\'s authenticator in place.', skills: ['res.containment'] },
  },
  truth: { summary: `An attacker with ${U.name}'s password triggered MFA pushes from ${ATK} (RO) until she approved one. They signed in from a new device, registered their own authenticator app, connected to the VPN and reached the file server over SMB. Her own sign-in the previous evening was normal.`, timeline: [[-12 * 60, 'Push denials start.'], [-60, 'One push approved.'], [-40, 'Attacker registers an authenticator.'], [-30, 'VPN connection.'], [-10, 'SMB to FS01.']], iocs: [{ type: 'ip', value: ATK, note: 'Attacker address' }] },
  test: { tools: { l1_triage: [['user', U.sam], ['reputation', ATK]] } },
});
