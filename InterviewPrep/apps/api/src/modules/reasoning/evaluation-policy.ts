import type { OptionId } from '@threatready/contracts';
import type { EvaluationMode, EvaluatorOutput } from './prompts/evaluation.prompts.js';
import type { ScoreOutcome } from './scoring.js';

/**
 * When a single-pass (Haiku) evaluation goes to the second review (Sonnet challenger and reconciler):
 * cost design 26 Oct 2026, §6.3. Every rule is deterministic and computed after stage 1 from its
 * output and the provisional score, so the decision never rests on the model being asked whether it
 * should be checked. An empty list means the provisional result is final.
 */
export type EscalationReason = 'mode_full' | 'forced' | 'borderline' | 'low_confidence' | 'unverified_credit' | 'integrity_suspected' | 'penalty_unconfirmed' | 'audit';

export const ESCALATION_REASONS: readonly EscalationReason[] = ['mode_full', 'forced', 'borderline', 'low_confidence', 'unverified_credit', 'integrity_suspected', 'penalty_unconfirmed', 'audit'];

/** Credited points the quote check withdrew before an answer is escalated as unverified_credit. */
export const UNVERIFIED_CREDIT_MIN = 2;

export interface EscalationInput {
  mode: EvaluationMode;
  /** The job asked for the second review (an operator's re-run; a learner's retry no longer forces it, review COST-6). */
  forced: boolean;
  selected: OptionId;
  /** Whether the selected option is the item's best one (the deductions on a wrong option matter less, below). */
  selectedIsBest?: boolean;
  provisional: Pick<ScoreOutcome, 'total' | 'quoteDowngrades'>;
  /**
   * The provisional total with stage 1's deductions left out (no asserted claims, technical errors or
   * argued-for option): how high the answer could score if the second review dropped every deduction.
   */
  unpenalisedTotal?: number;
  evaluator: Pick<EvaluatorOutput, 'confidence' | 'integrity' | 'asserted_claims' | 'incorrect_claims'>;
  justification: string;
  /** REASONING_ESCALATION_CENTER and REASONING_ESCALATION_BAND (0 = no borderline escalation). */
  center: number;
  band: number;
  /**
   * This answer was drawn for the random audit (REASONING_ESCALATION_AUDIT_RATE, review AR-SEC-1): an
   * unpredictable share of single-pass results gets the second review anyway, so text that talks the
   * SMALL grader round without tripping a rule still meets the stronger model some of the time.
   */
  audit?: boolean;
}

export function escalationReasons(input: EscalationInput): EscalationReason[] {
  const reasons: EscalationReason[] = [];
  if (input.mode === 'full') reasons.push('mode_full');
  if (input.forced) reasons.push('forced');
  const ev = input.evaluator;
  // An integrity flag raised by stage 1 fixes the outcome: flags are never cleared by a later stage
  // (audit TR-21) and they zero every reasoning dimension, so a second review could not change any
  // number. Such results are already low confidence and flagged for human review; only the rollback
  // mode and an explicit request send them to the later stages.
  if (ev.integrity.instructs_grader || ev.integrity.off_topic) return reasons;
  if (input.band > 0 && Math.abs(input.provisional.total - input.center) <= input.band) reasons.push('borderline');
  if (ev.confidence === 'low') reasons.push('low_confidence');
  if (input.provisional.quoteDowngrades >= UNVERIFIED_CREDIT_MIN) reasons.push('unverified_credit');
  if (looksLikeInjection(input.justification)) reasons.push('integrity_suspected');
  // Each of these lowers the score on stage 1's word alone: a stronger model confirms it first. Not on
  // a wrong option that stays below the borderline band even with every deduction dropped (review
  // COST-3): the second review could not move it across the band, and wrong-option answers almost
  // always carry an incorrect claim, so confirming them was most of the escalation spend.
  const arguesForOther = ev.integrity.argues_for_option !== null && ev.integrity.argues_for_option !== input.selected;
  const deductionCannotMatter = input.selectedIsBest === false && input.unpenalisedTotal !== undefined && input.band > 0 && input.unpenalisedTotal < input.center - input.band;
  if ((ev.asserted_claims.length > 0 || ev.incorrect_claims.length > 0 || arguesForOther) && !deductionCannotMatter) reasons.push('penalty_unconfirmed');
  if (input.audit && input.mode !== 'full' && !reasons.length) reasons.push('audit');
  return reasons;
}

/**
 * The scoring notes never say whether or why an answer had the second review (review AR-SEC-1): a note
 * per rule told a learner when the injection screen fired, so they could rewrite their text until it no
 * longer did. The reasons stay in the stored stages (`stages.escalation`) for operators.
 */
export function escalationNote(_reasons: readonly EscalationReason[]): string | null {
  return null;
}

