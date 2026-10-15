// The three existing modules, re-tagged for the level system
// (Build specification, section 6.1): s02-authfail is F3, s01-beacon is E1,
// and demo-portal also runs as I1 in normal mode. Their stories, logs and
// answer keys are unchanged. Newbie Demo Mode keeps using demo-portal as is.

import s01 from './s01-beacon.js';
import s02 from './s02-authfail.js';
import demo from './demo-portal.js';

const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

export const F3 = {
  ...s02,
  id: 'F3', code: 'F3', level: 'foundations', version: 2, keyVersion: 1,
  catalog: { ...s02.catalog, minutes: '10-15', tiers: 'L1', sourceGroups: ['windows', 'firewall', 'proxy', 'dns'] },
  skills: ['tri.verdict', 'tri.false-positive', 'inv.pivot', 'log.windows-auth'],
  fieldSkills: {
    checks: ['inv.pivot'], source: ['inv.pivot', 'log.windows-auth'], verdict: ['tri.verdict'], category: ['log.windows-auth', 'tri.false-positive'],
    change: ['tri.false-positive'], severity: ['tri.severity'], evidence: ['doc.evidence'], decision: ['tri.escalation'], note: ['doc.evidence'],
    assessment: ['tri.false-positive'], route: ['tri.escalation'], code: ['tri.verdict'], tuning: ['doc.root-cause'], summary: ['doc.root-cause'],
  },
  meta: { verdictField: 'verdict', severityField: 'severity', routeField: 'decision', benign: true },
  entities: { ids: ['CHG-4471'], domains: ['plugins.vulnscan-cloud.example'], ips: ['192.0.2.160'] },
  jitter: { timing: 0.2 },
  scaleTiming: true,
};

const { IOC } = s01._test;
export const E1 = {
  ...s01,
  id: 'E1', code: 'E1', level: 'expert', version: 2, keyVersion: 1,
  catalog: { ...s01.catalog, minutes: '45-90', sourceGroups: ['proxy', 'dns', 'email', 'endpoint', 'windows', 'firewall'] },
  skills: ['inv.timeline', 'inv.scope', 'kno.attack-mapping', 'res.containment', 'res.proportionality'],
  fieldSkills: {
    verdict: ['tri.verdict'], severity: ['tri.severity'], category: ['kno.attack-mapping'], evidence: ['doc.evidence'], decision: ['tri.escalation'], note: ['doc.evidence'],
    host: ['inv.pivot'], user: ['inv.pivot'], iocs: ['inv.ioc'], priority: ['tri.severity'], containment: ['res.containment'], summary: ['doc.evidence'],
    vector: ['kno.phishing'], patient_zero: ['inv.timeline'], attach_hash: ['inv.ioc'], parent: ['log.endpoint'], stage2: ['inv.ioc', 'log.network'], c2_domain: ['inv.ioc'], c2_ip: ['inv.ioc'],
    persistence: ['kno.malware'], cred_access: ['kno.attack-mapping'], lateral: ['kno.attack-mapping'], data: ['inv.scope'],
    checks: ['inv.search'], hosts: ['inv.scope'], accounts: ['inv.scope'], recipients: ['inv.scope'], earliest: ['inv.timeline'], sequence: ['inv.timeline'], attack: ['kno.attack-mapping'],
    declare: ['tri.escalation'], disposition: ['tri.verdict'], root_cause: ['doc.root-cause'], impact: ['inv.scope'], lessons: ['doc.root-cause'],
  },
  meta: { verdictField: 'verdict', severityField: 'severity', routeField: 'decision', benign: false },
  entities: {
    domains: [IOC.senderDomain, IOC.stage2Host, IOC.c2Host],
    ips: [IOC.senderIp, IOC.stage2Ip, IOC.c2Ip],
    ids: ['INV-88213'],
  },
  jitter: { timing: 0.15 },
  secret: {
    ...s01.secret,
    response: {
      ...s01.secret.response,
      objectives: s01.secret.response.objectives.map((o) => ({ ...o, containment: ['contain_ws', 'contain_fs', 'block', 'creds'].includes(o.id), skills: o.id === 'notify' ? ['res.proportionality'] : o.id === 'evidence' ? ['doc.evidence'] : ['eradicate', 'recover'].includes(o.id) ? ['res.recovery'] : ['res.containment'] })),
    },
  },
};

// I1: the guided-demo story in normal mode. Coaching, reveals, unlimited
// retries and the demo's response guard are removed.
const normalStage = (s) => ({
  ...omit(s, ['noFinalize', 'attempts']),
  ...(s.intro ? { intro: s.intro.replace(/\s*[^.]*\bdemo\b[^.]*\./gi, '').trim() } : {}),
  ...(s.fields ? { fields: s.fields.map((f) => ({ ...f, ...(f.key ? { key: omit(f.key, ['coach', 'reveal']) } : {}) })) } : {}),
});
export const I1 = {
  ...omit(demo, ['guard', 'facts']),
  id: 'I1', code: 'I1', level: 'intermediate', version: 2, keyVersion: 1, hidden: false,
  stages: demo.stages.map(normalStage),
  catalog: {
    ...demo.catalog,
    title: 'Repeated failed logons then a success for one account',
    queue: 'authentication',
    blurb: 'An authentication rule reports a burst of failed logons against one account, then a success.',
    difficulty: 'Intermediate', minutes: '20-35', tiers: 'L1, L2, L3',
    sources: ['proxy', 'dns', 'email', 'edr', 'winsec', 'firewall', 'audit'],
    sourceGroups: ['windows', 'firewall'],
  },
  skills: ['log.windows-auth', 'inv.timeline', 'inv.scope', 'res.containment'],
  fieldSkills: {
    source: ['log.windows-auth', 'inv.pivot'], account: ['log.windows-auth'], verdict: ['tri.verdict'], severity: ['tri.severity'], evidence: ['doc.evidence'], decision: ['tri.escalation'], note: ['doc.evidence'],
    host: ['inv.pivot'], iocs: ['inv.ioc'], priority: ['tri.severity'], summary: ['doc.evidence'],
    pattern: ['kno.auth-protocols'], count: ['inv.search'], baseline: ['inv.pivot'], after: ['inv.timeline'], benign: ['tri.false-positive'],
    checks: ['inv.search'], scope: ['inv.scope'], sequence: ['inv.timeline'],
  },
  meta: { verdictField: 'verdict', severityField: 'severity', routeField: 'decision', benign: false },
  entities: { ips: [demo.facts.ATK], names: [demo.facts.ATK_NAME] },
  jitter: {},
  secret: {
    ...demo.secret,
    response: { ...demo.secret.response, objectives: demo.secret.response.objectives.map((o) => ({ ...o, containment: ['block', 'creds'].includes(o.id), skills: o.id === 'notify' ? ['res.proportionality'] : ['res.containment'] })) },
  },
};
