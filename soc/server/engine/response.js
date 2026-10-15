// Response actions: catalogue, execution, and the state they leave behind.
// The state feeds back into log generation (a blocked domain shows up as
// DENIED proxy lines, an isolated host goes quiet), so containment can be
// verified in the live feed rather than assumed.

import { E } from './format.js';
import { hostNamed, account, BENIGN_DOMAINS, BENIGN_IPS, KNOWN_GOOD_HASHES, dom } from './env.js';
import { rng } from './rng.js';

export const ACTIONS = [
  { type: 'isolate_host', phase: 'Containment', label: 'Isolate host', desc: 'EDR network containment. The host keeps its EDR channel only.', target: 'host' },
  { type: 'block_domain', phase: 'Containment', label: 'Block domain', desc: 'Add to the web proxy and DNS blocklist.', target: 'text', placeholder: 'domain, e.g. bad.example' },
  { type: 'block_ip', phase: 'Containment', label: 'Block IP address', desc: 'Add to the perimeter firewall blocklist.', target: 'text', placeholder: 'IPv4 address' },
  { type: 'block_hash', phase: 'Containment', label: 'Block file hash', desc: 'Add SHA-256 to the EDR prevention list.', target: 'text', placeholder: 'SHA-256' },
  { type: 'block_sender', phase: 'Containment', label: 'Block email sender', desc: 'Block a sender address or sender domain at the mail gateway.', target: 'text', placeholder: 'address or domain' },
  { type: 'reset_credentials', phase: 'Containment', label: 'Reset credentials', desc: 'Force password change and revoke active sessions and tickets.', target: 'account' },
  { type: 'disable_account', phase: 'Containment', label: 'Disable account', desc: 'Disable the account in the directory.', target: 'account' },
  { type: 'purge_email', phase: 'Containment', label: 'Search and purge email', desc: 'Remove matching messages from every mailbox.', target: 'text', placeholder: 'message ID, sender address/domain, or attachment SHA-256' },
  { type: 'acquire_evidence', phase: 'Evidence', label: 'Acquire forensic package', desc: 'Memory image plus disk triage artefacts, hashed into the evidence locker.', target: 'host' },
  { type: 'remove_artifacts', phase: 'Eradication', label: 'Remove malicious artefacts', desc: 'EDR remediation: kill processes, delete files, remove persistence.', target: 'host' },
  { type: 'reimage_host', phase: 'Eradication', label: 'Reimage / rebuild host', desc: 'Wipe and rebuild from the gold image.', target: 'host' },
  { type: 'release_host', phase: 'Recovery', label: 'Release from isolation', desc: 'Return the host to the production network.', target: 'host' },
  { type: 'revoke_sessions', phase: 'Containment', label: 'Revoke sessions and tokens', desc: 'Sign the account out everywhere and invalidate refresh tokens. The password is unchanged.', target: 'account' },
  { type: 'end_session', phase: 'Containment', label: 'Terminate remote session', desc: 'Log off every interactive and remote session on a host.', target: 'host' },
  { type: 'remove_mail_rule', phase: 'Containment', label: 'Remove mailbox rule', desc: 'Delete an inbox rule or forwarding setting by name.', target: 'text', placeholder: 'rule name' },
  { type: 'revoke_consent', phase: 'Containment', label: 'Revoke application consent', desc: 'Remove an application\'s granted permissions for every user.', target: 'text', placeholder: 'application name or app id' },
  { type: 'block_app', phase: 'Containment', label: 'Block application tenant-wide', desc: 'Prevent any user from signing in to or consenting to the application.', target: 'text', placeholder: 'application name or app id' },
  { type: 'deactivate_key', phase: 'Containment', label: 'Deactivate cloud access key', desc: 'Set an AWS access key to inactive.', target: 'text', placeholder: 'access key id' },
  { type: 'waf_rule', phase: 'Containment', label: 'Add WAF deny rule', desc: 'Deny requests matching a path or source at the web application firewall.', target: 'text', placeholder: 'path pattern or source address' },
  { type: 'delete_cloud_user', phase: 'Eradication', label: 'Delete cloud identity', desc: 'Delete an IAM user (or other cloud identity) and its keys.', target: 'text', placeholder: 'user name' },
  { type: 'rollback_software', phase: 'Eradication', label: 'Stop or roll back software', desc: 'Stop a software agent or roll it back to the previous version across the fleet.', target: 'text', placeholder: 'product and version' },
  { type: 'restore_item', phase: 'Evidence', label: 'Recover deleted item', desc: 'Restore a deleted mail item or file into the evidence locker.', target: 'text', placeholder: 'item subject or path' },
  { type: 'notify', phase: 'Communication', label: 'Notify stakeholder', desc: 'Send an incident notification through the IR communication plan.', target: 'stakeholder' },
];
// Action types whose use on something outside the incident scope disrupts
// the business (collateral; Build specification, section 7.1).
export const DISRUPTIVE = new Set(['isolate_host', 'reimage_host', 'disable_account', 'reset_credentials', 'block_domain', 'block_ip', 'block_hash', 'block_sender', 'purge_email',
  'revoke_sessions', 'end_session', 'remove_mail_rule', 'revoke_consent', 'block_app', 'deactivate_key', 'waf_rule', 'delete_cloud_user', 'rollback_software']);
