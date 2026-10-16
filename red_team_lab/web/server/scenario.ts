// SERVER-ONLY scenario definitions for TR-RED-001 (AeroCart). None of this reaches the browser
// except objective/finding titles and, once earned, explanations. Detection predicates, hints not
// yet requested, remediation answer keys, canary flag values and the solver are kept here.

import { TargetState, Fixes } from './fixture';

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

export interface RemediationOption { id: string; label: string; correct: boolean }
export interface FindingDef {
  id: string;
  title: string;
  klass: keyof Fixes;         // the fix flag that remediates it
  confirmEvent: string;       // the detection event that proves exploitation in traffic
  severity: Severity;
  severityWhy: string;
  cwe: string;
  owasp: string;              // OWASP Top 10 2021 category
  routes: string[];           // where it lives (for report / affected component)
  evidenceHint: string;       // shown as the objective hint chain (progressive)
  impact: string;
  rootCause: string;
  remediation: string;        // the full explanation, revealed only after the fix is verified
  options: RemediationOption[];
  verifyRetest: string;       // what a passing re-test looks like
}

export const FINDINGS: FindingDef[] = [
  {
    id: 'V-SQLI', title: 'SQL injection in authentication and product lookup', klass: 'sqli', confirmEvent: 'web.sqlInjection',
    severity: 'Critical', severityWhy: 'Unauthenticated authentication bypass and full database read-out.',
    cwe: 'CWE-89', owasp: 'A03:2021 Injection', routes: ['POST /login', 'GET /product'],
    evidenceHint: 'The login form seems to trust whatever it is given. What happens to a single quote?',
    impact: 'An attacker signs in as any user without a password and can dump the users table (usernames and password hashes) via a UNION query.',
    rootCause: 'User input is concatenated directly into the SQL statement instead of being bound as a parameter.',
    remediation: 'Use parameterised queries / prepared statements for every query. Never build SQL by string concatenation. Add least-privilege DB accounts and input validation as defence in depth.',
    options: [
      { id: 'param', label: 'Use parameterised queries (bound parameters) for the login and lookup SQL', correct: true },
      { id: 'escape', label: 'Strip single quotes from the username field', correct: false },
      { id: 'waf', label: 'Add a WAF rule blocking the string "OR 1=1"', correct: false },
    ],
    verifyRetest: "Re-send the auth-bypass payload to /login — it must now be rejected (401).",
  },
  {
    id: 'V-RXSS', title: 'Reflected XSS in product search', klass: 'reflectedXss', confirmEvent: 'web.reflectedXss',
    severity: 'High', severityWhy: 'Arbitrary script execution in a victim\'s session via a crafted link.',
    cwe: 'CWE-79', owasp: 'A03:2021 Injection', routes: ['GET /search'],
    evidenceHint: 'The search term is echoed back onto the results page. Is it encoded?',
    impact: 'A crafted ?q= link runs attacker JavaScript in the victim\'s browser — session theft, UI redressing.',
    rootCause: 'The q parameter is written into the HTML response without output encoding.',
    remediation: 'Contextually output-encode all user data (HTML-entity encode for HTML body). Add a Content-Security-Policy as defence in depth.',
    options: [
      { id: 'encode', label: 'HTML-entity encode the echoed search term before rendering', correct: true },
      { id: 'blocklist', label: 'Reject queries containing the word "script"', correct: false },
      { id: 'length', label: 'Limit the search term to 20 characters', correct: false },
    ],
    verifyRetest: 'Re-send the <script> payload to /search — the response must contain the encoded form, not the live tag.',
  },
  {
    id: 'V-SXSS', title: 'Stored XSS in support tickets', klass: 'storedXss', confirmEvent: 'web.storedXss',
    severity: 'High', severityWhy: 'Persistent script executes in every viewer, including an admin.',
    cwe: 'CWE-79', owasp: 'A03:2021 Injection', routes: ['POST /support/ticket', 'GET /support/ticket', 'GET /admin/tickets'],
    evidenceHint: 'A ticket body is stored and later rendered. Submit one, then view it.',
    impact: 'A malicious ticket body runs script when staff open it — admin session compromise.',
    rootCause: 'Ticket bodies are stored verbatim and rendered into HTML without sanitisation or encoding.',
    remediation: 'Encode stored content on output; optionally sanitise on input with an allowlist HTML sanitiser. Apply a strict CSP.',
    options: [
      { id: 'encode', label: 'HTML-encode the ticket body on render', correct: true },
      { id: 'trim', label: 'Trim whitespace from ticket bodies', correct: false },
      { id: 'disable', label: 'Disable the public ticket form', correct: false },
    ],
    verifyRetest: 'Re-open a ticket whose body contains a script payload — the sink must no longer receive live markup.',
  },
  {
    id: 'V-IDOR', title: 'IDOR / broken object-level authorization on the order API', klass: 'idor', confirmEvent: 'web.idor',
    severity: 'High', severityWhy: 'Any customer reads any other customer\'s order and personal data.',
    cwe: 'CWE-639', owasp: 'A01:2021 Broken Access Control', routes: ['GET /api/order'],
    evidenceHint: 'The order API takes an id. What stops you reading an id that is not yours?',
    impact: 'Enumerating order ids exposes other customers\' addresses, emails and phone numbers (excessive data exposure).',
    rootCause: 'The endpoint returns the order by id without checking that it belongs to the authenticated user.',
    remediation: 'Enforce object-level authorization: the order\'s owner must equal the session user. Avoid returning more PII than the caller needs.',
    options: [
      { id: 'ownercheck', label: 'Check the order\'s owner equals the session user; 403 otherwise', correct: true },
      { id: 'uuid', label: 'Switch order ids to UUIDs so they are hard to guess', correct: false },
      { id: 'ratelimit', label: 'Rate-limit the order API', correct: false },
    ],
    verifyRetest: 'Request another user\'s order id while signed in — it must now return 403.',
  },
  {
    id: 'V-JWT', title: 'Forgeable admin session (weak JWT signing secret)', klass: 'jwtAuth', confirmEvent: 'web.jwtForged',
    severity: 'Critical', severityWhy: 'Full admin takeover by forging a signed token offline.',
    cwe: 'CWE-347', owasp: 'A07:2021 Identification and Authentication Failures', routes: ['GET /admin'],
    evidenceHint: 'Admin uses an HS256 cookie token. Where might its secret be, and is it strong?',
    impact: 'The HS256 secret is a common word (leaked in a backup). An attacker mints an admin token and takes over the console.',
    rootCause: 'A weak, guessable/leaked signing secret, and no server-side check that the token was actually issued.',
    remediation: 'Rotate to a long random secret stored in a secrets manager; bind tokens to a server-side session; reject tokens not issued by the server.',
    options: [
      { id: 'rotate', label: 'Rotate to a strong random secret and only accept server-issued tokens', correct: true },
      { id: 'expiry', label: 'Shorten token expiry to 1 hour', correct: false },
      { id: 'rs256only', label: 'Rename the cookie so attackers cannot find it', correct: false },
    ],
    verifyRetest: 'Present an admin token forged with the old secret — it must now be rejected (403).',
  },
  {
    id: 'V-FILE', title: 'Sensitive file exposure (database backup and .env)', klass: 'fileExposure', confirmEvent: 'web.fileExposure',
    severity: 'Medium', severityWhy: 'Leaks the DB backup and app secrets, enabling other attacks.',
    cwe: 'CWE-538', owasp: 'A05:2021 Security Misconfiguration', routes: ['GET /download'],
    evidenceHint: 'robots.txt disallows some paths. Disallow is not access control.',
    impact: 'The downloadable DB backup and .env expose the JWT secret and credentials — the pivot to the admin takeover.',
    rootCause: 'Sensitive artefacts are stored in a web-served directory and reachable by direct URL.',
    remediation: 'Remove sensitive files from the web root; serve downloads from an allowlist; rotate any exposed secret.',
    options: [
      { id: 'remove', label: 'Remove backups/.env from the served directory (and deny by allowlist)', correct: true },
      { id: 'robots', label: 'Add the paths to robots.txt', correct: false },
      { id: 'rename', label: 'Rename the backup file to something less obvious', correct: false },
    ],
    verifyRetest: 'Re-request the backup file — it must now return 404.',
  },
  {
    id: 'V-TRAVERSAL', title: 'Path traversal in the document downloader', klass: 'pathTraversal', confirmEvent: 'web.pathTraversal',
    severity: 'High', severityWhy: 'Reads arbitrary files outside the document root.',
    cwe: 'CWE-22', owasp: 'A01:2021 Broken Access Control', routes: ['GET /download'],
    evidenceHint: 'The file parameter builds a path. What if it contains ../ ?',
    impact: 'An attacker reads host files such as /etc/passwd and app config outside the intended directory.',
    rootCause: 'The file parameter is joined to the document root without canonicalisation or a jail check.',
    remediation: 'Canonicalise the resolved path and verify it stays within the document root; reject .. segments; prefer an id-to-file map.',
    options: [
      { id: 'canon', label: 'Canonicalise the path and reject anything outside the document root', correct: true },
      { id: 'strip', label: 'Replace the literal string "../" once', correct: false },
      { id: 'ext', label: 'Only allow files ending in .pdf', correct: false },
    ],
    verifyRetest: 'Re-send a ../ payload — it must now return 403.',
  },
  {
    id: 'V-CMD', title: 'OS command injection in admin host check', klass: 'cmdInjection', confirmEvent: 'web.cmdInjection',
    severity: 'Critical', severityWhy: 'Arbitrary command execution on the server.',
    cwe: 'CWE-78', owasp: 'A03:2021 Injection', routes: ['GET /admin/ping'],
    evidenceHint: 'The host check runs ping with your input. Shell metacharacters?',
    impact: 'An attacker runs arbitrary OS commands as the service account — full server compromise.',
    rootCause: 'User input is passed to a shell command string without validation or argument isolation.',
    remediation: 'Never build shell strings from input. Use an argument array with no shell, and validate the host against a strict pattern.',
    options: [
      { id: 'argv', label: 'Validate the host and invoke ping via an argument array (no shell)', correct: true },
      { id: 'sanitize', label: 'Remove semicolons from the input', correct: false },
      { id: 'timeout', label: 'Add a timeout to the ping command', correct: false },
    ],
    verifyRetest: 'Re-send a ; command payload to /admin/ping — it must now be rejected (400).',
  },
  {
    id: 'V-SSRF', title: 'SSRF in partner integration fetch', klass: 'ssrf', confirmEvent: 'web.ssrf',
    severity: 'High', severityWhy: 'Reaches the internal metadata service and steals credentials.',
    cwe: 'CWE-918', owasp: 'A10:2021 Server-Side Request Forgery', routes: ['GET /admin/fetch'],
    evidenceHint: 'The integration fetches a URL you supply. Where can that URL point?',
    impact: 'An attacker points the fetch at the internal metadata endpoint and retrieves cloud credentials.',
    rootCause: 'The server fetches an arbitrary user-supplied URL with no destination allowlist.',
    remediation: 'Allowlist the partner host(s); block internal/link-local ranges and metadata IPs; resolve and re-check after DNS.',
    options: [
      { id: 'allowlist', label: 'Restrict the fetch to an allowlist of partner hosts; block internal ranges', correct: true },
      { id: 'scheme', label: 'Only allow https:// URLs', correct: false },
      { id: 'ua', label: 'Send a custom User-Agent on the fetch', correct: false },
    ],
    verifyRetest: 'Re-send a metadata URL to /admin/fetch — it must now be blocked (400).',
  },
];