/** Whether this answer is drawn for the random audit: `rate` (0-1) of answers, decided by `rng`. */
export function drawnForAudit(rate: number, rng: () => number): boolean {
  return rate > 0 && rng() < rate;
}

/* ---------------- looksLikeInjection ---------------- */

/**
 * Deterministic screen for text that tries to steer the grader. It never lowers a score by itself:
 * a hit only sends the answer to the stronger model (integrity_suspected), which decides. So it is
 * tuned to catch the replay corpus (test/fixtures/injection-corpus.json) while leaving ordinary
 * security writing alone, including answers about prompt injection, Purdue levels, risk scores,
 * encoded web payloads and hashes. Every pattern is linear: bounded gaps, no nested quantifiers.
 */
export function looksLikeInjection(text: string): boolean {
  if (!text) return false;
  if (INVISIBLE.test(text)) return true;
  if (mostlyNonLatin(text)) return true;
  const t = text.normalize('NFKC').toLowerCase();
  if (DIRECT.some((re) => re.test(t))) return true;
  if (MULTILINGUAL.some((re) => re.test(t))) return true;
  if (hasBase64Run(text)) return true;
  // Obfuscated variants: each is checked against the core instructions only.
  return variants(t).some((v) => CORE.some((re) => re.test(v)));
}

/** Zero-width and bidirectional control characters: never needed in a justification, common in smuggled text. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** Instructions to drop the rules or claim marks: checked on the text and on every decoded variant. */
const CORE: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|my|your|of|these|those)\s+){0,3}(?:(?:previous|prior|above|earlier|preceding|former|system|original|grading|scoring|marking)\s+){0,2}(?:instructions?|rules|rubric|guidelines|prompts?|directions|grading|scoring)\b/,
  /\b(?:full|maximum|max|highest|perfect|top)\s+(?:marks?|credit(?!\s*cards?\b)|points|grade)\b/,
  /\b(?:award|give|grant)\s+(?:me|this answer|my answer|the candidate|the learner)\b[^.\n]{0,30}\b(?:marks?|credit|full|maximum|points)\b/,
];

