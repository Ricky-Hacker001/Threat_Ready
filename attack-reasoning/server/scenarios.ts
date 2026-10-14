// Attack Reasoning scenarios (ar.threatready.io). Content follows threatready.io/attack-reasoning-lab.html:
// one architecture with an active attack chain, five adaptive questions, four levels, scored on the
// five published rubric dimensions. The scenario engine is not built yet (roadmap V1.0), so every
// scenario is listed as coming soon; this file is the catalog the list and detail pages render.

export type Level = 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
export interface Technique { id: string; name: string }
export interface Scenario {
  id: string;
  title: string;
  track: string;
  summary: string;
  /** What the learner is shown first: the environment and what just happened */
  brief: string;
  architecture: string[];
  techniques: Technique[];
  categories: string[];
  levels: Level[];
  release: string;
  available: boolean;
}

export const LEVELS: { level: Level; minutes: string; hints: string }[] = [
  { level: 'Beginner', minutes: '5–8 min', hints: 'Full' },
  { level: 'Intermediate', minutes: '10–14 min', hints: 'Reduced' },
  { level: 'Advanced', minutes: '12–18 min', hints: 'Minimal' },
  { level: 'Expert', minutes: '15–20 min', hints: 'None' },
];

// Names as published in threatready.io/rubric.html
export const DIMENSIONS = [
  { code: 'TI', name: 'Threat Identification' },
  { code: 'CR', name: 'Containment & Response Logic' },
  { code: 'AB', name: 'Architecture & Blast Radius Analysis' },
  { code: 'CQ', name: 'Communication Quality' },
  { code: 'FA', name: 'Framework & Best Practice Application' },
];

const ALL: Level[] = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];
const T = (id: string, name: string): Technique => ({ id, name });

