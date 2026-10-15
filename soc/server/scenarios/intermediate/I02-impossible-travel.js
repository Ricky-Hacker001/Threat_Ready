// I2 · Impossible travel. Ground truth: the user's second sign-in came from
// the company's own VPN exit in Frankfurt. Same device, same session. Benign.

import { E } from '../../engine/format.js';
import { account, ORG, VPN_POOL } from '../../engine/env.js';
import { OFFICE_EGRESS } from '../../engine/noise.js';
import { defineScenario, ran, single } from '../lib.js';

const U = account('a.mensah');
const EXIT_DE = '192.0.2.233';
const DEVICE = 'dev-amensah';

export default defineScenario({
  code: 'I2', level: 'intermediate', benign: true,
  title: 'Impossible travel: sign-ins from GB and DE 40 minutes apart', rule: 'IDP-0120', severity: 'medium', queue: 'identity',
  blurb: 'An identity rule reports sign-ins for one user from two countries too close together.',
  sources: ['idp', 'vpn', 'proxy', 'dns', 'winsec', 'firewall'], sourceGroups: ['identity', 'vpn'],
  skills: ['log.cloud', 'kno.cloud-identity', 'tri.false-positive', 'inv.pivot'],
  entities: { ips: [EXIT_DE] },
  alertTags: ['signin_gb', 'signin_de'],
  build(x) {
    const mail = `${U.sam}@${ORG.mailDomain}`;
    x.add('signin_gb', E.signin(x.T(-40 * 60 + 30), { user: mail, app: 'Office 365', src_ip: OFFICE_EGRESS, country: 'GB', city: 'London', device_id: DEVICE, mfa: 'push', session_id: 'a91c03', user_agent: 'Mozilla/5.0 Edg/129.0' }));
    x.add('vpn_on', E.vpn(x.T(-150), { event: 'connect', user: U.sam, src_ip: OFFICE_EGRESS, src_country: 'GB', assigned_ip: `${VPN_POOL}.88`, client: 'SecureLink 6.2.1', device_id: DEVICE, pop: 'FRA' }));
    x.add('signin_de', E.signin(x.T(-20), { user: mail, app: 'Office 365', src_ip: EXIT_DE, country: 'DE', city: 'Frankfurt', device_id: DEVICE, mfa: 'previously satisfied', session_id: 'a91c03', user_agent: 'Mozilla/5.0 Edg/129.0' }));
    x.add('decoy_fail', E.signin(x.T(-900), { user: `s.petrov@${ORG.mailDomain}`, app: 'Office 365', result: 'failure', error_code: 50126, src_ip: '198.51.100.31', country: 'GB', city: 'Manchester', client_app: 'Mobile Apps and Desktop clients', mfa: 'none' }));
  },
  alert: () => ({
    description: `Sign-ins for ${U.sam} from GB (London) and DE (Frankfurt) 40 minutes apart.`,
    entity: { host: null, ip: EXIT_DE, user: U.sam },
    details: [['User', U.sam], ['First sign-in', `GB, ${OFFICE_EGRESS}`], ['Second sign-in', `DE, ${EXIT_DE}`], ['Rule logic', 'Two successful sign-ins whose locations imply travel faster than 900 km/h']],
    guidance: ['Find out who owns the second address.', 'Compare the device and session of the two sign-ins.'],
  }),
  assetRecords: { [EXIT_DE]: { facts: [['Owner', 'Meridian Freight Systems'], ['Role', 'Company VPN egress, Frankfurt point of presence (FRA)'], ['Used by', 'VPN01 for users routed through FRA']], notes: ['Traffic from VPN users routed through the FRA point of presence leaves from this address.'] } },
  intel: { [EXIT_DE]: { verdict: 'clean', detections: '0/89', facts: [['Owner', 'Meridian Freight Systems (VPN egress)']], notes: ['No reports.'] } },
  triage: {
    checks: [{ id: 'own', label: 'Second address looked up in the asset inventory or threat intelligence', test: (c) => ran('asset', EXIT_DE)(c) || ran('reputation', EXIT_DE)(c) }],
    fields: [
      single('same_device', 'Device of the two sign-ins', 6, [['same', 'Same device ID on both sign-ins'], ['different', 'Different devices'], ['none', 'No device recorded']], 'same', { hint: 'Compare the device and session fields.', explain: 'Both sign-ins carry the same device ID and session.', skills: ['log.cloud'] }),
      single('de_owner', 'Who owns the German address', 6, [['vpn', 'The company\'s own VPN exit'], ['cloud', 'A public cloud host'], ['isp', 'A consumer ISP'], ['bad', 'A known malicious host']], 'vpn', { hint: 'Look the second address up in the asset inventory.', explain: 'It is the company VPN egress in Frankfurt.', skills: ['inv.pivot', 'kno.cloud-identity'] }),
    ],
    verdict: { accept: { fp: 1, btp: 0.6 }, explain: 'Nobody travelled; the rule does not know the company\'s own egress addresses, so it matched activity it should not have.' },
    severity: { accept: 'low', explain: 'No risk once the address is known.' },
    evidence: { tags: ['vpn_on', 'signin_de'], explain: 'The VPN connection through FRA and the sign-in that followed it.' },
  },
  review: { explain: 'The asset inventory shows the second address is the company VPN egress; Tier 1 could close this.' },
  closure: {
    disposition: { options: [['fp', 'False positive: rule does not know company egress'], ['compromise', 'Account compromise'], ['travel', 'Real travel'], ['unknown', 'Unknown']], accept: 'fp', explain: 'Same device and session; the second address is our VPN.' },
    rootCause: { options: [['egress', 'The rule treats the company\'s VPN egress as a foreign location'], ['token', 'A stolen session token'], ['proxy', 'The user used a personal VPN'], ['geoip', 'A wrong GeoIP database']], accept: 'egress', explain: 'The FRA point of presence is not in the rule\'s trusted locations.' },
    actions: { options: [['close', 'Close the ticket'], ['trust', 'Add the company VPN egress ranges as trusted locations in the rule'], ['revoke', 'Revoke the user\'s sessions'], ['reset', 'Reset the user\'s password']], set: ['close', 'trust'], explain: 'Tuning removes the noise; nothing about the account needs changing.' },
  },
  truth: { summary: `${U.name} signed in to Microsoft 365 from the London office. Later she connected to the company VPN, whose traffic leaves through the Frankfurt point of presence (${EXIT_DE}). Her next sign-in came from that address, with the same device and session. Nobody travelled.`, timeline: [[-40 * 60 + 30, 'Sign-in from the London office.'], [-150, 'VPN connection routed through FRA.'], [-20, 'Sign-in from the FRA egress.']] },
  test: { tools: { l1_triage: [['asset', EXIT_DE]] } },
});
