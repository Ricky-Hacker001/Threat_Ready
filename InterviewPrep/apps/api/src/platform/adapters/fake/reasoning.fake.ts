import type { LlmRequest } from '../../ports/llm.port.js';

/**
 * Deterministic Attack Reasoning outputs for the fake LlmPort (tests and offline demos). Items are
 * derived from the variation seed in the prompt so different seeds give different text; grading is
 * derived from the justification so the quote checks and integrity rules run for real. Markers:
 *   ASSERT:<claimId>      the justification asserts a must-not-credit claim
 *   CHALLENGE:<pointId>   the challenger downgrades that point to missed
 *   TECHERROR             the challenger reports one technical error
 *   FLUENT_BUT_WRONG      the challenger flags fluent-but-wrong
 *   CVE-2024-99999        a hallucinated reference
 */
const lastUser = (req: LlmRequest) => req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
const tagged = (s: string, tag: string) => s.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1];
const line = (s: string, label: string) => s.match(new RegExp(`^- ${label}: ([^.\\n]+)\\.\\s*([^\\n]*)`, 'm'));
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function firstQuote(answer: string): string | null {
  const s = answer.trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  const q = s.length >= 8 ? s.slice(0, 200) : answer.trim().slice(0, 200);
  return q.length >= 8 ? q : null;
}

