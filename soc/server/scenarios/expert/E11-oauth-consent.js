// E11 · New app granted mailbox access by a user: OAuth consent phishing.
// The attacker's app reads mail with tokens, no password, and uses the first
// mailbox to phish the next user.

import { E } from '../../engine/format.js';
import { account, ORG } from '../../engine/env.js';
import { OFFICE_EGRESS } from '../../engine/noise.js';
import { defineScenario, ran, searched, single, multi, accounts, link } from '../lib.js';

const U1 = account('s.petrov');
const U2 = account('j.whitfield');
const M1 = `${U1.sam}@${ORG.mailDomain}`;
const M2 = `${U2.sam}@${ORG.mailDomain}`;
const APP = 'FreightDocs Viewer';
const APPID = '6b1f0c3e-58d2-4a7e-9c41-2f8e7d0a93b5';
const GOOD = 'TeamPlanner Pro';
const GOODID = 'a2d7e4f9-1c3b-4e8a-b6d0-7f5c9e2a1b84';
const LURE = 'freightdocs-portal.example';
const SENDER = `docs-share@${LURE}`;
const ATK = '198.51.100.140';
const EGRESS = OFFICE_EGRESS;
const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${APPID}&scope=Mail.Read%20Mail.Send%20offline_access%20User.Read&redirect_uri=https://app.${LURE}/cb`;
const PERMS = 'Mail.Read Mail.Send offline_access User.Read';

