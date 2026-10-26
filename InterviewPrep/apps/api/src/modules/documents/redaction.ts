/**
 * Pattern redaction applied before text is stored or sent to the LLM (ADD §9: email addresses,
 * phone numbers and street addresses are redacted by pattern). Also covers identifiers common
 * on Indian resumes (Aadhaar, PAN), dates of birth, profile URLs and the name line.
 * Markers keep the document readable so the candidate can see what was removed.
 */
export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

/**
 * Every pattern runs in linear time on the API thread (audit 2026-10-23 TR-04): no unbounded
 * quantifier can be retried from many start positions. Runs are bounded ({1,64}, {0,4}), and a
 * lookbehind lets a run start only at its first character, so 30,000 characters of adversarial
 * text ('a@a.a.a…', '12-12-…', long digit or whitespace runs) cost milliseconds, not seconds.
 * Whitespace between a label and its value is at most four characters (normaliseText has already
 * collapsed longer runs), which keeps "DOB:\n01/02/1999" matching across one line break.
 */
const RULES: { name: string; marker: string; re: RegExp }[] = [
  // The lookbehind anchors the match to the start of its run: without it a 30,000-character run of
  // address characters with no "@" is rescanned from every position (1.6 s per document, A11c / TR-04).
  // The bounded runs (RFC 5321 local part 64, domain 253, TLD 24) keep the work per start linear too.
  { name: 'email', marker: '[EMAIL]', re: /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}\b/gi },
  { name: 'url', marker: '[PROFILE_URL]', re: /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com|twitter\.com|x\.com|medium\.com|behance\.net|dribbble\.com)\/[^\s)|,;]+/gi },
  { name: 'url', marker: '[URL]', re: /\bhttps?:\/\/[^\s)|,;]+/gi },
  // Not after '+' (+919876543210 is a phone number, the phone rule below) nor in a CVE id (CVE-2023-12345678).
  { name: 'aadhaar', marker: '[ID_NUMBER]', re: /(?<!\+|[Cc][Vv][Ee]-)\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  { name: 'pan', marker: '[ID_NUMBER]', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { name: 'passport', marker: '[ID_NUMBER]', re: /\bpassport(?:\s{0,4}(?:no\.?|number))?\s{0,4}[:#-]?\s{0,4}[A-Z][0-9]{7}\b/gi },
  {
    name: 'phone',
    marker: '[PHONE]',
    // A run of 9-15 digits in any grouping, joined by up to three spaces, dots, hyphens or
    // parentheses within one line (audit final review BIZ-04, UI-3): +91 98765 43210, (+91) 98765-43210,
    // +1 (415) 555-0134, (022) 2345 6789, +44 7700 900 123, +33 6 12 34 56 78, 06.12.34.56.78, also
    // right after a label (Mob-, Ph.No., Mobile:-), on either side of '/' (9876543210/9123456789) and
    // before a full stop. A run cannot start inside a word, a dotted or hyphenated number or a CVE id
    // (the lookbehind), nor end before one (the lookahead); isPhone() then keeps fewer than 10 digits,
    // year ranges, dates, IP addresses, decimals and version numbers.
    re: /(?<![\w+(]|\d[.-]|cve-)(?:\+|\(\+?)?\d(?:(?:[^\S\n]|[.()-]){0,3}\d){8,14}(?![\w-]|\.\d)/gi,
  },
  { name: 'dob', marker: '[DATE_OF_BIRTH]', re: /\b(?:date of birth|d\.?o\.?b\.?|born on)\s{0,4}[:\-]?\s{0,4}[^\n]{4,30}/gi },
  {
    name: 'address',
    marker: '[ADDRESS]',
    re: /^[^\n]{0,80}\b(?:street|st\.|road|rd\.|lane|nagar|colony|sector|apartment|apt\.?|flat|floor|block|avenue|ave\.|marg|layout|cross|main road|near)\b[^\n]{0,120}\b\d{6}\b[^\n]*$/gim,
  },
  { name: 'address', marker: '[ADDRESS]', re: /^[^\S\n]{0,10}(?:address|addr\.?|residence)[^\S\n]{0,4}[:\-][^\n]+$/gim },
  { name: 'pincode', marker: '[PINCODE]', re: /\b(?:pin(?:code)?|zip)\s{0,4}[:\-]?\s{0,4}\d{5,6}\b/gi },
];

const YEAR_RANGE = /\b(19|20)\d{2}\s*[-–]\s*((19|20)\d{2}|present|now)\b/i;
const YEAR = /^(?:19|20)\d{2}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Whether a digit run the phone rule matched is a phone number (10-15 digits) rather than a date, address or version. */
function isPhone(match: string): boolean {
  const groups = match.match(/\d+/g) ?? [];
  const digits = groups.join('').length;
  if (digits < 10 || digits > 15 || YEAR_RANGE.test(match)) return false;
  // Dates and lists of years: 2019-01 - 2023-06, 2023-10-12 14, Top 10 2021 2022, 2021 2022 2023.
  if (groups.some((g) => YEAR.test(g)) && groups.every((g) => YEAR.test(g) || g.length <= 2)) return false;
  // Numbers written only with dots are phones only as groups of 2-5 digits (415.555.0134, 06.12.34.56.78):
  // not IP addresses (192.168.100.200), decimals (3.14159265358) or versions (10.0.19041.1234, 2023.10.1234567).
  if (/^\d+(?:\.\d+)+$/.test(match) && (IPV4.test(match) || groups.length < 3 || groups.some((g) => g.length < 2 || g.length > 5))) return false;
  return true;
}

export function redact(input: string, opts: { redactNameLine?: boolean } = {}): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (match) => {
      if (rule.name === 'phone' && !isPhone(match)) return match;
      // Three years in a row (2021 2022 2023, 2015-2016 2017) are not an Aadhaar number.
      if (rule.name === 'aadhaar' && (match.match(/\d{4}/g) ?? []).every((g) => YEAR.test(g))) return match;
      counts[rule.name] = (counts[rule.name] ?? 0) + 1;
      return rule.marker;
    });
  }
  if (opts.redactNameLine) {
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => l.trim().length > 0);
    const first = idx >= 0 ? lines[idx]!.trim() : '';
    // A first line of 2-4 capitalised words with no digits is almost always the candidate's name.
    if (first.length <= 100 && /^(?:[A-Z][a-zA-Z'.-]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-zA-Z'.-]+|[A-Z]{2,})){1,3}$/.test(first) && !/resume|curriculum|vitae|profile/i.test(first)) {
      lines[idx] = '[NAME]';
      counts.name = 1;
      text = lines.join('\n');
    }
  }
  return { text, counts };
}

/** Whitespace normalisation and a hard length ceiling for extracted text. */
export function normaliseText(raw: string, maxChars: number): { text: string; truncated: boolean } {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxChars ? { text: text.slice(0, maxChars).trimEnd(), truncated: true } : { text, truncated: false };
}
