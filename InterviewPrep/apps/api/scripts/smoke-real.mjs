// Real end-to-end smoke test against the running API with LLM_DRIVER=anthropic.
// Makes real Anthropic calls (about US$0.10-0.15). Usage: node scripts/smoke-real.mjs (API on :3100, demo account in .env).
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('../../.env', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const API = 'http://localhost:3100', ORIGIN = 'http://localhost:5173';
let cookie = '';
async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie?.() ?? []; if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 400)}`);
  return r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}
const done = (sse) => { const ev = sse.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6))); const err = ev.find((e) => e.type === 'error'); if (err) throw new Error('stream error ' + JSON.stringify(err)); return ev.find((e) => e.type === 'done').session; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resume = `Priya Sharma
Cloud Security Engineer | priya.sharma@example.com | +91 98765 43210
EXPERIENCE
Cloud Security Engineer, Aero Fintech (2022 - present)
- Designed least-privilege IAM roles across 40 AWS accounts using permission boundaries and SCPs.
- Investigated GuardDuty findings and CloudTrail anomalies; contained a leaked access key within 30 minutes.
- Deployed microservices using Kubernetes on EKS and enforced network policies and RBAC.
Security Analyst Intern, Beta Bank (2021)
- Triaged SIEM alerts in Splunk and escalated confirmed incidents.
SKILLS: AWS IAM, CloudTrail, GuardDuty, Terraform, Kubernetes, Python, Splunk
CERTIFICATIONS: AWS Certified Security - Specialty`;
const zip = new JSZip();
zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${resume.split('\n').map((l) => `<w:p><w:r><w:t xml:space="preserve">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
const docx = await zip.generateAsync({ type: 'nodebuffer' });

await call('POST', '/api/auth/sign-in/email', { email: env.DEV_DEMO_EMAIL, password: env.DEV_DEMO_PASSWORD });
const ct = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const up = await call('POST', '/v1/documents', { kind: 'resume', contentType: ct, sizeBytes: docx.length });
const fd = new FormData(); for (const [k, v] of Object.entries(up.upload.fields)) fd.append(k, v); fd.append('file', new Blob([docx], { type: ct }), 'resume.docx');
const r = await fetch(API + new URL(up.upload.url).pathname, { method: 'POST', body: fd }); if (r.status !== 204) throw new Error('upload ' + r.status);
await call('POST', `/v1/documents/${up.document.id}/complete`);
let doc; for (let i = 0; i < 30; i++) { doc = await call('GET', `/v1/documents/${up.document.id}`); if (doc.status !== 'extracting') break; await sleep(1000); }
console.log('resume:', doc.status, 'redactions', JSON.stringify(doc.redactions));
const jd = await call('POST', '/v1/documents/text', { kind: 'jd', text: `Senior Cloud Security Engineer
Secure our multi-account AWS platform.
Must have: AWS IAM least privilege across accounts; investigating CloudTrail and GuardDuty findings; preventing public S3 exposure; Kubernetes security on EKS (RBAC, network policies).
Preferred: Terraform and policy as code; secrets management in CI/CD; clear communication with engineering stakeholders.` });
const s0 = await call('POST', '/v1/interviews', { resumeDocumentId: doc.id, jdDocumentId: jd.id, aiProcessingConsent: { accepted: true, version: 'ai-processing.v1.2026-10-12' } });
let s; const t0 = Date.now(); for (let i = 0; i < 90; i++) { s = await call('GET', `/v1/interviews/${s0.id}`); if (s.state !== 'parsing') break; await sleep(2000); }
console.log('analysis:', s.state, `${Math.round((Date.now() - t0) / 1000)}s`, s.failure ? JSON.stringify(s.failure) : '');
if (s.state !== 'profiled') process.exit(1);
const b = await call('GET', `/v1/interviews/${s0.id}/briefing`);
console.log('role:', b.jobProfile.title, '|', b.jobProfile.role_id, b.jobProfile.seniority, '| candidate skills:', b.candidateProfile.skills.map((x) => x.skill_id + ':' + x.claimed_level).join(', '));
console.log('roles:', b.candidateProfile.roles.map((x) => `${x.title} @ ${x.organisation}`).join(' ; '));
console.log('focus:', b.focusPreview.map((f) => f.reason + ':' + f.label).join(', '));
console.log('recommendation:', JSON.stringify(b.recommendation));
const r2 = b.recommendation;
await call('POST', `/v1/interviews/${s0.id}/plan`, { config: { interviewType: r2.interviewType, difficulty: r2.difficulty, durationMin: 15, mode: 'practice', track: r2.track, focusSkillIds: [], speakQuestions: false } });
let v = done(await call('POST', `/v1/interviews/${s0.id}/start`));
const answers = [
  'I am a cloud security engineer with about three years of experience, mostly at Aero Fintech where I own IAM design and threat detection across our AWS organisation. Before that I interned in a bank SOC. I am interested in this role because it is a senior position focused on multi-account AWS security, which is exactly where I want to grow.',
  'At Aero Fintech I designed least-privilege roles across 40 AWS accounts. I started from CloudTrail access analysis to see which actions each workload really used, generated scoped policies, attached permission boundaries so delegated admins could not escalate, and enforced guardrails with SCPs such as denying disabling CloudTrail or leaving the region allow-list. We rolled it out account by account with IAM Access Analyzer checks in CI.',
  'I would check logs and rotate keys.',
];
for (const a of answers) {
  console.log(`\nQ (${v.currentTurn.kind}, ${v.currentTurn.topic}): ${v.currentTurn.question}`);
  const res = await call('POST', `/v1/interviews/${s0.id}/turns`, { turnId: v.currentTurn.turnId, answer: a, clientSubmissionId: crypto.randomUUID() });
  v = done(res);
  const fb = res.split('\n\n').map((x) => x.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6))).find((e) => e.type === 'feedback');
  if (fb) console.log('  practice feedback:', JSON.stringify(fb.feedback));
}
console.log(`\nNext Q (${v.currentTurn?.kind}): ${v.currentTurn?.question}`);
await call('POST', `/v1/interviews/${s0.id}/end`, { reason: 'candidate_ended' });
for (let i = 0; i < 90; i++) { s = await call('GET', `/v1/interviews/${s0.id}`); if (!['scoring', 'completed'].includes(s.state)) break; await sleep(2000); }
console.log('\nfinal state:', s.state, s.failure ? JSON.stringify(s.failure) : '');
if (s.state === 'report_ready') {
  const rep = await call('GET', `/v1/interviews/${s0.id}/report`);
  console.log('overall:', rep.overall.score, JSON.stringify({ t: rep.overall.technicalKnowledge, p: rep.overall.problemSolving, c: rep.overall.communication, cov: rep.overall.roleSkillCoverage }));
  console.log('summary:', rep.overall.summary);
  for (const q of rep.questions) console.log(`  Q${q.questionNumber} ${q.kind} score=${q.score} | ${q.explanation}`);
}
console.log('SESSION', s0.id);
