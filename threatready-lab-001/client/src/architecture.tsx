import { useEffect, useRef, useState } from 'react';
import { store } from './api';
import { Badge, useLab } from './ui';
import { statusTone } from './pages';
import { EXPLAIN } from './explain';

// Lab guide window: the story so far, how NovaCart works, and what each test did behind the scenes. Drag by the title bar, resize from the edges.
// Finding markers appear only for findings the learner has already discovered.
type Node = { id: string; x: number; y: number; w?: number; h?: number; title: string; sub: string; svc?: string; findings?: string[]; external?: boolean; what: string; ask?: string };
const W = 130, H = 56;
const NODES: Node[] = [
  { id: 'org', x: 10, y: 8, w: 790, h: 28, title: 'Account guardrails', sub: 'Governance', svc: 'org', findings: ['V10'],
    what: 'Organization-wide rules (service control policies). They can forbid an action for everyone in the account, even administrators.', ask: 'Is anything stopping a powerful user from switching off the audit log?' },
  { id: 'users', x: 20, y: 78, title: 'Customers', sub: 'Internet', external: true,
    what: 'People shopping on NovaCart from their browsers. They are outside AWS, on the public internet.', ask: 'Customers should only ever reach the load balancer, nothing behind it.' },
  { id: 'alb', x: 180, y: 78, title: 'Load balancer', sub: 'nc-storefront-alb', svc: 'ec2',
    what: 'The front door. It receives every customer request over HTTPS and passes it on to the app server. It is meant to be public.' },
  { id: 'app', x: 340, y: 78, title: 'App server', sub: 'nc-app-server', svc: 'ec2', findings: ['V3'],
    what: 'The virtual computer (EC2 instance) that runs the storefront code. Its security group is a firewall that decides who may connect to it.', ask: 'Who is allowed to connect to it directly, and on which ports?' },
  { id: 'fn', x: 500, y: 78, title: 'Order processor', sub: 'Lambda', svc: 'lambda', findings: ['V6', 'V7'],
    what: 'A small piece of code (Lambda function) that runs for every new order: it charges the customer and saves an export file.', ask: 'Where does it keep its payment key? What is its role allowed to do?' },
  { id: 'pay', x: 660, y: 78, title: 'Payment gateway', sub: 'external service', external: true,
    what: 'An outside company that processes card payments. The order processor proves who it is with a secret payment key.' },
  { id: 'iam', x: 20, y: 200, title: 'Identities', sub: 'IAM users & roles', svc: 'iam', findings: ['V1'],
    what: 'IAM decides who can do what. Users (people or apps with access keys) and roles (identities that services borrow) get their permissions from policies.', ask: 'Does each identity have only the permissions it needs? Any keys or users you do not recognise?' },
  { id: 'assets', x: 180, y: 200, title: 'Product images', sub: 'S3 · product-assets', svc: 's3',
    what: 'An S3 bucket (a folder in the cloud) holding product photos. These are meant to be public so the store can show them.' },
  { id: 'docs', x: 340, y: 200, title: 'Internal docs', sub: 'S3 · internal-docs', svc: 's3', findings: ['V2', 'V5'],
    what: 'An S3 bucket with confidential company files such as invoices and payroll.', ask: 'Who can read it? Is it encrypted the way company policy requires?' },
  { id: 'kms', x: 500, y: 200, title: 'Encryption key', sub: 'KMS · novacart-data', svc: 'kms', findings: ['V9'],
    what: 'The key that encrypts confidential data. Anyone allowed to use this key can read that data.', ask: 'Who may use the key, and who may change its rules?' },
  { id: 'secrets', x: 660, y: 200, title: 'Stored secrets', sub: 'Secrets Manager', svc: 'secrets',
    what: 'A safe for passwords and API keys. Apps fetch a secret when they need it instead of keeping it in their settings.' },
  { id: 'trail', x: 180, y: 318, title: 'Audit log', sub: 'CloudTrail', svc: 'cloudtrail', findings: ['V4'],
    what: 'The account\'s security camera. It records every action: who did it, when, and from which IP address.', ask: 'Is it recording right now? Does it cover all regions and all actions?' },
  { id: 'cw', x: 420, y: 318, title: 'Monitoring', sub: 'CloudWatch alarms', svc: 'cloudwatch', findings: ['V8'],
    what: 'Collects logs and metrics, and raises an alarm when something looks wrong.', ask: 'If someone made unauthorized calls, would any alarm go off?' },
  { id: 'team', x: 660, y: 318, title: 'Security team', sub: 'SNS · nc-security-alerts', external: true,
    what: 'The people who receive alarms (through the SNS topic nc-security-alerts) and respond to incidents. In this lab, that is you.' },
];
const SVC_LABEL: Record<string, string> = { org: 'Governance', ec2: 'EC2', lambda: 'Lambda', iam: 'IAM', s3: 'S3', kms: 'KMS', secrets: 'Secrets Manager', cloudtrail: 'CloudTrail', cloudwatch: 'CloudWatch' };
const N = Object.fromEntries(NODES.map(n => [n.id, n]));
const TOUR = ['users', 'alb', 'app', 'assets', 'docs', 'kms', 'fn', 'secrets', 'pay', 'iam', 'org', 'trail', 'cw', 'team'];
// [from, to, label, plain explanation, health probe that breaks this flow]
const EDGES: [string, string, string, string, string?][] = [
  ['users', 'alb', 'HTTPS', 'Customers send requests to the load balancer over HTTPS.', 'storefront'],
  ['alb', 'app', 'port 8080', 'The load balancer forwards each request to the app server on port 8080.', 'storefront'],
  ['app', 'fn', 'new order', 'When someone checks out, the app hands the order to the order processor.', 'orders'],
  ['fn', 'pay', 'charge', 'The order processor charges the card through the payment gateway.', 'orders'],
  ['app', 'assets', 'upload', 'The app uploads product photos using the svc-storefront-app access key.', 'asset-upload'],
  ['app', 'docs', 'invoices', 'The app writes invoices using its server role (nc-app-server-role).', 'invoices'],
  ['docs', 'kms', 'encrypts with', 'Confidential files are encrypted with the KMS key.'],
  ['fn', 'secrets', 'payment key', 'The order processor needs the payment key to charge cards.'],
  ['trail', 'cw', 'events', 'CloudTrail sends its events to CloudWatch for checking.'],
  ['cw', 'team', 'alert', 'When an alarm fires, CloudWatch notifies the security team.'],
];

