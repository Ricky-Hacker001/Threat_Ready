// Scenario 2. Ground truth (never sent to the analyst before closure):
// the "brute force" is the quarterly credentialed vulnerability scan.
// SCAN01 sweeps the server and DMZ segments, tries default credentials
// (the failures), then logs on with its documented service account. It is
// covered by an approved change that is in progress. Correct handling is a
// benign true positive closed at Tier 1 with a narrowly scoped tuning
// recommendation. The ticket only goes to Tier 2 if the analyst escalates.

import { E } from '../engine/format.js';
import { hostNamed, dom } from '../engine/env.js';
import { utc } from '../engine/common.js';

const SCAN = hostNamed('SCAN01');
const WINDOWS_TARGETS = ['DC01', 'DC02', 'FS01', 'BKP01', 'SQL01', 'APP01', 'JUMP01', 'WEB01'].map(hostNamed);
const APPLIANCES = ['MAILGW', 'PROXY01', 'VPN01'].map(hostNamed);
const PORTS = [22, 80, 135, 139, 443, 445, 1433, 3389, 5985, 8443];
const DEFAULT_USERS = ['administrator', 'admin', 'guest', 'test', 'backup', 'sa'];
const CHANGE_ID = 'CHG-4471';
const PLUGIN_HOST = 'plugins.vulnscan-cloud.example';
const PLUGIN_IP = '192.0.2.160';
const START = -520; // seconds: first Windows target
const STEP = 100;

function build({ t0 }) {
  const T = (off) => t0 + Math.round(off * 1000);
  const events = [];
  const add = (tags, e) => { e._tags = tags; events.push(e); };
  const zone = (h) => (h.vlan === 'DMZ' ? 'SERVERS->DMZ' : 'SERVERS->SERVERS');

  // Plugin feed update before the scan starts.
  add(['scan_update'], E.dns(T(START - 62), { client_ip: SCAN.ip, query: PLUGIN_HOST, answer: PLUGIN_IP }));
  ['/feed/v2/manifest.json', '/feed/v2/plugins-delta-20261009.tar.gz', '/feed/v2/compliance-audits.tar.gz'].forEach((p, i) => add(['scan_update'], E.proxy(T(START - 60 + i * 4), {
    src_ip: SCAN.ip, user: '-', method: 'GET', url: `https://${PLUGIN_HOST}${p}`, dest_ip: PLUGIN_IP, status: 200,
    bytes_out: 310, bytes_in: i === 0 ? 18220 : 4_200_000 + i * 913_000, category: 'Technology/Security', ua: 'VulnScan-Engine/10.8.2 (feed-updater)',
  })));

  // Appliances: port sweep only (no Windows event logs).
  APPLIANCES.forEach((h, i) => {
    PORTS.forEach((p, j) => add(['scan_sweep'], E.fw(T(START - 40 + i * 9 + j * 0.25), {
      src_ip: SCAN.ip, src_port: 40000 + i * 97 + j, dest_ip: h.ip, dest_port: p, zone: zone(h), rule: 'VulnScanner-to-Any', bytes: 120 + j * 8,
    })));
  });

  WINDOWS_TARGETS.forEach((h, i) => {
    const base = START + i * STEP;
    PORTS.forEach((p, j) => add(['scan_sweep'], E.fw(T(base + j * 0.3), {
      src_ip: SCAN.ip, src_port: 42000 + i * 131 + j, dest_ip: h.ip, dest_port: p, zone: zone(h), rule: 'VulnScanner-to-Any', bytes: 140 + j * 12,
    })));
    DEFAULT_USERS.forEach((u, j) => add(['scan_fail'], E.winsec(T(base + 6 + j * 2.1), h.name, 4625, 'An account failed to log on', {
      target_user: u, logon_type: 3, auth_package: 'NTLM', src_ip: SCAN.ip, workstation: 'SCAN01',
      status: '0xC000006D', failure_reason: j % 2 ? 'Unknown user name or bad password (0xC0000064)' : 'Unknown user name or bad password (0xC000006A)',
    })));
    const lid = `0x${(0x51a000 + i * 0x1d3).toString(16).toUpperCase()}`;
    add(['scan_ok'], E.winsec(T(base + 21), h.name, 4624, 'An account was successfully logged on', {
      target_user: dom('svc_scan'), logon_type: 3, auth_package: 'NTLM', src_ip: SCAN.ip, workstation: 'SCAN01', logon_id: lid,
    }));
    add(['scan_ok'], E.winsec(T(base + 21.1), h.name, 4672, 'Special privileges assigned to new logon', {
      target_user: dom('svc_scan'), privileges: 'SeBackupPrivilege SeSecurityPrivilege SeSystemProfilePrivilege', logon_id: lid,
    }));
    add(['scan_reg'], E.winsec(T(base + 22), h.name, 5140, 'A network share object was accessed', {
      subject_user: dom('svc_scan'), src_ip: SCAN.ip, share_name: '\\\\*\\IPC$', access: 'ReadData (or ListDirectory)', logon_id: lid,
    }));
    add(['scan_reg'], E.winsec(T(base + 23), h.name, 7036, 'The Remote Registry service entered the running state', { service_name: 'RemoteRegistry' }, 'System'));
    add(['scan_reg'], E.winsec(T(base + 24), h.name, 5140, 'A network share object was accessed', {
      subject_user: dom('svc_scan'), src_ip: SCAN.ip, share_name: '\\\\*\\ADMIN$', access: 'ReadData (or ListDirectory)', logon_id: lid,
    }));
    add(['scan_reg'], E.winsec(T(base + 86), h.name, 7036, 'The Remote Registry service entered the stopped state', { service_name: 'RemoteRegistry' }, 'System'));
    add(['scan_ok'], E.winsec(T(base + 87), h.name, 4634, 'An account was logged off', { target_user: dom('svc_scan'), logon_type: 3, logon_id: lid }));
  });
  return { events, periodic: [] };
}

