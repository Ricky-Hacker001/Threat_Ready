// E5 · New inbox rule forwarding mail externally: business email compromise
// with a fake bank-details letter sent to a customer.

import { E } from '../../engine/format.js';
import { account, ORG } from '../../engine/env.js';
import { defineScenario, ran, single, multi, link } from '../lib.js';

const U = account('p.nair');
const MAIL = `${U.sam}@${ORG.mailDomain}`;
const ATK = '198.51.100.226';
const EXT = 'remit.desk@mailbox-relay.example';
const CUSTOMER = 'accounts@nordhaven-shipping.example';
const SUBJECT = 'Updated bank details for remittance';

export default defineScenario({
  code: 'E5', level: 'expert',
  title: 'Inbox rule created that forwards mail to an external address', rule: 'M365-0310', severity: 'high', queue: 'email',
  blurb: 'A mailbox audit rule reports an inbox rule forwarding mail outside the company.',
  sources: ['m365', 'idp', 'email', 'proxy', 'dns', 'winsec'], sourceGroups: ['identity', 'email'],
  skills: ['log.cloud', 'log.email', 'kno.phishing', 'res.containment'],
  entities: { ips: [ATK], domains: ['mailbox-relay.example'] },
  alertTags: ['fwd'],
  build(x) {
    x.add('signin', E.signin(x.T(-40 * 60), { user: MAIL, app: 'Office 365', src_ip: ATK, country: 'NL', city: 'Amsterdam', device_id: 'dev-unknown-22c1', mfa: 'previously satisfied', risk: 'medium', session_id: '9f31aa', user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0' }));
    x.add('decoy_rule', E.m365(x.T(-38 * 60), { operation: 'New-InboxRule', user: MAIL, client_ip: '203.0.113.10', client_info: 'Outlook/16.0', rule_name: 'Newsletters', rule_params: 'From contains "newsletter"; MoveToFolder Newsletters' }));
    x.add('rule', E.m365(x.T(-35 * 60), { operation: 'New-InboxRule', user: MAIL, client_ip: ATK, client_info: 'OWA', rule_name: '.', rule_params: 'Subject or body contains "invoice","payment","remittance"; MoveToFolder RSS Feeds; ForwardTo', forward_to: EXT, session_id: '9f31aa' }));
    x.add('fraud_send', E.m365(x.T(-20 * 60), { operation: 'Send', user: MAIL, client_ip: ATK, client_info: 'OWA', recipient: CUSTOMER, subject: SUBJECT, session_id: '9f31aa' }));
    x.add('cover', E.m365(x.T(-19 * 60), { operation: 'SoftDelete', user: MAIL, client_ip: ATK, client_info: 'OWA', folder: 'Sent Items', subject: SUBJECT, item_count: 1, session_id: '9f31aa' }));
    x.add('fwd', E.m365(x.T(-8), { operation: 'Send', user: MAIL, client_ip: 'transport', client_info: 'InboxRule', rule_name: '.', recipient: EXT, subject: 'FW: Remittance advice BCL-44120', forward_to: EXT }));
  },
  alert: () => ({
    description: `An inbox rule on ${MAIL} forwarded mail to ${EXT}.`,
    entity: { host: 'M365', ip: ATK, user: U.sam },
    details: [['Mailbox', MAIL], ['Rule name', '"."'], ['Forwards to', EXT], ['Rule logic', 'Inbox rule forwarding to an external address']],
    guidance: ['Read what the rule does.', 'Find how the mailbox was accessed.', 'Find what else was done from that session.'],
  }),
  intel: { [ATK]: { verdict: 'suspicious', detections: '3/89', facts: [['Type', 'Proxy service']], notes: ['Often used in account takeover.'] } },
  accountNotes: { 'p.nair': ['Registered device: dev-pnair (company laptop).'] },
  triage: {
    checks: [{ id: 'dir', label: 'Mailbox owner looked up in the directory', test: ran('user', U.sam) }],
    verdict: { accept: 'tp', explain: 'A hidden forwarding rule created from an unknown address.' },
    severity: { accept: 'high', explain: 'Financial fraud is in progress.' },
    evidence: { tags: ['rule'], explain: 'The rule creation.' },
  },
  l2: {
    fields: [
      multi('rule_effect', 'What the rule does', 6, [['forward', `Forwards to ${EXT}`], ['hide', 'Hides matching mail in RSS Feeds'], ['delete', 'Deletes all mail'], ['newsletter', 'Moves newsletters']], ['forward', 'hide'], { hint: 'Read rule_params.', explain: 'It forwards payment mail and hides it from the user.', skills: ['log.cloud'] }),
      link(single('access', 'How the mailbox was accessed', 6, [['signin', 'A sign-in from an unknown address on a new device'], ['owner', 'The owner\'s own laptop'], ['delegate', 'A delegate']], 'signin', { hint: 'Search sign-ins for the mailbox before the rule.', explain: 'A new device from a proxy address, with a stolen session.', skills: ['kno.cloud-identity'] }), 'signin'),
      link(single('fraud', 'What else the session did', 10, [['letter', 'Sent a fake bank-details letter to a customer'], ['nothing', 'Nothing else'], ['download', 'Downloaded attachments']], 'letter', { hint: 'Search Send operations from the same session.', explain: 'Financial impact is the priority.', skills: ['kno.phishing'] }), 'fraud_send'),
      single('cover', 'Cover-up', 4, [['deleted', 'The sent copy was deleted'], ['none', 'Nothing'], ['purged', 'The mailbox was purged']], 'deleted', { explain: 'SoftDelete from Sent Items.', skills: ['log.cloud'] }),
    ],
  },
  response: {
    scope: { accounts: [U.sam], senders: [EXT, 'mailbox-relay.example'], ips: [ATK], remove_mail_rule: ['.'], restore_item: [SUBJECT.toLowerCase()] },
    textTargets: { remove_mail_rule: ['.', 'newsletters'], restore_item: [SUBJECT] },
    collateralReasons: { remove_mail_rule: { newsletters: 'That is the user\'s own rule.' } },
    contained: (st) => st.did('remove_mail_rule', '.') && st.revoked.has(U.sam),
    objectives: [
      { id: 'rule', label: 'Remove the forwarding rule', points: 3, containment: true, eval: (st) => (st.did('remove_mail_rule', '.') ? 1 : 0), explain: 'Stops the leak.' },
      { id: 'revoke', label: 'Revoke the attacker\'s sessions', points: 3, containment: true, eval: (st) => (st.revoked.has(U.sam) ? 1 : 0), explain: 'The session token survives a password reset.' },
      { id: 'reset', label: 'Reset the password', points: 2, containment: true, eval: (st) => (st.reset.has(U.sam) ? 1 : 0), explain: 'The password was phished.' },
      { id: 'block', label: 'Block the external forwarding address', points: 2, containment: true, eval: (st) => (st.blockedSenders.has(EXT) || st.blockedSenders.has('mailbox-relay.example') ? 1 : 0), explain: 'Stops replies reaching the attacker.' },
      { id: 'restore', label: 'Recover the deleted sent item as evidence', points: 2, skills: ['doc.evidence'], eval: (st) => (st.did('restore_item', SUBJECT) ? 1 : 0), explain: 'The letter is the evidence the customer and bank need.' },
    ],
  },
  closure: {
    disposition: { options: [['bec', 'Business email compromise with attempted payment fraud'], ['spam', 'Spam'], ['fp', 'False positive'], ['user', 'User set up forwarding']], accept: 'bec', explain: 'Account takeover used for fraud.' },
    rootCause: { options: [['phished', 'Password and session phished'], ['reuse', 'Password reuse from a breach'], ['malware', 'Malware'], ['insider', 'Insider']], accept: 'phished', explain: 'New device, proxy address, stolen session.' },
    actions: { options: [['finance', 'Tell finance not to change any bank details'], ['phone', 'Warn the customer by phone'], ['bank', 'Report to the bank if a payment was made'], ['email_customer', 'Email the customer from the affected mailbox']], set: ['finance', 'phone', 'bank'], explain: 'The mailbox is not yet trusted.', skills: ['res.proportionality'] },
  },
  truth: { summary: `${U.name} in Accounts Payable entered her password on a phishing page. The attacker signed in from ${ATK} with a stolen session, created a rule named "." that forwards payment mail to ${EXT} and hides it in RSS Feeds, sent the customer an "${SUBJECT}" letter from her mailbox and deleted the sent copy. Her own Newsletters rule is unrelated.`, timeline: [[-40 * 60, 'Attacker signs in.'], [-35 * 60, 'Forwarding rule created.'], [-20 * 60, 'Fake bank-details letter sent.'], [-19 * 60, 'Sent copy deleted.']], iocs: [{ type: 'email', value: EXT, note: 'Forwarding address' }] },
  test: { tools: { l1_triage: [['user', U.sam]] }, response: [['remove_mail_rule', '.'], ['revoke_sessions', U.sam], ['reset_credentials', U.sam], ['block_sender', EXT], ['restore_item', SUBJECT]] },
});