export const FINDING = Object.fromEntries(FINDINGS.map(f => [f.id, f])) as Record<string, FindingDef>;

// Progressive hints per finding (Hint 1 direction, Hint 2 behaviour/evidence, Hint 3 tool workflow).
export const HINTS: Record<string, string[]> = {
  'V-SQLI': [
    'Classic injection lives wherever input meets a query. Start at the login form.',
    "Try a username of  admin'--  with any password, or  ' OR '1'='1 .  For the dump, put a UNION SELECT in /product?id=.",
    'In ThreatProxy, capture POST /login, send it to Repeater, and edit the username field. Or use sqlmap in the terminal.',
  ],
  'V-RXSS': ['Look at pages that echo your input. The search results page shows your term.', 'Search for <script>alert(document.domain)</script> and read the raw response, not the rendered page.', 'Use Repeater on GET /search?q= and inspect the response body for your unencoded tag.'],
  'V-SXSS': ['Anything you save and that staff later read is a stored-XSS candidate.', 'Submit a support ticket whose body is <script>…</script>, then open the ticket.', 'Submit via POST /support/ticket, then GET /support/ticket?id=<new id> and check the sink.'],
  'V-IDOR': ['Access control questions are about "whose data is this?".', 'Sign in, note your order id, then request a neighbouring id like 5002 on /api/order.', 'Capture GET /api/order?id= in Repeater and iterate the id across values you do not own.'],
  'V-JWT': ['The admin console uses a signed cookie token. Signatures are only as strong as the secret.', 'The leaked backup/.env contains the signing secret. Decode the token, then re-sign an admin one.', 'Use the terminal jwt tool (or the Decoder) to decode ac_admin and sign a new {role:"admin"} token with the leaked secret.'],
  'V-FILE': ['robots.txt is a map of what they wish you would not look at.', 'Fetch /download?file=backups/aerocart-db.sql.bak and /download?file=.env.', 'Use curl or the browser address bar to request the disallowed paths directly.'],
  'V-TRAVERSAL': ['The downloader builds a filesystem path from your input.', 'Try /download?file=../../../../etc/passwd (and URL-encoded variants).', 'Use Repeater or curl on GET /download?file= with ../ sequences.'],
  'V-CMD': ['The admin host check shells out to ping.', 'Append a shell metacharacter: host=127.0.0.1;id .', 'From the admin console (needs the forged JWT), call /admin/ping?host=127.0.0.1;id in Repeater.'],
  'V-SSRF': ['The partner fetch will request any URL you give it.', 'Point it at the metadata IP: /admin/fetch?url=http://169.254.169.254/.', 'In Repeater (admin cookie set), set url to the internal metadata endpoint and read the response.'],
};

