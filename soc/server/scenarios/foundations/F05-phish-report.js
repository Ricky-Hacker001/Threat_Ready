// F5 · User reported a phishing email. Ground truth: a credential-phishing
// email reached four users; one reported it; nobody opened the link.

import { E } from '../../engine/format.js';
import { account, ORG } from '../../engine/env.js';
import { defineScenario, ran, single, accounts } from '../lib.js';

const RECIPIENTS = ['m.castillo', 'p.nair', 'a.mensah', 's.petrov'].map(account);
const REPORTER = RECIPIENTS[2];
const SENDER_DOMAIN = 'm365-account-notice.example';
const SENDER = `no-reply@${SENDER_DOMAIN}`;
const PHISH = 'login-m365-verify.example';
const SENDER_IP = '203.0.113.71';

export default defineScenario({
  code: 'F5', level: 'foundations',
  title: 'User-reported suspicious email', rule: 'MAIL-0200', severity: 'medium', queue: 'email',
  blurb: 'A user forwarded a suspicious email to the phishing mailbox.',
  sources: ['email', 'proxy', 'dns', 'winsec', 'edr', 'firewall'], sourceGroups: ['email', 'proxy'],
  skills: ['kno.phishing', 'log.email', 'inv.scope'],
  entities: { domains: [SENDER_DOMAIN, PHISH], ips: [SENDER_IP] },
  alertTags: ['report'],
  build(x) {
    RECIPIENTS.forEach((u, i) => x.add('phish_deliver', E.email(x.T(-40 * 60 + 60 + i * 2), {
      msg_id: `<a81f${i}.c2@${SENDER_DOMAIN}>`, from: SENDER, from_name: 'Microsoft 365 Account Team', to: u.email,
      subject: 'Your Microsoft 365 password expires today', src_ip: SENDER_IP, spf: 'fail', dkim: 'none', dmarc: 'fail',
      size: 18422, verdict: 'clean', action: 'DELIVERED', attachment: undefined,
    })));
    x.add('report', E.email(x.T(-30), { direction: 'internal', msg_id: `<r19.${REPORTER.sam}@${ORG.mailDomain}>`, from: REPORTER.email, from_name: REPORTER.name, to: `phishing@${ORG.mailDomain}`, subject: 'FW: Your Microsoft 365 password expires today', src_ip: '10.10.0.25', spf: 'pass', dkim: 'pass', dmarc: 'pass', size: 24411, verdict: 'clean', action: 'DELIVERED' }));
  },
  alert: () => ({
    description: `${REPORTER.name} reported an email titled "Your Microsoft 365 password expires today" from ${SENDER}.`,
    entity: { host: null, ip: SENDER_IP, user: REPORTER.sam },
    details: [['Reported by', REPORTER.email], ['Sender', SENDER], ['Subject', 'Your Microsoft 365 password expires today'], ['Link in body', `https://${PHISH}/o365/login`]],
    guidance: ['Find everyone who received the message.', 'Read the sender authentication results.', 'Check whether anyone opened the link.'],
  }),
  intel: { [PHISH]: { verdict: 'malicious', detections: '11/89', facts: [['Category', 'Credential phishing'], ['Registered', '2 days ago']], notes: ['Imitates a Microsoft 365 sign-in page.'] }, [SENDER_DOMAIN]: { verdict: 'malicious', detections: '6/89', facts: [['Registered', '3 days ago']], notes: ['Look-alike sender domain.'] } },
  triage: {
    checks: [
      { id: 'ti', label: 'Link domain checked in threat intelligence', test: ran('reputation', PHISH) },
    ],
    fields: [
      accounts('recipients', 'Everyone who received it', 6, RECIPIENTS.map((u) => u.sam), { hint: 'Search email by sender, not just the reported message.', explain: 'One report usually means more recipients: four mailboxes received it.', skills: ['inv.scope', 'log.email'] }),
      single('auth', 'Sender authentication', 4, [['fail', 'SPF and DMARC failed'], ['pass', 'SPF, DKIM and DMARC passed'], ['dkim_only', 'Only DKIM failed'], ['none', 'No authentication recorded']], 'fail', { hint: 'Look at the spf, dkim and dmarc fields.', explain: 'spf=fail dkim=none dmarc=fail: the sender is not who it claims to be.', skills: ['log.email', 'kno.phishing'] }),
      single('clicked', 'Did anyone open the link', 6, [['nobody', 'Nobody: no proxy or DNS traffic to the domain'], ['one', 'One recipient opened it'], ['all', 'Every recipient opened it'], ['cannot', 'Cannot be known from the logs']], 'nobody', { hint: 'Search the proxy and DNS logs for the link domain.', explain: 'Absence in both proxy and DNS logs is the proof that nobody clicked.', skills: ['inv.search', 'log.network'] }),
    ],
    verdict: { accept: 'tp', explain: 'Real phishing, with no impact.' },
    severity: { accept: 'medium', explain: 'Credential phishing reached four mailboxes; nobody clicked.' },
    evidence: { tags: ['phish_deliver'], explain: 'The delivery records show the sender, the failed authentication and every recipient.' },
  },
  closure: {
    disposition: { options: [['tp_noimpact', 'True positive, no impact'], ['compromise', 'Credential compromise'], ['fp', 'False positive'], ['spam', 'Spam, no action']], accept: 'tp_noimpact', explain: 'Real credential phishing; nobody reached the page.' },
    rootCause: { options: [['phish', 'Credential-phishing campaign using a look-alike domain'], ['internal', 'Compromised internal mailbox'], ['partner', 'Compromised partner'], ['newsletter', 'Misconfigured newsletter']], accept: 'phish', explain: 'A newly registered look-alike domain sent a fake password-expiry notice.' },
    actions: { options: [['block_sender', 'Block the sender domain'], ['purge', 'Purge the email from all four mailboxes'], ['block_link', 'Block the link domain at the proxy'], ['thank', 'Thank the reporter'], ['reset_all', 'Reset all four passwords'], ['isolate', 'Isolate the four laptops']], set: ['block_sender', 'purge', 'block_link', 'thank'], explain: 'Nobody clicked, so resets and isolation are not needed.' },
  },
  truth: { summary: `A credential-phishing email ("Your Microsoft 365 password expires today") from ${SENDER} reached four users. It failed SPF and DMARC. ${REPORTER.name} reported it. No host made a DNS query or proxy request to ${PHISH}, so nobody opened the link.`, timeline: [[-40 * 60 + 60, 'Email delivered to four mailboxes.'], [-30, 'Reported to the phishing mailbox.']], iocs: [{ type: 'domain', value: PHISH, note: 'Phishing page' }, { type: 'domain', value: SENDER_DOMAIN, note: 'Sender domain' }] },
  test: { tools: { l1_triage: [['reputation', PHISH]] } },
});
