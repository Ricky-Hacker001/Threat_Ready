// The simulated organisation. Every scenario runs against this same
// environment so that hosts, users, IPs and baselines stay consistent.
//
// All names are fictional. External attacker/partner infrastructure uses
// reserved documentation ranges (192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24) and the reserved .example TLD.

import { fakeSha256 } from './rng.js';

export const ORG = {
  name: 'Meridian Freight Systems',
  netbios: 'MERIDIAN',
  adDomain: 'corp.meridianfreight.example',
  mailDomain: 'meridianfreight.example',
};

const U = (sam, name, dept, title, host, ip, extra = {}) => ({
  sam, name, dept, title, host, ip, type: 'user',
  email: `${sam}@${ORG.mailDomain}`,
  groups: ['Domain Users', `${dept}-Staff`],
  localAdmin: false,
  ...extra,
});

export const USERS = [
  U('p.nair', 'Priya Nair', 'Finance', 'Accounts Payable Specialist', 'WS-FIN-014', '10.20.14.37', {
    manager: 'l.brandt', localAdmin: true,
    notes: 'Local administrator on WS-FIN-014 (exception EXC-0193: legacy banking plug-in installer).',
  }),
  U('d.okafor', 'Daniel Okafor', 'Finance', 'Financial Analyst', 'WS-FIN-009', '10.20.14.29', { manager: 'l.brandt' }),
  U('l.brandt', 'Lena Brandt', 'Finance', 'Finance Manager', 'WS-FIN-002', '10.20.14.12', { manager: 'v.sorensen' }),
  U('m.castillo', 'Marta Castillo', 'Finance', 'Payroll Administrator', 'WS-FIN-006', '10.20.14.21', { manager: 'l.brandt' }),
  U('t.nguyen', 'Tran Nguyen', 'Operations', 'Dispatch Coordinator', 'WS-OPS-031', '10.20.21.44', { manager: 'j.whitfield' }),
  U('j.whitfield', 'James Whitfield', 'Operations', 'Operations Manager', 'WS-OPS-004', '10.20.21.15', { manager: 'v.sorensen' }),
  U('s.petrov', 'Sofia Petrov', 'Operations', 'Logistics Planner', 'WS-OPS-018', '10.20.21.33', { manager: 'j.whitfield' }),
  U('a.mensah', 'Abena Mensah', 'Operations', 'Customs Specialist', 'WS-OPS-022', '10.20.21.38', { manager: 'j.whitfield' }),
  U('r.delgado', 'Rosa Delgado', 'Sales', 'Account Executive', 'WS-SAL-007', '10.20.30.19', { manager: 'k.yamamoto' }),
  U('k.yamamoto', 'Kenji Yamamoto', 'Sales', 'Sales Director', 'WS-SAL-001', '10.20.30.11', { manager: 'v.sorensen' }),
  U('h.lindqvist', 'Hanna Lindqvist', 'HR', 'HR Business Partner', 'WS-HR-003', '10.20.40.14', { manager: 'v.sorensen' }),
  U('r.khan', 'Rashid Khan', 'IT', 'Systems Administrator', 'WS-IT-002', '10.20.50.12', { manager: 'v.sorensen' }),
  U('e.morales', 'Elena Morales', 'IT', 'IT Support Technician', 'WS-IT-005', '10.20.50.17', { manager: 'r.khan' }),
  U('c.obrien', "Conor O'Brien", 'Engineering', 'DevOps Engineer', 'WS-ENG-011', '10.20.60.23', { manager: 'r.khan' }),
  U('n.haddad', 'Nour Haddad', 'Engineering', 'Software Developer', 'WS-ENG-008', '10.20.60.19', { manager: 'r.khan' }),
  U('v.sorensen', 'Viktor Sorensen', 'Executive', 'Chief Financial Officer', 'WS-EXE-002', '10.20.70.12', {}),
];