export const RECON_HINTS: Record<string, string[]> = {
  'L1.map': ['Every engagement starts with mapping. Walk the links and read robots.txt and sitemap.xml.', 'Visit the storefront pages and note every route you see.', 'Use whatweb / the browser, then open robots.txt to find hidden paths.'],
  'L1.surface': ['Attack surface is more than pages — look for APIs and privileged areas.', 'Find the order API and the admin console.', 'Request /api/order and /admin; use ffuf/gobuster in the terminal to discover routes.'],
};

export interface ObjectiveDef { id: string; level: number; title: string; points: number; category: string; kind: 'recon' | 'confirm' | 'fix' | 'report'; finding?: string; done: (s: any) => boolean; hints: string[] }

const confirmed = (s: any, id: string) => !!s.sim.findings[id]?.confirmed;
const verified = (s: any, id: string) => !!s.sim.findings[id]?.verified;

export const OBJECTIVES: ObjectiveDef[] = [
  { id: 'L1.map', level: 1, title: 'Map the application and its hidden paths', points: 5, category: 'recon', kind: 'recon', hints: RECON_HINTS['L1.map'],
    done: s => s.sim.recon.robots && s.sim.recon.routes >= 5 },
  { id: 'L1.surface', level: 1, title: 'Identify the order API and the admin console', points: 5, category: 'recon', kind: 'recon', hints: RECON_HINTS['L1.surface'],
    done: s => s.sim.recon.apiSeen && s.sim.recon.adminSeen },
  ...FINDINGS.map<ObjectiveDef>(f => ({ id: `confirm:${f.id}`, level: 2, title: `Confirm: ${f.title}`, points: 6, category: 'exploitation', kind: 'confirm', finding: f.id, hints: HINTS[f.id], done: s => confirmed(s, f.id) })),
  ...FINDINGS.map<ObjectiveDef>(f => ({ id: `fix:${f.id}`, level: 3, title: `Remediate and verify: ${f.title}`, points: 6, category: 'remediation', kind: 'fix', finding: f.id, hints: ['Apply the correct remediation option, then re-test.', f.verifyRetest, 'Use finding.retest after remediating to prove the fix holds.'], done: s => verified(s, f.id) })),
  { id: 'L4.report', level: 4, title: 'Deliver the penetration-test report', points: 14, category: 'reporting', kind: 'report', hints: ['Document every confirmed finding with evidence, then submit.', 'Fill the executive summary and per-finding severities.', 'Submit from the Report tab once findings are documented.'], done: s => !!s.sim.report },
];

