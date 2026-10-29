import type { GeneratorOutput } from './item.types.js';

/**
 * Content-quality checks on a generated item, beyond shape and diagram integrity (`validation.ts`).
 * Added 28 Oct 2026 after a review of 20 small-tier (Haiku) questions that passed the automatic
 * check with real problems: 4 gave the answer away in the scenario text, 1 had a timeline that ran
 * backwards, 1 misstated GDPR, 1 had two defensible answers. Every rule here is code only (no model
 * call), deterministic, and phrased as an instruction the generator can act on when the item is
 * regenerated with the errors fed back.
 *
 * Rules:
 *   answer_leak  the learner-visible text (title, scenario, narrative, objective, question) must not
 *                echo the best option, recommend it, or refer to options by letter
 *   timeline     clock times and dates in the attack narrative must not run backwards, and
 *                "N minutes later at HH:MM" must add up
 *   regulation   figures attached to named regulations (GDPR, HIPAA, PCI DSS, NIS2, SEC, DPDP,
 *                CIRCIA) must be the real ones, in every text field including the private half
 *   distractor   every non-best option's analysis must state why it fails, must not call it also
 *                valid, and no distractor may restate the best option
 *
 * Limits: `regulation` only knows the figures listed in REGULATION_RULES; other factual errors
 * need a model cross-check. `timeline` reads explicit times; a narrative with no timestamps passes.
 *
 * Both generators are checked (29 Oct 2026): the legacy item through `legacyView`, and a question on the
 * architecture library through `libraryQualityView` (validation.ts), called by the library gate
 * `validateLibraryItem`. Tuned on the 20 stored Haiku 5.5 questions of the H55 measurement so that none
 * of the good ones is rejected: the objective template the writer was given and vocabulary the long
 * fields already carry are no tell in a short field; questions and judgements on the past ("which layer
 * should have enforced") are not advice; a distractor analysis that says "never", "neither ... nor",
 * "overstates", "bypasses" states a failure; "window" alone is not a look-back. Also not errors: a
 * lower-case "a" after "answer"/"choice" (the article), a time-zone conversion in brackets
 * ("09:00 IST (03:30 UTC)"), a contractual deadline in a sentence that names a regulation, and component
 * names shared by two options (they name the same architecture, not the same action).
 */

export type QualityRule = 'answer_leak' | 'timeline' | 'regulation' | 'distractor';

/**
 * What the rules read, from either generator: the legacy item (GeneratorOutput, via legacyView) or a
 * library question (LibraryGeneratorOutput plus its architecture, via validation.ts libraryQualityView).
 */
export interface QualityView {
  /** Learner-visible prose by the generator's field name, in reading order: title, the long description, attack_narrative, objective, question. */
  visible: [string, string][];
  /** The long description's field name ('scenario' or 'situation'); rule 3 reports on it. */
  descriptionField: string;
  /** Short public labels drawn with the question (library attack-step labels): checked for letters and echoes only. */
  labels: [string, string][];
  attack_narrative: string;
  options: GeneratorOutput['options'];
  correct_option: GeneratorOutput['correct_option'];
  option_analysis: GeneratorOutput['option_analysis'];
  /** Component, origin and boundary labels: named in any question on the diagram, never distinctive. */
  names: string[];
  /** Private prose by field name (rubric, must_not_credit, reference_answer, architecture_analysis): regulation figures. */
  private: [string, string][];
  /** The wording the writer was given for the objective (label, guide, question): echoing it in a short field is no tell. */
  given?: string;
  /** Rule 1 (an option named by its letter). Off for library questions: their gate checks the same fields with OPTION_REF. */
  letters: boolean;
}

export const legacyView = (out: GeneratorOutput): QualityView => ({
  visible: [
    ['title', out.title],
    ['scenario', out.scenario],
    ['attack_narrative', out.attack_narrative],
    ['objective', out.objective],
    ['question', out.question],
  ],
  descriptionField: 'scenario',
  labels: [],
  letters: true,
  attack_narrative: out.attack_narrative,
  options: out.options,
  correct_option: out.correct_option,
  option_analysis: out.option_analysis,
  names: [...out.diagram.nodes.map((n) => n.label), ...out.diagram.boundaries.map((b) => b.label)],
  private: [
    ...out.rubric.flatMap((p): [string, string][] => [[`rubric.${p.id}.text`, p.text], [`rubric.${p.id}.hint`, p.hint], [`rubric.${p.id}.explanation`, p.explanation]]),
    ...out.must_not_credit.flatMap((m): [string, string][] => [[`must_not_credit.${m.id}.claim`, m.claim], [`must_not_credit.${m.id}.why`, m.why]]),
    ['reference_answer', out.reference_answer],
  ],
});

