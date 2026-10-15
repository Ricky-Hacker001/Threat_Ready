// Level configuration (Build specification, section 5.1). The only place
// pass marks, rounds, decay, hint policy and unlock rules are defined.

export const LEVELS = [
  {
    id: 'foundations', name: 'Foundations', short: 'F', order: 1,
    oneLine: 'Read one alert, decide, close or escalate.',
    audience: 'Freshers, first SOC job, students',
    workflow: 'L1 only: triage, close or escalate',
    trains: 'Reading Windows, firewall, proxy, email and endpoint logs, using the lookup tools, and telling normal from abnormal.',
    passMark: 60, rounds: 3, decay: [1, 0.7, 0.4], hints: 'auto', minutes: '10-15',
    noise: 'Low; the relevant lines stand out', unlockAfter: null,
  },
  {
    id: 'intermediate', name: 'Intermediate', short: 'I', order: 2,
    oneLine: 'Correlate two to four sources and investigate at L2.',
    audience: '6-18 months in L1, moving to L2',
    workflow: 'L1 then L2: investigation, validation',
    trains: 'Joining sources into a short chain, deciding scope, and separating real attacks from look-alikes.',
    passMark: 70, rounds: 2, decay: [1, 0.7], hints: 'request', hintCap: 0.8, minutes: '20-35',
    noise: 'Normal office day', unlockAfter: 'foundations',
  },
  {
    id: 'expert', name: 'Expert', short: 'E', order: 3,
    oneLine: 'Full incident, from first alert to proven containment.',
    audience: 'L2 and L3 analysts, incident responders',
    workflow: 'L1, L2 and L3: full response and proof',
    trains: 'Multi-stage intrusions, evidence spread across many sources, response with business impact, and decoys that punish jumping to conclusions.',
    passMark: 75, rounds: 1, decay: [1], hints: 'off', minutes: '45-90',
    noise: 'Heavy, with decoys that look malicious', unlockAfter: 'intermediate',
  },
];

export const BADGE_AT = 10;
export const PER_LEVEL = 12;
export const levelById = (id) => LEVELS.find((l) => l.id === id);

// Skill map (section 7.3). Fixed ids, used by every scenario.
export const SKILL_GROUPS = [
  { id: 'log', name: 'Log reading', skills: [
    ['log.windows-auth', 'Windows authentication logs'], ['log.network', 'Network logs (firewall, proxy, DNS)'], ['log.endpoint', 'Endpoint telemetry'],
    ['log.email', 'Email logs'], ['log.cloud', 'Cloud logs (CloudTrail, GuardDuty, Entra ID, M365)'], ['log.web', 'Web server and WAF logs'],
  ] },
  { id: 'tri', name: 'Triage', skills: [
    ['tri.verdict', 'Verdict'], ['tri.severity', 'Severity'], ['tri.escalation', 'Escalation decisions'], ['tri.false-positive', 'Benign and false-positive handling'],
  ] },
  { id: 'inv', name: 'Investigation', skills: [
    ['inv.search', 'Query building'], ['inv.pivot', 'Pivoting between entities'], ['inv.timeline', 'Timeline reconstruction'], ['inv.scope', 'Scoping'], ['inv.ioc', 'Indicators of compromise'],
  ] },
  { id: 'kno', name: 'Threat knowledge', skills: [
    ['kno.attack-mapping', 'MITRE ATT&CK mapping'], ['kno.auth-protocols', 'Kerberos and NTLM'], ['kno.malware', 'Malware behaviour'], ['kno.phishing', 'Phishing'], ['kno.cloud-identity', 'Cloud identity'],
  ] },
  { id: 'res', name: 'Response', skills: [
    ['res.containment', 'Containment'], ['res.recovery', 'Recovery'], ['res.proportionality', 'Proportionate response'],
  ] },
  { id: 'doc', name: 'Documentation', skills: [
    ['doc.evidence', 'Evidence handling'], ['doc.root-cause', 'Root cause'],
  ] },
];
export const SKILLS = SKILL_GROUPS.flatMap((g) => g.skills.map(([id, label]) => ({ id, label, group: g.id, groupName: g.name })));
export const SKILL_IDS = new Set(SKILLS.map((s) => s.id));
export const skillLabel = (id) => SKILLS.find((s) => s.id === id)?.label || id;

export const SKILL_BANDS = [
  { min: 80, band: 'Strong' }, { min: 65, band: 'Competent' }, { min: 50, band: 'Developing' }, { min: -1, band: 'Gap' },
];
export const bandOf = (score) => SKILL_BANDS.find((b) => score >= b.min).band;
export const SKILL_MIN_QUESTIONS = 3;
export const SKILL_MIN_SCENARIOS = 2;