const opt = (value, label) => ({ value, label });

const stages = [
  { id: 'monitoring', label: 'Monitor', tier: 'L1', kind: 'monitor' },
  {
    id: 'l1_triage', label: 'L1 triage', tier: 'L1', kind: 'form', weight: 60, attempts: 1, submitLabel: 'Submit triage decision',
    intro: 'Classify the alert. Establish what the source is, whether the activity is expected, and whether anything goes beyond what would be expected. Tier 1 decisions are final once submitted.',
    fields: [
      {
        id: 'checks', type: 'checks', label: 'Context checked', points: 6, help: 'Updated from the tools you have run on this case.',
        key: {
          checks: [
            { id: 'asset', label: 'Source host looked up in the asset inventory', test: (c) => c.toolRuns.some((t) => t.tool === 'asset' && ['scan01', SCAN.ip].includes(t.input)) },
            { id: 'change', label: 'Change calendar consulted', test: (c) => c.toolRuns.some((t) => t.tool === 'change') },
            { id: 'acct', label: 'Account that logged on successfully looked up in the directory', test: (c) => c.toolRuns.some((t) => t.tool === 'user' && t.input.replace(/^meridian\\/, '') === 'svc_scan') },
          ],
          explain: 'A benign verdict needs positive confirmation: what the source is, that the activity is authorised now, and that the account is the one documented for it.',
        },
      },
      { id: 'source', type: 'host', label: 'Source of the logon attempts', points: 4, summary: 'Source', key: { accept: 'SCAN01', explain: 'Every failure and every success carries src_ip 10.10.0.60 and workstation SCAN01.' } },
      {
        id: 'verdict', type: 'single', label: 'Verdict', points: 10, summary: 'Verdict',
        options: [
          opt('tp', 'True positive: malicious or unauthorised activity'),
          opt('fp', 'False positive: the rule matched activity it should not have'),
          opt('unknown', 'Inconclusive: not enough data to decide'),
          opt('btp', 'Benign true positive: real activity, but authorised or expected'),
        ],
        key: { accept: { btp: 1, fp: 0.4 }, explain: 'The rule worked: there really were dozens of failed logons followed by a success. The activity is authorised, which makes it a benign true positive. Calling it a false positive suggests the rule logic is broken and leads to the wrong fix.' },
      },
      {
        id: 'category', type: 'single', label: 'What the activity is', points: 6, summary: 'Activity',
        options: [
          opt('brute', 'Password brute force against one account'),
          opt('spray', 'Password spraying across accounts'),
          opt('misconfig', 'Service with an expired or mistyped password'),
          opt('scan', 'Authorised vulnerability scan with default-credential checks'),
          opt('lateral', 'Lateral movement with stolen credentials'),
        ],
        key: { accept: 'scan', explain: 'The same six default account names are tried once each on every host, preceded by a port sweep and followed by a logon with the scanner\'s own service account and Remote Registry access. That is the signature of a credentialed scan.' },
      },
      { id: 'change', type: 'text', label: 'Change record that authorises it', points: 6, placeholder: 'CHG-0000', summary: 'Change', key: { accept: [CHANGE_ID], norm: 'lower', explain: `${CHANGE_ID} covers SCAN01, the svc_scan account, the server and DMZ segments and a window that is open now.` } },
      {
        id: 'severity', type: 'single', label: 'Severity', points: 4, sets: 'severity', summary: 'Severity',
        options: [opt('low', 'Low'), opt('medium', 'Medium'), opt('high', 'High'), opt('critical', 'Critical')],
        key: { accept: { low: 1, medium: 0.3 }, explain: 'Authorised activity inside an approved window carries no risk beyond the rule noise it creates.' },
      },
      {
        id: 'evidence', type: 'pins', label: 'Key evidence', min: 2, points: 8,
        help: 'Choose at least two pinned events that show what the source did.',
        key: {
          groups: { failures: ['scan_fail'], success: ['scan_ok', 'scan_reg'], network: ['scan_sweep', 'scan_update'] },
          minGroups: 2, minPrecision: 0.6,
          describe: 'A failed default-credential logon from SCAN01 plus the svc_scan success, the Remote Registry access or the port sweep.',
          explain: 'The closure note should let a reviewer see the pattern without rerunning the search: the failures, and what shows they belong to a scan.',
        },
      },
      {
        id: 'decision', type: 'single', label: 'Disposition', points: 14, summary: 'Disposition',
        options: [
          opt('escalate', 'Escalate to Tier 2'),
          opt('close_benign', 'Close at Tier 1 as benign / authorised'),
          opt('close_fp', 'Close at Tier 1 as false positive'),
          opt('monitor', 'Keep open and continue monitoring'),
        ],
        key: { accept: { close_benign: 1, close_fp: 0.5, escalate: 0.15 }, explain: 'Source, account, scope and timing all match an approved change and nothing exceeds it. Escalating spends Tier 2 time on a question Tier 1 can answer.' },
      },
      { id: 'note', type: 'longtext', label: 'Triage note', min: 40, points: 2, help: 'What you checked and why you reached this verdict.', key: { explain: 'Recorded in the case file.' } },
    ],
  },
  {
    id: 'l2_review', label: 'L2 review', tier: 'L2', kind: 'form', weight: 15, attempts: 1, submitLabel: 'Return ticket',
    intro: 'Tier 1 escalated this ticket. Review it and decide where it goes.',
    fields: [
      {
        id: 'assessment', type: 'single', label: 'Tier 2 assessment', points: 5, summary: 'Assessment',
        options: [
          opt('incident', 'Credential attack in progress: declare an incident'),
          opt('authorised', 'Authorised scan under an approved change'),
          opt('unclear', 'Cannot determine; request packet capture'),
        ],
        key: { accept: 'authorised', explain: 'The asset inventory, directory and change calendar all agree.' },
      },
      {
        id: 'route', type: 'single', label: 'Routing', points: 5, summary: 'Routing',
        options: [
          opt('l3', 'Hand to incident response (L3)'),
          opt('hold', 'Hold at Tier 2 until the scan finishes'),
          opt('return', 'Return to Tier 1 for closure, with feedback on what to check before escalating'),
        ],
        key: { accept: 'return', explain: 'Nothing needs Tier 2 or Tier 3. The useful output is feedback so the next one is closed at Tier 1.' },
      },
    ],
  },
  {
    id: 'closure', label: 'Closure', tier: 'L1', kind: 'form', weight: 40, attempts: 1, final: true, submitLabel: 'Close ticket',
    intro: 'Record the closure and what should change so this does not consume analyst time every quarter.',
    fields: [
      {
        id: 'code', type: 'single', label: 'Closure code', points: 6, summary: 'Closure code',
        options: [
          opt('incident', 'Confirmed incident'),
          opt('fp', 'False positive: detection defect'),
          opt('benign', 'Benign: authorised activity'),
          opt('dup', 'Duplicate'),
        ],
        key: { accept: { benign: 1, fp: 0.4 }, explain: 'Closure codes feed detection metrics. Coding this as a detection defect would send the rule for rework it does not need.' },
      },
      {
        id: 'tuning', type: 'multi', label: 'Follow-up', points: 10,
        help: 'Select what you would recommend.',
        options: [
          opt('disable', 'Disable rule AUTH-0031'),
          opt('window', 'Suppress AUTH-0031 for SCAN01 only, limited to approved scan windows taken from the change calendar'),
          opt('allow_all', 'Permanently exclude 10.10.0.60 from all detection rules'),
          opt('calendar', 'Have scheduled scans announced in the SOC shift handover'),
          opt('reset', 'Reset the svc_scan password'),
          opt('block', 'Block SCAN01 at the firewall'),
          opt('threshold', 'Raise the rule threshold to 500 failures'),
        ],
        key: { set: ['window', 'calendar'], explain: 'A time-bound, source-specific suppression removes the noise without creating a blind spot. A permanent exclusion means a compromised scanner, which holds admin credentials for every server, would never alert. Disabling or blunting the rule removes real brute-force coverage.' },
      },
      { id: 'summary', type: 'longtext', label: 'Closure summary', min: 60, points: 2, help: 'Two or three sentences a reviewer could read without the case file.', key: { explain: 'Recorded in the case file.' } },
    ],
  },
];