const TEXT_TYPES = new Set(['remove_mail_rule', 'revoke_consent', 'block_app', 'deactivate_key', 'waf_rule', 'delete_cloud_user', 'rollback_software', 'restore_item']);

export const STAKEHOLDERS = [
  { id: 'ir_lead', label: 'CISO / incident response lead' },
  { id: 'it_ops', label: 'IT Operations (system owners)' },
  { id: 'data_owner', label: 'Business data owner' },
  { id: 'legal', label: 'Legal / privacy officer' },
  { id: 'user_mgr', label: 'Affected user and line manager' },
  { id: 'hr', label: 'Human Resources' },
  { id: 'law', label: 'Law enforcement' },
  { id: 'regulator', label: 'Data protection regulator' },
  { id: 'customers', label: 'Customers / external partners' },
  { id: 'press', label: 'Corporate communications / press' },
  { id: 'vendor', label: 'Software vendor / supplier' },
];

const ACTION_BY_TYPE = new Map(ACTIONS.map((a) => [a.type, a]));
const normDomain = (s) => String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0].replace(/^\[|\]$/g, '').replace(/\.$/, '');
const isIp = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((o) => Number(o) <= 255);
const isHash = (s) => /^[a-f0-9]{64}$/.test(s);
const isDomain = (s) => /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s);

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Fold the action log into the state in force at time `at`.
export function deriveState(actions, at = Infinity) {
  const st = {
    isolated: new Set(), everIsolated: new Map(), released: new Map(),
    blockedDomains: new Map(), blockedIps: new Map(), blockedHashes: new Map(), blockedSenders: new Map(),
    disabled: new Map(), reset: new Map(), resetCount: new Map(), purges: [],
    evidence: new Map(), cleaned: new Map(), reimaged: new Map(), notified: new Map(),
    revoked: new Map(), ended: new Map(), done: new Map(),
    actions: [],
  };
  for (const a of actions) {
    if (a.ts > at || !a.ok) continue;
    st.actions.push(a);
    const t = a.target;
    const first = (m) => { if (!m.has(t)) m.set(t, a.ts); };
    switch (a.type) {
      case 'isolate_host': st.isolated.add(t); first(st.everIsolated); break;
      case 'release_host': st.isolated.delete(t); st.released.set(t, a.ts); break;
      case 'block_domain': first(st.blockedDomains); break;
      case 'block_ip': first(st.blockedIps); break;
      case 'block_hash': first(st.blockedHashes); break;
      case 'block_sender': first(st.blockedSenders); break;
      case 'disable_account': first(st.disabled); break;
      case 'reset_credentials': first(st.reset); st.resetCount.set(t, (st.resetCount.get(t) || 0) + 1); break;
      case 'revoke_sessions': first(st.revoked); break;
      case 'end_session': first(st.ended); break;
      case 'purge_email': st.purges.push(a); break;
      case 'acquire_evidence': first(st.evidence); break;
      case 'remove_artifacts': first(st.cleaned); break;
      case 'reimage_host': first(st.reimaged); break;
      case 'notify': first(st.notified); break;
      default: break;
    }
    if (TEXT_TYPES.has(a.type)) {
      if (!st.done.has(a.type)) st.done.set(a.type, new Map());
      if (!st.done.get(a.type).has(t)) st.done.get(a.type).set(t, a.ts);
    }
  }
  st.did = (type, target) => !!st.done.get(type)?.has(String(target).toLowerCase());
  st.offline = (host) => st.isolated.has(String(host).toUpperCase());
  st.eradicated = (host) => st.cleaned.has(String(host).toUpperCase()) || st.reimaged.has(String(host).toUpperCase());
  st.domainBlocked = (d) => st.blockedDomains.has(String(d).toLowerCase());
  st.ipBlocked = (ip) => st.blockedIps.has(ip);
  return st;
}

