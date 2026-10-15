// Background activity for the simulated organisation. Pure function of
// (seed, slot): the same second always produces the same benign events.
//
// Deliberately includes look-alikes of attacker behaviour (encoded
// PowerShell from a monitoring agent, Excel opening spreadsheets, service
// account logons, periodic telemetry) so that keyword matching alone does
// not separate signal from noise.

import { rng, fakeSha256 } from './rng.js';
import { E } from './format.js';
import { USERS, SERVERS, WEB, UA, BINARIES as B, ORG, dom, stablePid, hostNamed, VPN_POOL, AWS, TENANT } from './env.js';

const DC = hostNamed('DC01');
const FS = hostNamed('FS01');
const BKP = hostNamed('BKP01');
const APP = hostNamed('APP01');
const SQL = hostNamed('SQL01');
const WEBSRV = hostNamed('WEB01');
const MANAGED_SERVERS = SERVERS.filter((s) => ['FS01', 'SQL01', 'APP01', 'BKP01', 'JUMP01'].includes(s.name));

const PATHS = {
  'outlook.office365.com': ['/owa/service.svc?action=FindItem', '/mapi/emsmdb/?MailboxId=', '/EWS/Exchange.asmx', '/owa/ev.owa2?ns=PendingRequest'],
  'login.microsoftonline.com': ['/common/oauth2/v2.0/token', '/common/GetCredentialType?mkt=en-US'],
  'teams.microsoft.com': ['/api/chatsvc/emea/v1/users/ME/conversations', '/api/mt/emea/beta/users/fetch'],
  'meridianfreight.sharepoint.com': ['/sites/Finance/_api/web/lists', '/sites/Operations/Shared%20Documents/Forms/AllItems.aspx', '/_api/SP.UserProfiles.PeopleManager', '/sites/Sales/_layouts/15/upload.aspx'],
  'graph.microsoft.com': ['/v1.0/me/calendarView', '/v1.0/me/drive/recent', '/beta/me/presence'],
  'v10.events.data.microsoft.com': ['/OneCollector/1.0/'],
  'ctldl.windowsupdate.com': ['/msdownload/update/v3/static/trustedr/en/disallowedcertstl.cab'],
  'www.google.com': ['/search?q=incoterms+2020+dap', '/search?q=port+of+rotterdam+congestion', '/complete/search?client=chrome'],
  'www.linkedin.com': ['/feed/', '/voyager/api/messaging/conversations'],
  'zoom.us': ['/wc/join', '/api/v1/meeting/status'],
  'updates.endpointshield.example': ['/defs/v4/manifest.json', '/defs/v4/delta-20261009.bin'],
  'portal.nordhaven-shipping.example': ['/bookings/search', '/api/v2/shipments?status=in_transit', '/documents/bol'],
  'tracking.balticcarrierlines.example': ['/track?awb=BCL', '/api/containers/status'],
  'rates.customs-gateway.example': ['/tariff/lookup', '/declarations/submit'],
  'edi.cargowise-hub.example': ['/as2/inbound', '/api/messages/poll'],
  'fuelcard.transfleet.example': ['/statements/2026-09', '/cards/usage'],
  'online.northbridge-bank.example': ['/corporate/payments/batch', '/corporate/accounts/summary'],
  'app.ledgerline.example': ['/api/invoices?state=open', '/api/vendors', '/reports/aging'],
  'meridian.my.salesforce.com': ['/lightning/o/Opportunity/list', '/services/data/v61.0/query'],
  'github.com': ['/meridianfreight/tms-integrations/pulls', '/meridianfreight/infra.git/info/refs'],
  'registry.npmjs.org': ['/express', '/@types%2fnode'],
  'pkgs.dev.azure.com': ['/meridianfreight/_packaging/internal/npm/registry/'],
  'hr.peoplecore.example': ['/timeoff/requests', '/api/employees/me'],
  'www.bbc.com': ['/news/business', '/news'],
  'www.reuters.com': ['/markets/commodities/', '/business/autos-transportation/'],
};