export function fakeReasoningItem(req: LlmRequest): unknown {
  const u = lastUser(req);
  const topology = line(u, 'Architecture topology');
  const entry = line(u, 'Attacker entry point');
  const objective = line(u, 'Assessment objective');
  const constraint = line(u, 'Operational constraint');
  const tech = u.match(/Primary \S+ technique: ([A-Z][\w.]*\d) ([^.\n]+)\./);
  const difficulty = req.system.match(/Difficulty: (beginner|intermediate|advanced|expert)/)?.[1] ?? 'intermediate';
  const topo = topology?.[1] ?? 'Three-tier web application';
  const topoGuide = topology?.[2] ?? '';
  const ent = entry?.[1] ?? 'A leaked access key';
  const entGuide = entry?.[2] ?? '';
  const obj = objective?.[1] ?? 'The single control that breaks the attack path';
  const objGuide = objective?.[2] ?? '';
  const cons = constraint?.[1] ?? 'A change freeze is in force';
  const consGuide = constraint?.[2] ?? '';
  const question = u.match(/The question must be: "([^"]+)"/)?.[1] ?? 'Which single change most directly breaks the attack path shown?';
  const companies = ['Northwind Logistics', 'Kestrel Payments', 'Orbital Health', 'Halden Retail', 'Meridian Insurance', 'Tidewater Energy', 'Larkspur Media', 'Granite Bank'];
  const company = companies[hash(`${topo}|${ent}|${obj}`) % companies.length]!;
  const seedWords = `${topo} ${ent} ${obj}`.toLowerCase();
  const data = /payment|retail|bank/.test(company.toLowerCase()) ? 'card tokens and order history' : /health/.test(company.toLowerCase()) ? 'patient records' : 'customer contracts and invoices';

  // Labels, phrasing and options vary with the seed so two seeds read as two different questions:
  // every sentence picks from four or more variants on different hash bits, so two items share few
  // word trigrams even when the learner has seen many.
  const v = hash(`${topo}|${ent}|${obj}|${cons}`);
  const v2 = hash(`${cons}|${obj}|${ent}|${topo}|salt`);
  const pick = <T,>(xs: T[], n: number) => xs[(((n < 16 ? v >>> n : v2 >>> (n - 16)) ^ (n * 2654435761)) >>> 0) % xs.length]!;
  const labels = {
    attacker: pick(['internet attacker', 'external threat actor', 'unknown remote operator', 'outside adversary'], 1),
    lb: pick(['public load balancer', 'edge gateway', 'CDN front door', 'ingress proxy'], 3),
    app: pick(['orders web app', 'billing API', 'claims portal', 'ingest service', 'partner dashboard'], 5),
    role: pick(['deploy-prod role', 'ci-release role', 'ops-automation role', 'pipeline-runner role'], 7),
    db: pick(['customer database', 'ledger table', 'records cluster', 'accounts warehouse'], 9),
    bucket: pick(['exports-prod bucket', 'archive-raw store', 'reports-share bucket', 'snapshots-nightly bucket'], 11),
    idp: pick(['SSO identity provider', 'corporate directory', 'workforce SSO', 'central login service'], 13),
    trail: pick(['control-plane audit log', 'cloud API trail', 'management-plane log', 'account activity journal'], 15),
  };
  const minutes = 4 + (v % 11);
  const hour = String(1 + (v % 22)).padStart(2, '0');
  const sentence = (n: number, variants: string[]) => pick(variants, n);
  const scenario = [
    `${company} runs a ${topo.toLowerCase()} for ${data}.`,
    topoGuide,
    sentence(17, [`Requests arrive at the ${labels.lb} and land on the ${labels.app}.`, `Customers reach the ${labels.lb}, which routes them to the ${labels.app}.`, `Partners connect through the ${labels.lb}; sessions terminate at the ${labels.app}.`, `Every visit passes the ${labels.lb} on its way to the ${labels.app}.`]),
    sentence(19, [`The ${labels.app} reads and writes the ${labels.db} and writes nightly exports to the ${labels.bucket}.`, `The ${labels.app} queries the ${labels.db} and publishes reports into the ${labels.bucket}.`, `The ${labels.app} updates the ${labels.db} and archives batches in the ${labels.bucket}.`, `From the ${labels.app}, writes go to the ${labels.db} and periodic dumps to the ${labels.bucket}.`]),
    sentence(21, [`Deployments run under the ${labels.role}, which can read the ${labels.bucket} and change the application.`, `Releases are applied by the ${labels.role}; its policy also allows reading the ${labels.bucket}.`, `Automation executes as the ${labels.role}, with rights over the ${labels.bucket} and the deployment.`, `The ${labels.role} ships new versions and, for convenience, can list and fetch the ${labels.bucket}.`]),
    sentence(23, [`Staff authenticate with the ${labels.idp}; every control-plane call lands in the ${labels.trail}.`, `Engineers sign in via the ${labels.idp}, and the ${labels.trail} keeps every API call.`, `The ${labels.idp} fronts all human access, while the ${labels.trail} records the management plane.`, `Human logins go through the ${labels.idp}; the ${labels.trail} is immutable and complete.`]),
    `${cons}.`,
    consGuide,
    sentence(25, ['The platform team is three people.', 'Security is a shared duty across engineering.', 'A managed detection service watches the account.', 'An external SOC receives alerts with a two-hour SLA.', 'Audits last year found no open findings.']),
  ].join(' ');
  const narrative = [
    `${ent}.`,
    entGuide,
    sentence(27, [`At ${hour}:14 the ${labels.trail} records the first calls from an address nobody recognises, acting as the ${labels.role}.`, `The ${labels.trail} shows, at ${hour}:14, API calls as the ${labels.role} from a network the team has never used.`, `Just after ${hour}:14 the ${labels.trail} captures the ${labels.role} being used from an unfamiliar address.`, `Starting ${hour}:14, entries in the ${labels.trail} attribute unusual calls to the ${labels.role}.`]),
    sentence(29, [`Within ${minutes} minutes the attacker enumerated the ${labels.bucket} and started pulling objects, then probed the ${labels.db} from the ${labels.app} network.`, `${minutes} minutes later the ${labels.bucket} was listed and downloads began; connection attempts to the ${labels.db} followed from the ${labels.app} subnet.`, `The ${labels.bucket} was walked inside ${minutes} minutes, objects were fetched, and the ${labels.db} was reached for from the ${labels.app} network.`, `After ${minutes} minutes of listing, exports left the ${labels.bucket}; the ${labels.db} then saw scans originating in the ${labels.app} network.`]),
    `The decision in front of you is ${obj.toLowerCase()}.`,
    objGuide,
  ].join(' ');
  const correct = 'B';
  const options = [
    { id: 'A', text: `${pick(['Rotate every credential in the account', 'Reset all keys and tokens at once', 'Re-issue every identity in the account', 'Invalidate all secrets across the account'], 20)} and force all staff to sign in again through the ${labels.idp} before anything else.` },
    { id: 'B', text: `${pick(['Revoke', 'Terminate', 'Cut off', 'End'], 2)} the ${labels.role} session and scope its policy so it can no longer read the ${labels.bucket} or reach the ${labels.db} network.` },
    { id: 'C', text: `${pick(['Add alerting on the', 'Raise the logging level of the', 'Watch the', 'Set a threshold alarm on the'], 22)} ${labels.trail} and wait for the next anomalous call before changing any permission.` },
    { id: 'D', text: `Take the ${labels.lb} offline so no further requests reach the ${labels.app} while the investigation ${pick(['runs', 'proceeds', 'continues', 'is under way'], 24)}.` },
  ];
  return {
    title: `${company}: ${obj}`,
    scenario,
    attack_narrative: narrative,
    objective: obj,
    question,
    options,
    correct_option: correct,
    option_analysis: [
      { id: 'A', verdict: 'plausible', why: 'Rotating everything stops the attacker too, but it is wider than needed and conflicts with the constraint; you lose the evidence trail of which identity was used.' },
      { id: 'B', verdict: 'best', why: `Revoking and scoping the ${labels.role} cuts the path the attacker is using right now without touching the public path or destroying audit evidence.` },
      { id: 'C', verdict: 'wrong', why: 'Waiting while exfiltration is under way accepts more data loss for no gain in evidence.' },
      { id: 'D', verdict: 'weak', why: 'The attacker is not coming through the load balancer; taking it down hurts the business and leaves the compromised identity active.' },
    ],
    diagram: {
      boundaries: [
        { id: 'internet', label: 'Internet', kind: 'internet' },
        { id: 'edge', label: 'Public subnet', kind: 'edge' },
        { id: 'vpc', label: 'Private subnet', kind: 'private' },
        { id: 'data', label: 'Data tier', kind: 'data' },
        { id: 'identity', label: 'Identity', kind: 'identity' },
      ],
      nodes: [
        { id: 'attacker', label: labels.attacker, type: 'attacker', boundary: 'internet', detail: 'Unknown address', compromised: false, entry_point: false, controls: [] },
        { id: 'lb', label: labels.lb, type: 'gateway', boundary: 'edge', detail: 'HTTPS only', compromised: false, entry_point: false, controls: ['WAF'] },
        { id: 'app', label: labels.app, type: 'web', boundary: 'vpc', detail: 'Stateless containers', compromised: true, entry_point: false, controls: [] },
        { id: 'role', label: labels.role, type: 'identity', boundary: 'identity', detail: 'Long-lived key used by CI', compromised: true, entry_point: true, controls: [] },
        { id: 'db', label: labels.db, type: 'database', boundary: 'data', detail: data, compromised: false, entry_point: false, controls: ['encryption at rest'] },
        { id: 'bucket', label: labels.bucket, type: 'storage', boundary: 'data', detail: 'Nightly exports', compromised: false, entry_point: false, controls: ['versioning'] },
        { id: 'idp', label: labels.idp, type: 'identity', boundary: 'identity', detail: 'SSO with MFA', compromised: false, entry_point: false, controls: ['MFA'] },
        { id: 'trail', label: labels.trail, type: 'control', boundary: 'identity', detail: 'All API calls', compromised: false, entry_point: false, controls: ['immutable retention'] },
        ...(difficulty === 'advanced' || difficulty === 'expert' ? [
          { id: 'cache', label: 'session cache', type: 'service' as const, boundary: 'vpc', detail: 'Reused password', compromised: false, entry_point: false, controls: [] as string[] },
          { id: 'peer', label: 'peered analytics VPC', type: 'network' as const, boundary: 'data', detail: 'Full-mesh peering', compromised: false, entry_point: false, controls: [] as string[] },
          { id: 'ci', label: 'CI runner pool', type: 'compute' as const, boundary: 'vpc', detail: 'Holds the deploy key', compromised: false, entry_point: false, controls: [] as string[] },
        ] : []),
      ],
      edges: [
        { id: 'e1', from: 'lb', to: 'app', label: 'HTTPS 443', kind: 'data' },
        { id: 'e2', from: 'app', to: 'db', label: 'SQL 5432', kind: 'data' },
        { id: 'e3', from: 'app', to: 'bucket', label: 'writes exports', kind: 'data' },
        { id: 'e4', from: 'idp', to: 'app', label: 'staff sign-in', kind: 'auth' },
        { id: 'e5', from: 'role', to: 'app', label: 'deploys', kind: 'control' },
        { id: 'a1', from: 'role', to: 'bucket', label: 'lists and downloads exports', kind: 'attack' },
        { id: 'a2', from: 'bucket', to: 'db', label: 'pivots toward the database network', kind: 'attack' },
        ...(difficulty === 'advanced' || difficulty === 'expert' ? [{ id: 'a3', from: 'db', to: 'idp', label: 'reuses a stored admin credential against SSO', kind: 'attack' as const }] : []),
      ],
      attack_path: difficulty === 'advanced' || difficulty === 'expert' ? ['a1', 'a2', 'a3'] : difficulty === 'beginner' ? ['a1'] : ['a1', 'a2'],
    },
    rubric: [
      { id: 'r1', dimension: 'reasoning', text: 'States that the attacker is operating as the deploy-prod role and that revoking that identity stops the current activity', weight: '5', hint: 'Name the identity the attacker is using; the audit log shows it is the deploy-prod role.', explanation: 'The path runs through one identity; cutting it ends the activity.' },
      { id: 'r2', dimension: 'reasoning', text: 'Uses the audit log evidence (unknown address, timing) to justify acting now rather than waiting', weight: '3', hint: 'Cite the audit log entries that show active exfiltration.', explanation: 'Evidence of active download justifies immediate action.' },
      { id: 'r3', dimension: 'reasoning', text: 'Explains why the narrower action is preferred over rotating everything or taking the load balancer down', weight: '3', hint: 'Compare the chosen action with the wider alternatives and say what they would cost.', explanation: 'Proportional containment preserves the service and the evidence.' },
      { id: 'a1', dimension: 'architecture', text: 'Traces the attack path from the role to the exports bucket and toward the database network', weight: '4', hint: 'Walk the path on the diagram: role, exports bucket, database network.', explanation: 'The diagram shows two attack edges; the answer must follow them.' },
      { id: 'a2', dimension: 'architecture', text: 'Recognises that the public load balancer is not on the attack path', weight: '2', hint: 'Check which edges carry the attack; the load balancer carries none.', explanation: 'The entry point is an identity, not the public path.' },
      { id: 'k1', dimension: 'risk', text: 'Addresses evidence preservation and the stated operational constraint', weight: '3', hint: 'Say what you keep (logs, the compromised key for forensics) and how the constraint shapes the action.', explanation: 'Containment must respect the constraint and keep evidence.' },
    ],
    must_not_credit: [{ id: 'm1', claim: 'The web application firewall would have blocked this attack', why: 'The attacker never passed through the load balancer or the WAF.', invalidates: ['a2'] }],
    reference_answer: `The attacker holds the ${labels.role} and is using it, right now, to download exports and probe the database network. The narrowest action that ends that is to revoke the role's current session and scope its policy so it can no longer read the ${labels.bucket} or reach the data tier. That keeps the ${labels.lb} and the application serving customers, respects the constraint, and leaves the ${labels.trail} intact for the investigation. Rotating every credential is wider than needed; alerting and waiting accepts more loss; taking the load balancer offline does nothing to an attacker who entered through an identity.`,
    // Only the seed's assigned technique, so the item stays valid for any domain's framework
    // (ATT&CK or ATLAS). A second hardcoded id would belong to one framework and break the others.
    techniques: [{ id: tech?.[1] ?? 'T1078.004', name: tech?.[2] ?? 'Valid Accounts: Cloud Accounts' }],
    concepts: ['least privilege', 'credential revocation', 'blast radius', 'evidence preservation', seedWords.split(' ')[0] ?? 'containment'],
    difficulty,
  };
}

