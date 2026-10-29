import { getArchitecture, pathNodeIds, sampleOverlay, surfacesFor, type ArchitectureDef, type AttackOverlay } from '../../../modules/reasoning/architectures/index.js';
import { getDomain } from '../../../modules/reasoning/domains/index.js';
import type { LlmRequest } from '../../ports/llm.port.js';

/**
 * Deterministic library question (schema `reasoning_question`, gen.v3) for the fake LlmPort (tests and
 * offline demos). It reads the architecture, the domain, the surface and the variation from the request,
 * takes a route the library itself can draw for that surface (sampleOverlay), and writes text that names
 * the path's components by label, so the quality gate runs for real. Every sentence is picked from
 * several variants on different bits of a hash of the whole variation, so two variations on one
 * architecture read as two different questions once the architecture's own wording is set aside.
 * Option B is always the best one (the evaluation fakes and the end-to-end tests rely on it).
 */
const lastUser = (req: LlmRequest) => req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function fakeReasoningQuestion(req: LlmRequest): unknown {
  const u = lastUser(req);
  const arch = getArchitecture(u.match(/^- Architecture: (\S+)/m)?.[1] ?? '');
  const domain = getDomain(u.match(/\(domain ([a-z_]+)\)/)?.[1] ?? '');
  if (!arch || !domain) return undefined;
  const surfaces = surfacesFor(arch, domain.key);
  const surface = surfaces.find((s) => s.id === u.match(/^- Attack surface \(([^)]+)\)/m)?.[1]) ?? surfaces[0];
  if (!surface) return undefined;
  const objective = domain.variation.objectives.find((o) => o.id === u.match(/^- Assessment objective \(([^)]+)\)/m)?.[1]) ?? domain.variation.objectives[0]!;
  const constraint = domain.variation.constraints.find((c) => c.id === u.match(/^- Operational constraint \(([^)]+)\)/m)?.[1]) ?? domain.variation.constraints[0]!;
  const techId = u.match(/^- Primary \S+ technique: (\S+) /m)?.[1];
  const technique = domain.techniques.find((t) => t.id === techId) ?? domain.techniques.find((t) => surface.techniques.includes(t.id)) ?? domain.techniques[0]!;
  const level = arch.level;

  const key = `${arch.id}|${surface.id}|${objective.id}|${technique.id}|${constraint.id}`;
  const v = hash(key);
  const v2 = hash(`${key}|salt`);
  const pick = <T,>(xs: readonly T[], n: number): T => xs[(((n < 16 ? v >>> n : v2 >>> (n - 16)) ^ (n * 2654435761)) >>> 0) % xs.length]!;
  // A seeded stream for the details that make two variations read differently (addresses, counts, adverbs).
  let state = (v ^ Math.imul(v2, 2654435761)) >>> 0;
  const rnd = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const any = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const addr = () => `${any(['198.51.100', '203.0.113', '192.0.2', '100.64.12'])}.${2 + Math.floor(rnd() * 250)}`;
  const detail = () =>
    any([
      `from ${addr()}`,
      `${3 + Math.floor(rnd() * 400)} requests in a burst`,
      `session ${Math.floor(rnd() * 9000 + 1000)}`,
      `user agent ${any(['curl', 'python-requests', 'Go-http-client', 'aws-cli', 'PowerShell'])} ${1 + Math.floor(rnd() * 9)}.${Math.floor(rnd() * 30)}`,
      `${2 + Math.floor(rnd() * 90)} objects touched`,
      `error rate ${1 + Math.floor(rnd() * 40)} percent`,
    ]);
  const adverb = () => any(['quietly', 'quickly', 'repeatedly', 'methodically', 'carefully', 'abruptly', 'slowly', 'openly']);
  const overlay = sampleOverlay(arch, surface, level, { variant: v % 4 }) ?? sampleOverlay(arch, surface, level);
  if (!overlay) return undefined;
  const label = (id: string) => arch.diagram.nodes.find((n) => n.id === id)?.label ?? arch.attackerOrigins.find((o) => o.id === id)?.label ?? id;
  const path = pathNodeIds(overlay);
  const comps = path.filter((id) => arch.diagram.nodes.some((n) => n.id === id));
  const entry = label(overlay.entryNode);
  const target = label(comps[comps.length - 1]!);
  const log = arch.logSources[v % arch.logSources.length]?.label ?? 'audit log';
  const offPath = arch.diagram.nodes.filter((n) => !path.includes(n.id));
  const off = (offPath.find((n) => n.type === 'gateway' || n.type === 'web') ?? offPath[0] ?? arch.diagram.nodes[0]!).label;
  const control = arch.controls.find((c) => c.status === 'present')?.label ?? arch.controls[0]?.label ?? 'the firewall';
  const steps = withLabels(arch, overlay, pick);

  const hour = 1 + (v % 21);
  const at = (i: number) => `${String(hour + Math.floor((i * 7 + (v2 % 13)) / 60)).padStart(2, '0')}:${String((i * 7 + (v2 % 13)) % 60).padStart(2, '0')}`;
  const ticket = `${pick(['INC', 'SEC', 'CHG', 'RISK', 'OPS'], 3)}-${1000 + (v2 % 9000)}`;
  const person = pick(['Priya', 'Tomasz', 'Amara', 'Lucas', 'Mei', 'Jonah', 'Farah', 'Diego'], 5);
  const situation = [
    pick(
      [
        `This ${pick(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], 7)} the team is ${pick(['closing a quarterly audit', 'onboarding two new engineers', 'migrating a reporting job', 'preparing a customer demo', 'rotating on-call duties'], 9)}.`,
        `${person} from the platform group opened ticket ${ticket} after a ${pick(['routine review', 'customer complaint', 'billing anomaly', 'partner question', 'failed nightly job'], 11)}.`,
        `A ${pick(['contractor', 'new hire', 'vendor engineer', 'temporary analyst'], 13)} reported something odd around the ${entry} during ${pick(['a deployment', 'a support call', 'an access review', 'a backup test'], 15)}.`,
        `Leadership asked for a decision within ${2 + (v % 5)} hours, and ${person} is coordinating the response under ticket ${ticket}.`,
      ],
      1,
    ),
    `${constraint.label}. ${constraint.guide}`,
    pick(
      [
        `Recent reporting on ${technique.name} (${technique.id}) has made the security lead nervous about the ${entry}.`,
        `The ${entry} was flagged in last month's review, which also mentioned ${technique.name}.`,
        `Industry peers saw ${technique.name} this quarter, and nobody has checked the ${entry} since.`,
        `An external advisory about ${technique.name} lists exactly the kind of exposure the ${entry} has.`,
      ],
      17,
    ),
    pick(
      [
        `Nobody has reviewed who can reach the ${target} since ${pick(['the last audit', 'the spring re-organisation', 'the cloud migration', 'a vendor change'], 10)}.`,
        `The ${target} matters most here: ${pick(['finance depends on it', 'customers would notice at once', 'regulators ask about it', 'it feeds every report'], 12)}.`,
        `${person} suspects the ${entry} is ${pick(['over-trusted', 'poorly monitored', 'shared by several teams', 'older than anyone remembers'], 14)}.`,
        `A ${pick(['pen-test note', 'board question', 'customer audit', 'insurance survey'], 16)} recently mentioned the ${target}.`,
      ],
      18,
    ),
    pick(
      [
        `The decision on the table is ${objective.label.toLowerCase()}.`,
        `What the team needs now is ${objective.label.toLowerCase()}.`,
        `${person} wants a clear view of ${objective.label.toLowerCase()}.`,
        `Before anything changes, the team must settle ${objective.label.toLowerCase()}.`,
      ],
      19,
    ),
  ].join(' ');
  const narrative = [
    ...steps.map((s, i) =>
      pick(
        [
          `At ${at(i)} the ${log} records the attacker ${adverb()} moving from the ${label(s.from)} to the ${label(s.to)} (${detail()}): ${s.label}.`,
          `${at(i)}: evidence in the ${log} shows a hop from the ${label(s.from)} toward the ${label(s.to)}, ${detail()} (${s.label}).`,
          `Around ${at(i)}, the ${label(s.from)} is ${adverb()} used against the ${label(s.to)}; the ${log} keeps the trace, ${detail()} (${s.label}).`,
          `By ${at(i)} the ${label(s.to)} is reached from the ${label(s.from)} with ${detail()}, which the ${log} captures as: ${s.label}.`,
        ],
        21 + i,
      ),
    ),
    pick(
      [
        `No alert fired on the ${target} itself, and the session is still active.`,
        `The activity on the ${target} has not stopped, and nobody has acted yet.`,
        `The attacker still holds the access gained at the ${entry}.`,
        `Data movement near the ${target} continues while the team decides.`,
      ],
      27,
    ),
  ].join(' ');
  const question = (u.match(/The question must be: "([^"]+)"/)?.[1] ?? objective.question).trim();

  const options = [
    { id: 'A', text: `${any(['Rotate every credential in the organisation', 'Reset all keys and tokens at once', 'Re-issue every identity the team manages', 'Invalidate every secret across the estate'])}, ${any(['including', 'starting with', 'not only'])} the one behind the ${entry}, and ${any(['force all staff to sign in again', 'require every user to re-enrol', 'expire every session'])} before anyone ${any(['looks at', 'touches', 'reviews'])} the ${target}.` },
    { id: 'B', text: `${any(['Revoke', 'Cut off', 'Disable', 'Withdraw'])} the access the attacker holds through the ${entry} and ${any(['scope it', 'narrow it', 'restrict it'])} so that nothing on that ${any(['path', 'route', 'chain'])} can reach the ${target} again.` },
    { id: 'C', text: `${any(['Raise alerting on', 'Add a threshold alarm to', 'Watch', 'Tune the rules on'])} the ${log} and ${any(['wait for', 'collect', 'look for'])} the next anomalous event before changing any permission on the ${entry}.` },
    { id: 'D', text: `${any(['Take', 'Shut', 'Pull'])} the ${off} offline so nothing reaches it while the investigation ${any(['runs', 'proceeds', 'continues', 'is under way'])}, and leave every other component as it is.` },
  ];
  const nRubric = { beginner: 6, intermediate: 7, advanced: 9 }[level];
  const rubric = [
    { id: 'r1', dimension: 'reasoning', text: `States that the attacker is operating through the ${entry} and that cutting that access stops the current activity`, weight: '5', hint: `Name the access the attacker is using; the evidence points at the ${entry}.`, explanation: 'The path runs through one foothold; cutting it ends the activity.' },
    { id: 'r2', dimension: 'reasoning', text: `Uses the evidence in the ${log} (timing, the hops recorded) to justify acting now rather than waiting`, weight: '3', hint: `Cite what the ${log} recorded about the attacker's steps.`, explanation: 'Evidence of activity in progress justifies immediate action.' },
    { id: 'r3', dimension: 'reasoning', text: 'Explains why the narrower action is preferred over rotating everything or taking an unrelated component offline', weight: '3', hint: 'Compare the chosen action with the wider alternatives and say what each would cost.', explanation: 'Proportional containment preserves the service and the evidence.' },
    { id: 'a1', dimension: 'architecture', text: `Traces the attack path from the ${entry} to the ${target}`, weight: '4', hint: `Walk the attack path on the diagram, from the ${entry} to the ${target}.`, explanation: 'The diagram shows the attack steps; the answer must follow them.' },
    { id: 'a2', dimension: 'architecture', text: `Recognises that the ${off} is not on the attack path`, weight: '2', hint: `Check which components carry the attack; the ${off} carries none.`, explanation: 'The entry point is not on the public path.' },
    { id: 'k1', dimension: 'risk', text: 'Addresses evidence preservation and the stated operational constraint', weight: '3', hint: 'Say what you keep for the investigation and how the constraint shapes the action.', explanation: 'Containment must respect the constraint and keep evidence.' },
    { id: 'r4', dimension: 'reasoning', text: `Rules out waiting on the ${log} because the attacker is active now`, weight: '2', hint: 'Explain why more monitoring alone accepts more loss.', explanation: 'Detection does not stop an attack in progress.' },
    { id: 'a3', dimension: 'architecture', text: 'Names the trust boundary the attack crosses on its way to the target', weight: '2', hint: 'Say which boundary the attacker crossed and what trust it relied on.', explanation: 'Boundaries crossed explain why controls on one side did not help.' },
    { id: 'k2', dimension: 'risk', text: 'States the residual risk once the access is cut and what to harden next', weight: '2', hint: 'Say what remains exposed after containment and the next fix.', explanation: 'Containment is followed by hardening.' },
  ].slice(0, nRubric);
  const why = {
    A: `Rotating everything also stops this attacker, but it is far wider than needed and collides with the constraint; you also lose track of which identity was abused.`,
    B: `Cutting the attacker's foothold at the ${entry} and narrowing what it can reach ends the activity at its source while the rest of the service keeps running and the evidence stays intact.`,
    C: `Watching for another event while the attacker is active accepts further loss and gains nothing you do not already have.`,
    D: `The ${off} carries no attack step, so removing it hurts the business and leaves the attacker's access in place.`,
  };
  return {
    title: `${arch.organisation.name}: ${objective.label}`.slice(0, 90),
    situation,
    attack_narrative: narrative,
    objective: objective.label,
    question,
    options,
    correct_option: 'B',
    option_analysis: [
      { id: 'A', verdict: 'plausible', why: why.A },
      { id: 'B', verdict: 'best', why: why.B },
      { id: 'C', verdict: 'wrong', why: why.C },
      { id: 'D', verdict: 'weak', why: why.D },
    ],
    attack: { entry_node: overlay.entryNode, compromised_nodes: overlay.compromisedNodes, steps },
    rubric,
    must_not_credit: [
      { id: 'm1', claim: `The ${control} would have blocked this attack`, why: 'The attacker never passed through that control on this path.', invalidates: ['a2'] },
      { id: 'm2', claim: `Restoring the ${target} from a backup ends the attack`, why: 'The attacker keeps the access that reached it; a restore does not remove the foothold.', invalidates: ['r1'] },
    ],
    reference_answer: `You should act on the foothold itself. The person or process abusing the ${entry} is still active, so removing exactly that access and narrowing what it can touch stops further movement toward the ${target}. Doing so keeps customers served, respects the constraint you were given, and preserves every record you will need later. Resetting all credentials goes far beyond what the evidence supports, more monitoring alone tolerates additional loss, and switching off the ${off} does nothing about an intruder who never used it.`,
    architecture_analysis: `You can see the intrusion begin at the ${entry} and end at the ${target}, crossing ${steps.length} hop${steps.length === 1 ? '' : 's'} on the drawing. Controls drawn elsewhere, such as the ${control}, sit off this route and so do not interrupt it, which is why a fix aimed at the foothold matters more than one aimed at the perimeter. The ${off} is not involved at all.`,
    techniques: [{ id: technique.id, name: technique.name }],
    concepts: ['least privilege', 'containment', 'blast radius', 'evidence preservation', objective.id.replace(/_/g, ' ')],
    difficulty: level,
  };
}

/** The overlay's steps with seed-varied labels (at most 70 characters, as the schema allows). */
function withLabels(arch: ArchitectureDef, overlay: AttackOverlay, pick: <T>(xs: readonly T[], n: number) => T): AttackOverlay['steps'] {
  const label = (id: string) => arch.diagram.nodes.find((n) => n.id === id)?.label ?? id;
  return overlay.steps.map((s, i) => ({
    from: s.from,
    to: s.to,
    label: `${pick(['reaches', 'pivots to', 'abuses access to', 'reads from', 'moves into'], 28 + i)} ${label(s.to)}`.slice(0, 70),
  }));
}
