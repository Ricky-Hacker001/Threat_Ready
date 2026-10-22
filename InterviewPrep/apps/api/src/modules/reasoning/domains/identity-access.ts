import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Identity & Access: SSO, federation, privileged access and the trust relationships attackers abuse.
 * Same engine as Cloud Security; the variation space is identity-shaped (tenant, directory, IdP,
 * federation trust, privileged workflow) and the attack always rides a credential, token or trust.
 */
export const IDENTITY_ACCESS: ReasoningDomain = {
  key: 'identity_access',
  title: 'Identity & Access',
  description: 'Read an identity architecture with an active account compromise, decide which trust, token or control the attack depends on, and defend the decision with evidence from the sign-in and directory logs.',
  track: 'Identity & Access',
  difficulty: 'intermediate',
  focus: [
    'How federation, SSO and directory trusts chain one compromise into many',
    'Phishing-resistant MFA, session and token lifetimes, and what each actually stops',
    'Privileged access paths: admin roles, break-glass, service principals and delegation',
    'Which sign-in, audit and directory logs show the abuse first',
  ],
  skillIds: ['iam.federation', 'iam.privileged_access', 'cloudsec.iam', 'soc.authentication_attacks', 'sec.fundamentals'],
  weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1078', 'Valid Accounts'),
    T('T1078.002', 'Valid Accounts: Domain Accounts'),
    T('T1078.004', 'Valid Accounts: Cloud Accounts'),
    T('T1110.003', 'Brute Force: Password Spraying'),
    T('T1110.004', 'Brute Force: Credential Stuffing'),
    T('T1621', 'Multi-Factor Authentication Request Generation'),
    T('T1556.006', 'Modify Authentication Process: Multi-Factor Authentication'),
    T('T1566.002', 'Phishing: Spearphishing Link'),
    T('T1539', 'Steal Web Session Cookie'),
    T('T1550.004', 'Use Alternate Authentication Material: Web Session Cookie'),
    T('T1528', 'Steal Application Access Token'),
    T('T1550.001', 'Use Alternate Authentication Material: Application Access Token'),
    T('T1606.002', 'Forge Web Credentials: SAML Tokens'),
    T('T1098', 'Account Manipulation'),
    T('T1098.003', 'Account Manipulation: Additional Cloud Roles'),
    T('T1136.003', 'Create Account: Cloud Account'),
    T('T1484.002', 'Domain or Tenant Policy Modification: Trust Modification'),
    T('T1558.003', 'Steal or Forge Kerberos Tickets: Kerberoasting'),
    T('T1003.006', 'OS Credential Dumping: DCSync'),
    T('T1649', 'Steal or Forge Authentication Certificates'),
  ],
  variation: {
    topologies: [
      { id: 'workforce_sso', label: 'Workforce SSO with a cloud identity provider', guide: 'A cloud IdP federating 40 SaaS apps via SAML/OIDC, conditional access by group, an HR system as the source of truth for joiner-mover-leaver, and a self-service password reset portal.' },
      { id: 'hybrid_ad', label: 'Hybrid Active Directory synchronised to a cloud tenant', guide: 'On-premises domain controllers, a directory sync server with a highly privileged connector account, password hash sync, a cloud tenant with global admins, and legacy apps bound to LDAP.' },
      { id: 'b2b_federation', label: 'Partner federation with external tenants', guide: 'Guest users from three partner tenants, cross-tenant access settings, a shared collaboration workspace, an inbound SAML trust from one partner IdP, and a partner-facing support app.' },
      { id: 'customer_ciam', label: 'Customer identity (CIAM) for a consumer app', guide: 'Customer IdP with social logins and passwordless email links, a profile API, a fraud-scoring service, support staff with account-impersonation rights, and a marketing platform synced with customer attributes.' },
      { id: 'pam_privileged', label: 'Privileged access management for infrastructure admins', guide: 'A PAM vault brokering SSH and RDP to servers, just-in-time elevation into admin groups, break-glass accounts in a safe, session recording, and a ticketing integration that approves elevation.' },
      { id: 'service_principals', label: 'Workload identities and service principals at scale', guide: 'Hundreds of service principals with client secrets and certificates, an automation platform that owns many of them, app registrations with delegated and application permissions, and a secrets manager some teams bypass.' },
      { id: 'mergers_two_forests', label: 'Two directory forests after an acquisition', guide: 'A forest trust between the acquirer and the acquired company, SID filtering decisions, duplicated admin groups, a migration tool with rights in both forests, and a shared cloud tenant with both companies as domains.' },
      { id: 'devops_sso_to_cloud', label: 'Engineer SSO into cloud consoles and CLIs', guide: 'IdP groups mapped to cloud permission sets, CLI sessions obtained via device-code flow, a CI identity using OIDC federation to assume deployment roles, and emergency IAM users nobody rotated.' },
    ],
    entryPoints: [
      { id: 'aitm_phish', label: 'An adversary-in-the-middle phishing page captures a session', guide: 'A reverse-proxy phishing kit relays the real login, passes the OTP, and captures the session cookie; the IdP sees a successful sign-in from the proxy address.' },
      { id: 'mfa_fatigue', label: 'MFA fatigue against a user with push notifications', guide: 'Password known from a breach dump; dozens of push prompts at night until one is approved; sign-in logs show repeated MFA denials then one success.' },
      { id: 'password_spray', label: 'Password spraying against a legacy authentication endpoint', guide: 'Basic-auth or legacy protocol endpoint bypasses conditional access; a seasonal password works for one service account.' },
      { id: 'oauth_consent', label: 'Illicit consent to a malicious OAuth application', guide: 'A user grants mail.read and files.read.all to a look-alike app; the attacker holds a refresh token that survives the password reset.' },
      { id: 'sync_server', label: 'Compromise of the directory synchronisation server', guide: 'The sync connector account has replication rights and the server stores credentials; the attacker now has both on-premises and cloud tenant leverage.' },
      { id: 'helpdesk_social', label: 'Help desk resets MFA after a convincing call', guide: 'Social engineering of the service desk re-registers the attacker’s authenticator on an administrator account.' },
      { id: 'stale_admin_account', label: 'A dormant global administrator excluded from MFA', guide: 'A legacy admin account kept for "emergencies" has no MFA and a password from a 2019 breach.' },
      { id: 'leaked_sp_secret', label: 'A service principal secret leaked in a build log', guide: 'The secret belongs to an app with application-level directory permissions; token requests arrive from an unfamiliar ASN.' },
      { id: 'guest_overreach', label: 'A compromised partner guest with excessive group membership', guide: 'The guest was added to an internal group that grants access to a sensitive workspace and an admin unit.' },
      { id: 'kerberoast_svc', label: 'Kerberoasting a service account with a weak password', guide: 'An authenticated low-privilege user requests service tickets and cracks a service account that is local admin on the file servers.' },
    ],
    objectives: [
      { id: 'break_the_path', label: 'The single control that breaks the attack path', guide: 'Ask which one identity control, applied now, stops the attacker reaching the objective; distractors are real controls that address a different step or do not apply to this authentication flow.', question: 'Which single change most directly breaks the attack path shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'what_survives_reset', label: 'What the attacker still holds after the obvious response', guide: 'Ask what access survives a password reset (or another obvious step) given the tokens, refresh tokens, app consents, registered devices or trusts on the diagram; distractors assume the reset is enough or over-state what survives.', question: 'After the obvious response, what access does the attacker still hold?', weights: { correctness: 30, reasoning: 35, architecture: 25, risk: 10 } },
      { id: 'detect_first', label: 'Where the abuse would be detected first', guide: 'Ask which sign-in, audit, directory or application log would show the attacker first; distractors are logs that exist but would not capture this step (for example a token replay that never touches the IdP).', question: 'Which log source would reveal this attacker first, given the controls shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'contain_now', label: 'The containment step to take first', guide: 'Ask for the first containment action that cuts the attacker’s access without locking out the business or destroying sign-in evidence; distractors are too broad (tenant-wide resets), too narrow (one password) or lose evidence.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'trust_blast_radius', label: 'The blast radius through trusts and delegation', guide: 'Ask what the attacker can reach through federation trusts, group nesting, role assignment, delegated permissions or directory sync from the compromised identity; distractors miss or invent a trust edge.', question: 'What can the attacker now reach from the compromised identity?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'least_privilege_fix', label: 'The privilege change with the most effect', guide: 'Ask which role, group, permission or trust change reduces the blast radius most while the business keeps working; distractors reduce risk less or break a required sign-in flow.', question: 'Which privilege or trust change reduces the blast radius most without breaking the workload?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'priority_order', label: 'The right order of two remediation steps under a constraint', guide: 'Ask which of two necessary identity actions must come first given the constraint (for example revoke sessions before resetting passwords, or remove the inbound trust before the admin cleanup); distractors invert the order or add a needless step.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
    ],
    constraints: [
      { id: 'exec_travelling', label: 'The affected administrator is travelling and unreachable for six hours', guide: 'Actions must not depend on that person approving or re-enrolling.' },
      { id: 'no_tenant_wide_reset', label: 'Leadership refuses a tenant-wide password reset during quarter close', guide: 'Favour targeted revocation and policy over blanket resets.' },
      { id: 'legacy_auth_required', label: 'A line-of-business app still requires legacy authentication', guide: 'Blocking legacy auth outright breaks it; scoping matters.' },
      { id: 'partner_sla', label: 'Partner guests must keep access under a contractual SLA', guide: 'Cross-tenant changes have external consequences.' },
      { id: 'regulated_records', label: 'The compromised identity can reach regulated personal records', guide: 'Notification deadlines and evidence preservation matter.' },
      { id: 'no_pam_yet', label: 'The PAM rollout is half done; some admins still use standing privilege', guide: 'Controls must cover both populations.' },
      { id: 'small_it_team', label: 'A two-person IT team runs identity for 400 staff', guide: 'Prefer managed detections and durable policy over manual review.' },
    ],
    components: [
      'cloud identity provider', 'on-premises domain controller', 'directory sync server', 'conditional access policy', 'MFA service', 'FIDO2 security keys', 'self-service password reset', 'HR system of record', 'SAML application', 'OIDC application', 'OAuth app registration', 'service principal', 'client secret', 'refresh token', 'session cookie', 'device registration', 'MDM compliance signal', 'admin unit', 'privileged role', 'just-in-time elevation', 'PAM vault', 'break-glass account', 'guest user', 'cross-tenant access policy', 'forest trust', 'LDAP-bound legacy app', 'sign-in log', 'directory audit log', 'identity protection alerts', 'SIEM', 'help desk ticketing', 'secrets manager',
    ],
  },
  guidance: `Identity & Access realism rules:
- Use provider-neutral but concrete names (for example "cloud identity provider", "conditional access policy CA-07", "service principal sp-billing-sync", "global administrator"). Never invent product features that do not exist.
- The attack path must be technically valid step by step: each step uses a credential, token, session, consent, group membership, role assignment, delegation or trust that the diagram shows. If a control on the diagram would block a step (phishing-resistant MFA, a device-compliance condition, token lifetime, SID filtering), the path must go around it or the narrative must say why it did not apply.
- Be precise about what a password reset, a session revocation, a token lifetime and an MFA re-registration each do and do not stop. Refresh tokens, app consents, registered authenticators, federation trusts and sync accounts survive things learners assume they do not.
- Trust boundaries are real boundaries: on-premises directory, cloud tenant, partner tenant, identity provider, privileged tier, application.
- The best answer must be the one an experienced identity engineer would choose for this exact diagram and constraint; the distractors must be sound identity controls in general that do not break this path, address a later step, or violate the constraint.
- Cite techniques from the ATT&CK Enterprise matrix only, favouring Credential Access, Initial Access and Persistence techniques about identities.`,
};
