import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Threat Intelligence & Hunting: adversary behaviour, hypotheses and the telemetry to test them.
 * The diagram is the environment plus its telemetry coverage; the learner reasons about which
 * hypothesis the evidence supports and where to hunt next, not about running an attack.
 */
export const THREAT_INTELLIGENCE: ReasoningDomain = {
  key: 'threat_intelligence',
  title: 'Threat Intelligence & Hunting',
  description: 'Read an environment, its telemetry coverage and an intelligence lead, decide the hypothesis the evidence supports and where to hunt next, and defend the decision with the data available.',
  track: 'Threat Intelligence',
  difficulty: 'intermediate',
  framing: 'an environment with its telemetry coverage and an active hunt',
  focus: [
    'Turning an intelligence lead into a testable hypothesis',
    'Mapping expected adversary behaviour to the telemetry that would show it',
    'Distinguishing an indicator match from a behaviour match',
    'Where coverage gaps make absence of evidence uninformative',
  ],
  skillIds: ['soc.threat_intel', 'soc.threat_detection', 'soc.siem_querying', 'soc.endpoint_forensics', 'sec.fundamentals'],
  weights: { correctness: 30, reasoning: 45, architecture: 15, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1595', 'Active Scanning'),
    T('T1590', 'Gather Victim Network Information'),
    T('T1071.001', 'Application Layer Protocol: Web Protocols'),
    T('T1071.004', 'Application Layer Protocol: DNS'),
    T('T1568', 'Dynamic Resolution'),
    T('T1572', 'Protocol Tunneling'),
    T('T1090', 'Proxy'),
    T('T1078', 'Valid Accounts'),
    T('T1053.005', 'Scheduled Task/Job: Scheduled Task'),
    T('T1547.001', 'Boot or Logon Autostart Execution: Registry Run Keys / Startup Folder'),
    T('T1059.001', 'Command and Scripting Interpreter: PowerShell'),
    T('T1218', 'System Binary Proxy Execution'),
    T('T1105', 'Ingress Tool Transfer'),
    T('T1570', 'Lateral Tool Transfer'),
    T('T1021', 'Remote Services'),
    T('T1486', 'Data Encrypted for Impact'),
    T('T1567', 'Exfiltration Over Web Service'),
    T('T1587', 'Develop Capabilities'),
    T('T1584', 'Compromise Infrastructure'),
    T('T1036', 'Masquerading'),
  ],
  variation: {
    topologies: [
      { id: 'enterprise_coverage', label: 'Enterprise with partial telemetry coverage', guide: 'EDR on most endpoints, a SIEM with AD, proxy and DNS logs, NetFlow at the perimeter only, cloud audit logs for one of three accounts, and a 30-day retention.' },
      { id: 'cloud_first', label: 'Cloud-first company', guide: 'Laptops with EDR, a cloud IdP with sign-in logs, control-plane audit logs, a threat-detection service, SaaS audit logs of varying depth, and no on-premises footprint.' },
      { id: 'ot_limited', label: 'Industrial site with limited OT visibility', guide: 'An IT estate with EDR and SIEM, an OT network with a passive sensor only, a historian in the DMZ, and vendor remote access.' },
      { id: 'mssp_feeds', label: 'Company consuming MSSP and intel feeds', guide: 'An MSSP watching the SIEM, a commercial intel feed of indicators and reports, an ISAC membership, and internal EDR the MSSP cannot see.' },
      { id: 'saas_platform', label: 'SaaS provider hunting in production telemetry', guide: 'Application logs, a bastion with session recording, cloud audit logs, WAF logs, and customer-tenant activity logs.' },
      { id: 'financial_regulated', label: 'Financial firm with rich but siloed logs', guide: 'Separate logging for trading, corporate and customer systems, strong retention, strict change control, and a fraud-analytics platform.' },
      { id: 'university_federated', label: 'University with federated, departmental systems', guide: 'Central IdP, departmental servers with inconsistent logging, DNS and NetFlow centrally, open research networks, and a small hunt capability.' },
      { id: 'retail_estate', label: 'Retailer with stores and a central SOC', guide: 'Store networks with POS, central firewalls and AD logs, limited store-side telemetry, and a seasonal peak.' },
    ],
    entryPoints: [
      { id: 'intel_report_ttp', label: 'An intel report describes a group’s TTPs', guide: 'A report attributes recent activity in your sector to a group with known behaviours; the lead is behavioural, not a single indicator.' },
      { id: 'ioc_list', label: 'A feed delivers a list of indicators', guide: 'Domains, hashes and IPs arrive; some are stale, some shared infrastructure; a naive match risks false positives.' },
      { id: 'isac_advisory', label: 'An ISAC advisory warns of a campaign', guide: 'A sector advisory names initial-access behaviours and a time window; the question is whether your environment shows them.' },
      { id: 'anomaly_lead', label: 'An internal anomaly suggests a hypothesis', guide: 'An unusual parent-child process, a rare scheduled task, or a new autorun appeared on a few hosts; it may be benign or an early stage.' },
      { id: 'dns_beacon_lead', label: 'A periodic outbound pattern hints at C2', guide: 'Regular DNS or HTTPS callouts to a young domain on a fixed interval suggest beaconing; coverage of the channel is the issue.' },
      { id: 'cred_abuse_lead', label: 'A valid-account abuse hypothesis', guide: 'A report describes living-off-the-land via valid accounts; the hunt is for anomalous but authenticated behaviour, which EDR alone may not flag.' },
      { id: 'supply_chain_lead', label: 'A supply-chain advisory for a deployed product', guide: 'A trusted product you run received a tampered update per an advisory; the hunt is for its post-update behaviour.' },
      { id: 'persistence_lead', label: 'A persistence-technique hypothesis', guide: 'A known group favours a specific persistence mechanism; the hunt is for its artefacts across the estate where telemetry exists.' },
      { id: 'exfil_pattern_lead', label: 'An exfiltration-pattern hypothesis', guide: 'A report describes staging then upload to a cloud service; the hunt is for the staging and egress signature where logs exist.' },
      { id: 'masquerade_lead', label: 'A masquerading-binary hypothesis', guide: 'A legitimate-looking binary name run from an unusual path is the lead; the hunt turns on path and signer telemetry.' },
    ],
    objectives: [
      { id: 'hypothesis', label: 'The hypothesis the evidence best supports', guide: 'Ask which hypothesis the current evidence supports, given coverage; distractors are hypotheses that ignore a coverage gap or over-read an indicator match as a behaviour match.', question: 'Which hypothesis does the current evidence best support?', weights: { correctness: 30, reasoning: 50, architecture: 10, risk: 10 } },
      { id: 'where_to_hunt', label: 'Where to hunt next for the strongest test', guide: 'Ask which data source or query would most sharply confirm or refute the hypothesis; distractors point at a source that cannot see the behaviour or that only matches an indicator, not the behaviour.', question: 'Which hunt would most sharply confirm or refute the hypothesis?', weights: { correctness: 30, reasoning: 45, architecture: 15, risk: 10 } },
      { id: 'indicator_vs_behaviour', label: 'Indicator match versus behaviour match', guide: 'Ask whether a match is a meaningful behaviour match or a weak/indicator-only match given shared infrastructure or staleness; distractors treat a coincidental or shared indicator as confirmation.', question: 'Does this match meaningfully support the hypothesis, or is it an indicator-only coincidence?', weights: { correctness: 30, reasoning: 45, architecture: 10, risk: 15 } },
      { id: 'coverage_gap', label: 'The coverage gap that makes absence uninformative', guide: 'Ask where a lack of hits proves nothing because the telemetry cannot see that behaviour; distractors name a source that does cover it or treat a gap as a clean result.', question: 'Where does absence of evidence prove nothing because of a coverage gap?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'scope_estimate', label: 'What a confirmed hit implies about scope', guide: 'Ask how far the activity likely reaches if the hunt confirms it, given the environment and trust paths; distractors over- or under-scope by ignoring a segment or shared account.', question: 'If the hunt confirms the hypothesis, what is the likely scope?', weights: { correctness: 30, reasoning: 35, architecture: 25, risk: 10 } },
      { id: 'detection_from_hunt', label: 'The durable detection the hunt should leave behind', guide: 'Ask which detection, written from this hunt, would catch the behaviour next time with few false positives; distractors are brittle indicator matches or rules the environment cannot feed.', question: 'Which durable detection should this hunt produce?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'priority_order', label: 'The right order of two hunt steps under a constraint', guide: 'Ask which of two steps comes first given the constraint (for example validate the indicator’s freshness before estate-wide search, or preserve a sample before pivoting); distractors invert the order.', question: 'Given the constraint, which step must come first?', weights: { correctness: 30, reasoning: 40, architecture: 10, risk: 20 } },
    ],
    constraints: [
      { id: 'retention_short', label: 'Verbose telemetry is retained only 30 days', guide: 'Evidence older than the window may be gone; frame the hunt within it.' },
      { id: 'noisy_feed', label: 'The intel feed has a high false-positive rate', guide: 'Weigh indicator matches against the cost of chasing noise.' },
      { id: 'no_ot_telemetry', label: 'The OT network has only a passive sensor', guide: 'Absence there is uninformative; say so.' },
      { id: 'mssp_blind', label: 'The MSSP cannot query EDR', guide: 'Who can run the hunt affects what is feasible.' },
      { id: 'analyst_hours', label: 'The hunt has one analyst-day budgeted', guide: 'Pick the test with the most discriminating power per hour.' },
      { id: 'legal_sensitivity', label: 'A possible insider makes the hunt legally sensitive', guide: 'Preserve, document, and avoid tipping off.' },
      { id: 'peak_season', label: 'A seasonal peak raises baseline noise', guide: 'Baselines shift; account for it before calling an anomaly.' },
    ],
    components: [
      'EDR agent', 'SIEM', 'DNS log', 'proxy log', 'NetFlow collector', 'cloud control-plane audit log', 'SaaS audit log', 'authentication log', 'threat-intel feed', 'ISAC advisory', 'indicator list', 'detection rule', 'retention window', 'WAF log', 'bastion session recording', 'OT passive sensor', 'historian', 'POS telemetry', 'process-event telemetry', 'scheduled-task inventory', 'autorun inventory', 'binary signer data', 'file-path telemetry', 'egress proxy', 'hunt notebook', 'baseline dataset', 'MSSP console', 'fraud-analytics platform', 'asset inventory', 'identity provider', 'domain controller', 'threat-detection service',
    ],
  },
  guidance: `Threat Intelligence & Hunting realism rules:
- The learner is a hunter reasoning over telemetry and intelligence, not an attacker. Describe the lead, the environment’s coverage, and what the data shows or cannot show; never write operational attacker tradecraft.
- Use concrete names (for example "proxy log", "EDR process events on the workstation fleet", "feed 'actor-X domains'", "CA sign-in log") and realistic retention and volumes. Never invent product features that do not exist; describe a technique by behaviour, and only cite a real ATT&CK id.
- The "attack path" here is the hypothesised behaviour chain: each diagram attack edge is a step the adversary would take, flagged against whether the environment’s telemetry could see it. Coverage gaps are first-class — mark controls/telemetry that are present and those that are absent.
- Be exact about the difference between an indicator match (a domain, hash or IP, which may be stale or shared) and a behaviour match (a technique observed in context), and about when absence of evidence is uninformative because nothing watches that behaviour.
- Trust boundaries are real boundaries and so are telemetry boundaries: endpoint-with-agent vs without, perimeter-flow vs east-west, cloud account with audit vs without, OT passive-only.
- The best answer must be the one an experienced hunter would choose for this exact coverage and lead; distractors must be reasonable-sounding hunts that look at the wrong source, over-read an indicator, or ignore a coverage gap.
- Cite techniques from the ATT&CK Enterprise matrix only.`,
};