export const OBJECTIVE = Object.fromEntries(OBJECTIVES.map(o => [o.id, o])) as Record<string, ObjectiveDef>;

// ---------- Guidance modes ----------
// The same lab, three levels of hand-holding. Beginner guidance (which contains the exact payloads)
// is SERVER-ONLY and sent to the browser ONLY for a beginner-mode session — intermediate/advanced
// never receive it, so answers can't be read out of the page.
export type GuideMode = 'beginner' | 'intermediate' | 'advanced';
export const GUIDE_MODES: { id: GuideMode; label: string; blurb: string }[] = [
  { id: 'beginner', label: 'Beginner', blurb: 'Step-by-step walkthrough — exactly what to do, where, and the input to use. Plus hints.' },
  { id: 'intermediate', label: 'Intermediate', blurb: 'A one-line goal per level and on-demand hints. You find the path.' },
  { id: 'advanced', label: 'Advanced', blurb: 'No guidance. Objective titles and on-demand hints only — just like a real engagement.' },
];

const allReported = (s: any) => FINDINGS.every(f => s.sim.findings[f.id]?.reported);
const T = 'shop.aerocart.lab';

export interface GuideStep { id: string; level: number; tool: string; title: string; detail: string; done: (s: any) => boolean }

// Exploitation steps — one per vulnerability (Level 2), each maps 1:1 to a `confirm:<id>` objective.
const EXPLOIT_STEPS: GuideStep[] = [
  { id: 'g-sqli', level: 2, tool: 'repeater', title: 'Bypass the login (SQL injection)', done: s => confirmed(s, 'V-SQLI'),
    detail: `Go to Repeater. Set method POST, path /login, header content-type: application/x-www-form-urlencoded, and body:\n  username=admin'--&password=x\nSend. You're logged in as admin with no password → SQL injection confirmed.` },
  { id: 'g-rxss', level: 2, tool: 'browser', title: 'Reflected XSS in search', done: s => confirmed(s, 'V-RXSS'),
    detail: `In the Browser address bar, enter:\n  /search?q=<script>alert(document.domain)</script>\nand Go. The response echoes your tag unencoded → reflected XSS confirmed.` },
  { id: 'g-sxss', level: 2, tool: 'browser', title: 'Stored XSS in a support ticket', done: s => confirmed(s, 'V-SXSS'),
    detail: `Browser → set method POST, path /support/ticket, body:\n  subject=hi&body=<script>alert(1)</script>\nGo. Then open the new ticket at /support/ticket?id=9002. The stored script reaches the page → stored XSS confirmed.` },
  { id: 'g-idor', level: 2, tool: 'browser', title: 'IDOR — read another user’s order', done: s => confirmed(s, 'V-IDOR'),
    detail: `First get a session: Browser → POST /login with body  username=admin'--&password=x.\nThen open  /api/order?id=5002  — you read a different customer’s order and personal data → IDOR confirmed.` },
  { id: 'g-traversal', level: 2, tool: 'browser', title: 'Path traversal in the downloader', done: s => confirmed(s, 'V-TRAVERSAL'),
    detail: `Browser →  /download?file=../../../../etc/passwd  — you read a host file outside the document root → path traversal confirmed.` },
  { id: 'g-file', level: 2, tool: 'browser', title: 'Grab the exposed backup & .env (leaks the JWT secret)', done: s => confirmed(s, 'V-FILE'),
    detail: `Browser →  /download?file=backups/aerocart-db.sql.bak  and  /download?file=.env .\nThe DB backup and .env are served directly → sensitive file exposure confirmed. Copy the JWT_SIGNING_SECRET / JWT_SECRET value — you’ll need it next.` },
  { id: 'g-jwt', level: 2, tool: 'terminal', title: 'Forge an admin token with the leaked secret', done: s => confirmed(s, 'V-JWT'),
    detail: `Terminal (use the secret from the previous step):\n  jwt sign <secret> {"user":"admin","role":"admin"}\nCopy the token. In the Browser cookie jar, Set cookie  ac_admin = <token>, then open /admin → forged admin session confirmed.` },
  { id: 'g-cmd', level: 2, tool: 'browser', title: 'Command injection in the admin host check', done: s => confirmed(s, 'V-CMD'),
    detail: `With the forged ac_admin cookie set, Browser →  /admin/ping?host=127.0.0.1;id  — the injected command runs → command injection confirmed.` },
  { id: 'g-ssrf', level: 2, tool: 'browser', title: 'SSRF to the internal metadata service', done: s => confirmed(s, 'V-SSRF'),
    detail: `With the admin cookie set, Browser →  /admin/fetch?url=http://169.254.169.254/  — you reach the internal metadata endpoint and its credentials → SSRF confirmed.` },
];

