import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Incident Response & DFIR: containment, evidence preservation and recovery under time pressure.
 * The diagram shows the environment mid-incident; the learner decides the responder's next move
 * weighing containment, evidence, business impact and the risk of tipping off the intruder.
 */
export const INCIDENT_RESPONSE: ReasoningDomain = {
  key: 'incident_response',
  title: 'Incident Response & DFIR',
  description: 'Read an environment during a declared incident, decide the responder’s next move, and defend it with evidence, weighing containment against evidence preservation, recovery and business impact.',
  track: 'Incident Response',
  difficulty: 'intermediate',
  focus: [
    'Containment that holds without destroying volatile evidence or tipping off the intruder',
    'Order of operations: scope, preserve, contain, eradicate, recover',
    'Which artefacts answer the open question and in what order to collect them',
    'Recovery that does not restore the foothold',
  ],
  skillIds: ['soc.incident_response', 'soc.endpoint_forensics', 'cloudsec.incident_response', 'soc.threat_detection', 'sec.fundamentals'],
  weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1486', 'Data Encrypted for Impact'),
    T('T1490', 'Inhibit System Recovery'),
    T('T1489', 'Service Stop'),
    T('T1070', 'Indicator Removal'),
    T('T1070.001', 'Indicator Removal: Clear Windows Event Logs'),
    T('T1078', 'Valid Accounts'),
    T('T1098', 'Account Manipulation'),
    T('T1136', 'Create Account'),
    T('T1053.005', 'Scheduled Task/Job: Scheduled Task'),
    T('T1547.001', 'Boot or Logon Autostart Execution: Registry Run Keys / Startup Folder'),
    T('T1505.003', 'Server Software Component: Web Shell'),
    T('T1021.001', 'Remote Services: Remote Desktop Protocol'),
    T('T1572', 'Protocol Tunneling'),
    T('T1567', 'Exfiltration Over Web Service'),
    T('T1041', 'Exfiltration Over C2 Channel'),
    T('T1003', 'OS Credential Dumping'),
    T('T1562.001', 'Impair Defenses: Disable or Modify Tools'),
    T('T1218', 'System Binary Proxy Execution'),
    T('T1105', 'Ingress Tool Transfer'),
    T('T1219', 'Remote Access Software'),
  ],
  variation: {
    topologies: [
      { id: 'ransomware_windows', label: 'Windows estate during a ransomware event', guide: 'Domain controllers, file servers partly encrypted, EDR on most hosts, offline-capable backups of uncertain integrity, a hypervisor cluster, and a business demanding restoration.' },
      { id: 'cloud_breach', label: 'Cloud account with a confirmed credential compromise', guide: 'A cloud tenant with control-plane audit logs, a leaked role in use, several workload accounts via cross-account roles, object storage with exfil candidates, and a threat-detection service.' },
      { id: 'web_compromise', label: 'Public web platform with a confirmed web shell', guide: 'A DMZ web tier with a web shell, an app tier, a database with customer records, a WAF, access logs retained 30 days, and a regulated-data obligation.' },
      { id: 'saas_bec', label: 'Business email compromise in a cloud productivity tenant', guide: 'A finance user’s mailbox with rules forwarding externally, an OAuth grant to a third-party app, shared drives, sign-in logs, and a pending wire transfer.' },
      { id: 'ot_incident', label: 'OT environment with an IT-side intrusion approaching the DMZ', guide: 'An IT estate with confirmed compromise, a DMZ historian and jump server, an OT network with PLCs, a vendor remote path, and a plant that cannot stop safely at short notice.' },
      { id: 'insider_exfil', label: 'Suspected insider data exfiltration', guide: 'A departing employee, DLP alerts, cloud-storage uploads, a code repository, access to customer lists, and HR and legal in the loop.' },
      { id: 'supply_chain_update', label: 'A malicious update from a trusted software vendor', guide: 'A widely deployed agent that received a tampered update, beaconing from many hosts, EDR telemetry, and a vendor advisory still forming.' },
      { id: 'laptop_theft_roaming', label: 'A compromised laptop roaming between home and office', guide: 'An EDR-managed laptop with a confirmed implant, a VPN with split tunnelling, cached domain credentials, and intermittent connectivity.' },
    ],
    entryPoints: [
      { id: 'encryption_underway', label: 'Encryption is actively spreading across file shares', guide: 'The responder arrives with files being renamed in real time; some hosts are still clean; backups may or may not be reachable by the intruder.' },
      { id: 'role_in_use_now', label: 'A compromised cloud role is making API calls right now', guide: 'Audit logs show live activity under the role from an unfamiliar network; revoking it has service side effects.' },
      { id: 'webshell_live', label: 'A web shell is receiving commands', guide: 'The DMZ host shows live interaction; the app tier and database are reachable from it; access logs are the main record.' },
      { id: 'mailbox_rules_active', label: 'Mailbox forwarding rules and an app grant are active', guide: 'Mail is being auto-forwarded externally and a third-party app holds a refresh token; a fraudulent transfer is pending.' },
      { id: 'intruder_near_ot', label: 'The intruder is on the DMZ jump server next to OT', guide: 'IT is compromised and the jump server into OT is in reach; stopping the plant abruptly carries its own safety risk.' },
      { id: 'dlp_uploads', label: 'DLP shows ongoing uploads by a named user', guide: 'Large transfers to personal cloud storage are in progress; HR confirms the person resigns Friday.' },
      { id: 'tampered_agent_fleet', label: 'A trusted agent is beaconing from hundreds of hosts', guide: 'A vendor update appears malicious; isolating the whole fleet breaks operations; the vendor advisory is incomplete.' },
      { id: 'logs_being_cleared', label: 'Event logs are being cleared on key hosts', guide: 'The intruder is erasing evidence as the team watches; preservation now competes with containment.' },
      { id: 'second_foothold', label: 'A second persistence mechanism found after initial cleanup', guide: 'A scheduled task or new account suggests the first eradication missed something; recovery risks restoring the foothold.' },
      { id: 'backups_touched', label: 'Backups may have been accessed before the impact', guide: 'The backup system shows logins from the intruder’s path; restore integrity is now in question.' },
    ],
    objectives: [
      { id: 'contain_now', label: 'The first containment action', guide: 'Ask for the first containment action that stops the harm without destroying volatile evidence, tipping off the intruder beyond what is unavoidable, or breaking a safety-critical process; distractors are premature, too broad, or evidence-destroying.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 10, risk: 25 } },
      { id: 'preserve_first', label: 'The evidence to preserve before it is lost', guide: 'Ask which volatile or soon-to-expire artefact must be captured first given what the action would destroy; distractors name artefacts that are durable or irrelevant to the open question.', question: 'Which evidence must be preserved before the next step destroys it?', weights: { correctness: 30, reasoning: 40, architecture: 10, risk: 20 } },
      { id: 'order_of_ops', label: 'The right order of two necessary actions', guide: 'Ask which of two actions must come first given the constraint (for example isolate before imaging, or revoke tokens before resetting passwords, or snapshot before shutting down); distractors invert the order or insert a needless step.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 10, risk: 25 } },
      { id: 'scope_now', label: 'What the evidence implies about scope', guide: 'Ask how far the incident reaches given the trust relationships, shared credentials and paths on the diagram; distractors over- or under-scope by ignoring a boundary or a reused credential.', question: 'What does the current evidence imply about the scope?', weights: { correctness: 30, reasoning: 35, architecture: 25, risk: 10 } },
      { id: 'eradicate_right', label: 'What eradication must remove to prevent return', guide: 'Ask which persistence or access must be removed so recovery does not restore the foothold; distractors clean the visible symptom and leave a second mechanism or a valid credential.', question: 'What must eradication remove so the intruder cannot simply return?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'recover_safely', label: 'The recovery step that does not reintroduce risk', guide: 'Ask which recovery action restores service without restoring the compromise or trusting tainted data/backups; distractors restore from a touched backup, re-enable a path, or skip a validation.', question: 'Which recovery step restores service without reintroducing the compromise?', weights: { correctness: 30, reasoning: 35, architecture: 20, risk: 15 } },
      { id: 'notify_decision', label: 'What the evidence does and does not support telling stakeholders', guide: 'Ask what can be stated to leadership, customers or a regulator given what is actually proven; distractors over-claim, under-claim, or notify the wrong party on the wrong clock.', question: 'Given what is proven, what is the right notification decision now?', weights: { correctness: 30, reasoning: 30, architecture: 5, risk: 35 } },
    ],
    constraints: [
      { id: 'regulated_clock', label: 'Regulated data is in scope with a 72-hour notification clock', guide: 'Scoping confidence drives an external deadline; preserve what proves scope.' },
      { id: 'plant_safety', label: 'The OT process cannot be stopped abruptly without a safety risk', guide: 'Containment must respect a safe-shutdown sequence.' },
      { id: 'revenue_down', label: 'The platform is down and revenue loss per hour is material', guide: 'Recovery pressure competes with thoroughness; balance the two explicitly.' },
      { id: 'backups_suspect', label: 'Backup integrity is unconfirmed', guide: 'Do not treat restore as safe until validated.' },
      { id: 'no_forensics_tooling', label: 'The team has EDR but no dedicated forensic imaging capability', guide: 'Preserve with what is available before it rolls off.' },
      { id: 'legal_hold', label: 'Legal has placed a hold; actions may become evidence', guide: 'Document and preserve; avoid irreversible destruction.' },
      { id: 'intruder_watching', label: 'The intruder appears to react to defender activity', guide: 'Avoid tipping them off before containment is ready.' },
    ],
    components: [
      'domain controller', 'file server', 'EDR agent', 'EDR console', 'SIEM', 'hypervisor cluster', 'backup system', 'offline backup', 'web server', 'web shell', 'application tier', 'database', 'WAF', 'access log', 'cloud control-plane audit log', 'cloud role', 'object storage', 'mailbox', 'mail forwarding rule', 'OAuth grant', 'refresh token', 'DMZ jump server', 'historian', 'PLC', 'VPN concentrator', 'DLP', 'cloud storage', 'code repository', 'memory capture', 'disk image', 'volatile artefacts', 'scheduled task', 'service account', 'legal hold',
    ],
  },
  guidance: `Incident Response & DFIR realism rules:
- The learner is a responder, not an attacker. Describe the state of the incident, the artefacts available, and the clocks; never write operational attacker tradecraft or recovery steps that teach evasion.
- Use concrete names (for example "fileserver-07", "deploy-prod role", "mailbox rule 'archive'", "backup repo BR-2", "jump-dmz-01") and realistic timings. Never invent product features that do not exist.
- The "attack path" is the chain of steps the intruder took that the responder must account for; each diagram attack edge is an action already taken, with the evidence that records it (or the gap that does not).
- Be exact about what each action destroys or preserves: isolating a host may lose memory; shutting down loses volatile state; revoking a role stops activity but refresh tokens, app grants and scheduled tasks may survive; a backup touched by the intruder is suspect.
- Containment, evidence, recovery and notification genuinely trade off; a strong answer names the trade-off it accepts.
- Trust boundaries are real boundaries: endpoint, identity, network zone, cloud control plane, OT, backup, third-party.
- The best answer must be the one an experienced incident commander would choose for this exact state and constraint; distractors must be defensible IR moves that are mistimed, destroy needed evidence, miss a second foothold, or notify the wrong party.
- Cite techniques from the ATT&CK Enterprise matrix only, favouring Impact, Persistence, Defense Evasion and Exfiltration.`,
};