const viewOf = (x: GeneratorOutput | QualityView): QualityView => ('visible' in x ? x : legacyView(x));

export interface QualityFinding {
  rule: QualityRule;
  severity: 'error' | 'warning';
  /** The item field the finding is about, as the generator names it. */
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------------------------
// Text helpers

const STOP = new Set(
  (
    'the a an and or but nor for with from into onto over under about above below after before while when where which who whom whose what why how ' +
    'this that these those there their them they then than thus such same both each every any all some none more most much many few less least very ' +
    'is are was were be been being am do does did done doing has have had having will would shall should can could may might must need needs to of in on at by as ' +
    'it its if so no not yes only also too again once still yet already ever never now just like via per each own other another one two three first second third last next ' +
    'through without within between among across along around toward towards against during until since because although though however whether either neither ' +
    'you your yours we our ours us i me my mine he she his her him them here out up down off back away well even ' +
    'use uses used using make makes made making take takes took taken get gets got give given keep keeps kept let lets ' +
    'attacker attack attacks access account accounts control controls security secure service services system systems network networks data user users role roles ' +
    'cloud server servers prod production public private internal external app application web api team company environment platform engineer engineers staff ' +
    'step steps path shown diagram scenario question option options answer best change changes most directly single which immediately right left'
  ).split(/\s+/),
);

/** Lower-case word tokens, keeping digits; hyphens and punctuation split words. */
export const wordTokens = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

/** A light stem so "revoked", "revoking" and "revokes" count as one term. */
export function stem(w: string): string {
  if (w.length <= 4) return w;
  let s = w;
  if (s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('ing') && s.length > 6) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 5) s = s.slice(0, -2);
  else if (s.endsWith('es') && s.length > 5) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  // "scope"/"scoping", "revoke"/"revoked", "stopped"/"stop" meet in one form.
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  if (s.length > 4 && s[s.length - 1] === s[s.length - 2] && !/[aeiou]/.test(s[s.length - 1]!)) s = s.slice(0, -1);
  return s;
}

/** Content terms: stemmed words of at least four letters that carry meaning in this domain. */
export function contentTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of wordTokens(text)) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
    const s = stem(w);
    if (s.length >= 3 && !STOP.has(s)) out.add(s);
  }
  return out;
}

const ngrams = (tokens: string[], n: number): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
};

const sentences = (text: string): string[] =>
  text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);

const pct = (n: number) => `${Math.round(n * 100)}%`;

const visibleFields = (v: QualityView): [string, string][] => v.visible;
const isLong = (v: QualityView, field: string) => field === v.descriptionField || field === 'attack_narrative';

// ---------------------------------------------------------------------------------------------
// answer_leak

/** Capital letters only, so the article ("did not answer a page", "no choice a week later") never matches. */
const OPTION_REFERENCE = /\b(?:[Oo]ption|[Aa]nswer|[Cc]hoice)\s*\(?[A-D]\)?(?![A-Za-z0-9-])/;
const RECOMMENDS =
  /\b(?:should|must|needs? to|ought to|has to|have to|recommend(?:s|ed|ation|ations)?|advis(?:e|es|ed)|the (?:fix|remediation|mitigation|solution|answer|root cause|correct (?:action|response|step)|right (?:move|call|action|response|step)|first (?:step|action|move)|priority) (?:is|was|here is|would be)|(?:decided|decides|plans?|planned|intends?|agreed) to|would (?:stop|block|prevent|break|close|contain|end|cut) (?:the|this|that|it)|(?:is|are) the (?:way|key) to)\b/i;

const ECHO_N = 5;
/**
 * A question or a judgement on the past ("which layer should have enforced"), not advice. A wh-word
 * before a modal is not enough: "spells out what the team should do: <the fix>" and "which is why the
 * team must <the fix>" are advice in a relative clause.
 */
const INTERROGATIVE = /\?\s*$|\b(?:should|must|ought to) have\b/i;

/**
 * The visible text must not point at the best option: by letter, by echoing its wording, by using
 * its distinctive vocabulary far more than the distractors', or by recommending it in a sentence.
 */
