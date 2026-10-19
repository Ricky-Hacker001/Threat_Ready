import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Cloud Security: the first Attack Reasoning domain. The variation space is what keeps generated
 * questions distinct: topology × entry point × objective × technique × constraint, with the
 * seed chosen to avoid what the learner has already seen (seed.ts) and a similarity check on the
 * result (similarity.ts).
 */
export const CLOUD_SECURITY: ReasoningDomain = {
  key: 'cloud_security',
  title: 'Cloud Security',
  description: 'Read a cloud architecture with an active attack, decide what breaks the attack path, and defend the decision with evidence from the diagram and the logs.',
  track: 'Cloud Security',
  difficulty: 'intermediate',
  focus: [
    'Identity and least privilege across accounts, roles and workloads',
    'Where cloud control-plane and data-plane logs would show the attack',
    'Containment that stops the attacker without destroying evidence',
    'Blast radius through trust relationships, keys and shared services',
  ],
  skillIds: ['cloudsec.iam', 'cloudsec.incident_response', 'cloudsec.logging_monitoring', 'cloudsec.network_controls', 'cloudsec.storage_exposure', 'cloudsec.posture_management'],
  weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1078.004', 'Valid Accounts: Cloud Accounts'),
    T('T1552.001', 'Unsecured Credentials: Credentials in Files'),
    T('T1552.005', 'Unsecured Credentials: Cloud Instance Metadata API'),
    T('T1530', 'Data from Cloud Storage'),
    T('T1098.001', 'Account Manipulation: Additional Cloud Credentials'),
    T('T1098.003', 'Account Manipulation: Additional Cloud Roles'),
    T('T1548.005', 'Abuse Elevation Control Mechanism: Temporary Elevated Cloud Access'),
    T('T1190', 'Exploit Public-Facing Application'),
    T('T1496', 'Resource Hijacking'),
    T('T1562.008', 'Impair Defenses: Disable or Modify Cloud Logs'),
    T('T1580', 'Cloud Infrastructure Discovery'),
    T('T1537', 'Transfer Data to Cloud Account'),
    T('T1550.001', 'Use Alternate Authentication Material: Application Access Token'),
    T('T1021.007', 'Remote Services: Cloud Services'),
    T('T1526', 'Cloud Service Discovery'),
    T('T1578', 'Modify Cloud Compute Infrastructure'),
  ],
  variation: {
    topologies: [
      { id: 'three_tier_web', label: 'Three-tier web application', guide: 'Load balancer, stateless web/app tier in private subnets, managed relational database, object storage for uploads and exports, a CI pipeline that deploys with a cloud role.' },
      { id: 'serverless_api', label: 'Serverless API', guide: 'API gateway in front of functions, a NoSQL table, an object store, secrets in a secrets manager, an event bus and an external SaaS webhook.' },
      { id: 'k8s_platform', label: 'Kubernetes platform on a cloud provider', guide: 'Managed Kubernetes cluster with node pools, an ingress controller, workload identity to cloud roles, a container registry, and a cloud database outside the cluster.' },
      { id: 'data_lake', label: 'Analytics data lake', guide: 'Ingestion jobs, a raw and a curated storage bucket, a query engine, notebooks used by analysts, and a BI tool with a service account.' },
      { id: 'multi_account_org', label: 'Multi-account organisation', guide: 'An organisation with a management account, a shared identity account with SSO, a security/logging account, and workload accounts assumed through cross-account roles.' },
      { id: 'hybrid_vpn', label: 'Hybrid cloud with on-premises connectivity', guide: 'A site-to-site VPN or direct link from an office network to a cloud VPC, a domain controller on-premises, an application server in the cloud that still talks to a legacy file server.' },
      { id: 'cicd_to_cloud', label: 'CI/CD pipeline deploying to the cloud', guide: 'Source repository, hosted CI runners, an artifact registry, deployment roles per environment, and production infrastructure managed as code.' },
      { id: 'saas_integrations', label: 'Cloud workloads integrated with third-party SaaS', guide: 'A core application with OAuth integrations to a CRM, a support desk and a payment provider, a webhook receiver, and a shared integration user.' },
    ],
    entryPoints: [
      { id: 'leaked_access_key', label: 'A long-lived access key leaked in a public repository', guide: 'The key belongs to a service or CI user with broad permissions; the first API calls come from an unfamiliar network.' },
      { id: 'public_storage', label: 'A storage bucket exposed to the internet', guide: 'A bucket policy or ACL grants anonymous read (or write); logs show bulk object reads from unknown clients.' },
      { id: 'ssrf_metadata', label: 'SSRF to the instance metadata service', guide: 'A public web component fetches attacker-controlled URLs and reaches the metadata endpoint, yielding the instance role credentials.' },
      { id: 'overprivileged_role', label: 'An over-privileged workload role', guide: 'A compromised application component holds a role that can read secrets, assume other roles or modify IAM.' },
      { id: 'exposed_management_port', label: 'A management port open to the internet', guide: 'SSH, RDP, a database port or a Kubernetes API reachable from any address with weak or reused credentials.' },
      { id: 'phished_console_user', label: 'A phished console user without phishing-resistant MFA', guide: 'An administrator or developer session is stolen through a reverse-proxy phishing page; the attacker has the console.' },
      { id: 'compromised_ci_token', label: 'A compromised CI runner or pipeline token', guide: 'A malicious dependency or a poisoned pull request runs in CI and uses the deployment role or registry credentials.' },
      { id: 'vulnerable_public_app', label: 'A vulnerable public-facing application', guide: 'A known vulnerability in a web component gives code execution on the instance or container that serves it.' },
      { id: 'oauth_app_consent', label: 'A malicious third-party OAuth application', guide: 'A user consents to an application that gains API tokens with broad scopes to cloud or SaaS data.' },
      { id: 'permissive_security_group', label: 'A permissive security group and reused credentials', guide: 'An internal database or cache is reachable from every subnet; a credential reused across environments opens it.' },
    ],
    objectives: [
      { id: 'break_the_path', label: 'The single control that breaks the attack path', guide: 'Ask which one control, applied now, stops the attacker reaching the objective; the distractors must be real controls that help but do not break this path.', question: 'Which single change most directly breaks the attack path shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'fastest_path_to_data', label: 'The fastest path to the sensitive data', guide: 'Ask which path the attacker takes to the sensitive data store from where they are now; distractors are paths that look shorter but are blocked by a control on the diagram.', question: 'From the compromised position, which path reaches the sensitive data with the fewest additional steps?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'detect_first', label: 'Where the attack would be detected first', guide: 'Ask which log source or detection would show the attacker first given the controls on the diagram; distractors are sources that exist but would not capture this step.', question: 'Which log source would reveal this attacker first, given the controls shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'contain_now', label: 'The containment step to take first', guide: 'Ask for the first containment action that stops the attacker without destroying evidence or breaking the service beyond what is necessary; distractors are actions that are too aggressive, too passive or destroy logs.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'least_privilege_fix', label: 'The least-privilege change with the most effect', guide: 'Ask which permission or trust-policy change reduces the blast radius most while keeping the system working; distractors reduce risk less or break a required flow.', question: 'Which permission change reduces the blast radius most without breaking the workload?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'blast_radius', label: 'The true blast radius of the compromised component', guide: 'Ask what the attacker can now reach through trust relationships, shared credentials and network paths; distractors over- or under-state it by ignoring a control or a trust edge.', question: 'What can the attacker now reach from the compromised component?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'priority_order', label: 'The right order of two remediation steps under a constraint', guide: 'Ask which of two necessary actions must come first given the stated operational constraint; distractors invert the order or add an unnecessary step.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
    ],
    constraints: [
      { id: 'change_freeze', label: 'A change freeze is in force for a product launch tomorrow', guide: 'Favour actions that are reversible or do not need a deploy.' },
      { id: 'regulated_data', label: 'The data store holds regulated personal or payment data', guide: 'Notification deadlines and evidence preservation matter.' },
      { id: 'no_soc', label: 'A three-person platform team with no security operations function', guide: 'Prefer managed detections and simple, durable controls.' },
      { id: 'checkout_uptime', label: 'Checkout must stay up; revenue loss per minute is material', guide: 'Avoid containment that takes the public path down when a narrower action works.' },
      { id: 'legacy_component', label: 'One legacy component cannot be changed this quarter', guide: 'Controls must work around it.' },
      { id: 'multi_region', label: 'The workload runs in two regions with replicated data', guide: 'Containment must cover both regions; logs are per region.' },
      { id: 'shared_credentials', label: 'Several teams share one deployment identity', guide: 'Rotation has side effects; scoping matters.' },
    ],
    components: [
      'application load balancer', 'web application firewall', 'API gateway', 'container service', 'virtual machines', 'serverless functions', 'managed Kubernetes', 'relational database', 'NoSQL table', 'object storage bucket', 'message queue', 'event bus', 'secrets manager', 'parameter store', 'key management service', 'identity provider with SSO', 'IAM roles and policies', 'instance profile', 'workload identity', 'VPC with public and private subnets', 'NAT gateway', 'VPC endpoints', 'security groups', 'bastion host', 'CI runners', 'container registry', 'infrastructure-as-code state', 'control-plane audit log', 'flow logs', 'threat detection service', 'backup vault', 'CDN', 'DNS zone', 'third-party SaaS integration',
    ],
  },
  guidance: `Cloud Security realism rules:
- Use provider-neutral but concrete component names (for example "object storage bucket exports-prod", "deployment role deploy-prod", "control-plane audit log"). Never invent product features that do not exist.
- The attack path must be technically valid step by step: each step uses a permission, a network path or a trust relationship that the diagram shows. If a control on the diagram would block a step, the path must go around it or the narrative must explain why the control did not apply.
- Trust boundaries are real boundaries: account, VPC, public subnet, private subnet, identity provider, CI/CD, on-premises.
- The best answer must be the one an experienced cloud security engineer would choose for this exact diagram and constraint; the distractors must be sound controls in general that do not break this path, address a later step, or violate the constraint.
- Cite techniques from the ATT&CK Cloud matrix only.`,
};