function anchor(a: Node, b: Node): [number, number, number, number] {
  const ac = [a.x + W / 2, a.y + H / 2], bc = [b.x + W / 2, b.y + H / 2];
  if (a.y === b.y) return a.x < b.x ? [a.x + W, ac[1], b.x, bc[1]] : [a.x, ac[1], b.x + W, bc[1]];
  return [ac[0], a.y + H, bc[0], b.y];
}

type Geo = { x: number; y: number; w: number; h: number };
const MIN_W = 360, MIN_H = 260, GEO_KEY = 'tr_arch_geo', SPLIT_KEY = 'tr_arch_split';
// Diagram camera: the SVG viewBox. Zoom keeps the point under the cursor fixed; pan moves the box.
type View = { x: number; y: number; w: number; h: number };
const FIT: View = { x: 0, y: 0, w: 810, h: 386 };
const zoomView = (v: View, f: number, cx = v.x + v.w / 2, cy = v.y + v.h / 2): View => {
  const k = Math.max(FIT.w / 5, Math.min(FIT.w * 2, v.w * f)) / v.w;
  return { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w: v.w * k, h: v.h * k };
};
// Keep the whole window inside the viewport so no control is ever out of reach.
const clamp = (g: Geo): Geo => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.max(Math.min(MIN_W, vw - 16), Math.min(g.w, vw - 16)), h = Math.max(Math.min(MIN_H, vh - 16), Math.min(g.h, vh - 16));
  return { w, h, x: Math.max(8, Math.min(g.x, vw - w - 8)), y: Math.max(8, Math.min(g.y, vh - h - 8)) };
};
const loadGeo = (): Geo | null => { try { const g = JSON.parse(store.get(GEO_KEY) || 'null'); return g && ['x', 'y', 'w', 'h'].every(k => typeof g[k] === 'number') ? clamp(g) : null; } catch { return null; } };