interface GradingContext {
  pointIds: { id: string; dimension: string }[];
  claimIds: string[];
  selected: string;
  correct: string;
  justification: string;
  question: string;
}

function gradingContext(req: LlmRequest): GradingContext {
  const u = lastUser(req);
  return {
    pointIds: [...u.matchAll(/^- \[([a-z0-9_-]+)\] \((reasoning|architecture|risk)/gm)].map((m) => ({ id: m[1]!, dimension: m[2]! })),
    claimIds: [...u.matchAll(/^- \{([a-z0-9_-]+)\}:/gm)].map((m) => m[1]!),
    selected: u.match(/Selected option: ([A-D])/)?.[1] ?? 'A',
    correct: u.match(/the best option is ([A-D])/)?.[1] ?? 'B',
    justification: tagged(u, 'untrusted_justification') ?? '',
    question: u.match(/^Question: ([^\n]+)/m)?.[1] ?? 'the question',
  };
}

const injected = (s: string) => /ignore (all|previous)|award (me|full)|give (me )?(full|maximum) marks/i.test(s);
const arguesFor = (s: string, selected: string): string | null => {
  const m = s.match(/I (?:would )?(?:choose|pick|select|prefer) option ([A-D])/i);
  return m && m[1]!.toUpperCase() !== selected ? m[1]!.toUpperCase() : null;
};

export function fakeReasoningEvaluator(req: LlmRequest): unknown {
  const c = gradingContext(req);
  const n = words(c.justification).length;
  const quote = firstQuote(c.justification);
  const asserted = [...c.justification.matchAll(/ASSERT:([a-z0-9_-]+)/g)].map((m) => m[1]!).filter((id) => c.claimIds.includes(id));
  const points = c.pointIds.map((p, i) => {
    let status: 'met' | 'partial' | 'missed' = 'missed';
    if (n >= 45) status = 'met';
    else if (n >= 20) status = i < Math.ceil(c.pointIds.length / 2) ? 'met' : 'missed';
    else if (n >= 6) status = i === 0 ? 'partial' : 'missed';
    return { point_id: p.id, status, rationale: status === 'missed' ? 'Not stated in the justification.' : `Stated in the justification (${p.dimension}).`, evidence_quote: status === 'missed' ? null : quote };
  });
  return {
    points,
    asserted_claims: asserted,
    incorrect_claims: /WRONGCLAIM/.test(c.justification) ? [{ quote: 'WRONGCLAIM', why: 'This claim is wrong for the scenario.' }] : [],
    integrity: { off_topic: n > 0 && n < 3, instructs_grader: injected(c.justification), argues_for_option: arguesFor(c.justification, c.selected) },
    strengths: n >= 20 ? ['You named the identity the attacker is using.'] : [],
    gaps: n < 45 ? ['You did not walk the attack path on the diagram.'] : [],
  };
}

export function fakeReasoningChallenger(req: LlmRequest): unknown {
  const c = gradingContext(req);
  const j = c.justification;
  const challenges = [...j.matchAll(/CHALLENGE:([a-z0-9_-]+)/g)].map((m) => m[1]!).filter((id) => c.pointIds.some((p) => p.id === id)).map((id) => ({ point_id: id, suggested_status: 'missed' as const, reason: 'The quoted sentence does not actually show this point.' }));
  return {
    challenges,
    technical_errors: /TECHERROR/.test(j) ? [{ quote: 'TECHERROR', why: 'Technically incorrect for this architecture.' }] : [],
    hallucinated_references: /CVE-\d{4}-99999|T1078\.099/.test(j) ? [{ reference: 'CVE-2024-99999', why: 'This identifier does not exist.' }] : [],
    fluent_but_wrong: /FLUENT_BUT_WRONG/.test(j),
    missing_critical: [],
    contradicts_selection: arguesFor(j, c.selected) !== null,
    asserted_claims: [],
    overall_assessment: challenges.length ? 'Some credited points are not supported by the quoted evidence.' : 'The evaluation is consistent with the justification.',
  };
}

export function fakeReasoningReconciler(req: LlmRequest): unknown {
  const c = gradingContext(req);
  const u = lastUser(req);
  const evaluator = JSON.parse(tagged(u, 'evaluator_output') ?? '{"points":[],"asserted_claims":[],"integrity":{"off_topic":false,"instructs_grader":false,"argues_for_option":null}}') as ReturnType<typeof fakeReasoningEvaluator> & {
    points: { point_id: string; status: string; rationale: string; evidence_quote: string | null }[];
    asserted_claims: string[];
    integrity: { off_topic: boolean; instructs_grader: boolean; argues_for_option: string | null };
  };
  const challengerRaw = tagged(u, 'challenger_output');
  const challenger = challengerRaw ? (JSON.parse(challengerRaw) as { challenges: { point_id: string; suggested_status: string; reason: string }[]; technical_errors: { quote: string; why: string }[] }) : null;
  const final_points = evaluator.points.map((p) => {
    const ch = challenger?.challenges.find((x) => x.point_id === p.point_id);
    return ch ? { point_id: p.point_id, status: ch.suggested_status, rationale: ch.reason, evidence_quote: null } : p;
  });
  const others = ['A', 'B', 'C', 'D'].filter((o) => o !== c.correct);
  const correct = c.selected === c.correct;
  return {
    final_points,
    confirmed_technical_errors: challenger?.technical_errors ?? [],
    asserted_claims: evaluator.asserted_claims,
    integrity: evaluator.integrity,
    feedback: {
      decision: `You selected option ${c.selected}. ${correct ? 'That is the best decision for this scenario: it cuts the identity the attacker is using.' : `The best decision is option ${c.correct}, which cuts the identity the attacker is using.`}`,
      reasoning: `Your justification for "${c.question}" ${final_points.every((p) => p.status === 'met') ? 'covered the attack path, the evidence and the trade-offs.' : 'left part of the rubric unaddressed.'}`,
      got_right: final_points.filter((p) => p.status !== 'missed').map((p) => `You showed: ${p.point_id}.`),
      missed: final_points.filter((p) => p.status === 'missed').map((p) => `You did not address: ${p.point_id}.`),
      why_best: `Option ${c.correct} removes the deploy-prod role's access that the attacker is using while keeping the public path and the audit log intact.`,
      why_alternatives: others.map((o) => ({ option: o, why: `Option ${o} either acts too widely, waits too long or acts on a component that is not on the attack path.` })),
      architecture_analysis: 'The entry point is an identity (the deploy-prod role) rather than the public path; the path runs to the exports bucket and toward the database network, crossing from the identity boundary into the data tier.',
      expert_explanation: 'Contain the identity in use, keep the service and the evidence, then harden: scope the role, add short-lived credentials and alert on reads from unknown addresses.',
      improve: ['Walk the attack path edge by edge before choosing a control.', 'Name the evidence that justifies acting now.'],
    },
    confidence_note: challenger ? 'Stages agree.' : 'Challenger unavailable.',
  };
}

export function fakeReasoning(name: string, req: LlmRequest): unknown {
  switch (name) {
    case 'reasoning_item':
      return fakeReasoningItem(req);
    case 'reasoning_evaluator':
      return fakeReasoningEvaluator(req);
    case 'reasoning_challenger':
      return fakeReasoningChallenger(req);
    case 'reasoning_reconciler':
      return fakeReasoningReconciler(req);
    default:
      return undefined;
  }
}