// Remediation steps — one per vulnerability (Level 3), each maps 1:1 to a `fix:<id>` objective.
const REMEDIATE_STEPS: GuideStep[] = FINDINGS.map(f => ({
  id: `g-fix-${f.id}`, level: 3, tool: 'findings', title: `Remediate & verify: ${f.title}`, done: (s: any) => verified(s, f.id),
  detail: `Open Findings and find “${f.title}” (${f.severity}). Choose the remediation that fixes the root cause (not a symptom), click “Apply remediation”, then “Re-test to verify”.\n${f.verifyRetest}`,
}));

export const GUIDE_STEPS: GuideStep[] = [
  // Level 1 — one step per recon objective.
  { id: 'g-recon-fp', level: 1, tool: 'terminal', title: 'Map the application and its hidden paths', done: s => s.sim.recon.robots && s.sim.recon.routes >= 5,
    detail: `In the Terminal, fingerprint the app, read robots.txt, and pull a few pages so you’ve mapped the surface:\n  whatweb http://${T}/\n  curl -i http://${T}/robots.txt\n  curl http://${T}/products\n  curl http://${T}/login\n  curl http://${T}/search\n“Disallow” in robots.txt lists paths the owner hid — which is not the same as protected.` },
  { id: 'g-recon-surface', level: 1, tool: 'browser', title: 'Identify the order API and the admin console', done: s => s.sim.recon.apiSeen && s.sim.recon.adminSeen,
    detail: `Attack surface is more than pages. Open the order API at /api/order?id=5001 and the admin console at /admin (a 401/403 still counts — you’ve found them). This completes recon and unlocks Level 2.` },
  // Level 2 — exploit each vulnerability.
  ...EXPLOIT_STEPS,
  { id: 'g-document', level: 2, tool: 'findings', title: 'Document every confirmed finding', done: allReported,
    detail: `Open Findings. For each confirmed finding, choose a severity and click “Document finding”. In the Proxy, use “★ Save to evidence” on a couple of the requests that prove your findings.` },
  // Level 3 — remediate & verify each vulnerability.
  ...REMEDIATE_STEPS,
  // Level 4 — deliver.
  { id: 'g-report', level: 4, tool: 'report', title: 'Write and submit the report', done: s => !!s.sim.report,
    detail: `Open Report, write an executive summary (at least 80 characters) covering what you found and the posture after fixes, then Submit. Your professional report renders with evidence.` },
];