const DOCS = {
  Finance: ['AP_Aging_Sept.xlsx', 'Q3_Accruals.xlsx', 'Vendor_Master_2026.xlsx', 'Payroll_Recon_Sep.xlsx', 'Bank_Rec_Northbridge.xlsx'],
  Operations: ['Dispatch_Plan_W41.xlsx', 'Carrier_Scorecard.xlsx', 'Customs_Holds.xlsx', 'Route_Costs_Oct.xlsx'],
  Sales: ['Pipeline_Q4.xlsx', 'RateCard_EU_2026.xlsx', 'Renewals.xlsx'],
  HR: ['Headcount_Oct.xlsx', 'Leave_Balances.xlsx'],
  IT: ['Asset_Inventory.xlsx', 'License_Tracker.xlsx'],
  Engineering: ['Sprint_42_Burndown.xlsx', 'API_Latency.xlsx'],
  Executive: ['Board_Pack_Q3.xlsx', 'Cashflow_Forecast.xlsx'],
};

const MAIL_PARTNERS = [
  ['ops@nordhaven-shipping.example', 'Nordhaven Shipping Ops', '192.0.2.45', ['Booking confirmation NH-', 'Vessel delay notice - MV Nordkapp', 'Updated ETA for shipment NH-']],
  ['invoices@balticcarrierlines.example', 'Baltic Carrier Lines', '203.0.113.181', ['Invoice BCL-', 'Statement of account - September', 'Remittance advice BCL-']],
  ['noreply@customs-gateway.example', 'Customs Gateway', '198.51.100.141', ['Declaration accepted: ', 'Query raised on declaration ']],
  ['billing@transfleet.example', 'TransFleet Fuel Cards', '192.0.2.118', ['Your fuel card statement is ready', 'Card usage alert']],
  ['notifications@ledgerline.example', 'Ledgerline', '198.51.100.59', ['Approval required: vendor payment run', 'Invoice matched: PO-']],
];

const BENIGN_ENCODED = [
  'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json',
  'Get-Service | Where-Object {$_.Status -ne "Running" -and $_.StartType -eq "Automatic"} | Select-Object Name | ConvertTo-Json',
  'Get-Counter "\\Processor(_Total)\\% Processor Time" -SampleInterval 1 -MaxSamples 1 | ConvertTo-Json',
];
const b64ps = (s) => Buffer.from(s, 'utf16le').toString('base64');

const sport = (r) => r.int(49152, 65535);
const logonId = (r) => `0x${r.hex(7).toUpperCase()}`;

function webFor(r, user) {
  const pool = WEB.filter((w) => w[3] === '*' || w[3].split(',').includes(user.dept));
  return r.pick(pool);
}