function alert(stream, c) {
  const until = c.t0 + 5000;
  const fails = stream.events.filter((e) => (e._tags || []).includes('scan_fail') && e.ts <= until);
  const oks = stream.events.filter((e) => (e._tags || []).includes('scan_ok') && e.fields.event_id === 4624 && e.ts <= until);
  const targets = [...new Set(fails.map((e) => e.host))];
  const users = [...new Set(fails.map((e) => e.fields.target_user))];
  return {
    id: 'A1', rule: 'AUTH-0031', severity: 'high',
    title: 'Multiple failed logons followed by a successful logon from one source',
    description: `${fails.length} failed network logons against ${targets.length} hosts from ${SCAN.ip}, using ${users.length} different account names, followed by successful logons from the same address.`,
    entity: { host: null, ip: SCAN.ip, user: `${users.length} account names (see details)` },
    details: [
      ['Source address', SCAN.ip], ['Failed logons', String(fails.length)], ['Distinct targets', targets.join(', ')],
      ['Account names tried', users.join(', ')], ['Successful logons after failures', String(oks.length)],
      ['First failure', utc(fails[0].ts)], ['Latest failure', utc(fails[fails.length - 1].ts)],
      ['Rule logic', '30 or more failed logons (4625) from one source within 15 minutes, followed by a successful logon (4624) from the same source'],
    ],
    guidance: [
      'Identify the source host and its owner.',
      'Establish whether the pattern is one account many times, or many accounts a few times each.',
      'Identify the account that succeeded and whether it normally logs on from this source.',
      'Check whether the activity is expected at this time.',
    ],
    matched: [...fails.slice(-14), ...oks.slice(-4)].map((e) => e.id),
    matchedTotal: fails.length + oks.length,
  };
}