export default defineScenario({
  code: 'E11', level: 'expert',
  title: 'New application granted mailbox access by a user', rule: 'IDP-0207', severity: 'medium', queue: 'identity',
  blurb: 'An identity rule reports users consenting to an unverified application that can read their mail.',
  sources: ['idp', 'm365', 'email', 'proxy', 'dns', 'winsec'], sourceGroups: ['identity', 'email'],
  skills: ['log.cloud', 'kno.cloud-identity', 'kno.phishing', 'res.containment'],
  entities: { domains: [LURE], ips: [ATK], names: [APP, GOOD] },
  history: 2 * 3600,
  alertTags: ['consent'],
  build(x) {
    x.add('lure', E.email(x.T(-104 * 60), { msg_id: '<a91c.77f2@freightdocs-portal.example>', from: SENDER, from_name: 'FreightDocs', to: M1, subject: 'Delivery schedule shared with you', src_ip: ATK, spf: 'pass', dkim: 'pass', dmarc: 'pass', size: 18220 }));
    x.add('lure', E.proxy(x.T(-101 * 60), { src_ip: U1.ip, user: U1.sam, url: authUrl, dest_ip: '20.190.151.7', category: 'Business/Authentication' }));
    x.add('consent', E.idpAudit(x.T(-100 * 60), { operation: 'Consent to application', actor: M1, target: APP, target_type: 'ServicePrincipal', app_id: APPID, app_name: APP, permissions: PERMS, publisher: 'Unverified', src_ip: EGRESS }));
    x.add('signin_ok', E.signin(x.T(-100 * 60 + 5), { user: M1, app: APP, src_ip: EGRESS, country: 'GB', city: 'London', device_id: 'dev-spetrov', mfa: 'satisfied', session_id: 'c11a02' }));
    for (let k = 0; k < x.n(6, 4); k++) x.add('read', E.m365(x.T(-95 * 60 + k * 600), { operation: 'MailItemsAccessed', user: M1, client_ip: ATK, client_info: 'Graph API', client_app_id: APPID, folder: k % 2 ? 'Inbox' : 'Sent Items', item_count: 50 + k * 7 }));
    x.add('internal_send', E.m365(x.T(-70 * 60), { operation: 'Send', user: M1, client_ip: ATK, client_info: 'Graph API', client_app_id: APPID, recipient: M2, subject: 'Updated delivery schedule' }));
    x.add('lure2', E.proxy(x.T(-8 * 60), { src_ip: U2.ip, user: U2.sam, url: authUrl, dest_ip: '20.190.151.7', category: 'Business/Authentication' }));
    x.add('consent', E.idpAudit(x.T(-6 * 60), { operation: 'Consent to application', actor: M2, target: APP, target_type: 'ServicePrincipal', app_id: APPID, app_name: APP, permissions: PERMS, publisher: 'Unverified', src_ip: EGRESS }));
    x.add('read', E.m365(x.T(-2 * 60), { operation: 'MailItemsAccessed', user: M2, client_ip: ATK, client_info: 'Graph API', client_app_id: APPID, folder: 'Inbox', item_count: 120 }));
    x.add('decoy_consent', E.idpAudit(x.T(-45 * 60), { operation: 'Consent to application', actor: `a.mensah@${ORG.mailDomain}`, target: GOOD, target_type: 'ServicePrincipal', app_id: GOODID, app_name: GOOD, permissions: 'User.Read', publisher: 'Verified (TeamPlanner Software Inc.)', src_ip: EGRESS }));
  },
  alert: ({ tagged }) => ({
    description: `${tagged('consent').length} users consented to "${APP}" (unverified publisher) with mail permissions.`,
    entity: { host: 'ENTRA', ip: null, user: U2.sam },
    details: [['Application', `${APP} (${APPID})`], ['Publisher', 'Unverified'], ['Permissions', PERMS], ['Rule logic', 'User consent to an unverified app requesting Mail.* scopes']],
    guidance: ['Read the permissions granted.', 'Find what the app did with them.', 'Find every user who consented.'],
  }),
  intel: { [LURE]: { verdict: 'malicious', detections: '4/89', facts: [['Registered', '6 days ago']], notes: ['Consent phishing kit.'] }, [ATK]: { verdict: 'suspicious', detections: '2/89', facts: [['Type', 'VPS hosting']], notes: [] } },
  triage: {
    checks: [
      { id: 'dir1', label: 'Consenting users looked up in the directory', test: ran('user', [U1.sam, U2.sam]) },
      { id: 'ti', label: 'Lure domain checked in threat intelligence', test: ran('reputation', LURE) },
    ],
    verdict: { accept: 'tp', explain: 'An unverified app with mail permissions, reached through a phishing link, reading mail from a hosting address.' },
    severity: { accept: 'high', explain: 'Two mailboxes readable without a password, and spreading.' },
    evidence: { tags: ['consent'], explain: 'The consent grants.' },
  },
  l2: {
    fields: [
      multi('perms', 'Permissions the app holds', 6, [['read', 'Read mail (Mail.Read)'], ['send', 'Send as the user (Mail.Send)'], ['offline', 'Keep access without the user (offline_access)'], ['dir', 'Read and write the directory'], ['files', 'Read all files']], ['read', 'send', 'offline'], { hint: 'Read the permissions on the consent event.', explain: 'offline_access means refresh tokens: access survives the user signing out.', skills: ['kno.cloud-identity'] }),
      link(single('how', 'How the app got access', 6, [['consent', 'The user approved a consent prompt from a phishing link; no password was stolen'], ['password', 'The password was phished'], ['admin', 'An administrator granted it'], ['mfa', 'MFA fatigue']], 'consent', { hint: 'Follow the user from the email to the proxy log.', explain: 'The proxy shows the authorize URL with the app\'s client_id right before the consent.', skills: ['kno.phishing'] }), 'lure'),
      link(accounts('users', 'Users who consented', 8, [U1.sam, U2.sam], { hint: 'Search consent events for the app id.', explain: 'Two users. The second was phished from the first user\'s mailbox.', skills: ['inv.scope'] }), 'consent'),
      link(single('spread', 'How the second user received the link', 6, [['internal', 'From the first user\'s mailbox, sent by the app'], ['external', 'The same external email'], ['teams', 'A Teams message'], ['unknown', 'Unknown']], 'internal', { hint: 'Search mail audit for Send operations by the app.', explain: 'Mail.Send used to phish a colleague with a trusted sender.', skills: ['log.cloud'] }), 'internal_send'),
      single('reset', 'Why a password reset alone does not fix it', 4, [['tokens', 'The app holds its own tokens; the consent must be revoked'], ['mfa', 'MFA is off'], ['works', 'A reset does fix it'], ['cached', 'Passwords are cached']], 'tokens', { explain: 'Consent grants are independent of the password.', skills: ['kno.cloud-identity'] }),
      single('decoy', `The consent to ${GOOD}`, 4, [['benign', 'Benign: verified publisher, sign-in profile only'], ['malicious', 'A second malicious app'], ['unknown', 'Unknown']], 'benign', { explain: 'User.Read from a verified publisher.', skills: ['tri.false-positive'] }),
    ],
  },
  response: {
    scope: { accounts: [U1.sam, U2.sam], ips: [ATK], senders: [SENDER, LURE], domains: [LURE], revoke_consent: [APP, APPID], block_app: [APP, APPID] },
    textTargets: { revoke_consent: [APP, APPID, GOOD, GOODID], block_app: [APP, APPID, GOOD, GOODID] },
    collateralReasons: { revoke_consent: { [GOOD.toLowerCase()]: `${GOOD} is a legitimate verified app.`, [GOODID]: `${GOOD} is a legitimate verified app.` }, block_app: { [GOOD.toLowerCase()]: `${GOOD} is a legitimate verified app.`, [GOODID]: `${GOOD} is a legitimate verified app.` } },
    contained: (st) => (st.did('revoke_consent', APP) || st.did('revoke_consent', APPID)),
    objectives: [
      { id: 'revoke', label: 'Revoke the app\'s consent', points: 3, containment: true, eval: (st) => (st.did('revoke_consent', APP) || st.did('revoke_consent', APPID) ? 1 : 0), explain: 'Removes the tokens\' permissions for every user.' },
      { id: 'block', label: 'Block the app tenant-wide', points: 2, containment: true, eval: (st) => (st.did('block_app', APP) || st.did('block_app', APPID) ? 1 : 0), explain: 'Stops anyone else consenting.' },
      { id: 'sessions', label: 'Revoke both users\' sessions', points: 2, containment: true, eval: (st) => [U1.sam, U2.sam].filter((u) => st.revoked.has(u)).length / 2, explain: 'Kills refresh tokens already issued.' },
      { id: 'reset', label: 'Reset both users\' passwords', points: 1, eval: (st) => [U1.sam, U2.sam].filter((u) => st.reset.has(u)).length / 2, explain: 'Precaution: the lure may have asked for credentials too.' },
      { id: 'review', label: 'Establish what the app read', points: 2, skills: ['inv.search'], eval: (st, ctx) => (searched('MailItemsAccessed')(ctx.case) || searched(APPID)(ctx.case) ? 1 : 0), explain: 'Needed to tell the data owner what was exposed.' },
      { id: 'sender', label: 'Block the lure sender', points: 1, eval: (st) => (st.blockedSenders.has(SENDER) || st.blockedSenders.has(LURE) ? 1 : 0), explain: 'Stops new lures.' },
    ],
  },
  closure: {
    disposition: { options: [['consent', 'True positive: OAuth consent phishing, two mailboxes read'], ['fp', 'False positive: a legitimate app'], ['password', 'Password phishing'], ['policy', 'Policy violation']], accept: 'consent', explain: 'Token abuse, not password theft.' },
    rootCause: { options: [['user_consent', 'Users may consent to unverified apps'], ['mfa', 'MFA not enforced'], ['spf', 'SPF misconfigured'], ['malware', 'Malware']], accept: 'user_consent', explain: 'Tenant setting allows user consent to any app.' },
    actions: { options: [['admin_consent', 'Require admin approval for apps from unverified publishers'], ['review', 'Review all app consents in the tenant'], ['disable_m365', 'Disable mail for the two users for a week'], ['block_graph', 'Block Microsoft Graph']], set: ['admin_consent', 'review'], explain: 'Fix the setting; do not break mail.', skills: ['doc.root-cause'] },
  },
  truth: { summary: `${U1.name} clicked a "Delivery schedule" link from ${SENDER} and approved a consent prompt for "${APP}" (unverified) with Mail.Read, Mail.Send and offline_access. The app read her mail from ${ATK} and sent ${U2.name} the same link from her mailbox; he consented minutes ago and the app is reading his mail. No password was used. The ${GOOD} consent is unrelated.`, timeline: [[-104 * 60, 'Lure delivered.'], [-100 * 60, 'First consent.'], [-95 * 60, 'App starts reading mail.'], [-70 * 60, 'Internal phish sent by the app.'], [-6 * 60, 'Second consent.']], iocs: [{ type: 'app', value: APPID, note: APP }, { type: 'domain', value: LURE, note: 'Lure' }] },
  test: { tools: { l1_triage: [['user', U1.sam], ['user', U2.sam], ['reputation', LURE]] }, searches: ['MailItemsAccessed'], response: [['revoke_consent', APP], ['block_app', APP], ['revoke_sessions', U1.sam], ['revoke_sessions', U2.sam], ['reset_credentials', U1.sam], ['reset_credentials', U2.sam], ['block_sender', SENDER]] },
});
