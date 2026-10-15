// Guided-demo scenario (Newbie Demo Mode and the homepage walkthrough
// preview only; never listed with the assessment scenarios).
//
// Ground truth: an external address guesses the password of one staff
// account on the customer portal (WEB01). Fourteen failures, then a
// success, then the attacker keeps an authenticated session and pulls
// data from the portal. The same account's normal sign-ins come from the
// user's own workstation, and include one ordinary mistyped password, so
// the learner has real benign activity to compare against.
//
// Every stage allows retries and returns coaching, because this scenario
// exists to teach. Its answers are still held here, on the server.

import { E } from '../engine/format.js';
import { account, hostNamed, dom } from '../engine/env.js';
import { deriveState } from '../engine/response.js';
import { utc } from '../engine/common.js';

const ATK = '203.0.113.253';
const ATK_NAME = 'DESKTOP-Q7M4K2';
const USER = account('r.delgado');
const WS = hostNamed(USER.host);
const WEB = hostNamed('WEB01');
const U = dom(USER.sam);
const FAILS = 14;
const AT = { typo: -1510, firstFail: -545, gap: 12.5, ok: -370, data: [-352, -338, -321], session: -300, legit: -1740 };

const sport = (r) => r.int(49152, 65535);

function build({ t0 }) {
  const T = (off) => t0 + Math.round(off * 1000);
  const events = [];
  const add = (tags, e) => { e._tags = tags; events.push(e); };
  const portalHit = (off, port, bytes) => E.fw(T(off), { src_ip: ATK, src_port: port, dest_ip: WEB.ip, dest_port: 443, zone: 'INTERNET->DMZ', rule: 'Public-Portal-HTTPS', bytes });

  // The real user mistypes her password once, then signs in. Ordinary.
  add(['legit_typo'], E.winsec(T(AT.typo), WEB.name, 4625, 'An account failed to log on', {
    target_user: U, logon_type: 3, auth_package: 'Kerberos', src_ip: WS.ip, workstation: WS.name,
    status: '0xC000006D', failure_reason: 'Unknown user name or bad password (0xC000006A)',
  }));
  add(['legit'], E.winsec(T(AT.typo + 14), WEB.name, 4624, 'An account was successfully logged on', {
    target_user: U, logon_type: 3, auth_package: 'Kerberos', src_ip: WS.ip, workstation: WS.name, logon_id: '0x2A91C40',
  }));

  // Password guessing from the external address.
  for (let i = 0; i < FAILS; i++) {
    const off = AT.firstFail + i * AT.gap;
    add(['atk_net'], portalHit(off - 0.3, 50110 + i * 7, 1620 + i * 11));
    add(['atk_fail'], E.winsec(T(off), WEB.name, 4625, 'An account failed to log on', {
      target_user: U, logon_type: 3, auth_package: 'NTLM', src_ip: ATK, workstation: ATK_NAME,
      status: '0xC000006D', failure_reason: 'Unknown user name or bad password (0xC000006A)',
    }));
  }
  add(['atk_net'], portalHit(AT.ok - 0.3, 50231, 2210));
  add(['atk_ok'], E.winsec(T(AT.ok), WEB.name, 4624, 'An account was successfully logged on', {
    target_user: U, logon_type: 3, auth_package: 'NTLM', src_ip: ATK, workstation: ATK_NAME, logon_id: '0x5D03E71',
  }));
  [6412880, 8904112, 7350664].forEach((bytes, i) => add(['atk_data'], portalHit(AT.data[i], 50240 + i * 9, bytes)));

  const periodic = [
    {
      // The attacker keeps coming back. What gets logged depends on the response so far.
      key: 'demo-atk', start: AT.session, period: 35, jitter: 6,
      make({ ts, state, r }) {
        const port = sport(r);
        if (state.ipBlocked(ATK)) {
          const e = E.fw(ts, { action: 'deny', src_ip: ATK, src_port: port, dest_ip: WEB.ip, dest_port: 443, zone: 'INTERNET->DMZ', rule: 'SOC-Blocklist-IP', bytes: 0 });
          e._tags = ['atk_denied'];
          return [e];
        }
        const net = E.fw(ts - 300, { src_ip: ATK, src_port: port, dest_ip: WEB.ip, dest_port: 443, zone: 'INTERNET->DMZ', rule: 'Public-Portal-HTTPS', bytes: r.int(40000, 300000) });
        net._tags = ['atk_net'];
        if (state.reset.has(USER.sam) || state.disabled.has(USER.sam)) {
          const f = E.winsec(ts, WEB.name, 4625, 'An account failed to log on', {
            target_user: U, logon_type: 3, auth_package: 'NTLM', src_ip: ATK, workstation: ATK_NAME,
            status: state.disabled.has(USER.sam) ? '0xC000006E' : '0xC000006D',
            failure_reason: state.disabled.has(USER.sam) ? 'Account currently disabled (0xC0000072)' : 'Unknown user name or bad password (0xC000006A)',
          });
          f._tags = ['atk_fail_after'];
          return [net, f];
        }
        const ok = E.winsec(ts, WEB.name, 4624, 'An account was successfully logged on', {
          target_user: U, logon_type: 3, auth_package: 'NTLM', src_ip: ATK, workstation: ATK_NAME, logon_id: `0x${r.hex(7).toUpperCase()}`,
        });
        ok._tags = ['atk_session'];
        return [net, ok];
      },
    },
    {
      // The real user working in the portal from her own workstation.
      key: 'demo-legit', start: AT.legit, period: 50, jitter: 8,
      make({ ts, state, r }) {
        const net = E.fw(ts - 250, { src_ip: WS.ip, src_port: sport(r), dest_ip: WEB.ip, dest_port: 443, zone: 'USERS->DMZ', rule: 'Staff-to-Portal', bytes: r.int(6000, 90000) });
        net._tags = ['legit_net'];
        if (state.disabled.has(USER.sam)) {
          const f = E.winsec(ts, WEB.name, 4625, 'An account failed to log on', {
            target_user: U, logon_type: 3, auth_package: 'Kerberos', src_ip: WS.ip, workstation: WS.name,
            status: '0xC000006E', failure_reason: 'Account currently disabled (0xC0000072)',
          });
          f._tags = ['legit_broken'];
          return [net, f];
        }
        const ok = E.winsec(ts, WEB.name, 4624, 'An account was successfully logged on', {
          target_user: U, logon_type: 3, auth_package: 'Kerberos', src_ip: WS.ip, workstation: WS.name, logon_id: `0x${r.hex(7).toUpperCase()}`,
        });
        ok._tags = [state.reset.has(USER.sam) ? 'legit_after' : 'legit'];
        return [net, ok];
      },
    },
  ];
  return { events, periodic };
}

