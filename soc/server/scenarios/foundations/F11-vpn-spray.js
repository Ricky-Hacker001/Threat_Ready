// F11 · Password spraying against the VPN. Ground truth: one external
// address tried one or two passwords against ~40 accounts; all failed.

import { E } from '../../engine/format.js';
import { USERS, EXTRA_USERS, account, VPN_POOL } from '../../engine/env.js';
import { defineScenario, ran, single } from '../lib.js';

const SPRAY = '203.0.113.66';
const STAFF = account('s.petrov');
const STAFF_HOME = '198.51.100.124';
const GUESSES = ['admin', 'test', 'helpdesk', 'scanner', 'backup', 'reception', 'training', 'support', 'sales', 'info', 'hr', 'it', 'operations', 'finance', 'manager', 'temp', 'guest', 'vpnuser', 'service', 'office'];

export default defineScenario({
  code: 'F11', level: 'foundations',
  title: 'Many failed VPN logons for different accounts from one address', rule: 'VPN-0031', severity: 'medium', queue: 'remote access',
  blurb: 'A VPN rule reports many failed logons for different accounts from one address.',
  sources: ['vpn', 'proxy', 'dns', 'winsec', 'firewall'], sourceGroups: ['vpn'],
  skills: ['kno.auth-protocols', 'log.network', 'tri.severity'],
  entities: { ips: [SPRAY, STAFF_HOME] },
  alertTags: ['spray'],
  build(x) {
    const names = [...USERS, ...EXTRA_USERS].map((u) => u.sam).concat(GUESSES).slice(0, x.n(40, 32));
    let k = 0;
    names.forEach((u, i) => {
      const tries = i % 3 === 0 ? 2 : 1;
      for (let t = 0; t < tries; t++) x.add('spray', E.vpn(x.T(-20 * 60 + (k++) * 22), { event: 'auth_fail', user: u, src_ip: SPRAY, src_country: 'NL', client: 'unknown', reason: GUESSES.includes(u) ? 'unknown user' : 'bad password' }));
    });
    x.add('real_user', E.vpn(x.T(-8 * 60 - 5), { event: 'mfa_push', user: STAFF.sam, src_ip: STAFF_HOME, src_country: 'GB', reason: 'approved' }));
    x.add('real_user', E.vpn(x.T(-8 * 60), { event: 'connect', user: STAFF.sam, src_ip: STAFF_HOME, src_country: 'GB', assigned_ip: `${VPN_POOL}.77`, client: 'SecureLink 6.2.1', device_id: 'dev-spetrov', pop: 'LON' }));
  },
  alert: ({ tagged }) => {
    const f = tagged('spray');
    return {
      description: `${f.length} failed VPN logons for ${new Set(f.map((e) => e.fields.user)).size} different accounts from ${SPRAY}.`,
      entity: { host: 'VPN01', ip: SPRAY, user: `${new Set(f.map((e) => e.fields.user)).size} accounts` },
      details: [['Source address', SPRAY], ['Country', 'NL'], ['Failures', String(f.length)], ['Distinct accounts', String(new Set(f.map((e) => e.fields.user)).size)], ['Rule logic', '20+ failed VPN logons for 10+ accounts from one address within 30 minutes']],
      guidance: ['Work out the pattern: how many accounts, how many tries each.', 'Check whether any attempt from that address succeeded.'],
    };
  },
  intel: { [SPRAY]: { verdict: 'malicious', detections: '8/89', facts: [['Network', 'Hosting provider (NL)'], ['Reports', 'VPN password spraying in the last 7 days']], notes: ['Not a partner or company address.'] } },
  triage: {
    checks: [{ id: 'ti', label: 'Source address checked in threat intelligence', test: ran('reputation', SPRAY) }],
    fields: [
      single('pattern', 'What the pattern is', 6, [['spray', 'Password spraying: many accounts, few passwords each'], ['brute', 'Brute force: many passwords against one account'], ['stuffing', 'Credential stuffing with known pairs'], ['misconfig', 'A misconfigured client']], { spray: 1, brute: 0.3 }, { hint: 'Count accounts, and attempts per account.', explain: 'Brute force is many passwords against one account; here it is one or two tries against many accounts.', skills: ['kno.auth-protocols'] }),
      single('success', 'Did any attempt from that address succeed', 6, [['no', 'No success from the address'], ['yes', 'Yes, one account connected'], ['mfa', 'One reached the MFA step']], 'no', { hint: 'Search the address for connect or MFA events.', explain: 'The only success in the window came from a different address: an employee at home.', skills: ['inv.search', 'log.network'] }),
    ],
    verdict: { accept: 'tp', explain: 'A real attack; no access gained.' },
    severity: { accept: 'medium', explain: 'Real attack, no access gained, MFA in place.' },
    evidence: { tags: ['spray'], explain: 'The failed attempts from the address.' },
  },
  closure: {
    disposition: { options: [['tp_noaccess', 'True positive, no access gained'], ['compromise', 'Account compromise'], ['fp', 'False positive'], ['benign', 'Benign testing']], accept: 'tp_noaccess', explain: 'Every attempt failed.' },
    rootCause: { options: [['spray', 'External password-spraying attempt'], ['user', 'A user who forgot their password'], ['pentest', 'Authorised penetration test'], ['vpn_bug', 'VPN software fault']], accept: 'spray', explain: 'A hosting-provider address tried common passwords across accounts.' },
    actions: { options: [['block', `Block ${SPRAY}`], ['mfa_check', 'Check the targeted accounts have MFA'], ['close', 'Close the ticket'], ['reset_all', 'Reset all targeted passwords'], ['disable_vpn', 'Disable the VPN'], ['disable_staff', `Disable ${STAFF.sam}`]], set: ['block', 'mfa_check', 'close'], explain: 'Every attempt failed and MFA is in place, so resets and outages are not needed.' },
  },
  truth: { summary: `An external address (${SPRAY}, a hosting provider) tried one or two common passwords against about forty accounts over twenty minutes. Every attempt failed. Separately, ${STAFF.name} connected normally from home with MFA.`, timeline: [[-20 * 60, 'Spraying starts.'], [-8 * 60, 'Unrelated normal connection by an employee.'], [5, 'VPN-0031 fires.']], iocs: [{ type: 'ip', value: SPRAY, note: 'Password-spraying source' }] },
  test: { tools: { l1_triage: [['reputation', SPRAY]] } },
});