// People who appear in specific scenarios. They are in the directory and
// asset inventory but do not generate background noise, so the noise of
// existing scenarios is unchanged.
export const EXTRA_USERS = [
  U('l.morgan', 'Leah Morgan', 'Finance', 'Credit Controller', 'WS-FIN-021', '10.20.14.44', { manager: 'l.brandt' }),
  U('r.santos', 'Rui Santos', 'Operations', 'Night Operations Controller', 'WS-OPS-040', '10.20.21.52', { manager: 'j.whitfield', notes: 'Shift: nights 22:00-06:00 (roster OPS-NIGHT). Works remotely through the VPN.' }),
  U('n.okoye', 'Nneka Okoye', 'Sales', 'Account Executive', 'WS-SAL-012', '10.20.30.24', { manager: 'k.yamamoto', notes: 'New starter. Account created under HR ticket HR-2219.' }),
  U('g.harlow', 'Gavin Harlow', 'Finance', 'Reporting Analyst (leaver)', 'WS-FIN-030', '10.20.14.52', { manager: 'l.brandt', disabled: true, notes: 'Leaver. Account disabled 21 days ago.' }),
  U('v.hale', 'Victor Hale', 'Finance', 'Finance IT Analyst', 'WS-FIN-033', '10.20.14.58', { manager: 'l.brandt', notes: 'On leave until Monday.' }),
];

const SVC = (sam, name, notes, groups, usual) => ({
  sam, name, type: 'service', dept: 'IT', title: 'Service account', groups, notes, usualHosts: usual,
});

export const SERVICE_ACCOUNTS = [
  SVC('svc_backup', 'Backup agent service',
    'Runs the backup agent on servers and workstations. Normal pattern: Kerberos network logons originating from BKP01 (10.10.0.35), service logons (type 5) on managed hosts.',
    ['Backup Operators', 'Server-LocalAdmins'], ['BKP01']),
  SVC('svc_sql', 'SQL Server service', 'SQL Server engine account on SQL01.', ['SQL-Service'], ['SQL01']),
  SVC('svc_scan', 'Vulnerability scanner credentialed-scan account',
    'Used by SCAN01 (10.10.0.60) for authenticated vulnerability scans. Normal pattern: logons originating only from SCAN01 during approved scan windows.',
    ['Scan-ReadOnly', 'Server-LocalAdmins'], ['SCAN01']),
  SVC('svc_web', 'Customer portal application pool', 'IIS application pool identity on WEB01.', ['Web-Service'], ['WEB01']),
  SVC('svc_migrate', 'Data migration job account', 'Runs approved bulk file migrations from MIG01.', ['Migration-Operators'], ['MIG01']),
  SVC('svc_finrpt', 'Finance reporting service account', 'Runs the finance reporting jobs on FIN-APP02. Has read access to the payroll database.', ['Finance-Reporting'], ['FIN-APP02']),
  SVC('svc_inventory', 'Network inventory account', 'Used by INV01 for asset discovery.', ['Inventory-ReadOnly'], ['INV01']),
  SVC('krbtgt', 'Kerberos ticket-granting account', 'Built-in. Its key signs every Kerberos ticket in the domain. Resetting it twice invalidates forged tickets.', ['Domain Controllers (built-in)'], ['DC01', 'DC02']),
  SVC('rt.operator1', 'Red team operator account', 'Created for exercise RT-2026-04. Expires at the end of the engagement.', ['RedTeam-Exercise'], ['FIN-APP02']),
  { sam: 'adm.rkhan', name: 'Rashid Khan (admin)', type: 'admin', of: 'r.khan', dept: 'IT', title: 'Privileged account',
    groups: ['Domain Admins'], notes: 'Tier-0 administrative account. Should only log on to DC01, DC02 and JUMP01.', usualHosts: ['JUMP01', 'DC01', 'DC02'] },
  { sam: 'adm.emorales', name: 'Elena Morales (admin)', type: 'admin', of: 'e.morales', dept: 'IT', title: 'Privileged account',
    groups: ['Server-LocalAdmins'], notes: 'Server administration account. Normally used from WS-IT-005 and JUMP01.', usualHosts: ['WS-IT-005', 'JUMP01'] },
  { sam: 'adm.vhale', name: 'Victor Hale (admin)', type: 'admin', of: 'v.hale', dept: 'Finance', title: 'Privileged account',
    groups: ['Finance-Server-Admins'], notes: 'Finance IT administration account for FIN01. Owner is on leave until Monday.', usualHosts: ['WS-FIN-033', 'JUMP01'] },
];

export const ACCOUNTS = [...USERS, ...EXTRA_USERS, ...SERVICE_ACCOUNTS];

const S = (name, ip, role, criticality, vlan, os, owner, notes = '') => ({
  name, ip, role, criticality, vlan, os, owner, notes, kind: 'server',
});