function alert(stream, c) {
  const until = c.t0 + 5000;
  const fails = stream.events.filter((e) => (e._tags || []).includes('atk_fail') && e.ts <= until);
  const ok = stream.events.find((e) => (e._tags || []).includes('atk_ok'));
  return {
    id: 'A1', rule: 'AUTH-0017', severity: 'medium',
    title: 'Repeated failed logons for one account followed by a successful logon',
    description: `${fails.length} failed network logons for one account on ${WEB.name} from ${ATK} in under four minutes, followed by a successful logon from the same address.`,
    entity: { host: WEB.name, ip: WEB.ip, user: U },
    details: [
      ['Source address', ATK], ['Target account', U], ['Failed logons', String(fails.length)],
      ['First failure', utc(fails[0].ts)], ['Last failure', utc(fails[fails.length - 1].ts)], ['Successful logon', utc(ok.ts)],
      ['Rule logic', '10 or more failed logons (4625) for one account from one source within 10 minutes, followed by a successful logon (4624) from the same source'],
    ],
    guidance: [
      'Identify the source address and whether it belongs to the organisation.',
      'Compare it with where this account normally signs in from.',
      'Check whether approved work explains the activity.',
      'Decide whether the successful logon is the real user or someone else.',
    ],
    matched: [...fails, ok].sort((a, b) => b.ts - a.ts).map((e) => e.id),
    matchedTotal: fails.length + 1,
  };
}

const opt = (value, label) => ({ value, label });
const RETRY = { attempts: 99, noFinalize: true };

