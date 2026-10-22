import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * GRC & Risk: risk-based prioritisation, control mapping and defensible decisions for leadership.
 * The diagram shows a control environment with a deficiency and the path by which a risk is being
 * realised; the learner makes the defensible risk/control decision, not a hands-on technical fix.
 */
export const GRC_RISK: ReasoningDomain = {
  key: 'grc_risk',
  title: 'GRC & Risk',
  description: 'Read a control environment with a deficiency being exploited or flagged, decide the most defensible risk or control decision, and justify it in terms a leader and an auditor would both accept.',
  track: 'Governance',
  difficulty: 'intermediate',
  framing: 'a control-environment diagram (systems, the controls mapped to them, and the path by which a risk is being realised) with a live incident or audit finding',
  focus: [
    'Mapping a real deficiency to the control and the risk it actually affects',
    'Prioritising by risk (likelihood × impact) rather than by noise or recency',
    'Compensating controls and residual risk when the ideal fix is not available',
    'Decisions that satisfy both the business and the relevant framework or regulator',
  ],
  skillIds: ['grc.risk_compliance', 'sec.vulnerability_management', 'sec.fundamentals', 'cloudsec.posture_management', 'soc.incident_response'],
  weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 },
  scoring: { partialCreditForPlausible: 0.3 },
  techniques: [
    T('T1190', 'Exploit Public-Facing Application'),
    T('T1078', 'Valid Accounts'),
    T('T1199', 'Trusted Relationship'),
    T('T1486', 'Data Encrypted for Impact'),
    T('T1530', 'Data from Cloud Storage'),
    T('T1552', 'Unsecured Credentials'),
    T('T1566', 'Phishing'),
    T('T1098', 'Account Manipulation'),
    T('T1485', 'Data Destruction'),
    T('T1203', 'Exploitation for Client Execution'),
    T('T1195', 'Supply Chain Compromise'),
    T('T1213', 'Data from Information Repositories'),
    T('T1110', 'Brute Force'),
    T('T1537', 'Transfer Data to Cloud Account'),
    T('T1498', 'Network Denial of Service'),
    T('T1082', 'System Information Discovery'),
  ],
  variation: {
    topologies: [
      { id: 'soc2_saas', label: 'SaaS company preparing for a SOC 2 Type II', guide: 'A production platform, an access-control process, a change-management process, a vendor list, logging of varying completeness, and a control matrix with a few exceptions.' },
      { id: 'pci_merchant', label: 'Merchant in PCI DSS scope', guide: 'A cardholder-data environment, a segmentation boundary, a logging requirement, a quarterly scan, a compensating-control worksheet, and a change freeze window.' },
      { id: 'iso_enterprise', label: 'Enterprise with an ISO 27001 ISMS', guide: 'A statement of applicability, a risk register, asset owners, a supplier-assurance process, internal audit findings, and a management-review cadence.' },
      { id: 'gdpr_controller', label: 'Data controller under GDPR', guide: 'Personal-data stores, a records-of-processing register, a DPIA process, processor contracts, a breach-notification workflow, and subject-rights handling.' },
      { id: 'nist_csf_program', label: 'Security programme mapped to NIST CSF', guide: 'A profile across the functions, a risk register, control owners, a plan of action and milestones, and a board risk-appetite statement.' },
      { id: 'vendor_risk', label: 'Third-party risk across many vendors', guide: 'A vendor inventory tiered by data access, assessment questionnaires, SLAs and right-to-audit clauses, a critical vendor with a reported incident, and a concentration risk.' },
      { id: 'vuln_prioritisation', label: 'Vulnerability management at scale', guide: 'Thousands of findings from several scanners, asset criticality of uneven quality, exploit-availability data, an SLA by severity, and limited remediation capacity.' },
      { id: 'regulated_financial', label: 'Regulated financial firm', guide: 'A regulatory obligation set, an operational-risk framework, key controls with testing evidence, an incident with a reporting threshold, and an audit committee.' },
    ],
    entryPoints: [
      { id: 'control_exception', label: 'A control operating with a standing exception', guide: 'A control in the matrix has an approved exception that an auditor or an incident now shows is being relied on where it should not be.' },
      { id: 'audit_finding', label: 'An internal-audit finding on a key control', guide: 'Testing shows a key control did not operate for part of the period; the question is how to treat the risk and the gap.' },
      { id: 'realised_incident', label: 'An incident realises a risk the register rated low', guide: 'A risk previously rated low likelihood has occurred; its rating, owner and treatment now need revisiting.' },
      { id: 'vendor_incident', label: 'A critical vendor reports a breach', guide: 'A tier-one vendor with data access reports an incident; the firm’s exposure depends on contracts, data shared and compensating controls.' },
      { id: 'scan_backlog', label: 'A vulnerability backlog past SLA on mixed assets', guide: 'Findings exceed remediation capacity; some are on crown-jewel assets, some have public exploits, some are internal-only.' },
      { id: 'segmentation_drift', label: 'Segmentation drift puts systems back in scope', guide: 'A change widened a boundary so systems previously out of scope now hold or reach regulated data.' },
      { id: 'missing_evidence', label: 'A control works but has no evidence', guide: 'A control is performed but not recorded, so it cannot be demonstrated to an auditor or a regulator.' },
      { id: 'policy_reality_gap', label: 'A policy that does not match what the business does', guide: 'The written policy diverges from operational reality, so either the policy or the practice is a finding.' },
      { id: 'concentration_risk', label: 'Concentration on a single provider or control', guide: 'Many critical processes depend on one provider or one control, so a single failure has outsized impact.' },
      { id: 'notification_threshold', label: 'An event near a regulatory reporting threshold', guide: 'An incident may or may not cross a notification threshold; the decision must be defensible either way.' },
    ],
    objectives: [
      { id: 'most_defensible', label: 'The most defensible decision for the deficiency', guide: 'Ask which decision best treats the risk and withstands scrutiny from both the business and the framework/regulator; distractors are decisions that are technically fine but indefensible, disproportionate, or non-compliant.', question: 'What is the most defensible decision for this deficiency?', weights: { correctness: 30, reasoning: 35, architecture: 10, risk: 25 } },
      { id: 'prioritise', label: 'What to remediate first by risk', guide: 'Ask which item to treat first given likelihood, impact, asset criticality and exploitability; distractors prioritise by severity label alone, by recency, or by ease rather than by risk.', question: 'Which item should be remediated first, judged by risk?', weights: { correctness: 30, reasoning: 40, architecture: 15, risk: 15 } },
      { id: 'map_control', label: 'The control and risk the deficiency actually affects', guide: 'Ask which control objective and which risk the deficiency maps to; distractors map it to an adjacent control, mis-state the risk, or treat a symptom as the risk.', question: 'Which control objective and risk does this deficiency actually affect?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'compensating_control', label: 'The compensating control when the ideal fix is unavailable', guide: 'Ask which compensating control meaningfully reduces the risk until the permanent fix lands, and what residual remains; distractors are controls that do not address this risk or that leave the same residual while looking busy.', question: 'Which compensating control best reduces the risk until the permanent fix, and what residual remains?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'residual_accept', label: 'Whether the residual risk is within appetite', guide: 'Ask whether the residual risk, after the proposed treatment, is within the stated appetite and who must accept it; distractors accept beyond appetite, reject within it, or assign acceptance to the wrong owner.', question: 'Is the residual risk within appetite after treatment, and who must accept it?', weights: { correctness: 30, reasoning: 35, architecture: 5, risk: 30 } },
      { id: 'notify_decision', label: 'What the facts do and do not oblige you to report', guide: 'Ask what the obligation requires given what is actually known, and on what clock; distractors over-report, under-report, or report to the wrong body/timeline.', question: 'Given the facts, what is the defensible notification decision?', weights: { correctness: 30, reasoning: 30, architecture: 5, risk: 35 } },
      { id: 'priority_order', label: 'The right order of two actions under a constraint', guide: 'Ask which of two necessary actions comes first given the constraint (for example contain and preserve before the regulator clock, or record evidence before closing the finding); distractors invert the order.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 10, risk: 25 } },
    ],
    constraints: [
      { id: 'audit_window', label: 'The audit period closes in two weeks', guide: 'Evidence and remediation must be defensible within the window.' },
      { id: 'limited_capacity', label: 'Remediation capacity is a fraction of the backlog', guide: 'Not everything can be fixed; prioritise by risk and defend the deferrals.' },
      { id: 'board_appetite', label: 'The board’s stated risk appetite is low for customer-data risk', guide: 'Decisions must respect the stated appetite.' },
      { id: 'regulatory_clock', label: 'A regulatory notification clock may apply', guide: 'The decision must be defensible on the regulator’s timeline.' },
      { id: 'vendor_contract', label: 'Remedies against the vendor are limited by the contract', guide: 'Treatment must work within the contractual rights that exist.' },
      { id: 'change_freeze', label: 'A change freeze is in force', guide: 'Favour treatments that do not require a deploy, or a documented emergency change.' },
      { id: 'cost_scrutiny', label: 'Spend is under scrutiny; controls must be proportionate', guide: 'The treatment must be proportionate to the risk and defensible on cost.' },
    ],
    components: [
      'control matrix', 'control objective', 'key control', 'control exception', 'risk register', 'risk owner', 'asset inventory', 'asset criticality', 'statement of applicability', 'plan of action and milestones', 'compensating-control worksheet', 'segmentation boundary', 'cardholder-data environment', 'personal-data store', 'records of processing', 'DPIA', 'processor contract', 'vendor inventory', 'vendor tier', 'right-to-audit clause', 'SLA', 'internal-audit finding', 'evidence repository', 'logging coverage', 'scan findings', 'exploit-availability data', 'risk appetite statement', 'management review', 'breach-notification workflow', 'regulatory obligation', 'audit committee', 'policy document',
    ],
  },
  guidance: `GRC & Risk realism rules:
- The learner is a risk/compliance professional making a defensible decision, not a hands-on responder and not an attacker. The diagram shows systems, the controls mapped to them, and the path by which a risk is being realised; describe the deficiency and the environment, never operational attacker tradecraft.
- Use concrete, framework-aware names (for example "control CC6.1", "PCI requirement 1.3", "risk R-14 unauthorised data access", "vendor tier 1", "SoA A.8.24") and name the framework in play (SOC 2, PCI DSS, ISO 27001, GDPR, NIST CSF). Never invent control ids that do not exist in the named framework; if unsure, describe the control objective in words.
- The "attack path" is the chain by which the deficiency lets a risk be realised: each diagram attack edge is a step from the gap to the impact, so the risk is concrete rather than abstract. Keep steps technically plausible but do not teach exploitation.
- Reason in likelihood × impact, asset criticality and residual risk; prioritise by risk, not by severity label, recency or ease. Be exact about what a compensating control does and what residual it leaves, and about who owns a risk acceptance.
- Trust boundaries are real boundaries and so are scope boundaries (in-scope vs out-of-scope for a framework, data classification lines, segmentation).
- The best answer must be the one an experienced GRC lead would defend to both leadership and an auditor for this exact situation and constraint; distractors must be decisions that are plausible but disproportionate, non-compliant, mis-prioritised, or assign acceptance/notification wrongly.
- Cite techniques from the ATT&CK Enterprise matrix only, to ground the risk in a concrete threat; keep them high-level.`,
};