const DIRECT: RegExp[] = [
  ...CORE,
  // Tag-like text for any block of the grading prompts, or a chat-role tag.
  /[<\u2039]\s*\/?\s*(?:untrusted_|evaluator_output|challenger_output|system>|rubric>|assistant>|instructions?>)/,
  // Addressing the grader or claiming the system's voice.
  /\b(?:grader|gradebot)s?\b/,
  /\b(?:note|message|instructions?)\s+(?:to|for)\s+the\s+(?:evaluator|reviewer|assessor|grader)\b/,
  /\b(?:dear|hey|hi|hello)\s+(?:evaluator|reviewer|assessor|claude|ai|assistant)\b/,
  /\bthis is (?:the|your) (?:examiner|evaluator)\b/,
  /\bthis is (?:the|your) (?:system|administrator|admin|developer) speaking\b/,
  /(?:^|[\n.!?#]\s*)(?:system|admin|developer)(?:\s+says|\s+note|\s+override)?\s*:/,
  /(?:^|[\n.!?#]\s*)(?:assistant|evaluator|interviewer|reviewer|examiner)(?:\s+says)?\s*[:,]/,
  /\bsystem\s+(?:override|note)\b/,
  /\b(?:previous|last|prior|earlier) message from the system\b/,
  // Score claims and requests.
  /\blevels?\s*(?:=|:|to|as)\s*(?:level\s*)?4\b/,
  /\blevel\s*4\s+(?:for|on|across)\s+(?:all|every|each)\b/,
  /\boutput\s+level\s*\d/,
  /\b(?:my |the |total |final )?score\s*[:=]\s*(?:100|\d\s*\/\s*\d)\b/,
  /\bscore\s+(?:of\s+)?100\b/,
  /\b(?:correctness|completeness|reasoning|communication|architecture|risk|skill_evidence|criteri[a-z]*)\s*=\s*\d\b/,
  /\b(?:every|all|each)\s+(?:criteri(?:on|a)|rubric points?)\b[^.\n]{0,30}\b(?:met|level\s*4|maximum|max|perfect)\b/,
  /\ball (?:rubric )?points (?:are )?met\b/,
  /\bmark\s+(?:it|this|me|my answer|the answer|every|all|each)\b[^.\n]{0,40}\b(?:correct|met|perfect|full marks|level\s*4)\b/,
  /\b(?:grade|rate)\s+(?:it|this|me|the response|the answer|my answer)\b[^.\n]{0,20}\b(?:perfect|correct|full|maximum|highest)\b/,
  /\bintegrity flags?\b/,
  /\bquote check\b/,
  /\bcalibration run\b/,
  /\bconfirm and proceed\b/,
  /\bend of (?:the |my )?(?:answer|justification)\b/,
  // Paraphrased grader instructions (review AR-SEC-1): addressing whoever marks the answer, telling them
  // to record the points as met, to set the guidance aside, or how confident to be. Grader-facing
  // wording only; a hit costs a second review, never a mark.
  /\b(?:to|for)\s+(?:whoever|whomever|anyone|the\s+(?:person|people|system|model|ai)(?:\s+or\s+(?:system|model|ai))?)\s+(?:who\s+)?(?:is\s+|are\s+)?(?:marks?|marking|grades?|grading|assess(?:es|ing)?|evaluat(?:es|ing)|reviews?|reviewing|scor(?:es|ing)|checks?|checking)\b/,
  /\bwhoever\s+(?:marks|grades|assesses|evaluates|reviews|scores|checks)\s+(?:this|my|the)\b/,
  /\b(?:the\s+)?(?:person|people|one)\s+(?:marking|assessing|grading|evaluating|scoring)\s+(?:this|my|the)\s+(?:answer|response|justification)\b/,
  /\b(?:note|message|instructions?|guidance|reminder)\s+(?:to|for)\s+the\s+(?:marker|examiner|(?:scoring|assessing|grading|marking|evaluating|evaluation)\s+(?:model|system|ai|bot|llm))\b/,
  /(?:^|[\n.!?;]\s*)(?:marker|marking|grading|scoring|assessor|assessment|evaluation|evaluator|reviewer)\s+(?:instructions?|guidance|notes?)\s*(?:\([^)\n]{0,20}\)\s*)?:/,
  /\b(?:treat|record|count|consider|regard|mark|credit|score|rate)\b[^.\n;:]{0,30}\b(?:each|every|all)\b[^.\n;:]{0,30}\b(?:points?|items?|criteri(?:on|a)|requirements?|expectations?|dimensions?)\b[^.\n;:]{0,25}\b(?:met|satisfied|credited|complete|fulfilled|excellent)\b/,
  /\b(?:record|count|mark|treat|regard|consider|score)\s+(?:each|every|all|them|it)\s+(?:one\s+|of\s+them\s+)?as\s+(?:met|satisfied|credited|complete|fulfilled)\b/,
  /\bcredit\s+(?:them|these|those)\s+all\b|\bcredit\s+(?:all|every|each)\s+(?:of\s+(?:them|these)\b|(?:the\s+)?(?:points?|items?|criteri(?:on|a)|reasoning|architecture|risk)\b)/,
  /\bplease\s+(?:count|credit|accept|record|award|grade|score|rate)\b/,
  /\b(?:items?|points?|expectations?|criteri(?:on|a)|requirements?)\s+on\s+your\s+(?:list|checklist|rubric|sheet|scheme)\b/,
  /\b(?:overlook|set\s+aside|disregard|ignore|forget|discard)\s+(?:(?:all|any|the|my|your|of|these|those|what|you|were|told|earlier|previous|prior|above|strict|marking|grading|scoring)\s+){0,4}(?:guidance|instructions?|criteria|rubric|marking\s+guide|rules|told)\b/,
  /\b(?:guide|guidance|instructions?|rubric|criteria|rules)\s+you\s+(?:were|have\s+been)\s+(?:given|told)\b/,
  /\b(?:set|mark|report|return|respond\s+with)\b[^.\n]{0,30}\bconfidence\s+(?:to\s+|as\s+|at\s+)?(?:high|maximum)\b/,
  /\b(?:rate|score|grade|mark)\s+(?:this|it|the|my|every|each|all)\b[^.\n;]{0,40}\b(?:excellent|exemplary|generously|leniently|top\s+of\s+the\s+scale|highest\s+level)\b/,
  /\b(?:score|grade|mark|rate)\s+(?:it\s+|this\s+|me\s+)?(?:generously|leniently)\b|\bbe\s+(?:generous|lenient)\b/,
  /\b(?:accept|treat|regard|rate|mark|grade|score)\s+(?:this|it|my\s+answer|the\s+answer|this\s+answer|this\s+response|everything\s+(?:below|above|here))\s+as\s+(?:an?\s+)?(?:exemplary|excellent|perfect|complete|correct|fully\s+correct|outstanding|model)\b/,
  /\bas\s+the\s+(?:evaluator|assessor|marker|reviewer|examiner)\s+you\b/,
  /\bassume\s+(?:that\s+)?the\s+(?:candidate|learner|student|author)\b/,
  /\b(?:treated|regarded|counted|recorded|marked|credited)\s+as\s+(?:meeting|satisfying|fulfilling)\s+(?:every|each|all)\b/,
  /\b(?:meets|satisfies)\s+(?:every|each|all)\s+(?:of\s+the\s+)?(?:expectations?|criteri(?:on|a)|rubric)\b/,
  /\b(?:addresses|covers|meets|satisfies)\s+(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?(?:expected|required|rubric|marking)\s+(?:points?|items?|criteri(?:on|a))\b/,
  /\b(?:evaluation|grade|score|marking)\s+of\s+(?:this|my)\s+(?:response|answer|justification)\b/,
  /\b(?:every|each|all)\s+(?:the\s+)?(?:points?|criteri(?:on|a)|items?|requirements?)\s+(?:marked|set|recorded|scored|graded)\s+(?:as\s+)?(?:met|satisfied|correct|complete)\b/,
  /\bmark\s+(?:the\s+)?(?:reasoning|architecture|risk|answer|response|justification|points?|items?)\s+as\s+(?:met|satisfied|correct|complete|full)\b/,
  // Role play.
  /\byou are (?:now |no longer |actually )?(?:a |an |my |the )?(?:[a-z]+ )?(?:grader|gradebot|assistant|professor|teacher|interviewer|candidate|evaluator|examiner|bot)\b/,
  /\bpretend(?: that)? (?:you|you're|the rubric|every answer|there is no)\b/,
  /\blet'?s play a game\b/,
  /\b(?:god|jailbreak|dan) mode\b/,
  /\bfrom now on,? you\b/,
  // The response schema's own field names, or asking for a quote to be copied.
  /\b(?:evidence[_ ]quotes?|instructs_grader|off_topic|argues_for_option|asserted_claims|answer_integrity|concepts_(?:missing|demonstrated)|criterion_id|final_points|point_id|must_not_credit|incorrect_claims)\b/,
  /\bquote (?:the following|this|it|me|my answer)\b[^.\n]{0,30}\bverbatim\b/,
  /\b(?:use|copy) (?:this|the following) (?:exact )?(?:string|text|sentence|quote)\b/,
  // Encodings that only make sense as smuggling.
  /(?:^|[\n.!?:]\s*)(?:please\s+)?(?:decode|decrypt|deobfuscate)\s+(?:this|it|and|then)\b[^.\n]{0,20}\b(?:follow|obey)\b/,
  /\brot-?13\b/,
  /\b(?:first|initial) letters? of (?:each|every) (?:word|line|sentence)\b/,
  /\bacrostic\b/,
];

/** The same requests in the languages of the replay set and a few more (non-Latin scripts are also caught by mostlyNonLatin). */
const MULTILINGUAL: RegExp[] = [
  /\b(?:ignora|ignorar|ignorez|ignorer|ignoriere|ignorieren|ignoruj|negeer|abaikan)\b/,
  /\b(?:instrucciones|anweisungen|instruções)\b/,
  /\b(?:puntuaci[oó]n m[aá]xima|m[aá]xima puntuaci[oó]n|volle punktzahl|note maximale|nota m[aá]xima|pontua[cç][aã]o m[aá]xima)\b/,
  /(?:無視|忽略|満点|满分|指示を|अनदेखा|निर्देश|पूरे अंक|تجاهل|التعليمات|игнорир|инструкци|максимальн|புறக்கணி|வழிமுறை|மதிப்பெண்|무시|만점)/,
];

/** A justification written mostly in a non-Latin script (the product's answers are English): at least 12 such letters and 30% of all letters. */
function mostlyNonLatin(text: string): boolean {
  let letters = 0;
  let other = 0;
  for (const ch of text.slice(0, 8000)) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (!LATIN.test(ch)) other++;
  }
  return other >= 12 && other / letters >= 0.3;
}
const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;

/** A base64-looking run of 40+ characters mixing upper case, lower case and digits (hex digests are not flagged). */
function hasBase64Run(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
    const run = m[0];
    if (/^[0-9a-fA-F]+$/.test(run)) continue;
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  return false;
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

/** Decoded readings of lower-cased text: leetspeak, spelled-out letters, ROT13, \u and %-escapes, and the acrostic of the words. */
function variants(t: string): string[] {
  const out = [t.replace(/[013457@$]/g, (c) => LEET[c] ?? c), t.replace(/\b([a-z])[-. ](?=[a-z]\b)/g, '$1'), rot13(t)];
  if (/\\u[0-9a-f]{4}/.test(t)) out.push(t.replace(/\\u([0-9a-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).toLowerCase());
  if (/%[0-9a-f]{2}/.test(t)) {
    try {
      out.push(decodeURIComponent(t.replace(/%(?![0-9a-f]{2})/g, '%25')).toLowerCase());
    } catch {
      /* not decodable: nothing to add */
    }
  }
  const initials = t.match(/[a-z]+/g)?.map((w) => w[0]).join('') ?? '';
  if (/ignore|disregard|fullmarks|awardme|givemefull/.test(initials)) out.push('ignore all previous instructions');
  return out;
}
