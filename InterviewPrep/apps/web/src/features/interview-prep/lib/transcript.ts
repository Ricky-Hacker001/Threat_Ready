/**
 * Clean-up for browser speech-to-text in a security interview. Speech engines spell out acronyms
 * ("s i e m"), mishear jargon ("sim", "mitre attack") and drop capitals; these rules fix the common
 * cases only where the intended term is unambiguous in this context. The candidate can still edit
 * the text before it is submitted.
 */
const RULES: [RegExp, string][] = [
  [/\bmit(?:re|er) (?:attack|att and ck|at&ck|att&ck)\b/gi, 'MITRE ATT&CK'],
  [/\b(?:s i e m|sim)\b(?= (?:tool|platform|alert|alerts|rule|rules|query|queries|logs?|data|solution|like|such|and|or)\b|[.,]|$)/gi, 'SIEM'],
  [/\bsiem\b/gi, 'SIEM'],
  [/\bs ?o ?a ?r\b|\bsoar\b/gi, 'SOAR'],
  [/\bs o c\b|\bsoc\b/gi, 'SOC'],
  [/\be ?d ?r\b/gi, 'EDR'],
  [/\bx ?d ?r\b/gi, 'XDR'],
  [/\bn ?d ?r\b/gi, 'NDR'],
  [/\bi ?o ?c ?s\b|\bioc's\b/gi, 'IOCs'],
  [/\bi o c\b|\bioc\b/gi, 'IOC'],
  [/\bt ?t ?p ?s\b|\bttp's\b/gi, 'TTPs'],
  [/\bc (?:two|2)\b|\bc2\b/gi, 'C2'],
  [/\bc ?v ?e\b/gi, 'CVE'],
  [/\bo ?w ?a ?s ?p\b|\bowasp\b/gi, 'OWASP'],
  [/\bx ?s ?s\b/gi, 'XSS'],
  [/\bs ?q ?l\b/gi, 'SQL'],
  [/\bs ?s ?r ?f\b/gi, 'SSRF'],
  [/\bc ?s ?r ?f\b/gi, 'CSRF'],
  [/\bn ?i ?s ?t\b/gi, 'NIST'],
  [/\bw ?a ?f\b/gi, 'WAF'],
  [/\bm ?f ?a\b/gi, 'MFA'],
  [/\bs ?s ?o\b/gi, 'SSO'],
  [/\bd ?n ?s\b/gi, 'DNS'],
  [/\bv ?p ?n\b/gi, 'VPN'],
  [/\bs ?s ?h\b/gi, 'SSH'],
  [/\bt ?l ?s\b/gi, 'TLS'],
  [/\bk ?q ?l\b/gi, 'KQL'],
  [/\bs ?p ?l\b(?= (?:query|queries|search)\b)/gi, 'SPL'],
  [/\ba ?w ?s\b/gi, 'AWS'],
  [/\bg ?c ?p\b/gi, 'GCP'],
  [/\bi ?d ?s\b(?= (?:and|or|rule|rules|alert|alerts|sensor|signature|signatures)\b)/gi, 'IDS'],
  [/\bi ?p ?s\b(?= (?:and|or|rule|rules|alert|alerts|sensor|signature|signatures)\b)/gi, 'IPS'],
  [/\bsplunk\b|\bsplank\b|\bsplunck\b/gi, 'Splunk'],
  [/\bsentinel (?:one|1)\b/gi, 'SentinelOne'],
  [/\bcrowd ?strike\b/gi, 'CrowdStrike'],
  [/\bwire ?shark\b/gi, 'Wireshark'],
  [/\bkubernetes\b|\bkuber netties\b|\bcuber netties\b/gi, 'Kubernetes'],
  [/\bactive directory\b/gi, 'Active Directory'],
  [/\bpower ?shell\b/gi, 'PowerShell'],
  [/\bphishing\b|\bfishing (?=email|emails|attack|attacks|campaign|simulation)\b/gi, 'phishing '],
];

export function cleanTranscript(text: string): string {
  let out = ` ${text.replace(/\s+/g, ' ').trim()} `;
  for (const [re, to] of RULES) out = out.replace(re, to);
  out = out.replace(/\s+/g, ' ').replace(/ ([,.!?])/g, '$1').trim();
  return out;
}

/** Joins a new phrase onto the answer so far: capitalises sentence starts and keeps spacing tidy. */
export function appendPhrase(answer: string, phrase: string): string {
  const p = cleanTranscript(phrase);
  if (!p) return answer;
  const base = answer.trimEnd();
  if (!base) return capitalise(p);
  const sentenceEnded = /[.!?]$/.test(base);
  return `${base} ${sentenceEnded ? capitalise(p) : p}`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Words a speech engine should expect in a security interview (used where the browser supports biasing). */
export const SECURITY_PHRASES = [
  'SIEM', 'SOC', 'SOAR', 'EDR', 'XDR', 'MITRE ATT&CK', 'IOC', 'TTPs', 'C2', 'Splunk', 'Sentinel', 'CrowdStrike', 'Wireshark',
  'phishing', 'ransomware', 'lateral movement', 'privilege escalation', 'threat hunting', 'incident response', 'triage',
  'false positive', 'vulnerability', 'CVE', 'OWASP', 'SQL injection', 'cross-site scripting', 'firewall', 'zero trust',
  'Active Directory', 'Kerberos', 'PowerShell', 'Kubernetes', 'IAM', 'MFA', 'DNS', 'VPN', 'TLS', 'encryption', 'malware',
];
