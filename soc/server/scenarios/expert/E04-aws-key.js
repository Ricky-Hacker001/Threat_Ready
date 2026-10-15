// E4 · AWS access key used from an unknown address: the CI key was leaked
// in a public repository; the attacker listed buckets, read invoices and
// created a backdoor admin user.

import { E } from '../../engine/format.js';
import { AWS } from '../../engine/env.js';
import { defineScenario, ran, single, order, link, searched } from '../lib.js';

const KEY = 'AKIA4QX7LEAKED93KD2M';
const ATK = '198.51.100.244';
const BACKDOOR = 'support-sync';
const ARN = (u) => `arn:aws:iam::${AWS.account}:user/${u}`;

export default defineScenario({
  code: 'E4', level: 'expert',
  title: 'GuardDuty: API calls from a malicious IP using IAM user ci-deploy', rule: 'AWS-0401', severity: 'high', queue: 'cloud',
  blurb: 'GuardDuty reports API calls from a malicious address using a CI identity.',
  sources: ['aws', 'proxy', 'dns', 'winsec', 'firewall'], sourceGroups: ['cloud'],
  skills: ['log.cloud', 'kno.cloud-identity', 'inv.scope', 'res.containment'],
  entities: { ips: [ATK], names: [KEY, BACKDOOR] },
  alertTags: ['gd'],
  build(x) {
    for (let i = 0; i < 4; i++) x.add('ci_normal', E.cloudtrail(x.T(-28 * 60 + i * 30), { event_name: 'PutObject', event_source: 's3.amazonaws.com', user_arn: ARN('ci-deploy'), access_key: KEY, src_ip: AWS.ciRunner, ua: 'aws-cli/2.17.3', resource: `mf-web-assets/release/app.${i}.js` }));
    x.add('recon', E.cloudtrail(x.T(-20 * 60), { event_name: 'GetCallerIdentity', event_source: 'sts.amazonaws.com', user_arn: ARN('ci-deploy'), access_key: KEY, src_ip: ATK, ua: 'Boto3/1.34 Python/3.11' }));
    x.add('recon', E.cloudtrail(x.T(-20 * 60 + 8), { event_name: 'ListBuckets', event_source: 's3.amazonaws.com', user_arn: ARN('ci-deploy'), access_key: KEY, src_ip: ATK, ua: 'Boto3/1.34 Python/3.11' }));
    const n = x.n(300, 250);
    for (let i = 0; i < n; i++) x.add('s3_read', E.cloudtrail(x.T(-15 * 60 + i * 1.5), { event_name: 'GetObject', event_source: 's3.amazonaws.com', user_arn: ARN('ci-deploy'), access_key: KEY, src_ip: ATK, ua: 'Boto3/1.34 Python/3.11', resource: `mf-invoices-prod/2026/INV-${40000 + i}.pdf` }));
    x.add('persist', E.cloudtrail(x.T(-5 * 60), { event_name: 'CreateUser', event_source: 'iam.amazonaws.com', user_arn: ARN('ci-deploy'), access_key: KEY, src_ip: ATK, ua: 'Boto3/1.34 Python/3.11', request_params: `{"userName":"${BACKDOOR}"}` }));
    x.add('persist', E.cloudtrail(x.T(-5 * 60 + 4), { event_name: 'CreateAccessKey', event_source: 'iam.amazonaws.com', user_arn: ARN('ci-deploy'), access_key: KEY, src_ip: ATK, ua: 'Boto3/1.34 Python/3.11', request_params: `{"userName":"${BACKDOOR}"}` }));
    x.add('persist', E.cloudtrail(x.T(-5 * 60 + 8), { event_name: 'AttachUserPolicy', event_source: 'iam.amazonaws.com', user_arn: ARN('ci-deploy'), access_key: KEY, src_ip: ATK, ua: 'Boto3/1.34 Python/3.11', request_params: `{"userName":"${BACKDOOR}","policyArn":"arn:aws:iam::aws:policy/AdministratorAccess"}` }));
    x.add('gd', E.guardduty(x.T(-10), { finding_type: 'Discovery:S3/MaliciousIPCaller', severity: 8, resource: 'ci-deploy', access_key: KEY, src_ip: ATK, count: n }));
    x.add('gd', E.guardduty(x.T(-9), { finding_type: 'Persistence:IAMUser/AnomalousBehavior', severity: 8, resource: 'ci-deploy', access_key: KEY, src_ip: ATK, count: 3 }));
    x.add('decoy_console', E.cloudtrail(x.T(-24 * 60), { event_name: 'ConsoleLogin', event_source: 'signin.amazonaws.com', user_arn: ARN('cloud.admin'), src_ip: '203.0.113.10', ua: 'Mozilla/5.0 Edg/129.0', mfa_used: 'true' }));
  },
  alert: () => ({
    description: `GuardDuty: ci-deploy key ${KEY} used from ${ATK} to list and read S3 and to change IAM.`,
    entity: { host: 'aws', ip: ATK, user: 'ci-deploy' },
    details: [['Identity', 'IAM user ci-deploy'], ['Access key', KEY], ['Source address', ATK], ['Findings', 'Discovery:S3/MaliciousIPCaller; Persistence:IAMUser/AnomalousBehavior']],
    guidance: ['Compare this use of the key with its normal use.', 'Work out what was read and what was changed.'],
  }),
  intel: { [ATK]: { verdict: 'malicious', detections: '9/89', facts: [['Network', 'Hosting provider'], ['Reports', 'Scanning for exposed cloud keys']], notes: [] } },
  assetRecords: { 'ci-deploy': { facts: [['Type', 'IAM user (CI pipeline)'], ['Normal use', `Only from the CI runner ${AWS.ciRunner}, user agent aws-cli`], ['Permissions', 'S3 read/write, IAM user management (legacy, flagged in the last review)']], notes: [] } },
  triage: {
    checks: [{ id: 'ti', label: 'Source address checked in threat intelligence', test: ran('reputation', ATK) }],
    verdict: { accept: 'tp', explain: 'A CI key used from a hosting provider to read data and create users.' },
    severity: { accept: 'high', explain: 'Data read and an admin backdoor created.' },
    evidence: { tags: ['gd'], explain: 'The GuardDuty findings.' },
  },
  l2: {
    fields: [
      single('key_leak', 'What the key\'s use shows', 6, [['outside', 'The key is used outside the CI runner'], ['normal', 'Normal CI activity'], ['admin', 'The cloud admin working']], 'outside', { hint: 'Compare source IP and user agent with normal use.', explain: 'Normal use is aws-cli from the CI runner.', skills: ['log.cloud'] }),
      link(single('data', 'What was read', 8, [['invoices', 'Invoice objects downloaded from mf-invoices-prod'], ['assets', 'Web assets'], ['none', 'Nothing'], ['backups', 'Backups']], 'invoices', { hint: 'Search GetObject events from the address.', explain: 'Hundreds of invoice PDFs.', skills: ['inv.scope'] }), 's3_read'),
      link(single('persistence', 'Persistence', 8, [['user', 'A new IAM user with admin rights and a key'], ['role', 'A new role'], ['none', 'None'], ['lambda', 'A Lambda function']], 'user', { hint: 'Search IAM events.', explain: 'CreateUser, CreateAccessKey, AttachUserPolicy AdministratorAccess.', skills: ['kno.cloud-identity'] }), 'persist'),
      order('timeline', 'Order of events', 6, [['who', 'Identity check'], ['list', 'Bucket list'], ['get', 'Downloads'], ['user', 'New admin user']], ['who', 'list', 'get', 'user'], { skills: ['inv.timeline'] }),
    ],
  },
  response: {
    scope: { ips: [ATK], deactivate_key: [KEY.toLowerCase()], delete_cloud_user: [BACKDOOR] },
    textTargets: { deactivate_key: [KEY], delete_cloud_user: [BACKDOOR, 'ci-deploy', 'cloud.admin', 'svc-backup-s3'] },
    impacts: { delete_cloud_user: { 'ci-deploy': 'Deployments now fail: the CI pipeline has no identity.' } },
    contained: (st) => st.did('deactivate_key', KEY),
    objectives: [
      { id: 'key', label: 'Deactivate the leaked key', points: 4, containment: true, eval: (st) => (st.did('deactivate_key', KEY) ? 1 : 0), explain: 'The key is what the attacker holds.' },
      { id: 'backdoor', label: 'Delete the backdoor user and its key', points: 4, containment: true, eval: (st) => (st.did('delete_cloud_user', BACKDOOR) ? 1 : 0), explain: 'Otherwise the attacker keeps admin access.' },
      { id: 'review', label: 'Review the invoice bucket access logs', points: 2, skills: ['inv.search'], eval: (st, ctx) => ((ctx.case.searches || []).some((s) => s.q.toLowerCase().includes('mf-invoices-prod')) ? 1 : 0), explain: 'You need the list of objects read for the legal assessment.' },
    ],
  },
  closure: {
    disposition: { options: [['incident', 'True positive: cloud credential compromise with data access'], ['contained', 'Blocked attempt'], ['fp', 'False positive'], ['ci', 'Normal CI activity']], accept: 'incident', explain: 'Data read, persistence created.' },
    rootCause: { options: [['leak', 'The CI key was committed to a public code repository'], ['phish', 'The cloud admin was phished'], ['vuln', 'An S3 bucket was public'], ['insider', 'An insider']], accept: 'leak', explain: 'A long-lived key used from outside the runner.' },
    actions: { options: [['legal', 'Notify legal about invoice data exposure'], ['rotate', 'Rotate the CI secret'], ['repo', 'Remove the key from the repository and its history'], ['delete_bucket', 'Delete the mf-invoices-prod bucket']], set: ['legal', 'rotate', 'repo'], explain: 'Deleting the bucket destroys business data.', skills: ['res.recovery'] },
  },
  truth: { summary: `The access key ${KEY} of IAM user ci-deploy was committed to a public code repository. An attacker used it from ${ATK}, listed buckets, downloaded invoice files and created the backdoor IAM user ${BACKDOOR} with AdministratorAccess. The cloud admin's console login was normal.`, timeline: [[-28 * 60, 'Normal CI use.'], [-20 * 60, 'Identity check and bucket list from the attacker.'], [-15 * 60, 'Invoice downloads.'], [-5 * 60, 'Backdoor admin user created.']], iocs: [{ type: 'ip', value: ATK, note: 'Attacker' }] },
  test: { tools: { l1_triage: [['reputation', ATK]], l2_investigation: [] }, response: [['deactivate_key', KEY], ['delete_cloud_user', BACKDOOR]], searches: ['mf-invoices-prod'] },
});