function normaliseTarget(def, raw) {
  const v = String(raw ?? '').trim();
  if (!v) throw new HttpError(400, 'Choose a target for this action.');
  switch (def.type) {
    case 'isolate_host': case 'acquire_evidence': case 'remove_artifacts': case 'reimage_host': case 'release_host': case 'end_session': {
      const h = hostNamed(v);
      if (!h) throw new HttpError(400, `Unknown host "${v}".`);
      return h.name;
    }
    case 'reset_credentials': case 'disable_account': case 'revoke_sessions': {
      const a = account(v);
      if (!a) throw new HttpError(400, `Unknown account "${v}".`);
      return a.sam;
    }
    case 'block_domain': {
      const d = normDomain(v);
      if (!isDomain(d)) throw new HttpError(400, `"${v}" is not a valid domain name.`);
      return d;
    }
    case 'block_ip':
      if (!isIp(v)) throw new HttpError(400, `"${v}" is not a valid IPv4 address.`);
      return v;
    case 'block_hash': {
      const h = v.toLowerCase();
      if (!isHash(h)) throw new HttpError(400, 'Enter a full SHA-256 (64 hexadecimal characters).');
      return h;
    }
    case 'block_sender': {
      const s = v.toLowerCase();
      if (!(isDomain(s) || /^[^@\s]+@([a-z0-9-]+\.)+[a-z]{2,}$/.test(s))) throw new HttpError(400, 'Enter a sender address or a sender domain.');
      return s;
    }
    case 'purge_email':
      return v.toLowerCase();
    case 'remove_mail_rule': case 'revoke_consent': case 'block_app': case 'deactivate_key': case 'waf_rule':
    case 'delete_cloud_user': case 'rollback_software': case 'restore_item':
      return v.toLowerCase().slice(0, 200);
    case 'notify':
      if (!STAKEHOLDERS.some((s) => s.id === v)) throw new HttpError(400, 'Unknown stakeholder.');
      return v;
    default:
      throw new HttpError(400, 'Unknown action.');
  }
}

function emailMatches(stream, target) {
  const bare = target.replace(/^<|>$/g, '');
  return stream.events.filter((e) => {
    if (e.source !== 'email' || e.fields.direction !== 'inbound') return false;
    const f = e.fields;
    const from = String(f.from || '').toLowerCase();
    return String(f.msg_id || '').toLowerCase().replace(/^<|>$/g, '') === bare
      || from === target || from.split('@')[1] === target
      || String(f.attachment_sha256 || '').toLowerCase() === target;
  });
}

