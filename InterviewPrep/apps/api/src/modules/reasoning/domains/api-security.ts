import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * API Security: authentication, authorisation and abuse across service interfaces. The diagram is
 * API endpoints, the gateway, the auth layer and the data behind them; the attack abuses an
 * authorisation gap, a token flaw, or a business-logic abuse rather than a memory-corruption bug.
 */
export const API_SECURITY: ReasoningDomain = {
  key: 'api_security',
  title: 'API Security',
  description: 'Read an API architecture with an active abuse, decide which authorisation gap, token flaw or logic abuse the attack depends on, and defend the decision with evidence from the gateway and application logs.',
  track: 'Application Security',
  difficulty: 'intermediate',
  focus: [
    'Object- and function-level authorisation across endpoints',
    'Token scope, audience and lifetime, and what each actually constrains',
    'Business-logic and rate abuses that look like valid traffic',
    'Where the gateway, the auth layer and the service each enforce (or do not)',
  ],
  skillIds: ['appsec.api_security', 'appsec.authz', 'appsec.injection', 'iam.federation', 'appsec.secure_sdlc'],
  weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1190', 'Exploit Public-Facing Application'),
    T('T1133', 'External Remote Services'),
    T('T1078', 'Valid Accounts'),
    T('T1550.001', 'Use Alternate Authentication Material: Application Access Token'),
    T('T1528', 'Steal Application Access Token'),
    T('T1539', 'Steal Web Session Cookie'),
    T('T1606.001', 'Forge Web Credentials: Web Cookies'),
    T('T1213', 'Data from Information Repositories'),
    T('T1530', 'Data from Cloud Storage'),
    T('T1565.001', 'Data Manipulation: Stored Data Manipulation'),
    T('T1499', 'Endpoint Denial of Service'),
    T('T1499.003', 'Endpoint Denial of Service: Application Exhaustion Flood'),
    T('T1071.001', 'Application Layer Protocol: Web Protocols'),
    T('T1552.001', 'Unsecured Credentials: Credentials in Files'),
    T('T1098.001', 'Account Manipulation: Additional Cloud Credentials'),
    T('T1199', 'Trusted Relationship'),
    T('T1659', 'Content Injection'),
    T('T1557', 'Adversary-in-the-Middle'),
    T('T1134', 'Access Token Manipulation'),
    T('T1110.004', 'Brute Force: Credential Stuffing'),
  ],
  variation: {
    topologies: [
      { id: 'public_rest', label: 'Public REST API behind a gateway', guide: 'An API gateway doing authentication and rate limits, a token issuer, several resource services, a database per service, and partner keys with broad scopes.' },
      { id: 'graphql_gateway', label: 'GraphQL gateway over several services', guide: 'A GraphQL gateway stitching services, per-field resolvers with their own auth, a batching layer, introspection, and a cost/complexity limiter of uncertain coverage.' },
      { id: 'mobile_bff', label: 'Mobile backend-for-frontend', guide: 'A BFF trusted by backends, device tokens, a refresh-token flow, a payments webhook, and an internal admin API on the same gateway.' },
      { id: 'partner_api', label: 'Partner-facing API with API keys and OAuth', guide: 'Partner integrations with API keys and OAuth clients, scoped tokens, a shared integration account, a webhook delivery system, and a sandbox that mirrors production data.' },
      { id: 'microservices_tokens', label: 'Microservices with token exchange', guide: 'Services calling each other with exchanged tokens, a service mesh, an authorization service, and one internal service that trusts the gateway header.' },
      { id: 'multi_tenant_api', label: 'Multi-tenant SaaS API', guide: 'Tenant id in the token and in resources, a tenant-resolution layer, bulk endpoints, an export API, and an impersonation endpoint for support.' },
      { id: 'webhook_platform', label: 'Webhook and callback platform', guide: 'Inbound webhooks from third parties, signature verification of varying rigour, a replay window, and an internal processing service triggered by them.' },
      { id: 'legacy_soap_rest', label: 'Legacy and modern APIs side by side', guide: 'A modern REST API with OAuth and an older API with basic auth on the same hosts, a shared user store, and a gateway that routes both.' },
    ],
    entryPoints: [
      { id: 'bola_object', label: 'Broken object-level authorisation on a resource', guide: 'An endpoint returns or modifies an object by id with only authentication, so one tenant or user reaches another’s records; logs show id enumeration.' },
      { id: 'bfla_function', label: 'Broken function-level authorisation on an admin action', guide: 'A privileged function is reachable by an ordinary token because the gateway authenticates but the service does not check role.' },
      { id: 'token_scope_wide', label: 'A token with a wider scope or audience than needed', guide: 'A partner or service token is accepted by an API it should not reach, or carries scopes far beyond the call’s need.' },
      { id: 'token_validation_weak', label: 'Weak token validation on one service', guide: 'A service accepts a token without checking audience, issuer or signature properly, so a token minted elsewhere is honoured.' },
      { id: 'mass_assignment_api', label: 'Mass assignment through a permissive endpoint', guide: 'An update endpoint binds unexpected fields (role, tenant, verified flag) from the request body.' },
      { id: 'logic_abuse', label: 'A business-logic abuse that looks like valid traffic', guide: 'A sequence of valid calls (coupon stacking, negative quantity, race on balance) produces an unintended effect; no single request is malformed.' },
      { id: 'rate_abuse', label: 'Resource exhaustion through an expensive query', guide: 'A costly GraphQL query or an unbounded list endpoint is called at scale, degrading the service for everyone.' },
      { id: 'webhook_forgery', label: 'A forged or replayed webhook', guide: 'Signature verification is missing or weak, so a forged callback triggers an internal action, or a captured one is replayed in the window.' },
      { id: 'bulk_export', label: 'A bulk or export endpoint authorised too loosely', guide: 'A bulk endpoint returns records across tenants or subjects with authentication only; one account pulls at volume.' },
      { id: 'legacy_basic_auth', label: 'A legacy endpoint with weaker auth on shared hosts', guide: 'An older API with basic auth shares the user store and host, giving a softer way to the same data.' },
    ],
    objectives: [
      { id: 'break_the_path', label: 'The single change that breaks the abuse', guide: 'Ask which one authorisation, token, gateway or service change stops the attacker reaching the objective; distractors are good API practices that address a different endpoint, a different flaw, or only the observed request.', question: 'Which single change most directly breaks the attack path shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'where_authz_fails', label: 'Where authorisation actually fails', guide: 'Ask which layer should have authorised this and did not (gateway vs service, object vs function level); distractors blame a layer that did enforce or a flaw not on the path.', question: 'Which layer failed to authorise this request, and why?', weights: { correctness: 30, reasoning: 45, architecture: 20, risk: 5 } },
      { id: 'token_reach', label: 'What the token actually permits', guide: 'Ask what this token’s scope, audience and lifetime truly allow against the services on the diagram; distractors over- or under-read the token, or assume the gateway constrains what the service does not.', question: 'Given its scope and audience, what does this token actually permit?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'detect_first', label: 'Where the abuse would be detected first', guide: 'Ask which log (gateway access log, auth log, service log, rate-limit metrics, data-access audit) would show it first; distractors exist but do not see this pattern (for example valid-looking logic abuse invisible to a WAF).', question: 'Which log source would reveal this abuse first, given the controls shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'data_reach', label: 'What data or actions the abuse reaches', guide: 'Ask which records, tenants or privileged actions the attacker reaches through this endpoint and token; distractors miss a reachable endpoint or over-state the token’s reach.', question: 'What data or actions can the attacker reach through this abuse?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'contain_now', label: 'The first containment action', guide: 'Ask for the first action that stops the abuse without taking the whole API down for every client or losing evidence; distractors are a full outage, a cosmetic block, or revoking the wrong credential.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'priority_order', label: 'The right order of two fixes under a constraint', guide: 'Ask which of two actions comes first given the constraint (for example revoke the over-scoped token before patching, or add object-level checks before re-enabling the endpoint); distractors invert the order.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
    ],
    constraints: [
      { id: 'partner_sla', label: 'Partner integrations have a contractual uptime SLA', guide: 'Avoid blanket key revocation when a scoped change works.' },
      { id: 'release_window', label: 'A code fix cannot ship until the next release', guide: 'Favour gateway/config mitigation and revocation over code that cannot ship yet.' },
      { id: 'gateway_only_auth', label: 'Services trust the gateway and do not re-check', guide: 'A gateway rule is the only same-hour lever; note what it cannot enforce.' },
      { id: 'multi_tenant', label: 'The abuse crosses tenant boundaries', guide: 'Blast radius spans customers; scope and notification matter.' },
      { id: 'payment_data', label: 'The endpoint touches payment data in PCI scope', guide: 'Scope and logging requirements apply.' },
      { id: 'high_traffic', label: 'The endpoint serves high legitimate traffic', guide: 'A blunt rate limit harms real users; target the abuse.' },
      { id: 'shared_integration_user', label: 'Several partners share one integration account', guide: 'Revoking it affects all of them; scoping matters.' },
    ],
    components: [
      'API gateway', 'rate limiter', 'token issuer', 'OAuth client', 'API key', 'access token', 'refresh token', 'token audience', 'token scope', 'authorization service', 'resource service', 'GraphQL resolver', 'introspection endpoint', 'backend-for-frontend', 'service mesh', 'tenant resolver', 'object-level check', 'function-level check', 'bulk endpoint', 'export endpoint', 'impersonation endpoint', 'webhook receiver', 'signature verification', 'replay window', 'per-service database', 'shared user store', 'legacy basic-auth API', 'gateway access log', 'auth log', 'service log', 'rate-limit metrics', 'data-access audit log',
    ],
  },
  guidance: `API Security realism rules:
- Use concrete endpoint and token names (for example "GET /v2/accounts/{id}", "POST /admin/payouts", "token aud=orders scope=read:self", "partner key pk_live_..."). Name the flaw class precisely (BOLA/object-level, BFLA/function-level, token scope/audience/validation, mass assignment, logic abuse, resource exhaustion, webhook forgery). Never invent framework features or CVEs.
- The attack path must be technically valid step by step: each step is a request, a token presented, an authorisation decision, or a trust the diagram shows. If a control (gateway authz, per-request object check, token audience validation, signature check, rate limit) would block a step, the path must go around it or the narrative must say why it did not apply.
- Be exact about where authorisation happens: authenticating at the gateway is not authorising at the object level; a scope limits what a token requests, not what a service forgets to check; a WAF does not see logic abuse made of valid requests.
- Distinguish the class from the symptom: blocking one id or one IP is not the same as object-level authorisation or token-audience validation.
- Trust boundaries are real boundaries: client, gateway/edge, authorization layer, each service, data tier, third-party/partner.
- The best answer must be the one an experienced API-security engineer would choose for this exact diagram and constraint; distractors must be sound API controls that address a different endpoint or flaw, do not break this path, or violate the constraint.
- Cite techniques from the ATT&CK Enterprise matrix only.`,
};
