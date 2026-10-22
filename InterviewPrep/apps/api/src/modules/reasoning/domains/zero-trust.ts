import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Zero Trust Architecture: policy enforcement points, device and identity signals, and what breaks
 * when trust is implicit. The diagram shows PEPs, the policy engine, the signals feeding it, and
 * the resources; the attack rides an implicit trust, a missing signal, or a bypassed PEP.
 */
export const ZERO_TRUST: ReasoningDomain = {
  key: 'zero_trust',
  title: 'Zero Trust Architecture',
  description: 'Read a zero-trust architecture with an active compromise, decide which implicit trust, missing signal or bypassed enforcement point the attack depends on, and defend the decision with evidence from the policy and access logs.',
  track: 'Architecture',
  difficulty: 'advanced',
  focus: [
    'Where enforcement actually happens versus where the diagram implies it does',
    'The signals a policy decision depends on, and what a missing one allows',
    'Implicit trust that survives a zero-trust rollout (flat internal paths, legacy auth, service-to-service)',
    'Blast radius when one policy enforcement point is bypassed',
  ],
  skillIds: ['iam.privileged_access', 'iam.federation', 'netsec.segmentation', 'cloudsec.iam', 'appsec.authz'],
  weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1078', 'Valid Accounts'),
    T('T1078.004', 'Valid Accounts: Cloud Accounts'),
    T('T1550.001', 'Use Alternate Authentication Material: Application Access Token'),
    T('T1550.004', 'Use Alternate Authentication Material: Web Session Cookie'),
    T('T1539', 'Steal Web Session Cookie'),
    T('T1528', 'Steal Application Access Token'),
    T('T1199', 'Trusted Relationship'),
    T('T1484.002', 'Domain or Tenant Policy Modification: Trust Modification'),
    T('T1557', 'Adversary-in-the-Middle'),
    T('T1090', 'Proxy'),
    T('T1572', 'Protocol Tunneling'),
    T('T1021.007', 'Remote Services: Cloud Services'),
    T('T1021.001', 'Remote Services: Remote Desktop Protocol'),
    T('T1098.003', 'Account Manipulation: Additional Cloud Roles'),
    T('T1556', 'Modify Authentication Process'),
    T('T1606.002', 'Forge Web Credentials: SAML Tokens'),
    T('T1133', 'External Remote Services'),
    T('T1535', 'Unused/Unsupported Cloud Regions'),
    T('T1648', 'Serverless Execution'),
    T('T1596', 'Search Open Technical Databases'),
  ],
  variation: {
    topologies: [
      { id: 'ztna_apps', label: 'ZTNA brokering access to internal apps', guide: 'A policy engine, a ZTNA broker as the enforcement point, identity and device-posture signals, internal apps behind the broker, and a few legacy apps still reachable on the network.' },
      { id: 'beyondcorp_web', label: 'Identity-aware proxy in front of web apps', guide: 'An identity-aware proxy enforcing per-request policy, device certificates, an access policy engine, backends that trust the proxy header, and a direct backend path that skips the proxy.' },
      { id: 'microseg_workloads', label: 'Microsegmented workloads with service identity', guide: 'Workloads with issued service identities and mTLS, an authorization policy layer, a policy engine, and a shared services tier some workloads reach implicitly.' },
      { id: 'sase_remote', label: 'SASE for a remote workforce', guide: 'A cloud edge enforcing identity and posture, split policies per app, a CASB for SaaS, and a full-tunnel legacy profile for contractors.' },
      { id: 'cloud_resource_policy', label: 'Cloud with per-resource policy and conditions', guide: 'Resource policies conditioned on identity, network and device, a central policy engine, workload identities, and a legacy resource with a permissive policy.' },
      { id: 'privileged_ztna', label: 'Zero-trust privileged access', guide: 'Just-in-time elevation gated by policy, a broker for admin sessions, device and risk signals, session recording, and a break-glass path outside policy.' },
      { id: 'partner_access', label: 'Zero-trust access for partners', guide: 'Partner identities federated in, policy limiting them to specific apps, device posture not available for partners, and a shared workspace they reach.' },
      { id: 'api_mesh_ztna', label: 'Zero trust across an internal API mesh', guide: 'Service-to-service calls authorized per request, a policy engine, token exchange between services, and one internal service that trusts callers by network position.' },
    ],
    entryPoints: [
      { id: 'stolen_session_token', label: 'A stolen session or access token presented to a PEP', guide: 'A valid token or cookie, captured earlier, is replayed to the enforcement point; without a device or continuous signal the policy admits it.' },
      { id: 'backend_direct', label: 'A backend reachable without going through the proxy', guide: 'The resource trusts a header or the network and can be reached directly, bypassing the identity-aware proxy entirely.' },
      { id: 'missing_device_signal', label: 'A policy that cannot see device posture for a population', guide: 'Partners or BYOD lack a posture signal, so the policy falls back to identity alone and admits a compromised but authenticated principal.' },
      { id: 'legacy_auth_path', label: 'A legacy authentication path outside policy', guide: 'An app or protocol that predates the rollout authenticates without the policy engine, giving an unconditioned way in.' },
      { id: 'service_implicit_trust', label: 'A service that trusts callers by network position', guide: 'One internal service authorizes by source network rather than identity, so any workload that reaches it is trusted.' },
      { id: 'token_exchange_abuse', label: 'Over-broad token exchange between services', guide: 'A service exchanges its token for one with wider scope than the call needs, which a compromised caller inherits.' },
      { id: 'break_glass_path', label: 'A break-glass account outside the policy engine', guide: 'An emergency account bypasses conditional policy and is weakly protected.' },
      { id: 'pep_bypass_route', label: 'A network route that skips the enforcement point', guide: 'Peering or a legacy route lets traffic reach resources without crossing the PEP.' },
      { id: 'posture_spoof', label: 'A posture or risk signal that can be influenced', guide: 'The device/risk signal the policy trusts can be forged or stale, so the decision is made on bad input.' },
      { id: 'federation_trust_added', label: 'An added federation or trust the policy honours', guide: 'A new inbound trust or role is honoured by the policy engine, admitting the attacker as a trusted identity.' },
    ],
    objectives: [
      { id: 'break_the_path', label: 'The single change that restores an effective control', guide: 'Ask which one enforcement, signal, trust or routing change stops the attacker reaching the resource; distractors are sound zero-trust practices that address a different gap or do not apply here.', question: 'Which single change most directly breaks the attack path shown?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'implicit_trust', label: 'The implicit trust the attack relies on', guide: 'Ask which implicit trust, missing signal or bypassed PEP the step depends on; distractors name a control that did apply or a trust not on the path.', question: 'Which implicit trust or missing signal does this attack rely on?', weights: { correctness: 30, reasoning: 45, architecture: 20, risk: 5 } },
      { id: 'where_enforced', label: 'Where enforcement actually happens on this path', guide: 'Ask at which point the request is truly evaluated versus where the diagram only implies it; distractors assume enforcement at a point the traffic can skip.', question: 'Where on this path is policy actually enforced, and where is it only assumed?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'detect_first', label: 'Where the bypass would be detected first', guide: 'Ask which log (policy-decision log, proxy access log, resource audit, identity sign-in) would show it first; distractors exist but do not see a request that skipped the PEP.', question: 'Which log source would reveal this first, given the controls shown?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'blast_radius', label: 'The blast radius when one PEP is bypassed', guide: 'Ask what the attacker reaches once this enforcement point is bypassed or this trust is used, through the resources and further trusts on the diagram; distractors miss a reachable resource or over-state one token’s scope.', question: 'What can the attacker reach once this enforcement point is bypassed?', weights: { correctness: 30, reasoning: 30, architecture: 35, risk: 5 } },
      { id: 'contain_now', label: 'The first containment action', guide: 'Ask for the first action that cuts the bypass without locking out the whole workforce or every service call; distractors are too broad, too narrow, or leave the bypass open.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 20, risk: 15 } },
      { id: 'priority_order', label: 'The right order of two steps under a constraint', guide: 'Ask which of two actions comes first given the constraint (for example close the PEP-bypass route before tightening policy, or revoke the token before re-enabling the app); distractors invert the order.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 20, risk: 15 } },
    ],
    constraints: [
      { id: 'rollout_partial', label: 'The zero-trust rollout is only partly complete', guide: 'Legacy paths still exist; controls must account for them.' },
      { id: 'partners_no_posture', label: 'Partner devices cannot provide a posture signal', guide: 'Policy for that population cannot rely on device state.' },
      { id: 'workforce_uptime', label: 'Blanket policy tightening would lock out the workforce', guide: 'Prefer targeted change over a global deny.' },
      { id: 'legacy_app_required', label: 'A legacy app on the bypass path cannot be retired yet', guide: 'Wrap a control around it rather than removing it.' },
      { id: 'break_glass_needed', label: 'A break-glass path must remain for emergencies', guide: 'Tighten without removing the emergency route.' },
      { id: 'service_calls_critical', label: 'Service-to-service calls are latency-sensitive', guide: 'Enforcement changes must not break the call path.' },
      { id: 'single_policy_owner', label: 'One team owns the policy engine and is stretched', guide: 'Prefer durable policy over bespoke per-case rules.' },
    ],
    components: [
      'policy engine', 'policy enforcement point', 'ZTNA broker', 'identity-aware proxy', 'identity provider', 'device-posture signal', 'risk signal', 'conditional access policy', 'session token', 'access token', 'token exchange', 'service identity', 'mTLS', 'authorization policy', 'internal app', 'legacy app', 'legacy auth path', 'backend service', 'shared services tier', 'break-glass account', 'CASB', 'SASE edge', 'resource policy', 'workload identity', 'federation trust', 'network route', 'VPC peering', 'policy-decision log', 'proxy access log', 'resource audit log', 'sign-in log', 'partner identity',
    ],
  },
  guidance: `Zero Trust Architecture realism rules:
- Use concrete, provider-neutral names (for example "policy engine", "ZTNA broker", "IAP", "posture signal device-compliant", "service billing->ledger call") and name the enforcement point explicitly. Never invent product features that do not exist.
- The attack path must be technically valid step by step: each step uses a token, a bypass route, a missing signal, an implicit trust, an over-broad token exchange, or a PEP the traffic can skip — all shown on the diagram. If a control (continuous evaluation, device binding, per-request authorization, a closed route) would block a step, the path must go around it or the narrative must say why it did not apply.
- Be exact about where enforcement happens: a backend that trusts a proxy header is only protected if traffic cannot reach it except through the proxy; identity alone is not zero trust if device/risk signals are absent; a token admitted once without continuous evaluation stays valid until it expires.
- This domain runs at advanced difficulty: include a trust relationship or missing signal most readers miss, and a control on the diagram that does not apply for a stated reason.
- Trust boundaries are real boundaries: the enforcement point is the boundary — anything reachable without crossing it is outside zero trust regardless of the label.
- The best answer must be the one an experienced zero-trust architect would choose for this exact diagram and constraint; distractors must be sound zero-trust practices that address a different gap, do not break this path, or violate the constraint.
- Cite techniques from the ATT&CK Enterprise matrix only.`,
};