const stages = [
  { id: 'monitoring', label: 'Monitor', tier: 'L1', kind: 'monitor' },

  {
    id: 'l1_triage', label: 'L1 triage', tier: 'L1', kind: 'form', weight: 20, ...RETRY, submitLabel: 'Submit triage decision',
    intro: 'Classify the alert. Pin the log events your decision rests on, then record a verdict. In this guided demo you can correct an answer and submit again.',
    fields: [
      {
        id: 'source', type: 'text', label: 'Source address of the logon attempts', points: 3, placeholder: 'IPv4 address', summary: 'Source',
        key: {
          accept: [ATK], norm: 'ip',
          coach: (v) => (String(v).trim() === WS.ip ? `${WS.ip} is the user's own workstation. That address has one failure, not fourteen. Look at src_ip on the burst of failures.` : String(v).trim() === WEB.ip ? `${WEB.ip} is WEB01, the server that was signed in to. The source is the address the attempts came from: src_ip.` : 'Open one of the failed logons in the alert and read the src_ip field.'),
          reveal: `The attempts came from ${ATK}.`,
          explain: `Every failure in the burst, and the success that follows, carries src_ip ${ATK}.`,
        },
      },
      {
        id: 'account', type: 'account', label: 'Account that was targeted', points: 3, summary: 'Account',
        key: { accept: USER.sam, hint: 'Read target_user on the failed logons.', reveal: `The targeted account is ${USER.sam}.`, explain: 'All fourteen failures and the success name the same account in target_user.' },
      },
      {
        id: 'verdict', type: 'single', label: 'Verdict', points: 6, summary: 'Verdict',
        options: [
          opt('fp', 'False positive: the rule matched activity it should not have'),
          opt('btp', 'Benign true positive: real activity, but authorised or expected'),
          opt('tp', 'True positive: malicious or unauthorised activity'),
          opt('unknown', 'Inconclusive: not enough data to decide'),
        ],
        key: {
          accept: 'tp',
          coach: {
            fp: 'A false positive means the rule fired on something it should not match. Here the rule matched exactly what it describes: many failures, then a success, one account, one source.',
            btp: 'Benign would need proof that the activity is allowed: a company address, an approved change, or the real user. Check the source address in threat intelligence and the change calendar before choosing this.',
            unknown: 'You have enough to decide. Compare the source address with where this account normally signs in from (Directory), and look the address up in threat intelligence.',
          },
          reveal: 'This is a true positive: an outside address guessed the password and got in.',
          explain: 'Fourteen wrong passwords for one account from an address that is not the user\'s, not the company\'s and is reported for password guessing, followed by a success from that same address.',
        },
      },
      {
        id: 'severity', type: 'single', label: 'Severity', points: 3, sets: 'severity', summary: 'Severity',
        options: [opt('low', 'Low'), opt('medium', 'Medium'), opt('high', 'High'), opt('critical', 'Critical')],
        key: {
          accept: { high: 1, critical: 0.6 },
          coach: {
            low: 'Low is for activity with no real risk. Here someone outside the company is signed in as a member of staff.',
            medium: 'Medium is the rule\'s default, set before anyone looked. An attacker with a working password is more serious than that.',
            critical: 'Critical is close. It is normally kept for several systems, privileged accounts or confirmed data loss. So far one ordinary account is involved.',
          },
          reveal: 'High fits: one account is compromised and in active use.',
          explain: 'One staff account is in an attacker\'s hands and being used. That is High. It is not Critical because no privileged account or internal system is involved.',
        },
      },
      {
        id: 'evidence', type: 'pins', label: 'Key evidence', min: 2, points: 5,
        help: 'Choose at least two pinned events: they should show the failed attempts and the successful logon.',
        key: {
          groups: { failures: ['atk_fail'], success: ['atk_ok', 'atk_session'] }, minGroups: 2, minPrecision: 0.6,
          coach: () => `Your evidence should include one failed logon (event 4625) and the successful logon (event 4624) from ${ATK}. Pin them from the Alert tab, then tick them here.`,
          describe: 'One of the failed logons and the successful logon from the external address.',
          explain: 'A verdict of password guessing needs both halves: the failures show the guessing, the success shows it worked.',
        },
      },
      {
        id: 'decision', type: 'single', label: 'Disposition', points: 6, summary: 'Disposition',
        options: [
          opt('close_fp', 'Close as false positive'),
          opt('close_benign', 'Close as benign / authorised'),
          opt('monitor', 'Keep at Tier 1 and continue monitoring'),
          opt('escalate', 'Escalate to Tier 2'),
        ],
        key: {
          accept: 'escalate',
          coach: {
            close_fp: 'Closing would leave an attacker signed in. A confirmed compromise is never closed at Tier 1.',
            close_benign: 'Nothing shows this is authorised. Closing would leave an attacker signed in.',
            monitor: 'Watching does not stop the attacker, and Tier 1 has no authority to contain. The ticket needs to move up.',
          },
          reveal: 'Escalate to Tier 2.',
          explain: 'Tier 1 has confirmed the alert is real. Working out the full scope and containing it belong to Tier 2 and Tier 3.',
        },
      },
      { id: 'note', type: 'longtext', label: 'Triage note', min: 40, points: 2, help: 'What you saw, where, and why you reached this verdict.', key: { explain: 'Recorded in the case file for the next tier.' } },
    ],
  },

  {
    id: 'l2_escalation', label: 'L2 escalation', tier: 'L1', kind: 'form', weight: 10, ...RETRY, submitLabel: 'Hand off to Tier 2',
    intro: 'Prepare the handoff. Tier 2 should be able to start from this package without repeating your triage.',
    fields: [
      {
        id: 'host', type: 'host', label: 'System that was signed in to', points: 3, summary: 'System',
        key: { accept: WEB.name, hint: 'The host column of the logon events names the server that recorded them.', reveal: `The logons were recorded on ${WEB.name}.`, explain: 'The logon events were recorded by WEB01, the customer portal server.' },
      },
      {
        id: 'iocs', type: 'ioc_list', label: 'Indicators handed over', points: 4,
        help: 'Add the attacker indicators you can support with evidence. They are saved to the case.',
        key: { must: [ATK], wantExtra: 0, valid: [ATK, ATK_NAME.toLowerCase()], coach: () => `An indicator identifies the attacker. Here that is the source address ${ATK}. Company addresses and account names are not attacker indicators.`, explain: 'The source address is the one value that identifies this attacker in the logs.' },
      },
      {
        id: 'priority', type: 'single', label: 'Escalation priority', points: 3, summary: 'Priority',
        options: [opt('p1', 'P1: respond immediately'), opt('p2', 'P2: respond within 30 minutes'), opt('p3', 'P3: respond within 4 hours'), opt('p4', 'P4: next business day')],
        key: { accept: { p1: 1, p2: 1 }, coach: { p3: 'Four hours is a long time for an attacker to stay signed in.', p4: 'Tomorrow is far too late: the attacker is signed in now.' }, reveal: 'P2 (or P1) fits an attacker with live access.', explain: 'The attacker has working access right now, so the response has to start within minutes.' },
      },
      { id: 'summary', type: 'longtext', label: 'Escalation summary', min: 60, points: 2, help: 'What happened, where, when, and why it needs Tier 2.', key: { explain: 'Recorded in the case file for Tier 2.' } },
    ],
  },

  {
    id: 'l2_investigation', label: 'Investigation', tier: 'L2', kind: 'form', weight: 25, ...RETRY, submitLabel: 'Submit findings for review',
    intro: 'Work out what the evidence supports. Each finding needs a linked pinned event that shows it. Findings that are accepted lock; correct the others and submit again.',
    fields: [
      {
        id: 'pattern', type: 'single', label: 'What the failed logons show', points: 4, linkable: true,
        options: [
          opt('spray', 'Many different accounts tried a few times each'),
          opt('typo', 'The real user mistyping her own password'),
          opt('guess', 'Many passwords tried against one account from one address'),
          opt('service', 'A service or scheduled job with an out-of-date password'),
        ],
        key: {
          accept: 'guess', support: ['atk_fail'],
          coach: {
            spray: 'Count the account names in target_user across the failures. There is only one.',
            typo: `A typo is one or two failures from the user's own workstation. These are fourteen, 12 seconds apart, from ${ATK}.`,
            service: 'A service account retries from a company server, on a schedule, for hours. This is a person\'s account, from outside, for under four minutes.',
          },
          reveal: 'Many passwords were tried against one account from one address.',
          explain: 'One account, one outside address, fourteen failures at a steady 12-second pace: a tool trying passwords.',
        },
      },
      {
        id: 'count', type: 'text', label: 'Failed logons from the source before the success', points: 3, linkable: true, placeholder: 'number',
        key: { accept: [String(FAILS)], support: ['atk_fail'], hint: `Search for event 4625 with src_ip ${ATK} and read the event count above the results.`, reveal: `There are ${FAILS}.`, explain: 'The search for event 4625 from that address returns fourteen events before the 4624.' },
      },
      {
        id: 'baseline', type: 'host', label: 'Where this account normally signs in from', points: 4, linkable: true,
        key: { accept: WS.name, support: ['legit', 'legit_typo', 'legit_after'], hint: 'Look the account up in Directory, then find its successful logons that are not from the outside address.', reveal: `It normally signs in from ${WS.name}.`, explain: 'The directory lists WS-SAL-007 as her workstation, and her earlier successful logons all come from its address with Kerberos.' },
      },
      {
        id: 'after', type: 'single', label: 'What happened after the successful logon', points: 4, linkable: true,
        options: [
          opt('nothing', 'Nothing further from that address'),
          opt('lateral', 'Logons from WEB01 to internal servers'),
          opt('session', 'The address stayed signed in and pulled several megabytes from the portal'),
          opt('malware', 'A new program was installed on WEB01'),
        ],
        key: {
          accept: 'session', support: ['atk_data', 'atk_session'],
          coach: {
            nothing: `Search for src_ip:${ATK} after the success. The address keeps coming back, and three firewall lines show transfers of 6 to 9 MB.`,
            lateral: 'No logon event shows this account, or WEB01, signing in to an internal server. State only what the logs show.',
            malware: 'No endpoint event shows a new program on WEB01. State only what the logs show.',
          },
          reveal: 'The address stayed signed in and pulled several megabytes from the portal.',
          explain: 'Right after the success the firewall records three transfers of 6 to 9 MB to that address, and it keeps signing in every half minute.',
        },
      },
      {
        id: 'benign', type: 'single', label: 'Is there an approved explanation', points: 4,
        options: [
          opt('pentest', 'Yes: an approved penetration test'),
          opt('scanner', 'Yes: the company vulnerability scanner'),
          opt('travel', 'Yes: the user working remotely'),
          opt('none', 'No: not a company address, no change record, no remote-access entitlement'),
        ],
        key: {
          accept: 'none',
          coach: {
            pentest: 'An approved test has a change record. Open the change calendar: nothing covers WEB01 today.',
            scanner: 'The scanner is SCAN01 at 10.10.0.60, an internal address. This source is external.',
            travel: 'The directory says this user has no remote-access entitlement, and a real user does not need fourteen attempts 12 seconds apart.',
          },
          reveal: 'No approved explanation exists.',
          explain: 'A benign explanation has to be found, not assumed. The address is not an asset, threat intelligence reports it for password guessing, and the change calendar has nothing for WEB01.',
        },
      },
    ],
  },

  {
    id: 'l2_validation', label: 'Validation', tier: 'L2', kind: 'form', weight: 15, ...RETRY, submitLabel: 'Sign off validation',
    intro: 'Confirm what is proven and what is not, then hand to incident response.',
    fields: [
      {
        id: 'checks', type: 'checks', label: 'Corroboration performed', points: 3, help: 'Updated from the tools you have run on this case.',
        key: {
          checks: [
            { id: 'ti', label: 'Source address checked in threat intelligence', test: (c) => c.toolRuns.some((t) => t.tool === 'reputation' && t.input === ATK) },
            { id: 'dir', label: 'Targeted account looked up in the directory', test: (c) => c.toolRuns.some((t) => t.tool === 'user' && t.input.replace(/^meridian\\/, '') === USER.sam) },
            { id: 'chg', label: 'Change calendar consulted', test: (c) => c.toolRuns.some((t) => t.tool === 'change') },
          ],
          explain: 'A conclusion is validated when independent sources agree: the logs, outside intelligence, the directory and the change record.',
        },
      },
      {
        id: 'scope', type: 'single', label: 'What is confirmed', points: 4, summary: 'Scope',
        options: [
          opt('server', 'WEB01 is fully compromised and must be rebuilt'),
          opt('account', 'One user account is compromised; no evidence that WEB01 itself or any other system is'),
          opt('domain', 'The whole domain is compromised'),
          opt('nothing', 'Nothing is confirmed yet'),
        ],
        key: {
          accept: 'account',
          coach: {
            server: 'Signing in to a website with a stolen password does not give control of the server. No log shows a program installed or an administrator logon on WEB01.',
            domain: 'One ordinary user account was used on one web portal. Nothing shows a domain controller or an administrator account involved.',
            nothing: 'The successful logon from the attacker\'s address is recorded. That confirms the account is compromised.',
          },
          reveal: 'One user account is compromised; nothing shows the server or other systems are.',
          explain: 'Separate confirmed facts from assumptions. Confirmed: the password is known to the attacker and was used. Not shown: any change to WEB01 or access to internal systems.',
        },
      },
      {
        id: 'sequence', type: 'order', label: 'Order of events', points: 3,
        items: [
          { id: 'ok', label: 'Successful logon from the outside address' },
          { id: 'legit', label: 'Normal sign-in by the real user from her workstation' },
          { id: 'data', label: 'Large transfers from the portal to the outside address' },
          { id: 'fail', label: 'Repeated failed logons from the outside address' },
        ],
        key: { order: ['legit', 'fail', 'ok', 'data'], coach: () => 'Compare the timestamps of your pinned events in the Evidence tab; they are listed oldest first.', explain: 'From the timestamps: the user was working normally, then the failures, the success six seconds after the last failure, then the transfers.' },
      },
      {
        id: 'severity', type: 'single', label: 'Validated severity', points: 2, sets: 'severity', summary: 'Severity',
        options: [opt('low', 'Low'), opt('medium', 'Medium'), opt('high', 'High'), opt('critical', 'Critical')],
        key: { accept: { high: 1 }, coach: { critical: 'The scope you confirmed is one ordinary account. Critical would need a privileged account, several systems or confirmed sensitive data loss.', medium: 'The attacker is signed in and has taken data from the portal. That is above Medium.', low: 'The attacker is signed in and has taken data from the portal. That is well above Low.' }, reveal: 'High.', explain: 'The investigation confirmed the Tier 1 rating: one account, active misuse, no spread.' },
      },
      {
        id: 'declare', type: 'single', label: 'Decision', points: 3, summary: 'Decision',
        options: [
          opt('close', 'Close as false positive'),
          opt('return', 'Return to Tier 1; evidence insufficient'),
          opt('incident', 'Declare a security incident and engage incident response (L3)'),
        ],
        key: { accept: 'incident', coach: { close: 'The evidence confirms a compromised account. It cannot be closed while the attacker has access.', return: 'The evidence is sufficient: source, account, success and follow-on activity are all pinned.' }, reveal: 'Declare a security incident.', explain: 'A compromised account in active use needs containment, which is incident response\'s job.' },
      },
      { id: 'summary', type: 'longtext', label: 'Investigation summary', min: 100, points: 2, help: 'Cover: what happened, why it is malicious, the evidence, the likely cause, the impact, and what still needs checking.', key: { explain: 'Recorded in the case file as the handover to incident response.' } },
    ],
  },

  {
    id: 'l3_response', label: 'L3 response', tier: 'L3', kind: 'response', weight: 15,
    intro: 'Contain the incident. Every action here is simulated: nothing outside this exercise is changed. Declare the response complete once the attacker is locked out.',
  },

  {
    id: 'l3_verify', label: 'Response check', tier: 'L3', kind: 'form', weight: 10, attempts: 3, submitLabel: 'Record validation',
    intro: 'Running an action is not the same as proving it worked. Show from the logs that the attacker is locked out and that the real user can still work.',
    fields: [
      {
        id: 'state', type: 'checks', label: 'Recorded response state', points: 3, help: 'Read from the action log.',
        key: {
          checks: [
            { id: 'blocked', label: 'Attacker address is on the firewall blocklist', test: (c) => deriveState(c.actions).ipBlocked(ATK) },
            { id: 'reset', label: 'Credentials of the affected account have been reset', test: (c) => deriveState(c.actions).reset.has(USER.sam) },
            { id: 'told', label: 'Incident response lead has been notified', test: (c) => deriveState(c.actions).notified.has('ir_lead') },
          ],
          explain: 'The case file must show which containment actions were taken.',
        },
      },
      {
        id: 'blocked_proof', type: 'pin_one', label: 'Proof the attacker is locked out', points: 4,
        help: 'Choose a pinned log line recorded after your actions that shows the outside address being refused.',
        key: {
          accept: { atk_denied: 1, atk_fail_after: 0.6 },
          partialDetail: 'That line shows the old password being rejected, which is good, but the address still reaches the server. Pin a firewall line with action=deny.',
          hint: `Search for src_ip:${ATK} action:deny. The attacker retries about every 35 seconds, so wait for the next attempt, then pin it.`,
          describe: 'A firewall line with action=deny for the attacker address, recorded after the block.',
          explain: 'This is the negative test: the prohibited activity is attempted again and fails.',
        },
      },
      {
        id: 'legit_proof', type: 'pin_one', label: 'Proof the real user can still sign in', points: 4,
        help: 'Choose a pinned log line recorded after the reset that shows the user signing in from her own workstation.',
        key: {
          accept: { legit_after: 1, legit: 0.3, legit_broken: 0.3 },
          partialDetail: 'That is not a successful sign-in recorded after the reset. If the account was disabled, the real user is locked out too.',
          hint: `Search for event_id:4624 host:WEB01 src_ip:${WS.ip}. She signs in about once a minute; pin one recorded after the reset.`,
          describe: 'A successful logon (4624) from WS-SAL-007 recorded after the credentials were reset.',
          explain: 'This is the positive test: approved activity still works after containment.',
        },
      },
      {
        id: 'residual', type: 'multi', label: 'Remaining risk to record', points: 3,
        options: [
          opt('data', 'Portal data the attacker viewed or downloaded before containment needs reviewing'),
          opt('rebuild', 'WEB01 must be rebuilt before it can be trusted'),
          opt('reuse', 'The same password may have been used by this user on other services'),
          opt('all', 'Every staff password is compromised'),
        ],
        key: { set: ['data', 'reuse'], hint: 'Record only risks the evidence supports.', explain: 'Containment stops further access; it does not undo what was already taken or protect other places the same password was used. Nothing supports rebuilding the server or a company-wide reset.' },
      },
    ],
  },

  {
    id: 'closure', label: 'Closure', tier: 'L3', kind: 'form', weight: 5, ...RETRY, final: true, submitLabel: 'Close ticket',
    intro: 'Record the final disposition. Closing the ticket ends the guided demo and opens the review.',
    fields: [
      {
        id: 'disposition', type: 'single', label: 'Final disposition', points: 3, summary: 'Disposition',
        options: [
          opt('fp', 'False positive'),
          opt('benign', 'Benign / authorised activity'),
          opt('tp_incident', 'True positive, confirmed security incident'),
          opt('dup', 'Duplicate of another ticket'),
        ],
        key: { accept: 'tp_incident', coach: { fp: 'The alert was correct and the activity was malicious.', benign: 'Nothing about this activity was authorised.', dup: 'There is no other ticket for this activity.' }, reveal: 'True positive, confirmed security incident.', explain: 'An account was compromised and used, and data was taken from the portal.' },
      },
      {
        id: 'root_cause', type: 'single', label: 'Root cause', points: 3,
        options: [
          opt('malware', 'Malware on the user\'s workstation'),
          opt('guessable', 'A guessable password on an internet-facing sign-in with no lockout and no second factor'),
          opt('vuln', 'An unpatched vulnerability in the portal software'),
          opt('insider', 'Deliberate misuse by the user'),
        ],
        key: { accept: 'guessable', coach: { malware: 'No endpoint event shows malware on WS-SAL-007, and the attacker needed fourteen guesses, so they did not already have the password.', vuln: 'The attacker signed in through the normal sign-in with a password. No exploit appears in the logs.', insider: 'The sign-in came from an outside address reported for password guessing, not from the user.' }, reveal: 'A guessable password with no lockout and no second factor.', explain: 'The asset record for WEB01 notes that portal sign-ins have no lockout. Fourteen guesses were allowed and one worked.' },
      },
      {
        id: 'lessons', type: 'multi', label: 'Recommendations', points: 4, help: 'Select the controls this incident justifies.',
        options: [
          opt('lockout', 'Lock or slow an account after repeated failed sign-ins on the portal'),
          opt('offline', 'Take the customer portal offline permanently'),
          opt('mfa', 'Require a second factor for staff sign-in to the portal'),
          opt('resetall', 'Force a password reset for every user in the company'),
          opt('alert', 'Alert on repeated failures sooner, before a success'),
        ],
        key: { set: ['lockout', 'mfa', 'alert'], hint: 'Pick the controls that would have stopped or shortened this attack, and leave out anything out of proportion.', explain: 'Lockout stops the guessing, a second factor makes a guessed password useless, and an earlier alert shortens the attack. Removing the portal or resetting everyone is out of proportion to one account.' },
      },
      { id: 'summary', type: 'longtext', label: 'Closure summary', min: 80, points: 1, help: 'Two or three sentences a manager could read without the case file.', key: { explain: 'Recorded in the case file.' } },
    ],
  },
];