const GEN = {
  web(r, ts) {
    const u = r.pick(USERS);
    const [host, ip, cat] = webFor(r, u);
    const path = r.pick(PATHS[host] || ['/']);
    const exempt = /Banking|Authentication/.test(cat);
    const isTelemetry = host.startsWith('v10.events') || host.startsWith('ctldl') || host.startsWith('updates.');
    const big = host.includes('sharepoint') && r.chance(0.04);
    const post = big || /token|submit|batch|OneCollector|as2|query/.test(path);
    const ev = E.proxy(ts, {
      src_ip: u.ip,
      user: isTelemetry ? '-' : dom(u.sam),
      method: exempt ? 'CONNECT' : post ? 'POST' : 'GET',
      url: exempt ? `${host}:443` : `https://${host}${path}${/[=-]$/.test(path) ? r.int(100000, 999999) : ''}`,
      dest_ip: ip,
      status: r.weighted([[90, 200], [4, 304], [3, 302], [2, 404], [1, 503]]),
      bytes_out: big ? r.int(8_000_000, 31_000_000) : post ? r.int(600, 9000) : r.int(280, 1400),
      bytes_in: r.int(400, 180000),
      category: cat,
      ua: host.startsWith('ctldl') ? UA.wu : host.startsWith('teams') ? UA.teams : host.startsWith('outlook') ? UA.office : r.chance(0.6) ? UA.chrome : UA.edge,
    });
    return [ev];
  },

  dns(r, ts) {
    const u = r.pick(USERS);
    if (r.chance(0.22)) {
      const q = r.pick([
        `fs01.${ORG.adDomain}`, `dc01.${ORG.adDomain}`, `app01.${ORG.adDomain}`,
        `_ldap._tcp.dc._msdcs.${ORG.adDomain}`, `wpad.${ORG.adDomain}`,
      ]);
      const ans = q.startsWith('fs01') ? FS.ip : q.startsWith('app01') ? APP.ip : q.startsWith('wpad') ? undefined : DC.ip;
      return [E.dns(ts, { client_ip: u.ip, query: q, qtype: q.startsWith('_ldap') ? 'SRV' : 'A', rcode: ans ? 'NOERROR' : 'NXDOMAIN', answer: ans })];
    }
    const [host, ip] = webFor(r, u);
    return [E.dns(ts, { client_ip: u.ip, query: host, answer: ip })];
  },

  auth(r, ts) {
    const u = r.pick(USERS);
    const k = r.weighted([[24, 'share'], [20, 'tgs'], [14, 'tgt'], [14, 'logoff'], [12, 'backup'], [6, 'fail'], [6, 'unlock'], [4, 'svc']]);
    switch (k) {
      case 'share':
        return [
          E.winsec(ts, 'FS01', 4624, 'An account was successfully logged on', {
            target_user: dom(u.sam), logon_type: 3, auth_package: 'Kerberos', src_ip: u.ip, logon_id: logonId(r),
          }),
          E.winsec(ts + r.int(20, 300), 'FS01', 5140, 'A network share object was accessed', {
            subject_user: dom(u.sam), src_ip: u.ip, share_name: `\\\\*\\${u.dept === 'Executive' ? 'Finance' : ['Finance', 'Operations', 'HR'].includes(u.dept) ? u.dept : 'Operations'}`, access: 'ReadData (or ListDirectory)',
          }),
        ];
      case 'tgs':
        return [E.winsec(ts, 'DC01', 4769, 'A Kerberos service ticket was requested', {
          target_user: `${u.sam}@${ORG.adDomain.toUpperCase()}`, service: r.pick(['cifs/FS01', 'HTTP/APP01', 'ldap/DC01', 'MSSQLSvc/SQL01:1433']), src_ip: u.ip, ticket_encryption: '0x12', status: '0x0',
        })];
      case 'tgt':
        return [E.winsec(ts, 'DC01', 4768, 'A Kerberos authentication ticket (TGT) was requested', {
          target_user: u.sam, src_ip: u.ip, ticket_encryption: '0x12', status: '0x0',
        })];
      case 'logoff':
        return [E.winsec(ts, r.pick(['FS01', 'APP01', u.host]), 4634, 'An account was logged off', {
          target_user: dom(u.sam), logon_type: 3, logon_id: logonId(r),
        })];
      case 'backup': {
        const tgt = r.chance(0.6) ? r.pick(MANAGED_SERVERS.filter((s) => s.name !== 'BKP01')) : hostNamed(r.pick(USERS).host);
        return [
          E.fw(ts, { src_ip: BKP.ip, src_port: sport(r), dest_ip: tgt.ip, dest_port: 9392, zone: tgt.kind === 'server' ? 'SERVERS->SERVERS' : 'SERVERS->USERS', rule: 'Backup-Agent', bytes: r.int(4000, 900000) }),
          E.winsec(ts + r.int(30, 400), tgt.name, 4624, 'An account was successfully logged on', {
            target_user: dom('svc_backup'), logon_type: 3, auth_package: 'Kerberos', src_ip: BKP.ip, workstation: 'BKP01', logon_id: logonId(r),
          }),
        ];
      }
      case 'fail':
        return [E.winsec(ts, u.host, 4625, 'An account failed to log on', {
          target_user: dom(u.sam), logon_type: r.pick([2, 7]), src_ip: '127.0.0.1', status: '0xC000006D', failure_reason: 'Unknown user name or bad password (0xC000006A)',
        })];
      case 'unlock':
        return [E.winsec(ts, u.host, 4624, 'An account was successfully logged on', {
          target_user: dom(u.sam), logon_type: 7, auth_package: 'Negotiate', src_ip: '127.0.0.1', logon_id: logonId(r),
        })];
      default: {
        const [h, a] = r.pick([['SQL01', 'svc_sql'], ['WEB01', 'svc_web'], ['FS01', 'svc_backup'], ['APP01', 'svc_backup']]);
        return [E.winsec(ts, h, 4624, 'An account was successfully logged on', {
          target_user: dom(a), logon_type: 5, auth_package: 'Negotiate', process: 'C:\\Windows\\System32\\services.exe', logon_id: logonId(r),
        })];
      }
    }
  },

  proc(r, ts) {
    if (r.chance(0.16)) {
      // Monitoring agent on servers runs short encoded PowerShell health checks.
      const s = r.pick(MANAGED_SERVERS);
      const script = r.pick(BENIGN_ENCODED);
      return [E.procCreate(ts, s.name, {
        user: 'NT AUTHORITY\\SYSTEM', image: B.powershell.path,
        command_line: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64ps(script)}`,
        pid: r.int(300, 3000) * 4, parent_image: B.monagent.path, ppid: stablePid(s.name, 'opsmon'),
        sha256: B.powershell.sha256, signature: `Valid (${B.powershell.signer})`,
      })];
    }
    const u = r.pick(USERS);
    const exp = { parent_image: B.explorer.path, ppid: stablePid(u.host, 'explorer') };
    const base = { user: dom(u.sam), pid: r.int(300, 3000) * 4 };
    const sig = (b) => ({ sha256: b.sha256, signature: `Valid (${b.signer})` });
    const doc = r.pick(DOCS[u.dept] || DOCS.Operations);
    const options = [
      [20, () => ({ image: B.chrome.path, command_line: `"${B.chrome.path}" --profile-directory=Default`, ...exp, ...sig(B.chrome) })],
      [12, () => ({ image: B.excel.path, command_line: `"${B.excel.path}" "\\\\FS01\\${['Finance', 'Operations', 'HR'].includes(u.dept) ? u.dept : 'Operations'}\\${doc}"`, ...exp, ...sig(B.excel) })],
      [8, () => ({ image: B.excel.path, command_line: `"${B.excel.path}" "C:\\Users\\${u.sam}\\Downloads\\${doc}"`, parent_image: B.outlook.path, ppid: stablePid(u.host, 'outlook'), ...sig(B.excel) })],
      [10, () => ({ image: B.outlook.path, command_line: `"${B.outlook.path}"`, ...exp, pid: stablePid(u.host, 'outlook'), ...sig(B.outlook) })],
      [9, () => ({ image: B.teams.path, command_line: '"ms-teams.exe" msteams:system-initiated', ...exp, ...sig(B.teams) })],
      [8, () => ({ image: B.acrobat.path, command_line: `"${B.acrobat.path}" "C:\\Users\\${u.sam}\\Downloads\\BCL-${r.int(40000, 49999)}.pdf"`, parent_image: B.outlook.path, ppid: stablePid(u.host, 'outlook'), ...sig(B.acrobat) })],
      [7, () => ({ image: B.winword.path, command_line: `"${B.winword.path}" /n "C:\\Users\\${u.sam}\\Documents\\Notes.docx"`, ...exp, ...sig(B.winword) })],
      [6, () => ({ image: B.tms.path, command_line: `"${B.tms.path}" /server:APP01`, ...exp, ...sig(B.tms) })],
      [5, () => ({ image: B.svchost.path, command_line: 'C:\\Windows\\System32\\svchost.exe -k netsvcs -p -s wuauserv', user: 'NT AUTHORITY\\SYSTEM', parent_image: B.services.path, ppid: stablePid(u.host, 'services'), ...sig(B.svchost) })],
    ];
    if (u.dept === 'IT') {
      options.push([14, () => ({ image: B.powershell.path, command_line: `powershell.exe -ExecutionPolicy Bypass -File \\\\FS01\\IT\\Scripts\\${r.pick(['Get-DiskReport.ps1', 'Sync-AssetInventory.ps1', 'Reset-PrintSpooler.ps1'])}`, ...exp, ...sig(B.powershell) })]);
      options.push([6, () => ({ image: B.cmd.path, command_line: `cmd.exe /c ${r.pick(['ipconfig /all', 'ping -n 2 fs01', 'gpupdate /force'])}`, ...exp, ...sig(B.cmd) })]);
    }
    if (u.dept === 'Engineering') {
      options.push([14, () => ({ image: B.git.path, command_line: `git.exe ${r.pick(['fetch --all', 'pull --rebase', 'status'])}`, parent_image: B.code.path, ppid: stablePid(u.host, 'code'), ...sig(B.git) })]);
      options.push([8, () => ({ image: B.powershell.path, command_line: 'powershell.exe -NoLogo -NoExit -Command "Set-Location C:\\src\\tms-integrations"', parent_image: B.code.path, ppid: stablePid(u.host, 'code'), ...sig(B.powershell) })]);
    }
    return [E.procCreate(ts, u.host, { ...base, ...r.weighted(options)() })];
  },

  fw(r, ts) {
    const u = r.pick(USERS);
    const k = r.weighted([[30, 'dc'], [22, 'fs'], [14, 'app'], [10, 'sql'], [12, 'inbound'], [12, 'scan']]);
    const ext = () => `${r.pick(['192.0.2', '198.51.100', '203.0.113'])}.${r.int(2, 250)}`;
    switch (k) {
      case 'dc': {
        const p = r.pick([53, 88, 389, 445, 135, 636]);
        return [E.fw(ts, { src_ip: u.ip, src_port: sport(r), dest_ip: r.chance(0.7) ? DC.ip : '10.10.0.11', dest_port: p, proto: p === 53 ? 'udp' : 'tcp', zone: 'USERS->SERVERS', rule: 'Users-to-DomainServices', bytes: r.int(180, 6000) })];
      }
      case 'fs':
        return [E.fw(ts, { src_ip: u.ip, src_port: sport(r), dest_ip: FS.ip, dest_port: 445, zone: 'USERS->SERVERS', rule: 'Users-to-FileServices', bytes: r.int(2000, 4_000_000) })];
      case 'app':
        return [E.fw(ts, { src_ip: u.ip, src_port: sport(r), dest_ip: APP.ip, dest_port: 8443, zone: 'USERS->SERVERS', rule: 'Users-to-TMS', bytes: r.int(1500, 250000) })];
      case 'sql':
        return [E.fw(ts, { src_ip: APP.ip, src_port: sport(r), dest_ip: SQL.ip, dest_port: 1433, zone: 'SERVERS->SERVERS', rule: 'TMS-App-to-DB', bytes: r.int(900, 400000) })];
      case 'inbound':
        return [E.fw(ts, { src_ip: ext(), src_port: sport(r), dest_ip: WEBSRV.ip, dest_port: 443, zone: 'INTERNET->DMZ', rule: 'Public-Portal-HTTPS', bytes: r.int(900, 90000) })];
      default:
        return [E.fw(ts, { action: 'deny', src_ip: ext(), src_port: sport(r), dest_ip: r.pick([WEBSRV.ip, '172.16.5.20']), dest_port: r.pick([22, 23, 3389, 445, 8080, 5900, 1433]), zone: 'INTERNET->DMZ', rule: 'Default-Deny-Inbound', bytes: 0 })];
    }
  },

  mail(r, ts) {
    const u = r.pick(USERS);
    const k = r.weighted([[52, 'partner'], [22, 'outbound'], [14, 'internal'], [12, 'spam']]);
    const id = () => `<${r.hex(12)}.${r.hex(8)}@`;
    if (k === 'partner') {
      const [from, name, ip, subjects] = r.pick(MAIL_PARTNERS);
      const s = r.pick(subjects);
      const att = from.startsWith('invoices@') || from.startsWith('billing@');
      const fname = att ? `${from.startsWith('invoices') ? 'BCL' : 'Statement'}-${r.int(40000, 49999)}.pdf` : undefined;
      const fin = USERS.filter((x) => x.dept === 'Finance' || x.dept === 'Operations');
      const to = att ? r.pick(fin) : u;
      return [E.email(ts, {
        msg_id: `${id()}${from.split('@')[1]}>`, from, from_name: name, to: to.email,
        subject: /[- ]$/.test(s) ? `${s}${r.int(40000, 49999)}` : s, src_ip: ip, spf: 'pass', dkim: 'pass', dmarc: 'pass',
        attachment: fname, attachment_sha256: fname ? fakeSha256(`${fname}|${ts}`) : undefined,
        size: r.int(9000, 480000), verdict: 'clean', action: 'DELIVERED',
      })];
    }
    if (k === 'outbound') {
      const [from] = r.pick(MAIL_PARTNERS);
      return [E.email(ts, {
        direction: 'outbound', msg_id: `${id()}${ORG.mailDomain}>`, from: u.email, from_name: u.name,
        to: `${r.pick(['ops', 'accounts', 'support', 'bookings'])}@${from.split('@')[1]}`,
        subject: r.pick(['RE: Updated ETA', 'Booking request - week 42', 'RE: Statement query', 'POD attached', 'RE: Rate confirmation']),
        src_ip: '10.10.0.25', spf: 'pass', dkim: 'pass', dmarc: 'pass', size: r.int(4000, 220000), verdict: 'clean', action: 'DELIVERED',
      })];
    }
    if (k === 'internal') {
      const v = r.pick(USERS);
      return [E.email(ts, {
        direction: 'internal', msg_id: `${id()}${ORG.mailDomain}>`, from: v.email, from_name: v.name, to: u.email,
        subject: r.pick(['RE: Month-end close timeline', 'Lunch?', 'FW: Carrier scorecard', 'Standup notes', 'RE: PO approval', 'Leave request']),
        src_ip: '10.10.0.25', spf: 'pass', dkim: 'pass', dmarc: 'pass', size: r.int(3000, 90000), verdict: 'clean', action: 'DELIVERED',
      })];
    }
    const sd = r.pick(['deals-outlet.example', 'crypto-yield-club.example', 'seo-rank-boost.example', 'parcel-redelivery-notice.example']);
    return [E.email(ts, {
      msg_id: `${id()}${sd}>`, from: `${r.pick(['promo', 'info', 'noreply'])}@${sd}`, from_name: r.pick(['Special Offers', 'Account Team', 'Delivery Service']),
      to: u.email, subject: r.pick(['Your parcel could not be delivered', 'Limited offer - 70% off', 'Boost your website ranking today', 'Action required: verify your wallet']),
      src_ip: `${r.pick(['192.0.2', '198.51.100', '203.0.113'])}.${r.int(2, 250)}`,
      spf: r.pick(['fail', 'softfail', 'none']), dkim: 'none', dmarc: 'fail', size: r.int(2000, 40000),
      verdict: r.pick(['spam', 'phishing-suspect']), action: 'QUARANTINED',
    })];
  },
};

const KINDS = [[34, 'web'], [20, 'dns'], [16, 'auth'], [12, 'proc'], [13, 'fw'], [5, 'mail']];

// ---------------------------------------------------------------------------
// v2 sources. Generated only for scenarios that list the source, from a
// separate random stream, so the noise of existing scenarios is unchanged.
// ---------------------------------------------------------------------------
export const OFFICE_EGRESS = '203.0.113.10';
const HOME_NETS = ['198.51.100', '203.0.113', '192.0.2'];
const homeIp = (u) => `${HOME_NETS[u.sam.length % 3]}.${20 + (u.sam.charCodeAt(0) % 200)}`;
const uaBrowser = UA.edge;
const EXTRA = {
  vpn(r, ts) {
    const u = r.pick(USERS);
    const k = r.weighted([[50, 'connect'], [35, 'disconnect'], [10, 'mfa_push'], [5, 'auth_fail']]);
    const base = { user: u.sam, src_ip: homeIp(u), src_country: 'GB', client: 'SecureLink 6.2.1', device_id: `dev-${u.sam.replace('.', '')}` };
    if (k === 'connect') return [E.vpn(ts, { ...base, event: 'connect', assigned_ip: `${VPN_POOL}.${r.int(10, 240)}`, pop: 'LON' })];
    if (k === 'disconnect') return [E.vpn(ts, { ...base, event: 'disconnect', duration_s: r.int(300, 30000), bytes_in: r.int(1e6, 4e8), bytes_out: r.int(2e5, 4e7) })];
    if (k === 'mfa_push') return [E.vpn(ts, { ...base, event: 'mfa_push', reason: 'approved' })];
    return [E.vpn(ts, { ...base, event: 'auth_fail', reason: 'bad password' })];
  },
  idp(r, ts) {
    const u = r.pick(USERS);
    if (r.chance(0.05)) return [E.idpAudit(ts, { operation: 'Update user', actor: 'e.morales', target: u.sam, target_type: 'User', result: 'success' })];
    const fail = r.chance(0.06);
    return [E.signin(ts, {
      user: `${u.sam}@${ORG.mailDomain}`, app: r.pick(TENANT.apps.slice(0, 3)), result: fail ? 'failure' : 'success', error_code: fail ? 50126 : undefined,
      src_ip: OFFICE_EGRESS, country: 'GB', city: 'London', user_agent: uaBrowser, device_id: `dev-${u.sam.replace('.', '')}`,
      mfa: fail ? 'none' : r.pick(['previously satisfied', 'push']), session_id: r.hex(12),
    })];
  },
  winsys(r, ts) {
    const h = r.pick(SERVERS.filter((x) => x.os.startsWith('Windows')));
    const svc = r.pick(['wuauserv', 'BITS', 'WinRM', 'Spooler', 'TrustedInstaller']);
    return [E.winsys(ts, h.name, 7036, `The ${svc} service entered the ${r.chance(0.5) ? 'running' : 'stopped'} state`, { service_name: svc })];
  },
  fileaudit(r, ts) {
    const u = r.pick(USERS);
    const share = ['Finance', 'Operations', 'HR'].includes(u.dept) ? u.dept : 'Projects';
    const doc = r.pick(['Report.xlsx', 'Plan.docx', 'Notes.docx', 'Rates.xlsx', 'Minutes.pdf']);
    return [E.fileaudit(ts, { user: dom(u.sam), share: `\\FS01\${share}`, path: `D:\Shares\${share}\${u.dept}_${doc}`, access: r.chance(0.8) ? 'ReadData' : 'WriteData', process: B.excel.path, src_ip: u.ip })];
  },
  web(r, ts) {
    const ip = `${r.pick(['192.0.2', '198.51.100', '203.0.113'])}.${r.int(2, 250)}`;
    if (r.chance(0.06)) return [E.waf(ts, { src_ip: ip, rule_id: r.pick(['920350', '913100']), rule_msg: r.pick(['Host header is a numeric IP address', 'Found User-Agent associated with security scanner']), action: 'log', uri: '/', score: r.int(2, 4) })];
    const uri = r.pick(['/', '/login', '/track', '/bookings', '/static/app.js', '/api/v1/shipments']);
    return [E.web(ts, { src_ip: ip, method: uri.startsWith('/api') ? r.pick(['GET', 'POST']) : 'GET', uri, query: uri === '/track' ? `id=${r.int(100000, 999999)}` : undefined, status: r.weighted([[92, 200], [4, 304], [3, 404], [1, 500]]), bytes: uri === '/track' ? r.int(4100, 4400) : r.int(500, 90000), ua: uaBrowser, time_ms: r.int(20, 300) })];
  },
  m365(r, ts) {
    const u = r.pick(USERS);
    if (r.chance(0.2)) return [E.m365(ts, { operation: 'UserLoggedIn', user: `${u.sam}@${ORG.mailDomain}`, client_ip: OFFICE_EGRESS, client_info: 'Outlook/16.0' })];
    return [E.m365(ts, { operation: 'MailItemsAccessed', user: `${u.sam}@${ORG.mailDomain}`, client_ip: OFFICE_EGRESS, client_info: 'Outlook/16.0', client_app_id: 'd3590ed6-52b3-4102-aeff-aad2292ab01c', item_count: r.int(1, 12), folder: 'Inbox' })];
  },
  aws(r, ts) {
    const k = r.weighted([[50, 'ci'], [40, 'admin'], [10, 'gd']]);
    if (k === 'ci') return [E.cloudtrail(ts, { event_name: 'PutObject', event_source: 's3.amazonaws.com', user_arn: `arn:aws:iam::${AWS.account}:user/ci-deploy`, access_key: 'AKIA4QX7CIDEPLOY7Q2M', src_ip: AWS.ciRunner, ua: 'aws-cli/2.17.3', resource: `${AWS.buckets[2]}/assets/app.${r.hex(8)}.js` })];
    if (k === 'admin') return [E.cloudtrail(ts, { event_name: r.pick(['DescribeInstances', 'ListBuckets', 'GetMetricData']), event_source: r.pick(['ec2.amazonaws.com', 's3.amazonaws.com', 'monitoring.amazonaws.com']), user_type: 'AssumedRole', user_arn: `arn:aws:sts::${AWS.account}:assumed-role/ec2-app-role/i-0${r.hex(16)}`, src_ip: '10.60.1.15', ua: 'aws-sdk-java/2.25' })];
    return [E.guardduty(ts, { finding_type: 'Recon:EC2/PortProbeUnprotectedPort', severity: 2, resource: `i-0${r.hex(16)}`, src_ip: `${r.pick(['192.0.2', '198.51.100'])}.${r.int(2, 250)}`, count: r.int(1, 20) })];
  },
};
const EXTRA_RATE = { vpn: 0.12, idp: 0.18, winsys: 0.06, fileaudit: 0.15, web: 0.25, m365: 0.15, aws: 0.18 };

export function noiseSlot(seed, slot, t0, opts = {}) {
  const r = rng(seed, 'noise', slot);
  const n = r.weighted([[24, 0], [36, 1], [24, 2], [11, 3], [5, 4]]);
  const out = [];
  for (let i = 0; i < n; i++) {
    const ts = t0 + slot * 1000 + r.int(0, 550);
    out.push(...GEN[r.weighted(KINDS)](r, ts));
  }
  const sources = opts.sources || [];
  const extra = Object.keys(EXTRA).filter((k) => sources.includes(k));
  if (extra.length || opts.heavy) {
    const r2 = rng(seed, 'noise2', slot);
    for (const k of extra) if (r2.chance(EXTRA_RATE[k])) out.push(...EXTRA[k](r2, t0 + slot * 1000 + r2.int(0, 900)));
    // Expert: a busier day.
    if (opts.heavy) { const m = r2.weighted([[50, 0], [35, 1], [15, 2]]); for (let i = 0; i < m; i++) out.push(...GEN[r2.weighted(KINDS)](r2, t0 + slot * 1000 + r2.int(0, 900))); }
  }
  return out;
}

export { b64ps };