export const SERVERS = [
  S('DC01', '10.10.0.10', 'Domain controller / DNS', 'Critical', 'SERVERS', 'Windows Server 2022', 'IT Infrastructure'),
  S('DC02', '10.10.0.11', 'Domain controller / DNS', 'Critical', 'SERVERS', 'Windows Server 2022', 'IT Infrastructure'),
  S('FS01', '10.10.0.21', 'File server (Finance, Operations, HR shares)', 'High', 'SERVERS', 'Windows Server 2019', 'IT Infrastructure',
    'Hosts D:\\Shares\\Finance (payroll, banking), D:\\Shares\\Operations, D:\\Shares\\HR. Data classification: Confidential.'),
  S('MAILGW', '10.10.0.25', 'Secure email gateway', 'High', 'SERVERS', 'Appliance', 'IT Security'),
  S('PROXY01', '10.10.0.30', 'Web proxy', 'High', 'SERVERS', 'Appliance', 'IT Security'),
  S('BKP01', '10.10.0.35', 'Backup server', 'High', 'SERVERS', 'Windows Server 2019', 'IT Infrastructure'),
  S('SQL01', '10.10.0.41', 'SQL Server (TMS database)', 'High', 'SERVERS', 'Windows Server 2019', 'Application Support'),
  S('APP01', '10.10.0.45', 'Transport management system application', 'High', 'SERVERS', 'Windows Server 2019', 'Application Support'),
  S('SCAN01', '10.10.0.60', 'Vulnerability scanner', 'Medium', 'SERVERS', 'Linux appliance', 'IT Security',
    'Credentialed scans run under svc_scan. Scan schedule is published in the change calendar.'),
  S('JUMP01', '10.10.0.70', 'Privileged access jump host', 'High', 'SERVERS', 'Windows Server 2022', 'IT Infrastructure'),
  S('WEB01', '172.16.5.10', 'Customer portal (DMZ)', 'High', 'DMZ', 'Windows Server 2019', 'Application Support'),
  S('VPN01', '172.16.5.20', 'Remote access VPN concentrator (DMZ)', 'High', 'DMZ', 'Appliance', 'IT Infrastructure'),
  S('FW01', '10.10.0.1', 'Perimeter / inter-VLAN firewall', 'Critical', 'SERVERS', 'Appliance', 'IT Security'),
  S('FS02', '10.10.0.22', 'File server (new storage, Projects share)', 'High', 'SERVERS', 'Windows Server 2022', 'IT Infrastructure'),
  S('WAF01', '172.16.5.11', 'Web application firewall in front of WEB01', 'High', 'DMZ', 'Appliance', 'IT Security'),
  S('INV01', '10.10.0.62', 'Network inventory and discovery', 'Medium', 'SERVERS', 'Linux appliance', 'IT Infrastructure', 'Runs the weekly asset discovery sweep.'),
  S('APP02', '10.10.0.46', 'Finance reporting server', 'High', 'SERVERS', 'Windows Server 2019', 'Finance Systems'),
  S('MIG01', '10.10.0.64', 'Data migration host', 'Medium', 'SERVERS', 'Windows Server 2022', 'IT Infrastructure'),
  S('FIN01', '10.10.0.48', 'Finance server (payroll exports)', 'Critical', 'SERVERS', 'Windows Server 2019', 'Finance Systems', 'Holds the Payroll$ share. Access is limited to Finance IT.'),
  S('FIN-APP02', '10.10.0.49', 'Finance application server', 'High', 'SERVERS', 'Windows Server 2019', 'Finance Systems'),
  S('PAY-DB01', '10.10.0.50', 'Production payroll database', 'Critical', 'SERVERS', 'Windows Server 2022', 'Finance Systems', 'Production payroll data. Excluded from all testing.'),
  S('OPS-TERM01', '10.10.0.75', 'Operations terminal server', 'High', 'SERVERS', 'Windows Server 2022', 'Operations'),
];

export const WORKSTATIONS = [...USERS, ...EXTRA_USERS].map((u) => ({
  name: u.host, ip: u.ip, role: `Workstation (${u.dept})`, criticality: u.dept === 'Executive' ? 'High' : 'Medium',
  vlan: 'USERS', os: 'Windows 11 Enterprise 23H2', owner: u.sam, kind: 'workstation', notes: '',
}));

export const HOSTS = [...SERVERS, ...WORKSTATIONS];