export function checkAnswerLeak(input: GeneratorOutput | QualityView): QualityFinding[] {
  const out = viewOf(input);
  const findings: QualityFinding[] = [];
  const correct = out.options.find((o) => o.id === out.correct_option);
  if (!correct) return findings;
  const distractors = out.options.filter((o) => o.id !== out.correct_option);
  const visibleText = [...visibleFields(out), ...out.labels].map(([, t]) => t).join('\n');

  // 1. Options referred to by letter.
  for (const [field, text] of out.letters ? [...visibleFields(out), ...out.labels] : []) {
    const m = OPTION_REFERENCE.exec(text);
    if (m) findings.push({ rule: 'answer_leak', severity: 'error', field, message: `${field}: refers to an option by letter ("${m[0]}"); the learner-visible text must never mention the options` });
  }

  // 2. Verbatim echo: a run of five words from the best option appears in the visible text. Runs that
  //    are only a component's name plus filler ("read the exports-prod bucket") are how a scenario
  //    describes its environment, so a run counts only with two content words beyond the labels. The
  //    same run from a distractor means the text names shared actions, not the answer.
  const labelTerms = contentTerms(out.names.join(' '));
  const substantive = (gram: string): boolean => [...contentTerms(gram)].filter((t) => !labelTerms.has(t)).length >= 2;
  const visibleGrams = ngrams(wordTokens(visibleText), ECHO_N);
  const echoOf = (text: string): string | undefined => {
    for (const g of ngrams(wordTokens(text), ECHO_N)) if (visibleGrams.has(g) && substantive(g)) return g;
    return undefined;
  };
  const correctEcho = echoOf(correct.text);
  if (correctEcho) {
    const distractorEcho = distractors.some((o) => echoOf(o.text));
    const where = [...visibleFields(out), ...out.labels].find(([, t]) => ngrams(wordTokens(t), ECHO_N).has(correctEcho))?.[0] ?? out.descriptionField;
    findings.push({
      rule: 'answer_leak',
      severity: distractorEcho ? 'warning' : 'error',
      field: where,
      message: `${where}: repeats the wording of the best option ("${correctEcho}"); describe the situation without stating the remedy`,
    });
  }

  // 3. Vocabulary asymmetry: the best option's distinctive terms are nearly all in the visible text
  //    while the distractors' are not. Component names are expected in the scenario whichever option
  //    they belong to, so the diagram's node and boundary labels do not count as distinctive.
  const termSets = out.options.map((o) => ({ id: o.id, terms: new Set([...contentTerms(o.text)].filter((t) => !labelTerms.has(t))) }));
  const distinctive = (id: string): Set<string> => {
    const mine = termSets.find((t) => t.id === id)!.terms;
    const others = new Set(termSets.filter((t) => t.id !== id).flatMap((t) => [...t.terms]));
    return new Set([...mine].filter((t) => !others.has(t)));
  };
  const visibleTerms = contentTerms(visibleText);
  const coverage = (id: string): { share: number; n: number } => {
    const d = distinctive(id);
    if (d.size < 3) return { share: 0, n: d.size };
    let hit = 0;
    for (const t of d) if (visibleTerms.has(t)) hit++;
    return { share: hit / d.size, n: d.size };
  };
  const c = coverage(correct.id);
  const worst = Math.max(...distractors.map((o) => coverage(o.id).share));
  // Vocabulary alone is an error only when the asymmetry is stark; ordinary security words (session,
  // policy, read) recur in any scenario, so a moderate imbalance is a warning for the logs.
  if (c.n >= 3) {
    if (c.n >= 4 && c.share >= 0.85 && c.share - worst >= 0.6) {
      findings.push({
        rule: 'answer_leak',
        severity: 'error',
        field: out.descriptionField,
        message: `${out.descriptionField}/attack_narrative: ${pct(c.share)} of the best option's distinctive terms appear in the visible text against at most ${pct(worst)} for any distractor; the text is steering to option ${correct.id}. Describe the environment and the evidence, not the fix, or give the distractors' subjects the same presence`,
      });
    } else if (c.share >= 0.6 && c.share - worst >= 0.3) {
      findings.push({ rule: 'answer_leak', severity: 'warning', field: out.descriptionField, message: `${out.descriptionField}: the best option's vocabulary is more present in the visible text (${pct(c.share)}) than any distractor's (${pct(worst)})` });
    }
  }

  // 4. The short fields (title, objective, question) ask the question; they must not carry the best
  //    option's action vocabulary while carrying none of the distractors'.
  const correctTerms = distinctive(correct.id);
  const distractorTerms = distractors.map((o) => distinctive(o.id));
  const given = contentTerms(out.given ?? '');
  const longTerms = contentTerms(visibleFields(out).filter(([f]) => isLong(out, f)).map(([, t]) => t).join('\n'));
  for (const [field, text] of visibleFields(out)) {
    if (isLong(out, field)) continue;
    const terms = contentTerms(text);
    const mine = [...correctTerms].filter((t) => terms.has(t) && !given.has(t) && !longTerms.has(t));
    const theirs = Math.max(0, ...distractorTerms.map((d) => [...d].filter((t) => terms.has(t)).length));
    if (mine.length >= 2 && theirs === 0) {
      findings.push({ rule: 'answer_leak', severity: 'error', field, message: `${field}: names the best option's action (${mine.join(', ')}) and nothing from the other options; ask the question without describing the remedy` });
    }
  }

  // 5. A sentence that recommends the best option's action.
  for (const [field, text] of visibleFields(out)) {
    if (field === 'title') continue;
    for (const s of sentences(text)) {
      if (!RECOMMENDS.test(s) || INTERROGATIVE.test(s)) continue;
      const terms = contentTerms(s);
      const sharedCorrect = [...correctTerms].filter((t) => terms.has(t) && !given.has(t));
      const sharedDistractor = Math.max(0, ...distractorTerms.map((d) => [...d].filter((t) => terms.has(t)).length));
      if (sharedCorrect.length >= 2 && sharedCorrect.length > sharedDistractor) {
        findings.push({
          rule: 'answer_leak',
          severity: 'error',
          field,
          message: `${field}: a sentence recommends the best option ("${s.slice(0, 120)}${s.length > 120 ? '…' : ''}"); the visible text may state facts and evidence, never what should be done`,
        });
        break;
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// timeline

interface TimePoint {
  /** Minutes since an arbitrary epoch; dates anchor it, otherwise day 0. */
  minutes: number;
  text: string;
  dated: boolean;
}

const ISO = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const CLOCK = /(?<![\d:.])(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d:.%])/gi;
const DAY_N = /\b[Dd]ay\s+(\d{1,2})\b/g;
const RELATIVE = /\b(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\s+later\b[^.;]*?\b(?:at\s+)?(\d{1,2}):([0-5]\d)\s*(am|pm)?/gi;
const LOOKS_BACK = /\b(?:earlier|previously|before (?:that|this|the)|back in|originally|had been|has been|was (?:created|issued|rotated|provisioned|granted|added|set)|created (?:on|at|in)|issued (?:on|at|in)|since|ago|last (?:week|month|year|quarter)|the (?:day|week|month) before|prior|retention|retained|expires?|expiry|valid (?:for|until)|scheduled|maintenance window)\b/i;

/** A clock time in brackets with a zone after another time, "09:00 IST (03:30 UTC)": the same moment, not a later step. */
const ZONE_CONVERSION = /\(\s*(?:\d{4}-\d{2}-\d{2}[T ])?\d{1,2}:[0-5]\d(?::[0-5]\d)?\s*(?:am|pm)?\s*(?:UTC|GMT|Z|[A-Z]{2,5}|local(?: time)?|[+-]\d{2}:?\d{2})\b[^)]{0,20}\)/g;

const dayMinutes = (y: number, mo: number, d: number): number => Math.round(Date.UTC(y, mo - 1, d) / 60_000);

function toMinutes(h: number, m: number, ampm?: string): number {
  let hh = h;
  const suffix = ampm?.toLowerCase().replace(/\./g, '');
  if (suffix === 'pm' && hh < 12) hh += 12;
  if (suffix === 'am' && hh === 12) hh = 0;
  return hh * 60 + m;
}

/** Explicit times in the order they are written, each anchored to the most recent date seen. */
export function extractTimeline(text: string): TimePoint[] {
  const points: TimePoint[] = [];
  for (const sentence of sentences(text)) {
    if (LOOKS_BACK.test(sentence)) continue;
    // Blank out bracketed zone conversions, keeping offsets (the order within a sentence is by offset).
    const s = sentence.replace(ZONE_CONVERSION, (m) => ' '.repeat(m.length));
    // Collect matches with their offsets so the order within a sentence is the written order.
    const found: { at: number; p: TimePoint; setsDay?: number }[] = [];
    for (const m of s.matchAll(ISO)) {
      const [, y, mo, d, h, mi] = m;
      const day = dayMinutes(Number(y), Number(mo), Number(d));
      const clock = h !== undefined ? Number(h) * 60 + Number(mi) : 0;
      found.push({ at: m.index!, p: { minutes: day + clock, text: m[0], dated: true }, setsDay: h !== undefined ? day : undefined });
    }
    for (const m of s.matchAll(DAY_N)) found.push({ at: m.index!, p: { minutes: Number(m[1]) * 1440, text: m[0], dated: true }, setsDay: Number(m[1]) * 1440 });
    for (const m of s.matchAll(CLOCK)) {
      const h = Number(m[1]);
      if (h > 23) continue;
      // Skip anything that is part of an ISO timestamp already collected.
      if (found.some((f) => m.index! >= f.at && m.index! < f.at + f.p.text.length)) continue;
      found.push({ at: m.index!, p: { minutes: toMinutes(h, Number(m[2]), m[3]), text: m[0].trim(), dated: false } });
    }
    found.sort((a, b) => a.at - b.at);
    for (const f of found) points.push(f.p);
  }
  // Anchor undated clock times to the latest date seen before them (or day 0).
  let base = 0;
  return points.map((p) => {
    if (p.dated) {
      base = Math.floor(p.minutes / 1440) * 1440;
      return p;
    }
    return { ...p, minutes: base + p.minutes };
  });
}

/** The attack narrative's explicit times must not run backwards, and relative statements must add up. */
export function checkTimeline(input: GeneratorOutput | QualityView): QualityFinding[] {
  const out = viewOf(input);
  const findings: QualityFinding[] = [];
  const field = 'attack_narrative';
  const points = extractTimeline(out.attack_narrative);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (cur.minutes < prev.minutes) {
      // An undated clock time that is earlier than the previous one is a backwards step unless the
      // narrative plausibly crossed midnight (previous late evening, current early morning).
      const crossesMidnight = !cur.dated && !prev.dated && prev.minutes % 1440 >= 22 * 60 && cur.minutes % 1440 < 6 * 60;
      if (crossesMidnight) continue;
      findings.push({
        rule: 'timeline',
        severity: 'error',
        field,
        message: `${field}: the timeline runs backwards ("${prev.text}" then "${cur.text}"); write the events in the order they happened with times that increase, or say explicitly when you refer back to something earlier`,
      });
      break;
    }
  }
  // "N minutes later at HH:MM": the arithmetic must hold against the previous time in the text.
  const all = extractTimeline(out.attack_narrative);
  for (const m of out.attack_narrative.matchAll(RELATIVE)) {
    const n = Number(m[1]);
    const unit = /^h/i.test(m[2]!) ? 60 : 1;
    const target = toMinutes(Number(m[3]), Number(m[4]), m[5]);
    const before = out.attack_narrative.slice(0, m.index!);
    const prev = extractTimeline(before).at(-1);
    if (!prev || all.length < 2) continue;
    const expected = (prev.minutes % 1440) + n * unit;
    const diff = Math.abs(((target - expected) % 1440) + 1440) % 1440;
    if (Math.min(diff, 1440 - diff) > 2) {
      findings.push({
        rule: 'timeline',
        severity: 'error',
        field,
        message: `${field}: "${m[0].trim()}" does not add up from "${prev.text}" (${n} ${unit === 60 ? 'hours' : 'minutes'} after ${prev.text} is ${String(Math.floor((expected % 1440) / 60)).padStart(2, '0')}:${String(expected % 60).padStart(2, '0')}); fix the figure or the clock time`,
      });
      break;
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// regulation

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const parseNumber = (s: string): number | undefined => {
  const t = s.toLowerCase().replace(/-/g, ' ').trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(/\s+/);
  let n = 0;
  for (const p of parts) {
    if (!(p in NUMBER_WORDS)) return undefined;
    n += NUMBER_WORDS[p]!;
  }
  return parts.length ? n : undefined;
};
// The figure: digits or number words up to ninety-nine (capture group 1 of each pattern below).
/** "within 24 hours", "no later than 60 days", and the attributive form "a 24-hour deadline", "the 7-day window". */
const WITHIN_TIME =
  /\b(?:(?:within|no later than|inside|in under|under|gives?|given|allows?|allowed|has|have)\s+(?:the\s+\w+\s+)?(?:only\s+)?(\d+(?:\.\d+)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)\s*(hours?|hrs?|business days?|working days?|days?|months?)\b|(\d+(?:\.\d+)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)[- ](hour|day|business[- ]day|month)\s+(?:deadline|window|limit|clock|notification|reporting|rule|period|requirement))/gi;
const PERCENT_TURNOVER = /\b(\d+(?:\.\d+)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)\s*(?:%|percent|per cent)\s+of\s+(?:(?:global|annual|worldwide|total|group|yearly)\s+)+(?:annual\s+)?(?:turnover|revenue)/gi;
const EURO_MILLION = /(?:€|EUR\s?|euros?\s)\s*(\d+(?:\.\d+)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)\s*(?:million|m\b)/gi;

interface RegulationRule {
  name: string;
  /** The regulation must be named in the same sentence. */
  trigger: RegExp;
  /** The sentence must also be about this (so a GDPR sentence about access requests is not held to the breach deadline). */
  context?: RegExp;
  /** Sentences matching this are a different obligation and are left alone. */
  exclude?: RegExp;
  claims: { re: RegExp; unit?: 'hours' | 'days' | 'months' | 'percent' | 'eur_million'; ok: number[]; truth: string }[];
}

const toHours = (n: number, unit: string): number | undefined => {
  const u = unit.toLowerCase();
  if (u.startsWith('hour') || u.startsWith('hr')) return n;
  if (u.includes('day')) return n * 24;
  return undefined;
};
const toDays = (n: number, unit: string): number | undefined => {
  const u = unit.toLowerCase();
  if (u.includes('day')) return n;
  if (u.startsWith('hour') || u.startsWith('hr')) return n / 24;
  if (u.startsWith('month')) return n * 30;
  return undefined;
};

const BREACH = /\b(?:notif|report|inform|breach|incident|supervisory|authority|regulator|disclos|the board|data protection board|cert)/i;
/** A deadline the parties agreed ("the processor contract requires notice within 24 hours", "the BAA gives 10 days"), not the regulation's. */
const CONTRACTUAL = /\b(?:contract(?:s|ual|ually)?|agreements?|BAA|DPA|SLA|addendum|(?:internal|company|corporate|our|their) polic(?:y|ies)|internally)\b/i;
const DSAR = /\b(?:access request|subject access|DSAR|erasure|right to|portability|respond to (?:a |the )?request)/i;

export const REGULATION_RULES: RegulationRule[] = [
  {
    name: 'GDPR supervisory-authority breach notification',
    trigger: /\bGDPR\b|General Data Protection Regulation|Article 33|Art\.? ?33\b/i,
    context: BREACH,
    exclude: DSAR,
    claims: [{ re: WITHIN_TIME, unit: 'hours', ok: [72], truth: 'GDPR Art. 33 requires notification to the supervisory authority within 72 hours of becoming aware (data subjects: without undue delay, no fixed hours)' }],
  },
  {
    name: 'GDPR data subject request deadline',
    trigger: /\bGDPR\b|General Data Protection Regulation|Article 12|Article 15/i,
    context: DSAR,
    claims: [{ re: WITHIN_TIME, unit: 'days', ok: [30, 31, 90, 93], truth: 'GDPR Art. 12 gives one month to answer a data subject request, extendable by two further months' }],
  },
  {
    name: 'GDPR fines',
    trigger: /\bGDPR\b|General Data Protection Regulation|Article 83/i,
    claims: [
      { re: PERCENT_TURNOVER, unit: 'percent', ok: [2, 4], truth: 'GDPR Art. 83 fines are up to 4% of global annual turnover (higher tier) or 2% (lower tier)' },
      { re: EURO_MILLION, unit: 'eur_million', ok: [10, 20], truth: 'GDPR Art. 83 fines are up to €20 million (higher tier) or €10 million (lower tier)' },
    ],
  },
  {
    name: 'HIPAA breach notification',
    trigger: /\bHIPAA\b|HITECH/i,
    context: BREACH,
    claims: [{ re: WITHIN_TIME, unit: 'days', ok: [60], truth: 'the HIPAA Breach Notification Rule requires notice without unreasonable delay and no later than 60 calendar days after discovery' }],
  },
  {
    name: 'SEC material cybersecurity incident disclosure',
    trigger: /\bSEC\b|Form 8-K|Item 1\.05|Securities and Exchange Commission/,
    context: /\b(?:disclos|8-K|material|incident)/i,
    claims: [{ re: WITHIN_TIME, unit: 'days', ok: [4], truth: 'SEC rules require a Form 8-K Item 1.05 disclosure within four business days of determining an incident is material' }],
  },
  {
    name: 'NIS2 incident reporting',
    trigger: /\bNIS\s?2\b|NIS2 Directive/i,
    context: BREACH,
    claims: [{ re: WITHIN_TIME, unit: 'hours', ok: [24, 72, 720, 744], truth: 'NIS2 Art. 23 requires an early warning within 24 hours, an incident notification within 72 hours and a final report within one month' }],
  },
  {
    name: 'India DPDP breach notification',
    trigger: /\bDPDP\b|Digital Personal Data Protection/i,
    context: BREACH,
    claims: [{ re: WITHIN_TIME, unit: 'hours', ok: [72], truth: 'the DPDP Rules require the Data Protection Board to be given the detailed breach report within 72 hours of becoming aware (affected individuals: without delay)' }],
  },
  {
    name: 'CIRCIA reporting',
    trigger: /\bCIRCIA\b/,
    context: BREACH,
    claims: [{ re: WITHIN_TIME, unit: 'hours', ok: [72, 24], truth: 'CIRCIA requires covered incidents to be reported to CISA within 72 hours and ransom payments within 24 hours' }],
  },
  {
    name: 'PCI DSS log retention',
    trigger: /\bPCI[\s-]?DSS\b/i,
    context: /\b(?:log|logs|audit trail|retain|retention)\b/i,
    claims: [{ re: /\b(?:retain(?:ed)?|kept|keep|store(?:d)?|retention of|for)\s+(?:at least\s+)?(\d+(?:\.\d+)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)\s*(months?|days?)\b/gi, unit: 'months', ok: [3, 12], truth: 'PCI DSS Req. 10.5.1 requires audit logs retained for at least 12 months, with the last 3 months immediately available' }],
  },
];

/** Figures attached to a named regulation must be the real ones. Checked in every text field, private half included. */
export function checkRegulationFacts(input: GeneratorOutput | QualityView): QualityFinding[] {
  const out = viewOf(input);
  const findings: QualityFinding[] = [];
  const fields: [string, string][] = [
    ...visibleFields(out),
    ...out.options.map((o): [string, string] => [`options.${o.id}`, o.text]),
    ...out.option_analysis.map((a): [string, string] => [`option_analysis.${a.id}`, a.why]),
    ...out.private,
  ];
  const seen = new Set<string>();
  for (const [field, text] of fields) {
    for (const s of sentences(text)) {
      for (const rule of REGULATION_RULES) {
        if (!rule.trigger.test(s)) continue;
        if (rule.context && !rule.context.test(s)) continue;
        if (rule.exclude && rule.exclude.test(s)) continue;
        if (CONTRACTUAL.test(s)) continue;
        for (const claim of rule.claims) {
          for (const m of s.matchAll(claim.re)) {
            // Patterns with alternatives capture the figure and unit in whichever branch matched.
            const captured = m.slice(1).filter((g): g is string => g !== undefined);
            const n = parseNumber(captured[0] ?? '');
            if (n === undefined) continue;
            const unit = captured[1];
            let value: number | undefined;
            if (claim.unit === 'hours') value = toHours(n, unit ?? 'hours');
            else if (claim.unit === 'days') value = toDays(n, unit ?? 'days');
            else if (claim.unit === 'months') value = unit && /day/i.test(unit) ? n / 30 : n;
            else value = n;
            if (value === undefined) continue;
            const ok = claim.ok.some((x) => Math.abs(x - value!) < 0.01);
            if (ok) continue;
            const key = `${field}|${m[0]}`;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push({
              rule: 'regulation',
              severity: 'error',
              field,
              message: `${field}: "${m[0].trim()}" misstates ${rule.name}: ${claim.truth}. Correct the figure or drop the regulatory claim`,
            });
          }
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// distractor

const HEDGE =
  /\b(?:(?:also|equally|likewise) (?:works?|valid|correct|acceptable|reasonable|effective|sufficient|sound|fine|appropriate|stops?|blocks?|breaks?|resolves?|fixes?|addresses|contains?)|equally (?:good|strong|defensible)|just as (?:good|valid|effective|sound|strong)|would (?:also|equally) (?:work|stop|block|resolve|fix|suffice|break|contain|address)|(?:a|an) (?:valid|acceptable|reasonable|equally good|sound|legitimate|defensible) (?:alternative|choice|option|answer|approach)|either (?:option|answer|choice|approach) (?:is|would|works?)|could (?:also )?be (?:argued|justified|defended|correct|right)|arguably (?:correct|best|right|the best)|(?:is|are) not (?:wrong|incorrect)|not (?:a )?wrong|both (?:options|answers|approaches|choices) (?:are|would|work)|hard to (?:fault|argue against)|(?:as|equally) (?:good|valid) as)\b/i;

const STATES_FAILURE =
  /\b(?:but|however|yet|though|although|whereas|except|unless|instead|rather than|does not|doesn't|do not|don't|did not|didn't|would not|wouldn't|will not|won't|cannot|can't|could not|couldn't|is not|isn't|are not|aren't|was not|wasn't|has no|have no|no longer|fails?|failing|failure|misses|missing|leaves?|leaving|ignores?|overlooks?|too (?:late|slow|broad|wide|narrow|early|blunt|coarse)|later (?:step|stage)|earlier (?:step|stage)|wrong (?:step|stage|layer|target|problem)|the wrong|without|not (?:the|a|an|on|enough|where|what|how|why|until|yet|this|that|here)|nothing|none|destroys?|loses?|lost|breaks?|violat(?:es|ing)|conflicts?|hurts?|harms?|slower|wider|narrower|unrelated|irrelevant|only|merely|just|still|remains?|already|after the fact|accepts? more|costs?|downtime|outage|blast radius|does nothing|achieves nothing|no effect|no gain|less|worse|weaker|insufficient|incomplete|partial|delays?|premature|overkill|excessive|risks?|never|neither|nor|not (?!wrong\b|incorrect\b)\w+|overstat\w*|understat\w*|over-?claims?|under-?claims?|exclud\w*|outside|unaffected|untouched|continues?|bypass\w*|blind)\b/i;

/** Every non-best option must be shown to fail for a stated reason; none may be "also valid" or a restatement of the best one. */
export function checkDistractors(input: GeneratorOutput | QualityView): QualityFinding[] {
  const out = viewOf(input);
  const findings: QualityFinding[] = [];
  const correct = out.options.find((o) => o.id === out.correct_option);
  if (!correct) return findings;
  for (const a of out.option_analysis) {
    const field = `option_analysis.${a.id}`;
    if (a.id === out.correct_option) {
      if (a.verdict === 'best' && HEDGE.test(a.why)) {
        findings.push({ rule: 'distractor', severity: 'error', field, message: `${field}: the best option is described as one of several valid answers ("${a.why.match(HEDGE)![0]}"); if the question has two defensible answers, change the scenario so only one is best` });
      }
      continue;
    }
    const hedged = HEDGE.exec(a.why)?.[0];
    const fails = STATES_FAILURE.test(a.why);
    if (hedged && !fails) {
      findings.push({ rule: 'distractor', severity: 'error', field, message: `${field}: option ${a.id} is called "${hedged}" with no reason it fails here; a distractor must be wrong for a reason the scenario shows (wrong step, breaks the constraint, destroys evidence, does not touch the path)` });
    } else if (!fails) {
      findings.push({ rule: 'distractor', severity: 'error', field, message: `${field}: option ${a.id} is not shown to fail; say which step it does not address, which constraint it breaks or what it costs, so the learner can see why it is weaker` });
    } else if (hedged) {
      findings.push({ rule: 'distractor', severity: 'warning', field, message: `${field}: option ${a.id} is described as "${hedged}"; make sure the stated reason it fails is decisive` });
    }
  }
  // A distractor that restates the best option is a second right answer: most terms shared, and the shared
  // terms are actions, not only component names. Two different actions on one component ("revoke the
  // ci-runner role session" / "enable logging for the ci-runner role session") share the names by design.
  const labelTerms = contentTerms(out.names.join(' '));
  const overlap = (a: Set<string>, b: Set<string>) => {
    const inter = [...a].filter((x) => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    return { inter, j: union ? inter / union : 0 };
  };
  const withoutNames = (t: Set<string>) => new Set([...t].filter((x) => !labelTerms.has(x)));
  const correctTerms = contentTerms(correct.text);
  for (const o of out.options) {
    if (o.id === out.correct_option) continue;
    const t = contentTerms(o.text);
    const all = overlap(t, correctTerms);
    const actions = overlap(withoutNames(t), withoutNames(correctTerms));
    if (all.j >= 0.5 && all.inter >= 4 && actions.j >= 0.4 && actions.inter >= 3) {
      findings.push({ rule: 'distractor', severity: 'error', field: `options.${o.id}`, message: `options: option ${o.id} restates the best option (${pct(all.j)} of their terms are shared); the two would both be defensible. Make the distractor a different action, not a rewording` });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------

export function qualityChecks(input: GeneratorOutput | QualityView): QualityFinding[] {
  const out = viewOf(input);
  return [...checkAnswerLeak(out), ...checkTimeline(out), ...checkRegulationFacts(out), ...checkDistractors(out)];
}
