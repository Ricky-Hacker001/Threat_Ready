import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Application Security: a web or service vulnerability is the way in; the question is about the
 * request, the code path and the data behind it. The diagram shows request flows, trust between
 * services, and the controls (WAF, authz, input handling, secrets) that did or did not apply.
 */
export const APPLICATION_SECURITY: ReasoningDomain = {
  key: 'application_security',
  title: 'Application Security',
  description: 'Read an application architecture with a live exploitation, decide which code path, control or trust the attack depends on, and defend the decision with evidence from the requests, logs and data flows.',
  track: 'Application Security',
  difficulty: 'intermediate',
  focus: [
    'Tracing a vulnerability class from the request to the data it exposes',
    'Why a WAF, a framework default or an input filter did or did not stop the request',
    'Authorisation at object and function level across services',
    'Fixes that remove the class of bug versus fixes that patch one payload',
  ],
  skillIds: ['appsec.injection', 'appsec.ssrf', 'appsec.authz', 'appsec.xss_web', 'appsec.secure_sdlc', 'sec.vulnerability_management'],
  weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1190', 'Exploit Public-Facing Application'),
    T('T1059', 'Command and Scripting Interpreter'),
    T('T1505.003', 'Server Software Component: Web Shell'),
    T('T1212', 'Exploitation for Credential Access'),
    T('T1552.001', 'Unsecured Credentials: Credentials in Files'),
    T('T1552.004', 'Unsecured Credentials: Private Keys'),
    T('T1552.005', 'Unsecured Credentials: Cloud Instance Metadata API'),
    T('T1083', 'File and Directory Discovery'),
    T('T1213', 'Data from Information Repositories'),
    T('T1565.001', 'Data Manipulation: Stored Data Manipulation'),
    T('T1185', 'Browser Session Hijacking'),
    T('T1539', 'Steal Web Session Cookie'),
    T('T1557', 'Adversary-in-the-Middle'),
    T('T1499.004', 'Endpoint Denial of Service: Application or System Exploitation'),
    T('T1071.001', 'Application Layer Protocol: Web Protocols'),
    T('T1027', 'Obfuscated Files or Information'),
    T('T1133', 'External Remote Services'),
    T('T1189', 'Drive-by Compromise'),
    T('T1195.002', 'Supply Chain Compromise: Compromise Software Supply Chain'),
    T('T1078', 'Valid Accounts'),
  ],
  variation: {
    topologies: [
      { id: 'monolith_mvc', label: 'Server-rendered monolith with a relational database', guide: 'A framework MVC app behind a reverse proxy, an ORM over a relational database, file uploads to local disk, a background job runner, and an admin panel on the same host.' },
      { id: 'spa_rest', label: 'Single-page app with a REST API', guide: 'A browser SPA, a JSON API behind an API gateway, JWT sessions, a user service and an orders service, a search index, and a CDN serving static assets.' },
      { id: 'microservices_mesh', label: 'Microservices behind an ingress with a service mesh', guide: 'Ingress, a BFF, six services with mTLS inside the mesh, an internal admin service without external auth, a message bus, and per-service databases.' },
      { id: 'multi_tenant_saas', label: 'Multi-tenant SaaS with a shared database', guide: 'Tenant id in every row, a tenant-resolution middleware, a reporting module that builds SQL from filters, exports to object storage, and a tenant-admin impersonation feature.' },
      { id: 'legacy_php_cms', label: 'Legacy CMS with plugins and a marketing site', guide: 'A CMS with third-party plugins, a theme that renders user content, a media library, a contact form that emails staff, and an integration that pushes leads to a CRM.' },
      { id: 'mobile_backend', label: 'Mobile app backend with push and payments', guide: 'Mobile clients, an API with device tokens, a payment webhook receiver, a referral service that renders user-supplied names, a notification service and a customer support console.' },
      { id: 'graphql_platform', label: 'GraphQL platform fronting several data sources', guide: 'A GraphQL gateway stitching three services, field-level resolvers with their own auth, a batching layer, a cache keyed by query, and an introspection endpoint left enabled.' },
      { id: 'file_processing', label: 'Document processing service', guide: 'Upload API, a converter using a native library, a preview renderer that fetches remote resources, an OCR worker, object storage for results, and a share-link feature with signed URLs.' },
    ],
    entryPoints: [
      { id: 'sqli_report_filter', label: 'SQL injection in a report filter parameter', guide: 'A filter is concatenated into a query; the WAF blocks obvious payloads but not a time-based variant; database logs show long-running queries from the app user.' },
      { id: 'ssrf_preview', label: 'SSRF through a URL preview or webhook feature', guide: 'The server fetches user-supplied URLs; it can reach internal services and the metadata endpoint; the fetch uses the app’s own identity.' },
      { id: 'idor_export', label: 'Insecure direct object reference on a data export', guide: 'Sequential ids on an export endpoint are authorised by authentication only; access logs show one user iterating thousands of ids.' },
      { id: 'deserialisation', label: 'Unsafe deserialisation of a session or message payload', guide: 'A signed-but-not-encrypted object or a message bus payload is deserialised by a vulnerable library, giving code execution on the worker.' },
      { id: 'stored_xss_admin', label: 'Stored XSS that executes in an administrator’s browser', guide: 'A user-controlled field renders unescaped in the admin console; the admin session cookie lacks HttpOnly or the CSP allows inline scripts.' },
      { id: 'path_traversal_download', label: 'Path traversal in a file download endpoint', guide: 'A filename parameter reaches the filesystem; configuration files with secrets are readable by the app user.' },
      { id: 'upload_webshell', label: 'Unrestricted file upload leading to a web shell', guide: 'Extension checks are client-side; uploads are served from a path the web server executes; the first request to the uploaded file comes minutes later.' },
      { id: 'jwt_alg_confusion', label: 'JWT verification weakness on the API', guide: 'The API accepts tokens signed with a key it should not trust (algorithm confusion, a leaked signing key, or an unverified issuer), so the attacker mints a token for another user.' },
      { id: 'vulnerable_dependency', label: 'A known-vulnerable dependency with a public exploit', guide: 'A library CVE with remote code execution is exploitable through an ordinary request; the component sits in the request path for every tenant.' },
      { id: 'mass_assignment', label: 'Mass assignment on a profile update', guide: 'The update handler binds every submitted field to the model, including a role or an email-verified flag.' },
    ],
    objectives: [
      { id: 'break_the_path', label: 'The single change that breaks the attack path', guide: 'Ask which one code, configuration or architectural change stops the attacker reaching the objective; distractors are good practices that address a later step, a different vulnerability class, or only the observed payload.', question: 'Which single change most directly breaks the attack path shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'root_cause_class', label: 'The root cause versus the symptom', guide: 'Ask which fix removes the vulnerability class rather than the one payload seen; distractors are blocklists, WAF rules or input filters that stop today’s payload and leave the class.', question: 'Which change removes the underlying vulnerability rather than the observed payload?', weights: { correctness: 30, reasoning: 45, architecture: 15, risk: 10 } },
      { id: 'why_control_failed', label: 'Why the existing control did not stop it', guide: 'Ask why the WAF, the framework protection, the authentication layer or the input validation on the diagram did not stop this request; distractors blame the wrong control or a control not on the path.', question: 'Why did the existing control shown on the diagram fail to stop this attack?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'detect_first', label: 'Where the exploitation would be detected first', guide: 'Ask which log source (access log, application log, database log, WAF log, egress log) would show this attacker first; distractors are sources that exist but do not see this step.', question: 'Which log source would reveal this attacker first, given the controls shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'data_reach', label: 'What data the attacker can reach from the vulnerable component', guide: 'Ask which data stores, secrets or services are reachable through the compromised component’s identity, network position and trust; distractors over- or under-state it by ignoring a boundary or a service identity.', question: 'What can the attacker now reach from the compromised component?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'contain_now', label: 'The first containment action', guide: 'Ask for the first action that stops ongoing exploitation without taking the service down beyond what is necessary or destroying evidence; distractors are a full outage, a cosmetic block, or a cleanup that loses the shell and logs.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'priority_order', label: 'The right order of two fixes under a constraint', guide: 'Ask which of two necessary actions must come first given the constraint (for example rotate the leaked key before patching, or virtual-patch before the release window); distractors invert the order.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
    ],
    constraints: [
      { id: 'release_freeze', label: 'The next deployment window is in five days', guide: 'Favour configuration, virtual patching and revocation over code that cannot ship yet.' },
      { id: 'payment_data', label: 'The application processes card payments in scope for PCI DSS', guide: 'Scope, logging and evidence requirements apply.' },
      { id: 'no_waf_owner', label: 'The WAF is managed by a vendor with a two-day change SLA', guide: 'WAF rules are not a same-hour control.' },
      { id: 'legacy_dependency', label: 'The vulnerable library cannot be upgraded without a major rewrite', guide: 'Mitigation must work without the upgrade.' },
      { id: 'uptime_contract', label: 'A 99.95% availability SLA with penalties is in force', guide: 'Avoid containment that takes the whole app down when a narrower action works.' },
      { id: 'single_dev', label: 'One developer knows the affected module', guide: 'Prefer actions that do not require deep code changes today.' },
      { id: 'multi_tenant', label: 'Two hundred tenants share the deployment', guide: 'A fix or an outage affects every tenant; blast radius matters.' },
    ],
    components: [
      'reverse proxy', 'web application firewall', 'CDN', 'API gateway', 'single-page app', 'mobile client', 'backend-for-frontend', 'authentication service', 'session store', 'JWT signing key', 'ORM layer', 'relational database', 'search index', 'cache', 'message bus', 'background worker', 'file upload handler', 'object storage', 'document converter', 'URL fetcher', 'admin console', 'tenant resolver', 'reporting module', 'payment webhook receiver', 'email sender', 'third-party plugin', 'dependency manifest', 'secrets file', 'instance metadata endpoint', 'application log', 'access log', 'database audit log', 'egress proxy',
    ],
  },
  guidance: `Application Security realism rules:
- Use concrete component and endpoint names (for example "POST /api/v2/reports/export", "orders-service", "converter worker", "admin console") and name the vulnerability class precisely (SQL injection, SSRF, IDOR, deserialisation, stored XSS, path traversal, unrestricted upload, JWT verification flaw, mass assignment). Never invent framework features or CVEs; if a CVE is needed, describe the bug without an id.
- The attack path must be technically valid step by step: each step is a request, a code path, a service identity, a network reachability or a trust the diagram shows. If a WAF, authz middleware, CSP, framework default or network boundary on the diagram would block a step, the path must go around it or the narrative must say why it did not apply.
- Distinguish the symptom from the class: a rule that blocks the observed payload is not the same as parameterised queries, allow-list URL validation, object-level authorisation or safe deserialisation.
- Trust boundaries are real boundaries: browser, edge/CDN, application tier, internal services, data tier, third-party integration, CI/CD.
- The best answer must be the one an experienced application security engineer would choose for this exact diagram and constraint; the distractors must be sound AppSec practices in general that do not break this path, address a later step, or violate the constraint.
- Cite techniques from the ATT&CK Enterprise matrix only.`,
};
