// F8 · Blocked request to a malicious website. Ground truth: a mistyped
// bank domain (typosquat); the proxy blocked it; she then typed it correctly.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single } from '../lib.js';

const U = account('m.castillo');
const WS = hostNamed(U.host);
const BANK = 'online.northbridge-bank.example';
const BANK_IP = '203.0.113.9';
const TYPO = 'online.northbrldge-bank.example';
const TYPO_IP = '198.51.100.93';

export default defineScenario({
  code: 'F8', level: 'foundations',
  title: 'Web request blocked: phishing category', rule: 'PRX-0300', severity: 'medium', queue: 'web',
  blurb: 'The web proxy blocked a request it classifies as phishing.',
  sources: ['proxy', 'dns', 'winsec', 'edr', 'firewall', 'email'], sourceGroups: ['proxy', 'dns'],
  skills: ['log.network', 'kno.phishing', 'tri.severity'],
  entities: { domains: [TYPO], ips: [TYPO_IP] },
  alertTags: ['blocked'],
  build(x) {
    x.add('typo_dns', E.dns(x.T(-12), { client_ip: WS.ip, query: TYPO, answer: TYPO_IP }));
    x.add('blocked', E.proxy(x.T(-11), { src_ip: WS.ip, user: dom(U.sam), method: 'GET', url: `https://${TYPO}/`, dest_ip: TYPO_IP, status: 403, bytes_out: 0, bytes_in: 0, category: 'Phishing', action: 'DENIED', rule: 'Block-Phishing-Category' }));
    x.add('correct', E.dns(x.T(28), { client_ip: WS.ip, query: BANK, answer: BANK_IP }));
    x.add('correct', E.proxy(x.T(30), { src_ip: WS.ip, user: dom(U.sam), method: 'CONNECT', url: `${BANK}:443`, dest_ip: BANK_IP, status: 200, bytes_out: 6200, bytes_in: 88400, category: 'Finance/Banking' }));
  },
  alert: () => ({
    description: `The proxy blocked ${WS.name} (${U.sam}) from ${TYPO}, category Phishing.`,
    entity: { host: WS.name, ip: WS.ip, user: U.sam },
    details: [['User', U.sam], ['Host', WS.name], ['Destination', TYPO], ['Proxy action', 'DENIED (403)']],
    guidance: ['Confirm whether anything got through.', 'Work out how the user reached the site.'],
  }),
  intel: { [TYPO]: { verdict: 'malicious', detections: '9/89', facts: [['Category', 'Phishing'], ['Registered', '9 days ago'], ['Resembles', BANK]], notes: ['Phishing kit observed imitating the bank\'s corporate login.'] } },
  triage: {
    checks: [{ id: 'ti', label: 'Destination checked in threat intelligence', test: ran('reputation', TYPO) }],
    fields: [
      single('proxy_action', 'What the proxy did', 6, [['blocked', 'Blocked'], ['allowed', 'Allowed'], ['warned', 'Warned, then allowed'], ['logged', 'Logged only']], 'blocked', { hint: 'Read the action field.', explain: 'action=DENIED with status 403.', skills: ['log.network'] }),
      single('got_through', 'Did anything get through', 6, [['no', 'No: no allowed request to the domain or its address'], ['yes', 'Yes: a later request was allowed'], ['dns', 'Only DNS resolved, so the page loaded']], 'no', { hint: 'Search both the domain and its IP address.', explain: 'Blocked once does not prove blocked always; here no request to either was allowed.', skills: ['inv.search', 'log.network'] }),
      single('how', 'How the user reached the site', 4, [['typo', 'Mistyped a legitimate domain'], ['email', 'A link in a phishing email'], ['malware', 'Malware on the workstation'], ['ad', 'An advert redirect']], 'typo', { hint: 'Compare with the next thing the user visited.', explain: 'Forty seconds later the user reached the real bank domain, one letter different.', skills: ['kno.phishing'] }),
    ],
    verdict: { accept: { tp: 1, btp: 0.4 }, explain: 'A real malicious site; the block prevented harm.' },
    severity: { accept: 'low', explain: 'Prevented, single user, no credentials entered.' },
    evidence: { tags: ['blocked', 'correct'], explain: 'The block and the correct visit right after it.' },
  },
  closure: {
    disposition: { options: [['prevented', 'True positive, prevented'], ['compromise', 'Credential compromise'], ['fp', 'False positive'], ['benign', 'Benign']], accept: 'prevented', explain: 'Malicious site, blocked.' },
    rootCause: { options: [['typo', 'A typosquatted domain reached by a typing error'], ['phish', 'A phishing email'], ['malware', 'Malware redirect'], ['dns', 'DNS hijack']], accept: 'typo', explain: 'One mistyped letter.' },
    actions: { options: [['close', 'Close the ticket'], ['bookmark', 'Suggest a bookmark for the bank site'], ['report', 'Report the typosquat to threat intelligence'], ['isolate', `Isolate ${WS.name}`], ['reset', 'Reset the user\'s password']], set: ['close', 'bookmark', 'report'], explain: 'No page loaded, so no credentials could be entered.' },
  },
  truth: { summary: `${U.name} mistyped the bank's domain as ${TYPO}, a phishing typosquat. The proxy blocked it; she then typed ${BANK} correctly. No allowed request ever reached the typosquat.`, timeline: [[-12, 'DNS lookup of the typosquat.'], [-11, 'Proxy blocks the request.'], [30, 'User reaches the real bank site.']], iocs: [{ type: 'domain', value: TYPO, note: 'Typosquat of the bank' }] },
  test: { tools: { l1_triage: [['reputation', TYPO]] } },
});
