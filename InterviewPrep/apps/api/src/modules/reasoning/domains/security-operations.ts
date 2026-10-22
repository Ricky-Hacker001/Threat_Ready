import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Security Operations: alerts, triage and the evidence that turns a signal into an incident. The
 * diagram shows the environment plus the telemetry pipeline (sensors, SIEM, EDR, rules), so the
 * learner reasons about what fired, what did not, and what to do with the signal. Entry points are
 * written as what the analyst observes, not as attacker procedure.
 */
export const SECURITY_OPERATIONS: ReasoningDomain = {
  key: 'security_operations',
  title: 'Security Operations',
  description: 'Read an environment and its detection pipeline during an active intrusion, decide what the alerts actually prove and what to do next, and defend the decision with evidence from the telemetry shown.',
  track: 'Security Operations',
  difficulty: 'intermediate',
  focus: [
    'Telling a true positive from a benign match using the surrounding telemetry',
    'What each sensor, log source and rule can and cannot see',
    'Escalation and scoping decisions under time and ticket pressure',
    'Detection gaps the intrusion crossed and how to close them',
  ],
  skillIds: ['soc.alert_triage', 'soc.siem_querying', 'soc.threat_detection', 'soc.incident_response', 'soc.authentication_attacks', 'soc.endpoint_forensics'],
  weights: { correctness: 30, reasoning: 45, architecture: 15, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1566', 'Phishing'),
    T('T1204.002', 'User Execution: Malicious File'),
    T('T1059.001', 'Command and Scripting Interpreter: PowerShell'),
    T('T1053.005', 'Scheduled Task/Job: Scheduled Task'),
    T('T1078', 'Valid Accounts'),
    T('T1110.003', 'Brute Force: Password Spraying'),
    T('T1021.001', 'Remote Services: Remote Desktop Protocol'),
    T('T1003', 'OS Credential Dumping'),
    T('T1486', 'Data Encrypted for Impact'),
    T('T1562.001', 'Impair Defenses: Disable or Modify Tools'),
    T('T1070', 'Indicator Removal'),
    T('T1071.001', 'Application Layer Protocol: Web Protocols'),
    T('T1041', 'Exfiltration Over C2 Channel'),
    T('T1105', 'Ingress Tool Transfer'),
    T('T1087', 'Account Discovery'),
    T('T1098', 'Account Manipulation'),
    T('T1055', 'Process Injection'),
    T('T1567.002', 'Exfiltration Over Web Service: Exfiltration to Cloud Storage'),
    T('T1071.004', 'Application Layer Protocol: DNS'),
    T('T1489', 'Service Stop'),
  ],
  variation: {
    topologies: [
      { id: 'enterprise_siem_edr', label: 'Enterprise with SIEM, EDR and an email gateway', guide: 'Windows estate with EDR on servers and most workstations, a SIEM ingesting domain controller, firewall, proxy and email gateway logs, a vulnerability scanner, and a ticketing system with a 15-minute P1 SLA.' },
      { id: 'mssp_hybrid', label: 'Outsourced L1 at an MSSP with an internal L2/L3 team', guide: 'An MSSP watches the SIEM 24x7 and escalates by email, an internal team owns EDR and identity, with gaps in what the MSSP can see (no EDR console, no cloud logs).' },
      { id: 'cloud_native_soc', label: 'Cloud-native company with no on-premises estate', guide: 'Laptops with EDR and MDM, a cloud IdP, SaaS everywhere, cloud workloads with control-plane audit logs and a threat-detection service, a SIEM in the cloud, and ChatOps alert routing.' },
      { id: 'retail_pos', label: 'Retailer with stores, point-of-sale and a head office', guide: 'Store networks with POS terminals, a central payment switch, head-office workstations, a SIEM that receives firewall and AD logs but not POS logs, and a seasonal peak.' },
      { id: 'university_open', label: 'University with an open network and federated identity', guide: 'Student and staff networks, research servers managed by departments, a central IdP, limited EDR coverage, DNS and NetFlow collection, and a small security team.' },
      { id: 'manufacturer_it_ot', label: 'Manufacturer with IT and OT visibility gaps', guide: 'IT estate with EDR and SIEM, an OT network with a passive monitoring sensor only, a vendor remote-access gateway, and a historian in the DMZ.' },
      { id: 'saas_provider', label: 'SaaS provider with production and corporate environments', guide: 'Corporate laptops and SSO, a production platform with application logs, a bastion with session recording, a bug bounty programme, and customer-facing status obligations.' },
      { id: 'healthcare_network', label: 'Hospital network with clinical systems', guide: 'EHR servers, clinical workstations shared across shifts, medical devices without agents, a SIEM with AD and VPN logs, a NAC, and strict uptime needs.' },
    ],
    entryPoints: [
      { id: 'phish_alert', label: 'An email-gateway and EDR pair of alerts on one workstation', guide: 'The analyst sees a delivered attachment flagged after the fact and, minutes later, an EDR alert that a document process started a scripting host; outbound traffic went to a newly seen domain. The question is what this proves and what to do.' },
      { id: 'edr_cred_access', label: 'An EDR credential-access alert on a server', guide: 'EDR reports access to credential memory on a file server; the process tree traces back to a remote admin tool run under a service account. The analyst must decide true positive versus admin activity.' },
      { id: 'impossible_travel', label: 'An impossible-travel sign-in alert on a cloud account', guide: 'Two successful sign-ins forty minutes apart from different continents, one residential, one a VPN exit. The analyst weighs this against a VPN or a travelling user.' },
      { id: 'spray_then_logon', label: 'A spike of failed logons followed by one success', guide: 'Hundreds of failed authentications across many accounts from one source, then a single success and an interactive session on a jump host.' },
      { id: 'dns_pattern', label: 'A periodic DNS pattern to a new domain with no proxy record', guide: 'A workstation resolves a long subdomain on a fixed interval; the proxy log shows nothing, which itself is the clue about the channel.' },
      { id: 'tamper_alert', label: 'Endpoint protection stopped on several hosts in a short window', guide: 'A tamper alert shows the agent stopped on three hosts by an administrative account; the SIEM received the alerts out of order and late.' },
      { id: 'priv_group_change', label: 'A directory alert for a new account in a privileged group', guide: 'A new account was created and added to a privileged group at 02:00 by a service account that should never perform that change.' },
      { id: 'mass_file_change', label: 'A surge of file renames on a file server', guide: 'File-server telemetry shows thousands of files renamed with one extension in minutes; backups and shadow copies are the next concern.' },
      { id: 'egress_to_storage', label: 'A large outbound transfer to a consumer cloud-storage domain', guide: 'Proxy logs show gigabytes uploaded to a personal cloud-storage service from a workstation that normally sends little.' },
      { id: 'benign_lookalike', label: 'An alert that closely resembles a true positive but is benign', guide: 'A scanner, a patch run, a backup agent or an admin script produced telemetry that matches a detection rule; the analyst must avoid both a false escalation and a missed real one.' },
    ],
    objectives: [
      { id: 'true_or_false_positive', label: 'Whether the alert is a true positive and why', guide: 'Ask whether the alert is a true positive given the surrounding telemetry, and the reason; distractors are verdicts that ignore a corroborating or exculpating signal on the diagram.', question: 'Is this alert a true positive, and what in the telemetry decides it?', weights: { correctness: 30, reasoning: 50, architecture: 10, risk: 10 } },
      { id: 'next_evidence', label: 'The single most useful next piece of evidence', guide: 'Ask which one query, log source or artefact would confirm or refute the hypothesis fastest; distractors are sources that exist but would not disambiguate, or that are not available in this environment.', question: 'Which single piece of evidence would most quickly confirm or rule out a real intrusion?', weights: { correctness: 30, reasoning: 45, architecture: 15, risk: 10 } },
      { id: 'escalate_or_not', label: 'Whether and how to escalate now', guide: 'Ask whether to escalate to the next tier or declare an incident given the SLA and what is proven; distractors escalate on too little, sit on too much, or route to the wrong owner.', question: 'Given what is proven and the SLA, what is the right escalation decision now?', weights: { correctness: 30, reasoning: 40, architecture: 10, risk: 20 } },
      { id: 'scope_now', label: 'What the signal implies about scope', guide: 'Ask how many hosts, accounts or systems are likely in scope given the telemetry and the environment; distractors over- or under-scope by ignoring a shared account, an unmonitored segment or a sensor gap.', question: 'What does the telemetry imply about the likely scope?', weights: { correctness: 30, reasoning: 35, architecture: 25, risk: 10 } },
      { id: 'detection_gap', label: 'The detection gap the intrusion crossed', guide: 'Ask which sensor, log source or rule should have fired and did not, given what is on the diagram; distractors name a source that did fire or one that could not have seen this step.', question: 'Which detection gap let this step go unseen?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'contain_now', label: 'The first containment action to request', guide: 'Ask for the first containment action the SOC should request that stops harm without destroying the evidence still being collected or breaking critical operations; distractors are premature, too broad, or evidence-destroying.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'priority_order', label: 'The right order of two triage steps under pressure', guide: 'Ask which of two necessary steps comes first given the constraint (for example preserve volatile evidence before isolating, or confirm scope before paging the business); distractors invert the order.', question: 'Given the constraint, which step must come first?', weights: { correctness: 30, reasoning: 40, architecture: 10, risk: 20 } },
    ],
    constraints: [
      { id: 'p1_sla', label: 'A 15-minute P1 acknowledgement SLA is in force', guide: 'The decision must fit the clock; perfect certainty is not available.' },
      { id: 'mssp_blind', label: 'The MSSP cannot see the EDR console or cloud logs', guide: 'Choices must account for who can actually run the query.' },
      { id: 'peak_season', label: 'It is peak trading season and false escalations are costly', guide: 'Weigh the cost of a false positive against a missed true one.' },
      { id: 'no_ot_agents', label: 'OT and medical devices have no endpoint agent', guide: 'Rely on network and identity telemetry for those.' },
      { id: 'log_retention', label: 'Verbose logs are kept only seven days', guide: 'Evidence older than a week may be gone; act on what remains.' },
      { id: 'one_analyst', label: 'A single analyst is on the night shift', guide: 'Prefer steps one person can do before handover.' },
      { id: 'customer_status', label: 'Customers must be told within an SLA if data is affected', guide: 'Scoping confidence drives an external clock.' },
    ],
    components: [
      'email gateway', 'EDR agent', 'EDR console', 'SIEM', 'detection rule', 'correlation alert', 'domain controller log', 'authentication log', 'cloud control-plane audit log', 'proxy log', 'DNS log', 'firewall log', 'NetFlow collector', 'file-server audit', 'vulnerability scanner', 'threat-intel feed', 'ticketing system', 'SOAR playbook', 'ChatOps channel', 'jump host', 'bastion session recording', 'NAC', 'MDM', 'identity protection alerts', 'cloud threat-detection service', 'backup system', 'POS terminal', 'OT monitoring sensor', 'historian', 'workstation', 'file server', 'service account', 'privileged group',
    ],
  },
  guidance: `Security Operations realism rules:
- The learner is an analyst reading telemetry, not an attacker. Describe what fired, what the surrounding logs show, and what is absent; never write operational attacker tradecraft.
- Use concrete names (for example "rule SOC-114 PowerShell download cradle", "EDR alert on fileserver-03", "proxy log", "CA sign-in log") and realistic timestamps and counts. Never invent product features that do not exist.
- The "attack path" is the chain of observable steps across the telemetry: each diagram attack edge is a step the environment did or did not record. If a sensor on the diagram should have seen a step, either it did (and the alert exists) or the narrative explains the gap (no agent, log not forwarded, rule scoped out, retention expired).
- Be exact about what each source can see: EDR sees process and memory events on covered hosts only; a SIEM sees what is forwarded; DNS logs see names not payloads; perimeter flow does not see east-west; an MSSP sees only its consoles.
- A benign look-alike (scanner, patching, backup, admin script) must be a live possibility the evidence resolves, so true-positive questions are real judgements.
- Trust boundaries are real boundaries: endpoint, identity, network perimeter, cloud control plane, OT, third-party/MSSP.
- The best answer must be the one an experienced SOC analyst would choose for this exact telemetry and constraint; distractors must be defensible triage moves that are premature, look at the wrong source, over- or under-scope, or break the SLA.
- Cite techniques from the ATT&CK Enterprise matrix only.`,
};