const secret = {
  response: {
    scope: { hosts: [], accounts: [USER.sam], domains: [], ips: [ATK], hashes: [], senders: [] },
    artifacts: {},
    notify: { premature: ['customers', 'press', 'regulator'], prematureReason: 'what was taken has not been reviewed yet, so external notification is premature and is a decision for legal and the incident lead.' },
    contained: (st) => st.ipBlocked(ATK) || st.reset.has(USER.sam),
    objectives: [
      { id: 'block', label: 'Block the attacker address', points: 4, eval: (st) => (st.ipBlocked(ATK) ? 1 : 0), explain: 'Blocking the address at the firewall stops this attacker reaching the portal at all.' },
      { id: 'creds', label: 'Invalidate the stolen password', points: 4, eval: (st) => (st.reset.has(USER.sam) ? 1 : st.disabled.has(USER.sam) ? 0.5 : 0), explain: 'The attacker can move to another address in seconds; the password is what they really hold. A reset makes it worthless. Disabling the account also stops the attacker, but locks the real user out.' },
      { id: 'notify', label: 'Tell the people who must know', points: 2, eval: (st) => 0.6 * (st.notified.has('ir_lead') ? 1 : 0) + 0.4 * (st.notified.has('user_mgr') ? 1 : 0), explain: 'The incident lead owns the response. The user needs to know her password was guessed and set a new one.' },
    ],
  },
  truth({ t0 }) {
    const T = (off) => t0 + off * 1000;
    return {
      summary: `An outside address (${ATK}) tried fourteen passwords against one staff account, ${USER.sam}, on the customer portal WEB01, 12 seconds apart. The fifteenth attempt worked. The attacker then stayed signed in and pulled about 22 MB from the portal. The same account's normal sign-ins all come from the user's own workstation, WS-SAL-007, including one ordinary mistyped password earlier in the day. Nothing shows WEB01 itself or any internal system being changed. This demo scenario is separate from the assessment scenarios: in those, an alert that looks similar can have a different explanation, so always check before deciding.`,
      timeline: [
        { ts: T(AT.typo), text: 'The real user mistypes her password once from WS-SAL-007, then signs in normally.' },
        { ts: T(AT.firstFail), text: `First failed logon from ${ATK}.` },
        { ts: T(AT.firstFail + (FAILS - 1) * AT.gap), text: 'Fourteenth and last failed logon.' },
        { ts: T(AT.ok), text: 'Successful logon from the same address.' },
        { ts: T(AT.data[0]), text: 'First of three large transfers from the portal to that address.' },
        { ts: T(5), text: 'AUTH-0017 fires.' },
      ],
      iocs: [{ type: 'ip', value: ATK, note: 'Password-guessing source' }],
    };
  },
};

