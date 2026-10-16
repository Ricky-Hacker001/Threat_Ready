// E8 · Web server process spawning a command shell: a web shell uploaded
// through the customer portal's document upload. The job is to contain it
// without taking the portal offline.

import { E } from '../../engine/format.js';
import { hostNamed, dom } from '../../engine/env.js';
import { defineScenario, ran, single, multi, link } from '../lib.js';

const WEB = hostNamed('WEB01');
const SQL = hostNamed('SQL01');
const ATK = '198.51.100.77';
const CUST = '192.0.2.44';
const SHELL = 'inv_3391.aspx';
const ROOT = 'D:\\inetpub\\portal';
const W3WP = 'C:\\Windows\\System32\\inetsrv\\w3wp.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

export default defineScenario({
  code: 'E8', level: 'expert',
  title: 'Web server process spawned a command shell', rule: 'EDR-0731', severity: 'high', queue: 'endpoint',
  blurb: 'An endpoint rule reports the IIS worker process on the customer portal starting cmd.exe.',
  sources: ['web', 'edr', 'firewall', 'winsec', 'proxy', 'dns'], sourceGroups: ['web', 'endpoint'],
  skills: ['log.web', 'log.endpoint', 'res.containment', 'res.proportionality'],
  entities: { ips: [ATK] },
  history: 60 * 60,
  alertTags: ['cmd'],
  build(x) {
    const P = (i) => 7000 + i * 13;
    x.add('decoy_upload', E.web(x.T(-50 * 60), { src_ip: CUST, method: 'POST', uri: '/documents/upload.aspx', status: 200, bytes: 412, ua: UA, referer: 'https://portal.aerofreight.example/documents', time_ms: 310 }));
    x.add('decoy_upload', E.edr(x.T(-50 * 60 + 1), WEB.name, 11, 'FileCreate', { user: dom('svc_web'), image: W3WP, target_filename: `${ROOT}\\uploads\\POD_88412.pdf`, file_size: 182330 }));
    x.add('recon', E.web(x.T(-31 * 60), { src_ip: ATK, method: 'GET', uri: '/documents/upload.aspx', status: 200, bytes: 5120, ua: UA, time_ms: 40 }));
    x.add('upload', E.web(x.T(-30 * 60), { src_ip: ATK, method: 'POST', uri: '/documents/upload.aspx', status: 200, bytes: 398, ua: UA, referer: 'https://portal.aerofreight.example/documents/upload.aspx', time_ms: 220 }));
    x.add('upload', E.edr(x.T(-30 * 60 + 1), WEB.name, 11, 'FileCreate', { user: dom('svc_web'), image: W3WP, target_filename: `${ROOT}\\uploads\\${SHELL}`, file_size: 2711 }));
    x.add('waf_log', E.waf(x.T(-29 * 60), { src_ip: ATK, rule_id: '933100', rule_msg: 'Script file requested from uploads path', action: 'log', uri: `/uploads/${SHELL}`, score: 5, ua: UA }));
    const cmds = ['whoami', 'ipconfig /all', 'net group "Domain Admins" /domain', 'systeminfo', `dir ${ROOT}\\App_Data`];
    cmds.forEach((c, i) => {
      const t = -28 * 60 + i * 300;
      x.add('shell_hits', E.web(x.T(t), { src_ip: ATK, method: 'POST', uri: `/uploads/${SHELL}`, status: 200, bytes: 600 + i * 90, ua: UA, time_ms: 180 }));
      x.add(i === cmds.length - 1 ? 'cmd' : 'cmd_early', E.procCreate(x.T(t + 1), WEB.name, { user: dom('svc_web'), image: 'C:\\Windows\\System32\\cmd.exe', command_line: `cmd.exe /c ${c}`, pid: P(i), parent_image: W3WP, ppid: 3120 }));
    });
    x.add('pivot_try', E.fw(x.T(-12 * 60), { action: 'deny', src_ip: WEB.ip, src_port: 50211, dest_ip: SQL.ip, dest_port: 445, zone: 'DMZ->SERVERS', rule: 'DMZ-DENY-SMB' }));
    x.add('pivot_try', E.fw(x.T(-12 * 60 + 2), { action: 'deny', src_ip: WEB.ip, src_port: 50212, dest_ip: SQL.ip, dest_port: 135, zone: 'DMZ->SERVERS', rule: 'DMZ-DENY-RPC' }));
    x.add('cmd', E.web(x.T(-3), { src_ip: ATK, method: 'POST', uri: `/uploads/${SHELL}`, status: 200, bytes: 1210, ua: UA, time_ms: 260 }));
    x.add('cmd', E.procCreate(x.T(-2), WEB.name, { user: dom('svc_web'), image: 'C:\\Windows\\System32\\cmd.exe', command_line: `cmd.exe /c type ${ROOT}\\web.config`, pid: 7101, parent_image: W3WP, ppid: 3120 }));
  },
  alert: () => ({
    description: `w3wp.exe on ${WEB.name} started cmd.exe.`,
    entity: { host: WEB.name, ip: WEB.ip, user: 'svc_web' },
    details: [['Host', `${WEB.name} (customer portal, DMZ)`], ['Parent', 'w3wp.exe (IIS worker)'], ['Child', 'cmd.exe'], ['Rule logic', 'Web server worker process starting a shell']],
    guidance: ['Find the web request that triggered the shell.', 'Find how the file got onto the server.', 'Decide how to contain it with the portal still serving customers.'],
  }),
  intel: { [ATK]: { verdict: 'suspicious', detections: '5/89', facts: [['Type', 'VPS hosting']], notes: ['Seen scanning web applications.'] } },
  assetNotes: { WEB01: ['Customer portal. Customers upload delivery documents (PDF, JPG) at /documents/upload.aspx.', 'Outage during business hours stops customers booking and tracking shipments.'] },
  triage: {
    checks: [{ id: 'asset', label: 'Server looked up in the asset inventory', test: ran('asset', [WEB.name, WEB.ip]) }],
    verdict: { accept: 'tp', explain: 'A web worker running discovery commands is a web shell until proven otherwise.' },
    severity: { accept: 'high', explain: 'Code execution on an internet-facing server.' },
    evidence: { tags: ['cmd'], explain: 'The shell starting from w3wp.exe.' },
  },
  l2: {
    fields: [
      link(single('entry', 'How the attacker got code onto the server', 8, [['upload', `Uploaded ${SHELL} through the document upload form`], ['sqli', 'SQL injection'], ['rdp', 'Stolen RDP credentials'], ['patch', 'A failed patch']], 'upload', { hint: 'Find the file creation in the uploads folder and the web request just before it.', explain: 'The upload form accepted an .aspx file, and IIS executes .aspx in that folder.', skills: ['log.web'] }), 'upload'),
      multi('commands', 'What the attacker ran', 6, [['user', 'Checked which account the site runs as'], ['network', 'Network configuration'], ['admins', 'Listed domain admins'], ['config', 'Read the site configuration (connection strings)'], ['ransom', 'Encrypted files'], ['account', 'Created a local account']], ['user', 'network', 'admins', 'config'], { hint: 'Read every cmd.exe started by w3wp.exe.', explain: 'Discovery, then the web.config with database credentials.', skills: ['log.endpoint', 'kno.attack-mapping'] }),
      link(single('pivot', 'Did the attacker reach the internal network?', 6, [['blocked', 'Tried SMB and RPC to SQL01; the DMZ firewall denied it'], ['yes', 'Reached SQL01 over SMB'], ['no', 'No attempt'], ['dc', 'Reached a domain controller']], 'blocked', { hint: 'Search the firewall for connections from the web server.', explain: 'Denied by the DMZ rules, which limits the scope.', skills: ['log.network', 'inv.scope'] }), 'pivot_try'),
      single('decoy', 'The customer upload of POD_88412.pdf', 4, [['benign', 'Normal customer use'], ['malicious', 'Part of the attack'], ['unknown', 'Unknown']], 'benign', { explain: 'A PDF from a customer address, not executed.', skills: ['tri.false-positive'] }),
      single('tradeoff', 'Containment that fits the business', 6, [['waf', 'Deny script requests in /uploads at the WAF, block the source, clean the server, keep the portal up'], ['isolate', 'Isolate WEB01 until the investigation ends'], ['shutdown', 'Shut the portal down for the week'], ['wait', 'Wait until the weekend to act']], 'waf', { explain: 'The attacker is contained at the edge; the business keeps running.', skills: ['res.proportionality', 'res.containment'] }),
    ],
  },
  response: {
    scope: { accounts: ['svc_web'], ips: [ATK], waf_rule: ['/uploads/*.aspx', '/uploads/*', ATK] },
    textTargets: { waf_rule: ['/uploads/*.aspx', '/uploads/*', ATK] },
    impacts: {},
    contained: (st) => (st.did('waf_rule', '/uploads/*.aspx') || st.did('waf_rule', '/uploads/*')) && st.ipBlocked(ATK),
    objectives: [
      { id: 'waf', label: 'Deny script requests to the uploads path at the WAF', points: 3, containment: true, eval: (st) => (st.did('waf_rule', '/uploads/*.aspx') || st.did('waf_rule', '/uploads/*') ? 1 : 0), explain: 'Cuts the web shell off without an outage.' },
      { id: 'block', label: 'Block the attacker address', points: 2, containment: true, eval: (st) => (st.ipBlocked(ATK) || st.did('waf_rule', ATK) ? 1 : 0), explain: 'Stops the operator returning from the same address.' },
      { id: 'evidence', label: 'Acquire evidence from WEB01, then remove the shell', points: 3, skills: ['doc.evidence'], eval: (st) => {
        const ev = st.evidence.get('WEB01');
        const cl = st.cleaned.get('WEB01');
        if (ev !== undefined && cl !== undefined) return ev <= cl ? 1 : 0.5;
        return ev !== undefined || cl !== undefined ? 0.5 : 0;
      }, explain: 'Collect first so the upload and commands can be proven, then delete the shell.' },
      { id: 'reset', label: 'Reset the application pool account', points: 2, containment: true, eval: (st) => (st.reset.has('svc_web') ? 1 : 0), explain: 'The attacker read web.config and its credentials.' },
      { id: 'online', label: 'Keep the customer portal online', points: 2, skills: ['res.proportionality'], eval: (st) => (st.offline('WEB01') || st.reimaged.has('WEB01') ? 0 : (st.did('waf_rule', '/uploads/*.aspx') || st.did('waf_rule', '/uploads/*') ? 1 : 0)), explain: 'Containment at the edge made an outage unnecessary.' },
    ],
  },
  closure: {
    disposition: { options: [['webshell', 'True positive: web shell through the upload form, contained without an outage'], ['fp', 'False positive'], ['scan', 'Unsuccessful scan'], ['admin', 'Administrator activity']], accept: 'webshell', explain: 'Upload, execution, discovery.' },
    rootCause: { options: [['upload', 'Upload form accepts script files in an executable folder'], ['patch', 'Missing OS patch'], ['password', 'Weak admin password'], ['insider', 'Insider']], accept: 'upload', explain: 'No file-type check and execute permission on /uploads.' },
    actions: { options: [['filetype', 'Allow only PDF and image uploads'], ['noexec', 'Remove execute permission from the uploads folder'], ['rotate', 'Rotate the database credentials in web.config'], ['rebuild', 'Rebuild the portal during business hours']], set: ['filetype', 'noexec', 'rotate'], explain: 'Fix the cause; a daytime rebuild is an avoidable outage.', skills: ['doc.root-cause'] },
  },
  truth: { summary: `An attacker at ${ATK} uploaded ${SHELL} through the customer document upload form. IIS executed it, and the attacker ran discovery commands as svc_web and read web.config. Attempts to reach SQL01 were denied by the DMZ firewall. The PDF upload from ${CUST} is a normal customer.`, timeline: [[-50 * 60, 'Customer uploads a PDF.'], [-30 * 60, 'Web shell uploaded.'], [-28 * 60, 'First commands.'], [-12 * 60, 'Pivot to SQL01 denied.'], [-2, 'web.config read.']], iocs: [{ type: 'ip', value: ATK, note: 'Attacker' }, { type: 'file', value: SHELL, note: 'Web shell' }] },
  test: { tools: { l1_triage: [['asset', WEB.name]] }, response: [['waf_rule', '/uploads/*.aspx'], ['block_ip', ATK], ['acquire_evidence', WEB.name], ['remove_artifacts', WEB.name], ['reset_credentials', 'svc_web']] },
});