// Execute one action. Returns the stored action record.
export function executeAction(c, stream, scenario, req, now) {
  const def = ACTION_BY_TYPE.get(req.type);
  if (!def) throw new HttpError(400, 'Unknown action.');
  const target = normaliseTarget(def, req.target);
  const state = deriveState(c.actions);
  const r = rng(c.seed, 'action', c.actions.length);
  const sec = scenario.secret.response;
  const by = c.analyst;
  const host = hostNamed(target);
  const logs = [];
  let summary = '';
  const details = [];
  let impact = null;
  let ok = true;

  const needsConfirm = host && ['isolate_host', 'reimage_host'].includes(def.type) && ['High', 'Critical'].includes(host.criticality);
  if (needsConfirm && !req.confirm) {
    throw new HttpError(409, 'Confirmation required', {
      needsConfirmation: true,
      message: `${host.name} is rated ${host.criticality} (${host.role}). ${def.type === 'isolate_host' ? 'Isolating it interrupts that service for the business.' : 'Rebuilding it takes the service offline until restore completes.'} Confirm to proceed.`,
    });
  }

  switch (def.type) {
    case 'isolate_host':
      if (state.offline(target)) { ok = false; summary = `${target} is already isolated.`; break; }
      summary = `${target} isolated. EDR network containment active; only the EDR management channel is permitted.`;
      logs.push(E.audit(now, 'EDR-CONSOLE', 'edr', [['action', 'network_containment'], ['target_host', target], ['status', 'applied'], ['operator', by], ['ticket', c.ticket]], target));
      if (host.criticality === 'Critical') impact = `${target} (${host.role}) is now unreachable. IT Operations has raised a major incident for the resulting service outage.`;
      else if (host.kind === 'server') impact = `${host.role} is unavailable to users while ${target} is isolated.`;
      break;
    case 'release_host':
      if (!state.offline(target)) { ok = false; summary = `${target} is not isolated.`; break; }
      summary = `${target} released from isolation and returned to the production network.`;
      logs.push(E.audit(now, 'EDR-CONSOLE', 'edr', [['action', 'network_containment'], ['target_host', target], ['status', 'lifted'], ['operator', by], ['ticket', c.ticket]], target));
      break;
    case 'block_domain':
      if (state.domainBlocked(target)) { ok = false; summary = `${target} is already blocked.`; break; }
      summary = `${target} added to the proxy and DNS blocklist. New requests will be denied.`;
      logs.push(E.audit(now, 'PROXY01', 'policy', [['action', 'blocklist_add'], ['type', 'domain'], ['value', target], ['list', 'SOC-Blocklist-Domain'], ['operator', by], ['ticket', c.ticket]]));
      if (BENIGN_DOMAINS.has(target)) impact = `${target} is in regular business use. The service desk is receiving reports that it no longer loads.`;
      break;
    case 'block_ip':
      if (state.ipBlocked(target)) { ok = false; summary = `${target} is already blocked.`; break; }
      summary = `${target} added to the perimeter firewall blocklist (inbound and outbound).`;
      logs.push(E.audit(now, 'FW01', 'policy', [['action', 'blocklist_add'], ['type', 'ip'], ['value', target], ['list', 'SOC-Blocklist-IP'], ['operator', by], ['ticket', c.ticket]]));
      if (BENIGN_IPS.has(target) || target.startsWith('10.')) impact = `${target} carries legitimate traffic. Users are reporting connection failures.`;
      break;
    case 'block_hash':
      if (state.blockedHashes.has(target)) { ok = false; summary = 'Hash is already on the prevention list.'; break; }
      summary = `SHA-256 ${target.slice(0, 16)}… added to the EDR prevention list for all endpoints.`;
      logs.push(E.audit(now, 'EDR-CONSOLE', 'edr', [['action', 'prevention_list_add'], ['sha256', target], ['scope', 'all-endpoints'], ['operator', by], ['ticket', c.ticket]]));
      if (KNOWN_GOOD_HASHES.has(target)) impact = `That hash is ${KNOWN_GOOD_HASHES.get(target).path.split('\\').pop()}, a signed system binary. Endpoints are now blocking a legitimate program.`;
      break;
    case 'block_sender':
      if (state.blockedSenders.has(target)) { ok = false; summary = `${target} is already blocked.`; break; }
      summary = `${target} added to the mail gateway sender blocklist. Future messages will be rejected.`;
      logs.push(E.audit(now, 'MAILGW', 'policy', [['action', 'sender_block_add'], ['value', target], ['operator', by], ['ticket', c.ticket]]));
      break;
    case 'reset_credentials': {
      const a = account(target);
      summary = `Password reset for ${dom(target)}; active sessions and Kerberos tickets revoked.`;
      if (a.type === 'service') details.push('Service account: new secret stored in the vault and pushed to dependent services.');
      logs.push(E.winsec(now, 'DC01', 4724, "An attempt was made to reset an account's password", { subject_user: dom('soc-automation'), target_user: dom(target) }));
      break;
    }
    case 'disable_account': {
      if (state.disabled.has(target)) { ok = false; summary = `${dom(target)} is already disabled.`; break; }
      const a = account(target);
      summary = `${dom(target)} disabled in the directory.`;
      if (a.type === 'service') impact = `Jobs that run as ${target} will fail until the account is re-enabled.`;
      if (a.type === 'admin') impact = `${target} is a privileged administrative account; administrators lose that access path.`;
      logs.push(E.winsec(now, 'DC01', 4725, 'A user account was disabled', { subject_user: dom('soc-automation'), target_user: dom(target) }));
      break;
    }
    case 'purge_email': {
      const hits = emailMatches(stream, target);
      if (!hits.length) { ok = false; summary = 'No delivered inbound messages match that message ID, sender or attachment hash.'; break; }
      const mailboxes = [...new Set(hits.map((e) => e.fields.to))];
      summary = `${hits.length} message${hits.length === 1 ? '' : 's'} removed from ${mailboxes.length} mailbox${mailboxes.length === 1 ? '' : 'es'}.`;
      details.push(...hits.slice(0, 12).map((e) => `${e.fields.to} - "${e.fields.subject}" from ${e.fields.from}`));
      if (hits.length > 12) details.push(`…and ${hits.length - 12} more`);
      req._matched = hits.map((e) => e.id);
      logs.push(E.audit(now, 'MAILGW', 'purge', [['action', 'search_and_purge'], ['criteria', target], ['messages', hits.length], ['mailboxes', mailboxes.length], ['operator', by], ['ticket', c.ticket]]));
      break;
    }
    case 'acquire_evidence':
      if (state.evidence.has(target)) { ok = false; summary = `A forensic package for ${target} is already in the evidence locker.`; break; }
      if (state.reimaged.has(target)) { ok = false; summary = `${target} has been rebuilt. There is nothing left to acquire.`; break; }
      summary = `Forensic package for ${target} stored as EV-${c.ticket.slice(-4)}-${String(state.evidence.size + 1).padStart(2, '0')}.`;
      details.push(`Memory image ${r.int(8, 32)} GB, $MFT, event logs, prefetch, registry hives.`, `Package SHA-256 ${r.hex(64)}`);
      if (state.cleaned.has(target)) details.push('Note: artefacts were removed before acquisition. Volatile evidence of the intrusion is no longer present.');
      logs.push(E.audit(now, 'EDR-CONSOLE', 'edr', [['action', 'forensic_acquisition'], ['target_host', target], ['status', 'completed'], ['operator', by], ['ticket', c.ticket]], target));
      break;
    case 'remove_artifacts': {
      if (state.reimaged.has(target)) { ok = false; summary = `${target} has already been rebuilt.`; break; }
      const found = (sec.artifacts && sec.artifacts[target]) || [];
      if (state.cleaned.has(target)) { ok = false; summary = `Remediation has already run on ${target}.`; break; }
      if (found.length) {
        summary = `Remediation completed on ${target}: ${found.length} artefact${found.length === 1 ? '' : 's'} removed.`;
        details.push(...found);
      } else {
        summary = `Remediation scan completed on ${target}: nothing matched this case's indicators.`;
      }
      logs.push(E.audit(now, 'EDR-CONSOLE', 'edr', [['action', 'remediation'], ['target_host', target], ['artifacts_removed', found.length], ['operator', by], ['ticket', c.ticket]], target));
      break;
    }
    case 'reimage_host':
      if (state.reimaged.has(target)) { ok = false; summary = `${target} has already been rebuilt.`; break; }
      summary = `${target} wiped and rebuilt from the gold image.`;
      if (host.kind === 'server') { details.push('Server role and data restored from last verified backup.'); impact = `${host.role} was offline during the rebuild.`; }
      logs.push(E.audit(now, 'DEPLOY01', 'imaging', [['action', 'reimage'], ['target_host', target], ['image', host.kind === 'server' ? 'srv2019-gold-2026.09' : 'w11-23h2-gold-2026.09'], ['status', 'completed'], ['operator', by], ['ticket', c.ticket]], target));
      break;
    case 'revoke_sessions':
      if (state.revoked.has(target)) { ok = false; summary = `Sessions for ${target} were already revoked.`; break; }
      summary = `All sessions and refresh tokens for ${target} revoked. The user must sign in again.`;
      logs.push(E.audit(now, 'ENTRA', 'idp', [['action', 'revoke_sessions'], ['target_user', target], ['operator', by], ['ticket', c.ticket]]));
      break;
    case 'end_session':
      if (state.ended.has(target)) { ok = false; summary = `Sessions on ${target} were already terminated.`; break; }
      summary = `All interactive and remote sessions on ${target} logged off.`;
      logs.push(E.audit(now, 'EDR-CONSOLE', 'edr', [['action', 'logoff_sessions'], ['target_host', target], ['operator', by], ['ticket', c.ticket]], target));
      if (host.kind === 'server') impact = `Users working on ${target} were disconnected.`;
      break;
    case 'remove_mail_rule': case 'revoke_consent': case 'block_app': case 'deactivate_key': case 'waf_rule':
    case 'delete_cloud_user': case 'rollback_software': case 'restore_item': {
      if (state.did(def.type, target)) { ok = false; summary = 'That action has already been applied to this target.'; break; }
      const known = (sec.textTargets?.[def.type] || []).map((x) => String(x).toLowerCase());
      const okTarget = !known.length || known.includes(target) || (sec.textAllowAny || []).includes(def.type);
      summary = okTarget ? `${def.label}: ${target} done.` : `${def.label}: ${target} applied, but nothing matching that name exists in this environment.`;
      const reporter = ['deactivate_key', 'delete_cloud_user'].includes(def.type) ? 'aws' : def.type === 'waf_rule' ? 'WAF01' : def.type === 'rollback_software' ? 'EDR-CONSOLE' : def.type === 'restore_item' ? 'M365' : 'ENTRA';
      logs.push(E.audit(now, reporter, 'console', [['action', def.type], ['target', target], ['operator', by], ['ticket', c.ticket]]));
      const imp = sec.impacts?.[def.type]?.[target];
      if (imp) impact = imp;
      break;
    }
    case 'notify': {
      if (state.notified.has(target)) { ok = false; summary = 'That stakeholder has already been notified.'; break; }
      const s = STAKEHOLDERS.find((x) => x.id === target);
      summary = `Notification sent to ${s.label}.`;
      break;
    }
    default:
      throw new HttpError(400, 'Unknown action.');
  }

  const rec = {
    id: `a${c.actions.length + 1}`,
    ts: now,
    type: def.type,
    label: def.label,
    phase: def.phase,
    target,
    targetLabel: def.type === 'notify' ? STAKEHOLDERS.find((x) => x.id === target).label : target,
    comment: String(req.comment || '').slice(0, 500),
    by,
    ok,
    summary,
    details,
    impact: ok ? impact : null,
    matched: req._matched,
  };
  return { rec, logs: ok ? logs : [] };
}