const hostByName = new Map(HOSTS.map((h) => [h.name.toUpperCase(), h]));
const hostByIp = new Map(HOSTS.map((h) => [h.ip, h]));
const acctBySam = new Map(ACCOUNTS.map((a) => [a.sam.toLowerCase(), a]));

// v2 environment records (Build specification, section 10.2).
export const VPN_POOL = '10.50.0';
export const TENANT = { name: 'meridianfreight.onmicrosoft.com', apps: ['Office 365', 'Azure Portal', 'Salesforce', 'VPN SAML'] };
export const AWS = {
  account: '441900170632', iamUsers: ['ci-deploy', 'cloud.admin', 'svc-backup-s3'], roles: ['ci-deploy', 'ec2-app-role'],
  buckets: ['mf-invoices-prod', 'mf-backups', 'mf-web-assets'], ciRunner: '10.10.0.80',
};
export const WEB_APPS = ['portal.meridianfreight.example', 'track.meridianfreight.example'];

export const hostNamed = (n) => hostByName.get(String(n || '').toUpperCase());
export const hostAt = (ip) => hostByIp.get(ip);
export const hostNameAt = (ip) => hostByIp.get(ip)?.name;
export const account = (sam) => acctBySam.get(String(sam || '').toLowerCase().replace(/^meridian\\/, ''));
export const dom = (sam) => `${ORG.netbios}\\${sam}`;

// ---------------------------------------------------------------------------
// Benign web destinations: [host, ip, proxy category, departments ('*' = all)]
// ---------------------------------------------------------------------------
export const WEB = [
  ['outlook.office365.com', '52.96.165.18', 'Business/Email', '*'],
  ['login.microsoftonline.com', '20.190.151.7', 'Business/Authentication', '*'],
  ['teams.microsoft.com', '52.113.194.132', 'Business/Collaboration', '*'],
  ['meridianfreight.sharepoint.com', '13.107.136.10', 'Business/File Sharing', '*'],
  ['graph.microsoft.com', '20.190.160.20', 'Business/API', '*'],
  ['v10.events.data.microsoft.com', '20.189.173.9', 'Technology/Telemetry', '*'],
  ['ctldl.windowsupdate.com', '23.48.203.19', 'Technology/Updates', '*'],
  ['www.google.com', '142.250.74.36', 'Search Engines', '*'],
  ['www.linkedin.com', '13.107.42.14', 'Social/Professional', '*'],
  ['zoom.us', '170.114.52.2', 'Business/Collaboration', '*'],
  ['updates.endpointshield.example', '192.0.2.81', 'Technology/Security', '*'],
  ['portal.nordhaven-shipping.example', '192.0.2.44', 'Business/Logistics', 'Operations,Sales,Finance'],
  ['tracking.balticcarrierlines.example', '203.0.113.180', 'Business/Logistics', 'Operations,Finance'],
  ['rates.customs-gateway.example', '198.51.100.140', 'Business/Government', 'Operations'],
  ['edi.cargowise-hub.example', '198.51.100.201', 'Business/Logistics', 'Operations'],
  ['fuelcard.transfleet.example', '192.0.2.117', 'Business/Finance', 'Finance,Operations'],
  ['online.northbridge-bank.example', '203.0.113.9', 'Finance/Banking', 'Finance,Executive'],
  ['app.ledgerline.example', '198.51.100.58', 'Business/Finance', 'Finance'],
  ['meridian.my.salesforce.com', '136.147.46.10', 'Business/CRM', 'Sales'],
  ['github.com', '140.82.121.4', 'Technology/Development', 'Engineering,IT'],
  ['registry.npmjs.org', '104.16.1.35', 'Technology/Development', 'Engineering'],
  ['pkgs.dev.azure.com', '13.107.42.20', 'Technology/Development', 'Engineering,IT'],
  ['hr.peoplecore.example', '192.0.2.200', 'Business/HR', 'HR'],
  ['www.bbc.com', '151.101.0.81', 'News', '*'],
  ['www.reuters.com', '104.18.36.74', 'News', '*'],
];

export const BENIGN_DOMAINS = new Set(WEB.map((w) => w[0]));
export const BENIGN_IPS = new Set(WEB.map((w) => w[1]));

export const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  office: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)',
  wu: 'Windows-Update-Agent/10.0.10011.16384 Client-Protocol/2.71',
  teams: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Teams/24215.1007.3082.1590 Chrome/122.0.0.0 Electron/29.4.5 Safari/537.36',
};

