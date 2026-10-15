// I10 · SQL injection patterns against the customer portal: an automated
// scanner, blocked or errored, no data returned. The id parameter errors.

import { E } from '../../engine/format.js';
import { defineScenario, ran, single, link } from '../lib.js';

const SCANNER = '203.0.113.201';
const UA = 'sqlmap/1.8.4#stable (https://sqlmap.org)';
const PAYLOADS = ["1' OR '1'='1", "1 UNION SELECT NULL,NULL--", "1' AND SLEEP(5)--", "1; DROP TABLE x--", "1' ORDER BY 3--", "1 AND 1=CONVERT(int,@@version)--"];

export default defineScenario({
  code: 'I10', level: 'intermediate',
  title: 'SQL injection patterns against portal from one address', rule: 'WAF-0920', severity: 'high', queue: 'web',
  blurb: 'The web application firewall reports SQL injection patterns against the customer portal.',
  sources: ['web', 'firewall', 'proxy', 'dns', 'winsec'], sourceGroups: ['web'],
  skills: ['log.web', 'inv.ioc', 'tri.escalation', 'doc.root-cause'],
  entities: { ips: [SCANNER] },
  alertTags: ['sqli_block'],
  build(x) {
    const n = x.n(380, 300);
    for (let i = 0; i < n; i++) x.add('sqli_block', E.waf(x.T(-900 + i * 2.2), { src_ip: SCANNER, rule_id: '942100', rule_msg: 'SQL Injection Attack Detected via libinjection', action: 'block', uri: '/track', param: 'id', match: PAYLOADS[i % PAYLOADS.length], score: 5, ua: UA }));
    const m = x.n(28, 20);
    for (let i = 0; i < m; i++) x.add('sqli_pass', E.web(x.T(-880 + i * 29), { src_ip: SCANNER, uri: '/track', query: `id=${encodeURIComponent(`1)) AND ${1000 + i}=${1000 + i}--`)}`, status: 500, bytes: 1120 + (i % 60), ua: UA, time_ms: 40 + i }));
    for (let i = 0; i < 12; i++) x.add('baseline', E.web(x.T(-1500 + i * 60), { src_ip: `192.0.2.${40 + i}`, uri: '/track', query: `id=${400000 + i * 137}`, status: 200, bytes: 4100 + i * 25, ua: 'Mozilla/5.0 Edg/129.0', time_ms: 80 }));
  },
  alert: ({ tagged }) => ({
    description: `${tagged('sqli_block').length} SQL injection patterns from ${SCANNER} against /track, blocked by the WAF.`,
    entity: { host: 'WEB01', ip: SCANNER, user: null },
    details: [['Source address', SCANNER], ['Target', 'portal /track, parameter id'], ['WAF rule', '942100'], ['User agent', UA]],
    guidance: ['Identify the tool.', 'Check whether any request passed the WAF and what the server returned.'],
  }),
  intel: { [SCANNER]: { verdict: 'malicious', detections: '12/89', facts: [['Type', 'Known scanning host']], notes: ['Mass-scans web applications for injection flaws.'] } },
  triage: {
    checks: [{ id: 'ti', label: 'Source address checked in threat intelligence', test: ran('reputation', SCANNER) }],
    fields: [single('tool', 'What is sending the requests', 4, [['scanner', 'An automated SQL injection tool'], ['customer', 'A customer with a typo'], ['monitor', 'Our uptime monitor'], ['browser', 'A manual browser session']], 'scanner', { hint: 'Read the user agent.', explain: 'The user agent is sqlmap.', skills: ['log.web'] })],
    verdict: { accept: 'tp', explain: 'A real attack; L2 must confirm nothing was taken.' },
    severity: { accept: 'high', explain: 'An injection attack against a customer-facing database.' },
    evidence: { tags: ['sqli_block'], explain: 'The blocked attempts.' },
  },
  l2: {
    fields: [
      link(single('passed', 'Did any request get past the WAF', 6, [['some_500', 'Some passed and got 500 errors'], ['none', 'None passed'], ['some_200', 'Some passed and returned data']], 'some_500', { hint: 'Search the web server log, not only the WAF.', explain: 'Twenty-odd obfuscated requests passed and the server answered 500.', skills: ['log.web', 'inv.search'] }), 'sqli_pass'),
      single('data_left', 'Did any data leave', 10, [['no', 'No: no successful response larger than normal'], ['yes', 'Yes: large 200 responses'], ['unknown', 'Cannot be determined']], 'no', { hint: 'Compare response sizes with normal /track responses.', explain: 'Status and size, not the request, show success: every passed request got a small 500.', skills: ['log.web'] }),
      single('vulnerable', 'What the 500 errors suggest', 6, [['fix', 'The id parameter causes database errors and needs fixing'], ['fine', 'The site is fine'], ['waf', 'The WAF is broken'], ['ddos', 'The server is overloaded']], 'fix', { hint: 'What does a 500 on an injection payload suggest?', explain: 'Database errors on crafted input mean the parameter is not safely handled.', skills: ['doc.root-cause'] }),
    ],
  },
  closure: {
    disposition: { options: [['unsuccessful', 'True positive, unsuccessful'], ['breach', 'Data breach'], ['fp', 'False positive'], ['benign', 'Benign testing']], accept: 'unsuccessful', explain: 'Real attack, no data returned.' },
    rootCause: { options: [['scanner', 'Automated injection scanning; the id parameter is vulnerable to errors'], ['insider', 'Insider testing'], ['bug', 'A deployment bug'], ['bot', 'Search-engine crawler']], accept: 'scanner', explain: 'sqlmap from a known scanning host.' },
    actions: { options: [['block', `Block ${SCANNER} at the WAF`], ['fix', 'Raise a fix for the id parameter with the web team'], ['close', 'Close as unsuccessful'], ['offline', 'Take the portal offline'], ['restore', 'Restore the database']], set: ['block', 'fix', 'close'], explain: 'No data was taken; outages are not needed.' },
  },
  truth: { summary: `An automated scanner at ${SCANNER} (sqlmap) tested the /track page for SQL injection. The WAF blocked most requests; about twenty obfuscated ones passed and the server answered with small 500 errors. No request returned data. The id parameter does produce a database error, so the code needs fixing.`, timeline: [[-900, 'Scanning starts.'], [-880, 'First request passes the WAF; 500 error.']], iocs: [{ type: 'ip', value: SCANNER, note: 'Scanner' }] },
  test: { tools: { l1_triage: [['reputation', SCANNER]] } },
});