// What the analyst sees of the current response state.
export function publicResponse(c) {
  const st = deriveState(c.actions);
  const hosts = new Map();
  const touch = (h) => { if (!hosts.has(h)) hosts.set(h, { host: h, status: [] }); return hosts.get(h); };
  for (const h of st.everIsolated.keys()) touch(h).status.push(st.isolated.has(h) ? 'Isolated' : 'Released');
  for (const h of st.evidence.keys()) touch(h).status.push('Evidence acquired');
  for (const h of st.cleaned.keys()) touch(h).status.push('Artefacts removed');
  for (const h of st.reimaged.keys()) touch(h).status.push('Rebuilt');
  return {
    catalog: ACTIONS,
    stakeholders: STAKEHOLDERS,
    actions: c.actions.map(({ matched, ...a }) => a),
    hosts: [...hosts.values()],
    blocks: [
      ...[...st.blockedDomains.keys()].map((v) => ({ kind: 'Domain', value: v })),
      ...[...st.blockedIps.keys()].map((v) => ({ kind: 'IP', value: v })),
      ...[...st.blockedHashes.keys()].map((v) => ({ kind: 'Hash', value: v })),
      ...[...st.blockedSenders.keys()].map((v) => ({ kind: 'Sender', value: v })),
    ],
    accounts: [
      ...[...st.reset.keys()].map((v) => ({ account: v, status: st.resetCount.get(v) > 1 ? `Credentials reset (${st.resetCount.get(v)} times)` : 'Credentials reset' })),
      ...[...st.disabled.keys()].map((v) => ({ account: v, status: 'Disabled' })),
      ...[...st.revoked.keys()].map((v) => ({ account: v, status: 'Sessions revoked' })),
    ],
    other: [...st.done.entries()].flatMap(([type, m]) => [...m.keys()].map((v) => ({ kind: ACTION_BY_TYPE.get(type).label, value: v }))),
    notified: [...st.notified.keys()].map((id) => STAKEHOLDERS.find((s) => s.id === id)?.label),
  };
}