// Known-good binaries and their (synthetic, stable) hashes.
const BIN = (path, signer) => ({ path, signer, sha256: fakeSha256(path.toLowerCase()) });
export const BINARIES = {
  explorer: BIN('C:\\Windows\\explorer.exe', 'Microsoft Windows'),
  outlook: BIN('C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE', 'Microsoft Corporation'),
  excel: BIN('C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE', 'Microsoft Corporation'),
  winword: BIN('C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE', 'Microsoft Corporation'),
  chrome: BIN('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'Google LLC'),
  edge: BIN('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Corporation'),
  teams: BIN('C:\\Program Files\\WindowsApps\\MSTeams_24215.1007.3082.1590_x64__8wekyb3d8bbwe\\ms-teams.exe', 'Microsoft Corporation'),
  powershell: BIN('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'Microsoft Windows'),
  cmd: BIN('C:\\Windows\\System32\\cmd.exe', 'Microsoft Windows'),
  rundll32: BIN('C:\\Windows\\System32\\rundll32.exe', 'Microsoft Windows'),
  net: BIN('C:\\Windows\\System32\\net.exe', 'Microsoft Windows'),
  nltest: BIN('C:\\Windows\\System32\\nltest.exe', 'Microsoft Windows'),
  whoami: BIN('C:\\Windows\\System32\\whoami.exe', 'Microsoft Windows'),
  tasklist: BIN('C:\\Windows\\System32\\tasklist.exe', 'Microsoft Windows'),
  services: BIN('C:\\Windows\\System32\\services.exe', 'Microsoft Windows'),
  svchost: BIN('C:\\Windows\\System32\\svchost.exe', 'Microsoft Windows'),
  lsass: BIN('C:\\Windows\\System32\\lsass.exe', 'Microsoft Windows'),
  notepad: BIN('C:\\Windows\\System32\\notepad.exe', 'Microsoft Windows'),
  acrobat: BIN('C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe', 'Adobe Inc.'),
  sevenzip: BIN('C:\\Program Files\\7-Zip\\7z.exe', 'Igor Pavlov'),
  code: BIN('C:\\Users\\Public\\Programs\\Microsoft VS Code\\Code.exe', 'Microsoft Corporation'),
  git: BIN('C:\\Program Files\\Git\\cmd\\git.exe', 'Johannes Schindelin'),
  monagent: BIN('C:\\Program Files\\OpsMonitor\\Agent\\opsmon-agent.exe', 'OpsMonitor Software Ltd'),
  bkpagent: BIN('C:\\Program Files\\VaultLine\\Agent\\vlagent.exe', 'VaultLine Backup Inc.'),
  tms: BIN('C:\\Program Files\\FreightDesk\\TMSClient.exe', 'FreightDesk Software'),
};

export const KNOWN_GOOD_HASHES = new Map(Object.values(BINARIES).map((b) => [b.sha256, b]));

// Stable PID for long-lived per-host processes.
export function stablePid(host, name) {
  let h = 0;
  const s = `${host}|${name}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 600 + (h % 2200) * 4;
}

// Routine entries every scenario sees in the change calendar.
// start/end are minutes relative to the case start (t0).
export const BASE_CHANGES = [
  { id: 'CHG-4398', title: 'Monthly Windows cumulative updates - workstation ring 2', scope: 'WS-OPS-*, WS-SAL-*', owner: 'r.khan', status: 'Approved', start: -3 * 1440, end: -3 * 1440 + 240 },
  { id: 'CHG-4412', title: 'Proxy category database refresh', scope: 'PROXY01', owner: 'IT Security', status: 'Completed', start: -2 * 1440, end: -2 * 1440 + 30 },
  { id: 'CHG-4460', title: 'TMS application patch 8.4.2', scope: 'APP01, SQL01', owner: 'Application Support', status: 'Scheduled', start: 2 * 1440, end: 2 * 1440 + 120 },
];

// Directory lists exposed to the analyst UI (names only, no ground truth).
export function publicDirectory() {
  return {
    org: ORG,
    hosts: HOSTS.map((h) => ({ name: h.name, ip: h.ip, role: h.role, kind: h.kind })),
    accounts: ACCOUNTS.map((a) => ({ sam: a.sam, name: a.name, type: a.type, dept: a.dept })),
  };
}
