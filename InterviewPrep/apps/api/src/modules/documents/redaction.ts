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

const RULES: { name: string; marker: string; re: RegExp }[] = [
  // The lookbehind anchors the match to the start of its run: without it a 30,000-character run of
  // address characters with no "@" is rescanned from every position (1.6 s per document, A11c).
  { name: 'email', marker: '[EMAIL]', re: /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { name: 'url', marker: '[PROFILE_URL]', re: /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com|twitter\.com|x\.com|medium\.com|behance\.net|dribbble\.com)\/[^\s)|,;]+/gi },
  { name: 'url', marker: '[URL]', re: /\bhttps?:\/\/[^\s)|,;]+/gi },
  { name: 'aadhaar', marker: '[ID_NUMBER]', re: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  { name: 'pan', marker: '[ID_NUMBER]', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { name: 'passport', marker: '[ID_NUMBER]', re: /\bpassport(?:\s*(?:no\.?|number))?\s*[:#-]?\s*[A-Z][0-9]{7}\b/gi },
  {
    name: 'phone',
    marker: '[PHONE]',
    re: /(?<![\w/.-])(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{4,5}(?![\w/.-])/g,
  },
  { name: 'dob', marker: '[DATE_OF_BIRTH]', re: /\b(?:date of birth|d\.?o\.?b\.?|born on)\s*[:\-]?\s*[^\n]{4,30}/gi },
  {
    name: 'address',
    marker: '[ADDRESS]',
    re: /^[^\n]{0,80}\b(?:street|st\.|road|rd\.|lane|nagar|colony|sector|apartment|apt\.?|flat|floor|block|avenue|ave\.|marg|layout|cross|main road|near)\b[^\n]{0,120}\b\d{6}\b[^\n]*$/gim,
  },
  { name: 'address', marker: '[ADDRESS]', re: /^\s*(?:address|addr\.?|residence)\s*[:\-][^\n]+$/gim },
  { name: 'pincode', marker: '[PINCODE]', re: /\b(?:pin(?:code)?|zip)\s*[:\-]?\s*\d{5,6}\b/gi },
];

const YEAR_RANGE = /\b(19|20)\d{2}\s*[-–]\s*((19|20)\d{2}|present|now)\b/i;

export function redact(input: string, opts: { redactNameLine?: boolean } = {}): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (match) => {
      // Do not treat date ranges or plain years as phone numbers.
      if (rule.name === 'phone' && (YEAR_RANGE.test(match) || match.replace(/\D/g, '').length < 10)) return match;
      counts[rule.name] = (counts[rule.name] ?? 0) + 1;
      return rule.marker;
    });
  }
  if (opts.redactNameLine) {
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => l.trim().length > 0);
    const first = idx >= 0 ? lines[idx]!.trim() : '';
    // A first line of 2-4 capitalised words with no digits is almost always the candidate's name.
    if (/^(?:[A-Z][a-zA-Z'.-]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-zA-Z'.-]+|[A-Z]{2,})){1,3}$/.test(first) && !/resume|curriculum|vitae|profile/i.test(first)) {
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