export const SCENARIOS: Scenario[] = [
  {
    id: 'AR-CLOUD-001', title: 'Leaked Keys, Open Bucket', track: 'Cloud Security',
    summary: 'A developer key from a public repo is being used against your AWS account, and customer exports are leaving a storage bucket.',
    brief: 'CloudTrail shows ListBuckets and GetObject calls from an unfamiliar address using a CI access key. The key appeared in a public commit two days ago.',
    architecture: ['Public web tier behind a load balancer', 'S3 buckets for exports and backups', 'CI pipeline with long-lived IAM user keys'],
    techniques: [T('T1552.001', 'Credentials in Files'), T('T1078', 'Valid Accounts'), T('T1530', 'Data from Cloud Storage')],
    categories: ['Threat ID', 'Containment', 'Remediation'], levels: ALL, release: 'V1.0', available: false,
  },
  {
    id: 'AR-IAM-001', title: 'Persistence by Design', track: 'Identity & Access',
    summary: 'An attacker with temporary admin adds their own credentials and elevates a service role before the session expires.',
    brief: 'A new access key appeared on a break-glass user at 02:14, followed by a policy change on the deployment role.',
    architecture: ['SSO with a break-glass IAM user', 'Deployment role assumed by CI', 'Organisation guardrails (SCPs)'],
    techniques: [T('T1098.001', 'Additional Cloud Credentials'), T('T1548', 'Abuse Elevation Control'), T('T1078', 'Valid Accounts')],
    categories: ['Detection', 'Architecture', 'Containment'], levels: ALL, release: 'V1.0', available: false,
  },
  {
    id: 'AR-SOC-001', title: 'The Invoice Attachment', track: 'Security Operations',
    summary: 'A finance user opens a macro document; minutes later an endpoint beacons out and a remote session appears on a file server.',
    brief: 'EDR flags an Office process spawning PowerShell on FIN-LT-042, then an RDP logon from that host to FS-01.',
    architecture: ['Windows endpoints with EDR', 'File server reachable over RDP from the user VLAN', 'Email gateway with attachment sandboxing'],
    techniques: [T('T1566.001', 'Spearphishing Attachment'), T('T1021', 'Remote Services'), T('T1562', 'Impair Defenses')],
    categories: ['Triage', 'Detection', 'Containment'], levels: ALL, release: 'V1.0', available: false,
  },
  {
    id: 'AR-APPSEC-001', title: 'Storefront Takeover', track: 'Application Security',
    summary: 'A vulnerable plugin on the public storefront becomes the way in, and the attacker reaches the payments database.',
    brief: 'WAF logs show repeated requests to an upload endpoint, then a new process on the web host making database connections.',
    architecture: ['Public e-commerce app', 'Database in a private subnet', 'Secrets in environment variables'],
    techniques: [T('T1190', 'Exploit Public-Facing Application'), T('T1552.001', 'Credentials in Files'), T('T1567', 'Exfiltration Over Web Service')],
    categories: ['Threat ID', 'Architecture', 'Forensics'], levels: ALL, release: 'V1.0', available: false,
  },
  {
    id: 'AR-SAAS-001', title: 'Consent Granted', track: 'SaaS & Identity',
    summary: 'A user consents to a look-alike app; its token reads mail and files across the tenant without a password.',
    brief: 'An OAuth app named "Docs Viewer" received Mail.Read and Files.Read.All consent and is pulling data from an overseas address.',
    architecture: ['Cloud email and file sharing tenant', 'User consent to third-party apps allowed', 'Conditional access on sign-in only'],
    techniques: [T('T1550.001', 'Application Access Token'), T('T1567', 'Exfiltration Over Web Service')],
    categories: ['Detection', 'Containment', 'Compliance'], levels: ALL, release: 'V1.0', available: false,
  },
  {
    id: 'AR-SUPPLY-001', title: 'Poisoned Dependency', track: 'DevSecOps',
    summary: 'A compromised package version runs in CI, steals the pipeline token and pushes to production.',
    brief: 'A minor-version bump of a build dependency added a post-install script; the next deploy came from an unexpected commit.',
    architecture: ['Monorepo with automated dependency updates', 'CI runners with deploy tokens', 'Container registry and Kubernetes cluster'],
    techniques: [T('T1195.002', 'Software Supply Chain'), T('T1552.001', 'Credentials in Files'), T('T1078', 'Valid Accounts')],
    categories: ['Threat ID', 'Remediation', 'Architecture'], levels: ALL, release: 'V1.0', available: false,
  },
  {
    id: 'AR-IR-001', title: 'Friday Night Encryption', track: 'Incident Response',
    summary: 'Backups are deleted, then file shares start encrypting. Decide what to isolate, what to preserve and what to tell the board.',
    brief: 'Shadow copies were removed on three servers at 21:40; at 22:05 users report files renamed with a new extension.',
    architecture: ['Domain-joined file servers', 'Backup server on the same domain', 'Leadership expecting a briefing within the hour'],
    techniques: [T('T1486', 'Data Encrypted for Impact'), T('T1562', 'Impair Defenses'), T('T1021', 'Remote Services')],
    categories: ['Containment', 'Forensics', 'Compliance'], levels: ALL, release: 'V1.0', available: false,
  },
  {
    id: 'AR-CLOUD-002', title: 'The Expensive Weekend', track: 'Cloud Security',
    summary: 'Compute spend spikes overnight: a stolen key is launching GPU instances for crypto mining in unused regions.',
    brief: 'Billing alerts fire on Saturday; dozens of large instances are running in three regions nobody deploys to.',
    architecture: ['Multi-region AWS account', 'Budget alerts but no region restrictions', 'Long-lived access keys for automation'],
    techniques: [T('T1496', 'Resource Hijacking'), T('T1078', 'Valid Accounts'), T('T1098.001', 'Additional Cloud Credentials')],
    categories: ['Triage', 'Containment', 'Remediation'], levels: ALL, release: 'V1.0', available: false,
  },
];

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);