export default {
  id: 's02-authfail',
  historySeconds: 30 * 60,
  catalog: {
    title: 'Multiple failed logons followed by a successful logon from one source',
    queue: 'authentication',
    blurb: 'An authentication rule reports a burst of failed logons across several servers from one internal address, then successes. Work the ticket from the alert queue to closure.',
    difficulty: 'Foundation',
    minutes: '10-20',
    tiers: 'L1 (L2 only if escalated)',
    sources: ['proxy', 'dns', 'email', 'edr', 'winsec', 'firewall'],
    environment: 'Meridian Freight Systems, about 30 hosts. Web egress is logged at the proxy; firewall logs cover inter-VLAN and inbound traffic. All times are UTC.',
  },
  build,
  alert: { at: 5, build: alert },
  relatedAlerts: [],
  stages,
  flow(stageId, { values }) {
    if (stageId === 'l1_triage') {
      if (values.decision === 'escalate') {
        return { next: 'l2_review', result: 'Escalated', notes: [{ actor: 'Tier 2 queue', text: 'Escalation accepted for review.' }] };
      }
      if (values.decision === 'monitor') {
        return { next: 'closure', result: 'Overruled', notes: [{ actor: 'SOC shift lead', text: 'QA review: tickets are not left open "to monitor" without an owner and an exit condition. Reach a conclusion and close it.' }] };
      }
      return { next: 'closure' };
    }
    if (stageId === 'l2_review') {
      return { next: 'closure', notes: [{ actor: 'L2 analyst', text: 'Returned to Tier 1 for closure. Before escalating an authentication alert from an internal source, check the asset inventory and the change calendar.' }] };
    }
    return null;
  },
  intel() {
    return {
      [PLUGIN_HOST]: { verdict: 'clean', detections: '0/89', facts: [['Category', 'Technology/Security'], ['Registered', 'More than 5 years ago'], ['Owner', 'VulnScan Inc. (vulnerability scanner vendor)']], notes: ['Plugin feed for the vulnerability scanner.'] },
      [PLUGIN_IP]: { verdict: 'clean', detections: '0/89', facts: [['Resolves from', PLUGIN_HOST], ['Category', 'Technology/Security']], notes: [] },
    };
  },
  sandbox: {},
  assetNotes: {},
  accountNotes: { svc_scan: ['Password rotated 21 days ago by the vault. No interactive logon rights.'] },
  changes: [
    {
      id: CHANGE_ID, title: 'Quarterly credentialed vulnerability scan - server and DMZ segments',
      scope: 'SERVERS 10.10.0.0/24 and DMZ 172.16.5.0/24, from SCAN01 (10.10.0.60) as svc_scan',
      owner: 'IT Security (e.morales)', status: 'Approved, in progress', start: -30, end: 150,
      detail: 'Includes default-credential checks, so authentication failures are expected on every Windows target, followed by remote registry access.',
    },
  ],
  secret: {
    response: { scope: {}, objectives: [], notify: {}, artifacts: {} },
    truth({ t0 }) {
      const T = (off) => t0 + off * 1000;
      return {
        summary: `Nothing malicious happened. SCAN01 ran the quarterly credentialed vulnerability scan under ${CHANGE_ID}. For each target it swept ten common ports, tried six default account names once each (the failed logons), then authenticated with its documented service account svc_scan and read configuration through Remote Registry. Source, account, scope and timing all match the approved change, and no activity goes beyond what a scan does. The skill being exercised is confirming that positively and quickly, coding it correctly as a benign true positive, and recommending tuning that removes the noise without blinding the SOC to a compromised scanner.`,
        timeline: [
          { ts: T(-30 * 60), text: `${CHANGE_ID} window opens.` },
          { ts: T(START - 60), text: `SCAN01 downloads its plugin feed from ${PLUGIN_HOST}.` },
          { ts: T(START - 40), text: 'Port sweep of the mail gateway, proxy and VPN appliances.' },
          { ts: T(START), text: 'First Windows target (DC01): port sweep, six default-credential failures, svc_scan logon, Remote Registry read.' },
          { ts: T(5), text: 'AUTH-0031 fires on the accumulated failures.' },
          { ts: T(START + 7 * STEP + 87), text: 'Last target (WEB01) finished; scan complete.' },
        ],
        iocs: [],
      };
    },
  },
  _test: {
    tools: { l1_triage: [['asset', 'SCAN01'], ['change', ''], ['user', 'svc_scan']] },
  },
};