// Grade the response against the scenario's hidden objectives.
export function evaluateResponse(c, scenario, stream) {
  const sec = scenario.secret.response;
  const st = deriveState(c.actions);
  const ctx = { stream, case: c };
  const objectives = sec.objectives.map((o) => {
    const res = o.eval(st, ctx);
    const credit = Math.max(0, Math.min(1, typeof res === 'number' ? res : res.credit));
    return { id: o.id, label: o.label, points: o.points, credit, earned: +(o.points * credit).toFixed(2), explain: o.explain, note: typeof res === 'object' ? res.note : undefined };
  });

  const scope = sec.scope;
  const inScope = (list, v) => (list || []).map((x) => String(x).toLowerCase()).includes(String(v).toLowerCase());
  const findings = [];
  const add = (a, points, reason, collateral = false) => findings.push({ actionId: a.id, action: `${a.label}: ${a.targetLabel}`, points, reason, ...(collateral ? { collateral: true } : {}) });

  for (const a of st.actions) {
    const t = a.target;
    const h = hostNamed(t);
    switch (a.type) {
      case 'isolate_host': case 'reimage_host':
        if (!inScope(scope.hosts, t)) add(a, h.criticality === 'Critical' ? 3 : h.kind === 'server' ? 2 : 1, `No evidence in this case implicates ${t}. ${h.kind === 'server' ? 'The action caused an avoidable service outage.' : 'The user lost their workstation for no reason.'}`, true);
        break;
      case 'remove_artifacts': break;
      case 'disable_account': case 'reset_credentials':
        if (!inScope(scope.accounts, t)) add(a, account(t).type === 'user' ? 1 : 2, `${t} is not implicated by the evidence. Unnecessary credential action disrupts the business and dilutes the response.`, true);
        break;
      case 'revoke_sessions':
        if (!inScope(scope.accounts, t)) add(a, 0.5, `${t} is not implicated by the evidence. Signing the user out everywhere interrupted their work.`, true);
        break;
      case 'end_session':
        if (!inScope(scope.sessions || scope.hosts, t)) add(a, 1, `Nothing in this case required ending sessions on ${t}. People working there were disconnected.`, true);
        break;
      case 'block_domain':
        if (!inScope(scope.domains, t)) add(a, BENIGN_DOMAINS.has(t) ? 2 : 0.5, BENIGN_DOMAINS.has(t) ? `${t} is a legitimate business destination. Blocking it broke normal work.` : `${t} is not an indicator supported by the evidence.`, true);
        break;
      case 'block_ip':
        if (!inScope(scope.ips, t)) add(a, BENIGN_IPS.has(t) || t.startsWith('10.') ? 2 : 0.5, BENIGN_IPS.has(t) || t.startsWith('10.') ? `${t} carries legitimate traffic.` : `${t} is not an indicator supported by the evidence.`, true);
        break;
      case 'block_hash':
        if (!inScope(scope.hashes, t)) add(a, KNOWN_GOOD_HASHES.has(t) ? 2 : 0.5, KNOWN_GOOD_HASHES.has(t) ? 'The hash belongs to a signed system binary. Blocking it by hash breaks legitimate use.' : 'That hash is not an indicator supported by the evidence.', true);
        break;
      case 'block_sender':
        if (!inScope(scope.senders, t)) add(a, 1, `${t} is not the malicious sender. Blocking it stops legitimate mail.`, true);
        break;
      case 'purge_email': {
        const ids = new Set(a.matched || []);
        const bad = [...ids].filter((id) => !(stream.get(id)?._tags || []).some((tag) => (sec.purgeTags || []).includes(tag)));
        if (bad.length) add(a, Math.min(2, 0.5 * bad.length), `The purge criteria also removed ${bad.length} legitimate message${bad.length === 1 ? '' : 's'}.`, true);
        break;
      }
      case 'notify':
        if ((sec.notify?.premature || []).includes(t)) add(a, 1, `${a.targetLabel}: ${sec.notify.prematureReason}`);
        break;
      case 'restore_item': break;
      default:
        if (DISRUPTIVE.has(a.type) && !inScope(scope[a.type], t)) add(a, 1, (sec.collateralReasons?.[a.type]?.[t]) || `${a.label} on ${t} is not supported by the evidence in this case.`, true);
        break;
    }
  }

  // Ordering rules for in-scope hosts.
  for (const hName of scope.hosts || []) {
    const H = hName.toUpperCase();
    const erad = Math.min(st.cleaned.get(H) ?? Infinity, st.reimaged.get(H) ?? Infinity);
    const ev = st.evidence.get(H) ?? Infinity;
    if (erad !== Infinity && ev > erad) {
      const a = st.actions.find((x) => x.ts === erad && x.target === H);
      add(a, 1.5, `${H} was eradicated before a forensic package was acquired. Memory and disk evidence needed for root-cause analysis and any legal follow-up is gone.`);
    }
    const rel = st.released.get(H);
    if (rel !== undefined && rel < erad) {
      const a = st.actions.find((x) => x.type === 'release_host' && x.target === H);
      add(a, 2, `${H} was released from isolation before the malware was removed, reconnecting an infected host to the network.`);
    }
  }

  const max = objectives.reduce((s, o) => s + o.points, 0);
  const earned = objectives.reduce((s, o) => s + o.earned, 0);
  return { objectives, findings, earned: +earned.toFixed(2), max, penalty: +findings.reduce((s, f) => s + f.points, 0).toFixed(2), collateral: findings.filter((f) => f.collateral).length };
}