// ---------- The story: what is happening and why the learner is doing it, one entry per server chapter ----------
const STORY: Record<number, { what: string; why: string; focus: string[] }> = {
  1: { what: 'NovaCart is about to launch. A review found settings that may be unsafe, and customers report odd account activity. Nobody knows yet whether someone has broken in.',
    why: 'Think of yourself as a building inspector. Look at who can reach what, write down each problem, fix it, then prove the fix works. The audit log (CloudTrail) is your best witness of what really happened.', focus: ['iam', 'docs', 'app', 'trail'] },
  2: { what: 'The audit log stopped recording. The last thing it saw: someone using the storefront app\'s identity switched it off, from an internet address that is not NovaCart\'s. Someone outside has one of the app\'s keys.',
    why: 'Saving that last event as evidence proves what happened, even if logs are lost later. Next you will work out which key was stolen.', focus: ['trail', 'iam'] },
  3: { what: 'An alarm fired: the stolen key is being used right now. The intruder keeps working in the background and tries a new move every so often.',
    why: 'Stop the stolen key first, but only that key. The store uses a different key; if you switch that one off, customers cannot shop (an outage).', focus: ['iam', 'app'] },
  4: { what: 'The stolen key belongs to an identity that may do far more than the app needs, and confidential files could be read by anyone. A small leak became a big breach.',
    why: '"Blast radius" means how much damage one stolen key can do. Cutting permissions down to only what is needed makes the next leak much smaller.', focus: ['iam', 'docs'] },
  5: { what: 'The stolen key no longer works and you have saved evidence. The intruder\'s way in is closed.',
    why: 'Now prove it: test the old key and confirm it is rejected. Then check what else the intruder could have taken, such as the payment key in the order processor.', focus: ['iam', 'fn', 'secrets'] },
  6: { what: 'The intruder is out, but the setup still has weaknesses that made the attack easy or would hide the next one: secrets, encryption, monitoring and guardrails.',
    why: 'Fixing the root weaknesses means the same attack cannot work again, and if something does happen, the log keeps recording and an alarm wakes someone up.', focus: ['secrets', 'kms', 'trail', 'cw', 'org'] },
  7: { what: 'Everything is fixed and verified. New alerts are arriving: some are real, some are noise. You still need to find out how the key leaked in the first place.',
    why: 'In real jobs most alerts are not attacks, so judge each one by its evidence. The logs show how the key escaped. That is the root cause, and it goes in your report.', focus: ['cw', 'team'] },
  8: { what: 'You have written up what happened, what was affected and how to stop it happening again.',
    why: 'The report is how leadership, auditors and other teams learn from an incident.', focus: ['team'] },
};
const LOOP: [string, string][] = [
  ['Investigate', 'Open a service and read its settings and logs to understand what is going on.'],
  ['Report', 'Record what is wrong with "Report finding". The lab checks that you looked at the evidence first.'],
  ['Fix', 'Change the setting yourself. Each change is applied to the simulated cloud right away.'],
  ['Verify', 'Run a test to prove the fix works and the store still runs. A fix you have not tested is only a guess.'],
];
// Intruder moves, by step id and outcome. Only moves that have already happened are sent by the server.
const INTRUDER: Record<string, { target: string; label: string; text: Record<string, string> }> = {
  A1: { target: 'docs', label: 'payroll file', text: { success: 'Downloaded the payroll file from Internal docs.', blocked: 'Tried to download the payroll file, but was blocked.', idle: 'Had no working key, so could not reach Internal docs.' } },
  A2: { target: 'iam', label: 'backdoor user', text: { success: 'Created a new admin user (support-temp-01): a backdoor to get back in later.', blocked: 'Tried to create a backdoor user, but was blocked.', idle: 'Had no working key, so could not create a backdoor user.' } },
  A3: { target: 'fn', label: 'read settings', text: { success: 'Read the order processor\'s settings, including the payment key stored there.', harmless: 'Read the order processor\'s settings, but the payment key was no longer there.', blocked: 'Tried to read the order processor\'s settings, but was blocked.', idle: 'Had no working key, so could not read the order processor.' } },
  A4: { target: 'pay', label: 'fraud charges', text: { success: 'Used the stolen payment key to make fraudulent charges.', blocked: 'Tried the stolen payment key, but the gateway rejected it because you replaced it.', idle: 'Had no stolen payment key to use.' } },
};
// Hand-routed paths from the intruder box (bottom left) so they avoid the other boxes.
const ATK_PATH: Record<string, { d: string; lx: number; ly: number }> = {
  iam: { d: 'M85,318 V258', lx: 90, ly: 300 }, trail: { d: 'M150,346 H178', lx: 164, ly: 340 },
  docs: { d: 'M140,318 V298 H405 V258', lx: 410, ly: 280 }, fn: { d: 'M140,318 V304 H485 V146 H520 V136', lx: 490, ly: 170 }, pay: { d: 'M140,318 V310 H645 V146 H705 V136', lx: 650, ly: 170 },
};

// ---------- Behind the scenes: plain-language explanation of each test the learner ran ----------
const short = (a: string) => (a || '').split(/[:/]/).pop();
const who = (p: string) => p === 'anonymous' ? 'anyone on the internet' : short(p);
function explainTest(t: any): { title: string; ok: boolean; result: string; how: string; nodes: string[] } {
  const ok = !!(t.allowed ?? t.ok ?? t.recorded ?? t.accepted ?? (t.fired?.length > 0));
  switch (t.kind) {
    case 'iam.simulate': return { title: `Permission check: can ${short(t.principal)} do ${t.action}?`, ok, result: ok ? 'Allowed' : 'Denied',
      how: 'The simulator read every policy that applies to this identity (its own permissions and the account guardrails) and worked out the answer without doing anything for real. A "deny" anywhere always wins.', nodes: ['iam', 'org'] };
    case 's3.access': return { title: `Access test: can ${who(t.principal)} ${t.operation === 'GET' ? 'read' : t.operation === 'PUT' ? 'write' : t.operation} ${t.key ? `${t.bucket}/${t.key}` : t.bucket}?`, ok, result: ok ? 'Allowed' : 'Denied',
      how: `The simulator sent a pretend request and checked, in order: is the access key active, does Block Public Access stop it, what do the bucket policy and ACL say, and what do the caller's own permissions allow.${t.reason ? ` Answer: ${t.reason}` : ''}`,
      nodes: [t.bucket === 'novacart-product-assets' ? 'assets' : 'docs', t.principal === 'anonymous' ? 'users' : 'iam'] };
    case 'ec2.reach': return { title: `Network test: can ${t.source === 'internet' ? 'the internet' : t.source} reach the ${t.target === 'alb' ? 'load balancer' : 'app server'} on port ${t.port}?`, ok, result: ok ? 'Reachable' : 'Blocked',
      how: `The simulator followed the path a network packet would take, then checked the firewall rules (security group) on the target.${t.reason ? ` Answer: ${t.reason}` : ''}`, nodes: [t.target === 'alb' ? 'alb' : 'app', t.source === 'internet' ? 'users' : 'alb'] };
    case 'cloudtrail.audit': return { title: 'Audit test: is the audit log recording?', ok, result: ok ? 'Recorded' : 'Not recorded',
      how: 'The simulator performed a harmless test action, then looked for it in the audit log. If it is missing, an attacker\'s actions would be missing too.', nodes: ['trail'] };
    case 'cw.test': return { title: `Alarm test: ${t.count} × ${t.metric}`, ok, result: ok ? `Alarm fired: ${t.fired.join(', ')}` : t.delivered ? 'No alarm' : 'Events not delivered',
      how: 'The simulator sent fake warning events and watched whether an alarm went off and told someone. No alarm means a real attack could go unnoticed.', nodes: ['trail', 'cw', 'team'] };
    case 'lambda.invoke': return { title: 'Function test: run the order processor with a sample order', ok, result: ok ? 'Worked' : 'Failed',
      how: 'The simulator ran the order processor end to end: fetch the payment key, charge the card, save the export. This shows your changes did not break checkout.', nodes: ['fn', 'pay', 'secrets'] };
    case 'kms.crypto': return { title: `Encryption test: can ${short(t.principal)} ${t.operation} with the key?`, ok, result: ok ? 'Allowed' : 'Denied',
      how: `The key's own policy decides who may use it. The simulator asked the key on behalf of this identity.${t.reason ? ` Answer: ${t.reason}` : ''}`, nodes: ['kms', 'iam'] };
    case 'secrets.testCredential': return { title: `Credential test: does the ${t.source === 'leaked' ? 'old, exposed' : 'stored'} payment key still work?`, ok, result: ok ? 'Accepted' : 'Rejected',
      how: 'The simulator tried this key against the payment gateway. The exposed key should be rejected and the stored one accepted.', nodes: ['secrets', 'pay'] };
    default: return { title: t.kind, ok, result: ok ? 'Passed' : 'Failed', how: '', nodes: [] };
  }
}
const KEYWORDS: [RegExp, string][] = [[/intruder|Consequence|198\.51\.100\.77|Nobody at NovaCart/i, 'intruder'], [/CloudTrail|audit|logging/i, 'trail'], [/bucket|S3|payroll/i, 'docs'], [/access key|credential|IAM|user/i, 'iam'], [/order processor|function/i, 'fn'], [/payment/i, 'pay'], [/alarm|CloudWatch/i, 'cw'], [/storefront|outage|restored/i, 'app'], [/finding/i, 'iam']];
const nodesFor = (text: string) => [...new Set(KEYWORDS.filter(([re]) => re.test(text)).map(([, n]) => n))].slice(0, 4);