// Beginner-only "do it here" prefills: the exact input pre-loaded into the right tool for each step.
// Sent only to a beginner-mode session (same gating as the step text). Steps with no entry just open the tool.
export const PREFILL: Record<string, any> = {
  'g-recon-fp': { tool: 'terminal', commands: [`whatweb http://${T}/`, `curl -i http://${T}/robots.txt`, `curl http://${T}/products`, `curl http://${T}/login`, `curl http://${T}/search`] },
  'g-recon-surface': { tool: 'browser', urls: [
    { label: 'Order API · /api/order?id=5001', url: '/api/order?id=5001' },
    { label: 'Admin console · /admin', url: '/admin' },
  ] },
  'g-sqli': { tool: 'repeater', request: { method: 'POST', path: '/login', query: '', headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookies: {}, body: "username=admin'--&password=x" } },
  'g-rxss': { tool: 'browser', method: 'GET', url: '/search?q=<script>alert(document.domain)</script>' },
  'g-sxss': { tool: 'browser', method: 'POST', url: '/support/ticket', body: 'subject=hi&body=<script>alert(1)</script>' },
  'g-idor': { tool: 'browser', method: 'GET', url: '/api/order?id=5002' },
  'g-traversal': { tool: 'browser', method: 'GET', url: '/download?file=../../../../etc/passwd' },
  'g-file': { tool: 'browser', method: 'GET', url: '/download?file=backups/aerocart-db.sql.bak' },
  'g-jwt': { tool: 'terminal', runnable: false, commands: ['jwt sign <paste-the-JWT_SECRET-from-.env-here> {"user":"admin","role":"admin"}'] },
  'g-cmd': { tool: 'browser', method: 'GET', url: '/admin/ping?host=127.0.0.1;id' },
  'g-ssrf': { tool: 'browser', method: 'GET', url: '/admin/fetch?url=http://169.254.169.254/' },
};