export default {
  id: 'demo-portal-login',
  hidden: true,
  historySeconds: 30 * 60,
  catalog: {
    title: 'Guided demo: repeated failed logons followed by a successful logon',
    queue: 'authentication (guided demo)',
    blurb: 'Dedicated sample scenario for Newbie Demo Mode.',
    difficulty: 'Guided',
    minutes: '30-40',
    tiers: 'L1, L2, L3',
    sources: ['proxy', 'dns', 'email', 'edr', 'winsec', 'firewall', 'audit'],
    environment: 'Meridian Freight Systems, a simulated company of about 30 hosts. All logs are synthetic. All times are UTC.',
  },
  build,
  alert: { at: 5, build: alert },
  relatedAlerts: [],
  stages,
  flow: () => null,
  // Stops a stage being left in a state the next one cannot recover from.
  guard(stageId, c) {
    if (stageId !== 'l3_response') return null;
    const st = deriveState(c.actions);
    const missing = [];
    if (!st.ipBlocked(ATK)) missing.push('block the attacker address');
    if (!st.reset.has(USER.sam)) missing.push('reset the affected account\'s credentials');
    return missing.length ? `The response is not complete yet: ${missing.join(' and ')} first.` : null;
  },
  intel() {
    return {
      [ATK]: {
        verdict: 'malicious', detections: '7/89',
        facts: [['Network', 'AS64503 CLOUDNODE-VPS (RO)'], ['Type', 'Rented virtual server'], ['Vendor tags', 'Password guessing / credential stuffing source (7 vendors)'], ['First reported', '3 weeks ago']],
        notes: ['Not a known corporate, VPN or partner address.'],
      },
    };
  },
  sandbox: {},
  assetNotes: {
    WEB01: [
      'Staff sign in to the portal back office with their domain accounts. Each sign-in is recorded as a Windows logon event on WEB01, with the client address in src_ip.',
      'No lockout is applied to portal sign-ins (risk accepted in 2025; review overdue).',
    ],
  },
  accountNotes: {
    [USER.sam]: ['Signs in to the customer portal from WS-SAL-007 during office hours.', 'No remote-access (VPN) entitlement.', 'Password last changed 310 days ago.'],
  },
  changes: [],
  secret,
  // Used by the automated tests and by the read-only walkthrough preview.
  _test: {
    tools: { l2_validation: [['reputation', ATK], ['user', USER.sam], ['change', '']] },
    actions: [
      { type: 'reset_credentials', target: USER.sam },
      { type: 'block_ip', target: ATK },
      { type: 'notify', target: 'ir_lead' },
      { type: 'notify', target: 'user_mgr' },
    ],
  },
  // Server-side constants for the guided-step validators and tests.
  facts: { ATK, ATK_NAME, USER: USER.sam, WS: WS.name, WS_IP: WS.ip, WEB: WEB.name, WEB_IP: WEB.ip, FAILS },
};