export function ArchitectureCorner() {
  const { status, nav } = useLab();
  const [open, setOpen] = useState(false);
  const [geo, setGeo] = useState<Geo | null>(null); const [maxFrom, setMaxFrom] = useState<Geo | null>(null);
  const [tab, setTab] = useState<'story' | 'tasks' | 'system' | 'behind'>('story');
  const [task, setTask] = useState<string | null>(null); const [taskLevel, setTaskLevel] = useState<number | null>(null);
  const [sel, setSel] = useState<string | null>(null); const [tour, setTour] = useState(false);
  const [chapter, setChapter] = useState<number | null>(null); const [entry, setEntry] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<View>(FIT); const [panning, setPanning] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null); const bodyRef = useRef<HTMLDivElement>(null); const dragged = useRef(false);
  const [split, setSplit] = useState<number | null>(() => { const n = Number(store.get(SPLIT_KEY)); return n > 0 ? n : null; });
  useEffect(() => { store.set(SPLIT_KEY, split ? String(split) : null); }, [split]);
  // Screen pixel -> diagram units (preserveAspectRatio "meet" uses the larger ratio)
  const unit = () => { const r = svgRef.current?.getBoundingClientRect(); return r && r.width && r.height ? Math.max(view.w / r.width, view.h / r.height) : 1; };
  const toDiagram = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect(); const u = unit();
    const ox = (r.width * u - view.w) / 2, oy = (r.height * u - view.h) / 2; // letterbox offsets
    return { x: view.x + (clientX - r.left) * u - ox, y: view.y + (clientY - r.top) * u - oy };
  };
  // Wheel zoom needs a non-passive listener so the page does not scroll at the same time
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const f = (e: WheelEvent) => { e.preventDefault(); const p = toDiagram(e.clientX, e.clientY); setView(v => zoomView(v, e.deltaY > 0 ? 1.12 : 1 / 1.12, p.x, p.y)); };
    el.addEventListener('wheel', f, { passive: false }); return () => el.removeEventListener('wheel', f);
  });
  // Drag anywhere on the diagram to pan. A press that barely moves stays a normal click on a box.
  const startPan = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return; const el = e.currentTarget; const x0 = e.clientX, y0 = e.clientY, v0 = view, u = unit(); let on = false; dragged.current = false;
    const mv = (m: PointerEvent) => {
      const dx = m.clientX - x0, dy = m.clientY - y0;
      if (!on && Math.hypot(dx, dy) < 4) return;
      if (!on) { on = true; dragged.current = true; el.setPointerCapture(m.pointerId); setPanning(true); }
      setView({ ...v0, x: v0.x - dx * u, y: v0.y - dy * u });
    };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); setPanning(false); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  // Drag the bar under the diagram to change how much room it gets
  const startSplit = (e: React.PointerEvent) => {
    e.preventDefault(); const el = e.currentTarget as HTMLElement; el.setPointerCapture(e.pointerId);
    const top = svgRef.current!.parentElement!.getBoundingClientRect().top, body = bodyRef.current!.getBoundingClientRect();
    const mv = (m: PointerEvent) => setSplit(Math.round(Math.max(120, Math.min(m.clientY - top, body.bottom - top - 110))));
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  };

  useEffect(() => { if (geo) store.set(GEO_KEY, JSON.stringify(geo)); }, [geo]);
  useEffect(() => { const f = () => setGeo(g => g && clamp(g)); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  useEffect(() => { setChapter(null); }, [status.chapter]);
  useEffect(() => { setTaskLevel(null); }, [status.level]); // jump to the newest chapter when the story advances

  const cornerGeo = (): Geo => {
    const r = fabRef.current?.parentElement?.getBoundingClientRect();
    const w = Math.min(780, (r?.width ?? 800) - 32), h = Math.min(640, (r?.height ?? 600) - 28);
    return clamp({ x: (r?.left ?? 0) + 16, y: (r?.bottom ?? h) - h - 14, w, h });
  };
  const show = () => { setGeo(loadGeo() || cornerGeo()); setOpen(true); };
  const showRef = useRef(show); showRef.current = show;
  useEffect(() => {
    const f = (e: Event) => { const id = (e as CustomEvent).detail as string; setTask(id); setTaskLevel(null); setTab('tasks'); showRef.current(); };
    window.addEventListener('tr:explain', f); return () => window.removeEventListener('tr:explain', f);
  }, []);
  const resetPos = () => { setMaxFrom(null); setGeo(cornerGeo()); };
  const toggleMax = () => {
    if (!geo) return;
    if (maxFrom) { setGeo(maxFrom); setMaxFrom(null); return; }
    setMaxFrom(geo); setGeo(clamp({ x: 8, y: 52, w: window.innerWidth - 16, h: window.innerHeight - 60 }));
  };
  // One pointer handler for moving ('move') and resizing from an edge or corner ('e', 's', 'w', 'se', 'sw').
  const startDrag = (mode: string) => (e: React.PointerEvent) => {
    if (!geo || e.button !== 0 || (mode === 'move' && (e.target as HTMLElement).closest('button'))) return;
    e.preventDefault(); const g0 = geo, x0 = e.clientX, y0 = e.clientY; const el = e.currentTarget as HTMLElement; el.setPointerCapture(e.pointerId); setMoving(true);
    const mv = (m: PointerEvent) => {
      const dx = m.clientX - x0, dy = m.clientY - y0; const g = { ...g0 };
      if (mode === 'move') { g.x += dx; g.y += dy; }
      if (mode.includes('e')) g.w = Math.min(g0.w + dx, window.innerWidth - g0.x - 8);
      if (mode.includes('s')) g.h = Math.min(g0.h + dy, window.innerHeight - g0.y - 8);
      if (mode.includes('w')) { g.w = Math.max(MIN_W, Math.min(g0.w - dx, g0.x + g0.w - 8)); g.x = g0.x + g0.w - g.w; }
      setMaxFrom(null); setGeo(clamp(g));
    };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); setMoving(false); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };

  const fstat = Object.fromEntries(status.findings.map((f: any) => [f.id, f]));
  const known = (n: Node) => (n.findings || []).map(id => fstat[id]).filter(f => f && f.status !== 'Not found');
  const mark = (n: Node) => { const k = known(n); return !k.length ? null : k.every((f: any) => f.status === 'Verified') ? 'ok' : 'warn'; };
  const broken = new Set(status.health.filter((h: any) => !h.ok).map((h: any) => h.id));
  const pick = (id: string | null) => { setSel(id); if (!id) setTour(false); };
  const step = tour && sel ? TOUR.indexOf(sel) : -1;
  const node = sel ? N[sel] : null;

  // Story state
  const chNow: number = status.chapter; const ch = chapter ?? chNow; const story = STORY[ch]; const chMeta = status.chapters.find((c: any) => c.n === ch);
  const intruderSeen = chNow >= 2; const contained = chNow >= 5;
  const moves: { id: string; outcome: string }[] = status.intruder?.steps || [];
  // Behind-the-scenes feed: your tests plus notable lab events, newest first
  const feed = [
    ...status.tests.map((t: any, i: number) => ({ key: `t${i}-${t.at}`, at: t.at, test: explainTest(t) })),
    ...status.timeline.filter((e: any) => e.kind !== 'story').map((e: any, i: number) => ({ key: `e${i}-${e.at}`, at: e.at, event: e })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 25);
  const cur = feed.find(f => f.key === entry) || feed[0];

  // Your tasks: objectives of the chosen level, with the selected one explained
  const lvl: number = taskLevel ?? status.objectives.find((o: any) => o.id === task && !o.locked)?.level ?? status.level;
  const lvlObjs = status.objectives.filter((o: any) => o.level === lvl && !o.locked);
  const tsel = lvlObjs.find((o: any) => o.id === task) || lvlObjs.find((o: any) => !o.done) || lvlObjs[0];
  const tx = tsel ? EXPLAIN[tsel.id] : null;
  const tfind = tsel && /^V\d+\./.test(tsel.id) ? fstat[tsel.id.split('.')[0]] : null;
  // Which boxes to highlight depends on the tab
  let focus: Set<string> | null = null;
  if (tab === 'system' && sel) focus = new Set([sel, ...EDGES.filter(e => e[0] === sel || e[1] === sel).flatMap(e => [e[0], e[1]])]);
  if (tab === 'story' && story) focus = new Set([...story.focus, ...(intruderSeen && ch === chNow ? ['intruder', 'trail', ...moves.map(m => INTRUDER[m.id].target)] : [])]);
  if (tab === 'tasks' && tx) focus = new Set(tx.nodes);
  if (tab === 'behind' && cur) focus = new Set(cur.test ? cur.test.nodes : nodesFor(cur.event.text));
  const dim = (id: string) => !!focus && focus.size > 0 && !focus.has(id);

  const fab = <button ref={fabRef} className="archfab" onClick={show} aria-label="Open the lab guide and architecture diagram" style={open ? { visibility: 'hidden' } : undefined} tabIndex={open ? -1 : 0}><span aria-hidden>⧉</span> What's happening?</button>;
  if (!open || !geo) return fab;
  const atkLines = intruderSeen ? [
    { key: 'iam', cls: contained ? 'blocked' : 'live', label: contained ? 'key disabled' : 'stolen key', tip: contained ? 'The stolen key has been disabled.' : 'The intruder signs requests with an old access key of the storefront app.' },
    { key: 'trail', cls: 'live', label: '', tip: 'The intruder switched off the audit log.' },
    ...moves.filter(m => m.id !== 'A2').map(m => ({ key: INTRUDER[m.id].target, cls: m.outcome === 'success' ? 'live' : 'blocked', label: `${m.outcome === 'success' ? '' : '✕ '}${INTRUDER[m.id].label}`, tip: INTRUDER[m.id].text[m.outcome] || '' })),
  ] : [];

  return <>{fab}
    <section className={`archwin ${moving ? 'moving' : ''}`} style={{ left: geo.x, top: geo.y, width: geo.w, height: geo.h }} aria-label="Lab guide" onKeyDown={e => e.key === 'Escape' && pick(null)}>
      <div className="archwin-h" onPointerDown={startDrag('move')} onDoubleClick={e => !(e.target as HTMLElement).closest('button') && toggleMax()} title="Drag to move · double-click to maximise">
        <span className="grip" aria-hidden>⠿</span><b>Lab guide</b>
        <div className="archtabs" role="tablist">{([['story', 'The story'], ['tasks', 'Your tasks'], ['system', 'How it works'], ['behind', 'Behind the scenes']] as const).map(([id, l]) =>
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>)}</div>
        <span className="grow" />
        <button className="btn sm" onClick={toggleMax}>{maxFrom ? 'Restore' : 'Maximise'}</button>
        <button className="btn sm" onClick={resetPos} title="Put the window back in the corner">Reset</button>
        <button className="x" onClick={() => setOpen(false)} aria-label="Close lab guide">×</button></div>
      <div className={`archwin-b ${split ? 'sized' : ''}`} ref={bodyRef}>
        <div className={`archcanvas ${panning ? 'panning' : ''}`} style={split ? { height: split, flex: 'none' } : undefined}>
          <div className="archzoom" onPointerDown={e => e.stopPropagation()}>
            <button className="btn sm" onClick={() => setView(v => zoomView(v, 1 / 1.25))} aria-label="Zoom in" title="Zoom in">+</button>
            <button className="btn sm" onClick={() => setView(v => zoomView(v, 1.25))} aria-label="Zoom out" title="Zoom out">−</button>
            <button className="btn sm" onClick={() => setView(FIT)} title="Show the whole diagram">Fit</button>
          </div>
          <span className="archpanhint" aria-hidden>Drag to move · scroll to zoom</span>
          <svg ref={svgRef} className="archmap" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet" onPointerDown={startPan}
            onClickCapture={e => { if (dragged.current) { e.stopPropagation(); e.preventDefault(); dragged.current = false; } }} role="img" aria-label="NovaCart architecture: customers to load balancer to app server, then to storage, order processing and monitoring" onClick={e => e.target === e.currentTarget && pick(null)}>
            <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#545b64" /></marker>
              <marker id="arr-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#0972d3" /></marker>
              <marker id="arr-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#d13212" /></marker>
              <marker id="arr-off" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#aab7b8" /></marker></defs>
            <rect className="arch-vpc" x="168" y="52" width="314" height="98" rx="6" /><text className="arch-lbl" x="176" y="146">Private network (VPC)</text>
            <line className="arch-sep" x1="10" y1="290" x2="800" y2="290" /><text className="arch-lbl" x="20" y="282">Watching everything: every action above is recorded and checked</text>
            {EDGES.map(([a, b, label, why, probe]) => {
              const [x1, y1, x2, y2] = anchor(N[a], N[b]); const bad = !!probe && broken.has(probe); const hl = tab === 'system' && !!sel && (a === sel || b === sel);
              return <g key={a + b} className={`arch-edge ${bad ? 'bad' : ''} ${hl ? 'hl' : ''} ${dim(a) || dim(b) ? 'dim' : ''}`}><title>{bad ? `Broken right now — ${why}` : why}</title>
                <line x1={x1} y1={y1} x2={x2} y2={y2} markerEnd={`url(#${bad ? 'arr-bad' : hl ? 'arr-hl' : 'arr'})`} />
                <text x={(x1 + x2) / 2 + (x1 === x2 ? 6 : 0)} y={y1 === y2 ? N[a].y - 5 : (y1 + y2) / 2} textAnchor={x1 === x2 ? 'start' : 'middle'}>{bad ? `${label} — broken` : label}</text></g>;
            })}
            {atkLines.map(l => <g key={l.key} className={`arch-atk ${l.cls} ${dim('intruder') ? 'dim' : ''}`}><title>{l.tip}</title>
              <path d={ATK_PATH[l.key].d} markerEnd={`url(#${l.cls === 'live' ? 'arr-bad' : 'arr-off'})`} />
              {l.label && <text x={ATK_PATH[l.key].lx} y={ATK_PATH[l.key].ly}>{l.label}</text>}</g>)}
            {NODES.map(n => {
              const m = mark(n); const w = n.w ?? W, h = n.h ?? H; const band = n.id === 'org';
              return <g key={n.id} className={`arch-node ${band ? 'band' : ''} ${n.external ? 'ext' : ''} ${tab === 'system' && sel === n.id ? 'sel' : ''} ${focus?.has(n.id) && tab !== 'system' ? 'focus' : ''} ${dim(n.id) ? 'dim' : ''}`}
                onClick={() => { setTab('system'); setTour(false); setSel(sel === n.id && tab === 'system' ? null : n.id); }} onDoubleClick={() => n.svc && nav(n.svc)}
                role="button" tabIndex={0} aria-label={`${n.title}: ${n.sub}`} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab('system'); setTour(false); setSel(n.id); } }}>
                <rect x={n.x} y={n.y} width={w} height={h} rx={band ? 4 : 5} />
                {band ? <text x={n.x + w / 2} y={n.y + 19} textAnchor="middle" className="t">Account guardrails (Governance) — rules that apply to everyone, even admins</text>
                  : <><text x={n.x + w / 2} y={n.y + 24} textAnchor="middle" className="t">{n.title}</text><text x={n.x + w / 2} y={n.y + 41} textAnchor="middle" className="s">{n.sub}</text></>}
                {m && <><circle cx={n.x + w - 4} cy={n.y + 4} r="9" className={`arch-dot ${m}`} /><text x={n.x + w - 4} y={n.y + 8} textAnchor="middle" className="arch-dot-t">{m === 'ok' ? '✓' : '!'}</text></>}
              </g>;
            })}
            {intruderSeen && <g className={`arch-node intruder ${contained ? 'out' : ''} ${dim('intruder') ? 'dim' : ''}`} onClick={() => setTab('story')}><title>The intruder: someone outside NovaCart using a stolen key</title>
              <rect x="20" y="318" width={W} height={H} rx="5" /><text x={85} y={342} textAnchor="middle" className="t">Intruder</text><text x={85} y={359} textAnchor="middle" className="s">{contained ? 'locked out' : 'outside, stolen key'}</text></g>}
          </svg>
        </div>
        <div className="archsplit" onPointerDown={startSplit} onDoubleClick={() => setSplit(null)} role="separator" aria-orientation="horizontal" aria-label="Resize diagram" title="Drag to resize the diagram · double-click to reset" />

        <div className="archpanel">
          {tab === 'story' && story && <>
            <div className="storyhead"><span className="archstep">Chapter {ch} of 8</span><b>{chMeta?.title}</b><span className="grow" />
              {status.chapters.length > 1 && <span className="storynav"><button className="btn sm" disabled={ch <= 1} onClick={() => setChapter(ch - 1)}>‹</button><button className="btn sm" disabled={ch >= chNow} onClick={() => setChapter(ch + 1 >= chNow ? null : ch + 1)}>›</button></span>}</div>
            {ch < chNow && <p className="muted small">You are looking back at an earlier chapter. <a href="#" onClick={e => { e.preventDefault(); setChapter(null); }}>Back to now</a></p>}
            <div className="storybox what"><span className="storyk">What's going on</span>{story.what}</div>
            <div className="storybox why"><span className="storyk">Why you're doing this</span>{story.why}</div>
            {ch === chNow && status.intruder?.active && !contained && <div className="storybox clock"><span className="storyk">Happening in the background</span>
              The lab clock moves forward each time you do something (it is not real time). Roughly every 30 simulated minutes the intruder tries their next move. The sooner you disable the stolen key, the less they can do.</div>}
            {intruderSeen && moves.length > 0 && <div className="storybox"><span className="storyk">What the intruder did so far</span>
              <ul className="moves">{moves.map(m => <li key={m.id} className={m.outcome === 'success' ? 'bad' : 'good'}>{m.outcome === 'success' ? '✗' : '✓'} {INTRUDER[m.id].text[m.outcome]}</li>)}</ul></div>}
            <details className="loop"><summary>How every task works (4 moves)</summary>
              <ol>{LOOP.map(([k, v]) => <li key={k}><b>{k}.</b> {v}</li>)}</ol></details>
            <p className="muted small">Highlighted boxes are the parts this chapter is about. Click any box to learn what it does.</p>
          </>}

          {tab === 'tasks' && <div className="tasks">
            <div className="tasklist">
              <div className="tasklvl">{[1, 2, 3, 4].filter(n => n <= status.level).map(n => <button key={n} className={n === lvl ? 'on' : ''} onClick={() => { setTaskLevel(n === status.level ? null : n); setTask(null); }}>Level {n}</button>)}</div>
              <ul>{lvlObjs.map((o: any) => <li key={o.id} className={`${o === tsel ? 'on' : ''} ${o.done ? 'done' : o.partial ? 'part' : ''}`}><button onClick={() => setTask(o.id)}><span aria-hidden>{o.done ? '✓' : o.partial ? '◐' : '○'}</span> {o.title}</button></li>)}</ul>
            </div>
            {tsel && tx && <div className="taskd" aria-live="polite">
              <div className="taskd-h"><b>{tsel.title}</b><Badge tone={tsel.done ? 'green' : tsel.partial ? 'orange' : 'grey'}>{tsel.done ? 'Done' : tsel.partial ? 'Fixed, not yet verified' : 'To do'}</Badge></div>
              <div className="storybox why"><span className="storyk">Why this matters</span>{tx.why}</div>
              <div className="storybox what"><span className="storyk">How it works</span>{tx.how}</div>
              <div className="storybox clock"><span className="storyk">What happens behind the scenes</span>{tx.behind}</div>
              <div className="storybox"><span className="storyk">When it counts as done</span>{tx.done}
                {tfind?.checks && /\.fix$/.test(tsel.id) && <ul className="taskchecks">{tfind.checks.map((c: any) => <li key={c.label} className={c.passed ? 'pass' : ''}>{c.passed ? '✓' : '○'} {c.label}</li>)}</ul>}
                {tfind && /\.fix$/.test(tsel.id) && !tfind.checks && <p className="muted small">The live checklist appears here once you have reported this finding.</p>}</div>
              <p className="muted small">Highlighted boxes on the diagram are the parts involved. Need exact clicks? Use <b>Hints</b> in the lab panel (costs points).</p>
            </div>}
          </div>}

          {tab === 'system' && <>
            {!node && <p className="archintro"><b>New to cloud?</b> Each box is one part of NovaCart; arrows show how data moves. <b>Click any box</b> to learn what it does, or take the tour. <button className="btn sm" onClick={() => { setTour(true); setSel(TOUR[0]); }}>▶ Guided tour</button></p>}
            {node && <div className="archinfo" aria-live="polite">
              <div className="archinfo-h">{step >= 0 && <span className="archstep">Step {step + 1} of {TOUR.length}</span>}<b>{node.title}</b><span className="muted">· {node.sub}</span><span className="grow" /><button className="x" onClick={() => pick(null)} aria-label="Close details">×</button></div>
              <p>{node.what}</p>
              {node.ask && <p className="archask"><b>Good question to ask:</b> {node.ask}</p>}
              {known(node).map((f: any) => <p key={f.id} className="archfind"><Badge tone={statusTone(f.status)}>{f.status}</Badge> {f.title}</p>)}
              {EDGES.filter(e => e[0] === node.id || e[1] === node.id).map(([a, b, , why, probe]) => <p key={a + b} className={`archflow ${probe && broken.has(probe) ? 'bad' : ''}`}>{a === node.id ? '→' : '←'} {why}{probe && broken.has(probe) ? ' (broken right now)' : ''}</p>)}
              <div className="archinfo-f">
                {node.svc && <button className="btn sm primary" onClick={() => nav(node.svc!)}>Open {SVC_LABEL[node.svc!]} in console</button>}
                <span className="grow" />
                {tour && <><button className="btn sm" disabled={step <= 0} onClick={() => setSel(TOUR[step - 1])}>‹ Back</button>
                  {step < TOUR.length - 1 ? <button className="btn sm" onClick={() => setSel(TOUR[step + 1])}>Next ›</button> : <button className="btn sm" onClick={() => pick(null)}>Finish tour</button>}</>}
              </div>
            </div>}
          </>}

          {tab === 'behind' && <>
            <p className="archintro">Nothing here touches real AWS. Every action and test you run is worked out by a simulator, the same way AWS would decide it. Pick an entry to see what was checked and which parts were involved.</p>
            {!feed.length && <p className="muted">Nothing yet. Run a test (an access test, network test or policy check) and it will be explained here.</p>}
            <div className="behind">
              <ul className="feed">{feed.map(f => <li key={f.key} className={`${f === cur ? 'on' : ''} ${f.test ? (f.test.ok ? 'ok' : 'no') : `ev-${f.event.kind}`}`}><button onClick={() => setEntry(f.key)}>
                <span className="feed-t">{f.test ? f.test.title : f.event.text}</span>{f.test && <small>{f.test.result}</small>}</button></li>)}</ul>
              {cur && <div className="feed-d">{cur.test ? <>
                <b>{cur.test.title}</b><p><Badge tone={cur.test.ok ? 'green' : 'grey'}>{cur.test.result}</Badge></p>
                <p><span className="storyk">What happened behind the scenes</span>{cur.test.how}</p>
                <p className="muted small">Why tests matter: a fix only counts once a test proves it. Testing that a request is denied shows the hole is closed; testing that a normal request is still allowed shows the store still works.</p>
              </> : <>
                <b>{cur.event.kind === 'bad' ? 'Something went wrong' : cur.event.kind === 'good' ? 'Progress' : cur.event.kind === 'warn' ? 'Warning' : 'Lab event'}</b>
                <p>{cur.event.text}</p>
                {cur.event.kind === 'bad' && <p className="muted small">Red events are consequences: things the intruder achieved or outages your changes caused. Use them to decide what to do next.</p>}
              </>}</div>}
            </div>
          </>}
        </div>
        <div className="archlegend"><span><i className="lg-dot warn" /> Reported, not fixed</span><span><i className="lg-dot ok" /> Fixed and verified</span><span><i className="lg-line" /> Broken or attack path</span><span><i className="lg-ext" /> Outside AWS</span></div>
      </div>
      {['e', 's', 'w', 'se', 'sw'].map(d => <div key={d} className={`archrs rs-${d}`} onPointerDown={startDrag(d)} aria-hidden />)}
    </section>
  </>;
}