// Why each step matters (the teaching context shown in beginner mode).
export const STEP_WHY: Record<string, string> = {
  'g-recon-fp': 'Recon comes first: before attacking anything, learn what the app is and what it exposes. whatweb fingerprints the tech stack; robots.txt often lists paths the owner wishes were hidden — and "hidden" is not the same as "protected".',
  'g-recon-surface': 'Attack surface is more than pages — APIs and privileged areas are where the serious bugs live. Finding the order API and the admin console tells you where to aim next.',
  'g-sqli': 'A login that builds its SQL query from your input can be tricked into returning a user row without the right password. Proving the bypass shows the query trusts input it should treat as plain data.',
  'g-rxss': 'If the app writes your input back into the page without encoding it, your input becomes live code in the victim’s browser — this is how attackers run script in someone else’s session.',
  'g-sxss': 'Stored XSS is worse than reflected: the payload is saved and runs for everyone who views it later — including staff and admins who open the ticket.',
  'g-idor': 'Access control must check “is this yours?” on every object. If the order API hands back any id you ask for, one customer can read another customer’s data (an IDOR / broken object-level authorization bug).',
  'g-traversal': 'When a filename from the user is used to build a path on disk, “../” can climb out of the intended folder and read arbitrary files on the server.',
  'g-file': 'Backups and .env files left in the web root hand an attacker the app’s secrets — here, the JWT signing key. That secret is the pivot that enables the admin takeover in the next step.',
  'g-jwt': 'A signed token is only as strong as its secret. With a weak or leaked secret you can mint your own “admin” token offline and walk straight into the admin console.',
  'g-cmd': 'If user input reaches an OS shell command, metacharacters like “;” let you run extra commands — that’s full control of the server.',
  'g-ssrf': 'If the server fetches a URL you supply, you can point it at internal-only services (like the cloud metadata endpoint) that you could never reach directly from the internet.',
  'g-document': 'A finding only counts if you can prove and explain it. Documenting each one with a severity and evidence is the deliverable a client actually pays for.',
  'g-report': 'The report is what the client acts on: clear findings, business impact and concrete fixes, all backed by your recorded evidence.',
  ...Object.fromEntries(FINDINGS.map(f => [`g-fix-${f.id}`, `Finding the bug is only half the job — verifying the fix is the other half. Pick the remediation that addresses the root cause of ${f.title.toLowerCase()} (not a symptom), then re-test. A fix only counts once the re-test passes, and re-introducing the weakness fails verification.`])),
};

// Why each level/phase exists.
export const LEVEL_WHY = [
  'Understand the target before you touch it. Map every page, API and admin area so you know where bugs could hide. This is reconnaissance — observe, don’t exploit yet.',
  'Prove each weakness with real requests. You’re demonstrating impact with safe, synthetic payloads — not guessing. Each confirmed bug is backed by traffic the server detected.',
  'For every confirmed bug, apply the fix that addresses the root cause, then re-test to prove it’s actually closed. A fix is never trusted until a re-test passes.',
  'Turn your evidence into a professional report the client can act on: findings by severity, impact, root cause, remediation and retest results.',
];

export const LEVEL_TIPS = [
  `Recon — map the attack surface. Fingerprint the app (whatweb), read robots.txt, enumerate routes (ffuf/gobuster), and find the API and admin console.`,
  `Exploit — confirm each vulnerability with real traffic using the Browser, Proxy, Repeater and Terminal. Reveal an objective hint if you get stuck.`,
  `Remediate — in Findings, fix each confirmed issue and re-test to verify it’s closed.`,
  `Report — document severities, attach evidence, and deliver the report.`,
];

// Final-report form (the learner's deliverable). Choices are server-validated.
export const REPORT_FORM = {
  severitySuggested: Object.fromEntries(FINDINGS.map(f => [f.id, f.severity])),
};

export function scoreReport(s: any, input: any): { total: number; max: number; breakdown: { label: string; got: number; max: number }[] } {
  const breakdown: { label: string; got: number; max: number }[] = [];
  // Coverage: findings documented (reported) out of total.
  const reported = FINDINGS.filter(f => s.sim.findings[f.id]?.reported).length;
  breakdown.push({ label: 'Findings documented', got: Math.round((reported / FINDINGS.length) * 6 * 10) / 10, max: 6 });
  // Severity accuracy on documented findings.
  let sevGot = 0, sevMax = 0;
  for (const f of FINDINGS) { const r = s.sim.findings[f.id]; if (r?.reported) { sevMax += 1; if (r.reportedSeverity === f.severity) sevGot += 1; } }
  breakdown.push({ label: 'Severity accuracy', got: sevMax ? Math.round((sevGot / sevMax) * 4 * 10) / 10 : 0, max: 4 });
  // Executive summary present.
  breakdown.push({ label: 'Executive summary', got: (input.summary || '').trim().length >= 80 ? 2 : 0, max: 2 });
  // Evidence attached.
  breakdown.push({ label: 'Evidence attached', got: s.sim.evidence.length >= 3 ? 2 : s.sim.evidence.length > 0 ? 1 : 0, max: 2 });
  const total = Math.round(breakdown.reduce((n, b) => n + b.got, 0) * 10) / 10;
  const max = breakdown.reduce((n, b) => n + b.max, 0);
  return { total, max, breakdown };
}

export const CHAPTERS = [
  { n: 1, title: 'The brief', text: 'AeroCart reports account anomalies and possible customer-data exposure. You have an authorized engagement. Map the surface first.', when: () => true },
  { n: 2, title: 'First blood', text: 'You have proven at least one vulnerability against the target. Keep going — breadth matters.', when: (s: any) => FINDINGS.some(f => confirmed(s, f.id)) },
  { n: 3, title: 'The chain', text: 'The leaked secret, the forged admin token and the admin-only sinks chain into full compromise. Document the chain.', when: (s: any) => confirmed(s, 'V-FILE') && confirmed(s, 'V-JWT') },
  { n: 4, title: 'Hardening', text: 'Engineering shipped fixes. Verify each one and catch any regression.', when: (s: any) => FINDINGS.some(f => verified(s, f.id)) },
  { n: 5, title: 'Deliver', text: 'Write up the engagement: findings, evidence, impact, remediation and retest results.', when: (s: any) => !!s.sim.report },
];

export const BRIEFING = {
  client: 'AeroCart (e-commerce)', role: 'Junior Penetration Tester', engagement: 'ENG-2041',
  intro: 'AeroCart, an Indian e-commerce startup, has reported account anomalies and possible customer-data exposure ahead of a major launch. Our consultancy has an authorized engagement to assess their storefront, APIs and admin console. You are the tester on record.',
  authorization: 'Authorized, time-boxed black/grey-box web application assessment of the AeroCart staging target only. Signed by the AeroCart CTO.',
  scope: ['shop.aerocart.lab storefront, APIs under /api, and the admin console at /admin.'],
  outOfScope: ['Any host other than the provided target.', 'Denial-of-service / stress testing.', 'Social engineering and physical attacks.', 'Destructive actions against data.'],
  rules: [
    'Everything is simulated. No real company, customer, credential or system is involved.',
    'Prove findings with evidence from the tools — do not assert a vulnerability you have not demonstrated.',
    'A finding is only Verified after you remediate it and a re-test shows it fixed.',
    'Hints are available per objective and reduce that objective\'s points by 25% each.',
    'Investigate in any order; levels unlock as you complete the previous level.',
  ],
  deliverables: 'A professional penetration-test report: executive summary, findings by severity with evidence, impact, root cause, remediation and retest results.',
  levels: [
    { n: 1, name: 'Reconnaissance — map the attack surface' },
    { n: 2, name: 'Exploitation — confirm the vulnerabilities' },
    { n: 3, name: 'Remediation — fix and verify' },
    { n: 4, name: 'Reporting — deliver the engagement' },
  ],
};
