// Log event builders. Each returns { ts, source, host, raw, fields }.
// `raw` is the line an analyst reads; `fields` are the parsed values the
// query language matches on. Nothing here marks an event as malicious.

import { hostNameAt, UA } from './env.js';

const iso = (ts) => new Date(ts).toISOString();

function kv(pairs) {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const s = String(v);
      return /[\s"=]/.test(s) ? `${k}="${s.replace(/"/g, '\\"')}"` : `${k}=${s}`;
    })
    .join(' ');
}

function mk(source, ts, reporter, tag, pairs, host) {
  const clean = pairs.filter(([, v]) => v !== undefined && v !== null && v !== '');
  const fields = { source, host: host || reporter };
  for (const [k, v] of clean) fields[k] = v;
  return {
    ts: Math.round(ts),
    source,
    host: host || reporter,
    raw: `${iso(ts)} ${reporter} ${tag}: ${kv(clean)}`,
    fields,
  };
}

function hostOfUrl(url) {
  return String(url).replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
}

export const E = {
  proxy(ts, o) {
    const srcHost = hostNameAt(o.src_ip);
    return mk('proxy', ts, 'PROXY01', 'proxy', [
      ['src_ip', o.src_ip], ['src_host', srcHost], ['user', o.user || '-'],
      ['method', o.method || 'GET'], ['url', o.url], ['dest_host', hostOfUrl(o.url)], ['dest_ip', o.dest_ip],
      ['status', o.status ?? 200], ['bytes_out', o.bytes_out ?? 0], ['bytes_in', o.bytes_in ?? 0],
      ['category', o.category || 'Uncategorized'], ['action', o.action || 'ALLOWED'],
      ['rule', o.rule], ['user_agent', o.ua === undefined ? UA.chrome : o.ua],
    ], srcHost || 'PROXY01');
  },

  dns(ts, o) {
    const srcHost = hostNameAt(o.client_ip);
    return mk('dns', ts, 'DC01', 'dns', [
      ['client_ip', o.client_ip], ['src_host', srcHost], ['query', o.query], ['qtype', o.qtype || 'A'],
      ['rcode', o.rcode || 'NOERROR'], ['answer', o.answer],
    ], srcHost || 'DC01');
  },

  email(ts, o) {
    return mk('email', ts, 'MAILGW', 'smtp', [
      ['direction', o.direction || 'inbound'], ['msg_id', o.msg_id], ['from', o.from], ['from_name', o.from_name],
      ['to', o.to], ['subject', o.subject], ['src_ip', o.src_ip],
      ['spf', o.spf], ['dkim', o.dkim], ['dmarc', o.dmarc],
      ['attachment', o.attachment], ['attachment_sha256', o.attachment_sha256], ['size', o.size],
      ['verdict', o.verdict || 'clean'], ['action', o.action || 'DELIVERED'],
    ], 'MAILGW');
  },

  // Endpoint telemetry (Sysmon-style event IDs).
  edr(ts, host, eventId, eventName, o) {
    return mk('edr', ts, host, 'sysmon', [
      ['event_id', eventId], ['event', eventName], ['user', o.user],
      ['image', o.image], ['command_line', o.command_line], ['pid', o.pid],
      ['parent_image', o.parent_image], ['ppid', o.ppid],
      ['target_filename', o.target_filename], ['file_size', o.file_size], ['zone_id', o.zone_id],
      ['target_image', o.target_image], ['granted_access', o.granted_access], ['call_trace', o.call_trace],
      ['target_object', o.target_object], ['details', o.details],
      ['image_loaded', o.image_loaded],
      ['dest_ip', o.dest_ip], ['dest_port', o.dest_port], ['dest_host', o.dest_host],
      ['sha256', o.sha256], ['signature', o.signature],
    ], host);
  },

  procCreate(ts, host, o) {
    return E.edr(ts, host, 1, 'ProcessCreate', o);
  },

  winsec(ts, host, eventId, desc, o, channel = 'Security') {
    return mk('winsec', ts, host, channel, [
      ['event_id', eventId], ['event', desc],
      ['subject_user', o.subject_user], ['target_user', o.target_user], ['logon_type', o.logon_type],
      ['auth_package', o.auth_package], ['src_ip', o.src_ip], ['workstation', o.workstation],
      ['target_server', o.target_server], ['process', o.process], ['pid', o.pid],
      ['status', o.status], ['failure_reason', o.failure_reason],
      ['privileges', o.privileges], ['share_name', o.share_name], ['relative_target', o.relative_target],
      ['access', o.access], ['object_name', o.object_name],
      ['service_name', o.service_name], ['image_path', o.image_path], ['service_account', o.service_account],
      ['start_type', o.start_type], ['ticket_encryption', o.ticket_encryption], ['service', o.service],
      ['logon_id', o.logon_id],
    ], host);
  },

  fw(ts, o) {
    return mk('firewall', ts, 'FW01', 'fw', [
      ['action', o.action || 'allow'], ['src_ip', o.src_ip], ['src_host', hostNameAt(o.src_ip)], ['src_port', o.src_port],
      ['dest_ip', o.dest_ip], ['dest_host', hostNameAt(o.dest_ip)], ['dest_port', o.dest_port],
      ['proto', o.proto || 'tcp'], ['zone', o.zone], ['rule', o.rule], ['bytes', o.bytes],
    ], hostNameAt(o.src_ip) || 'FW01');
  },

  // Security tooling audit trail (response actions, console operations).
  audit(ts, reporter, tag, pairs, host) {
    return mk('audit', ts, reporter, tag, pairs, host || reporter);
  },

  // DNS analytics: one summary line per host, domain and day.
  dnsStats(ts, o) {
    return mk('dns', ts, 'DNS-ANALYTICS', 'dnsstats', [
      ['day', o.day], ['client_ip', o.client_ip], ['src_host', o.src_host], ['domain', o.domain], ['query_count', o.query_count], ['label_bytes', o.label_bytes], ['unique_labels', o.unique_labels],
    ], o.src_host || 'DNS-ANALYTICS');
  },

  // ---- v2 sources (Build specification, section 10.1) ----
  vpn(ts, o) {
    return mk('vpn', ts, 'VPN01', 'vpn', [
      ['event', o.event], ['user', o.user], ['src_ip', o.src_ip], ['src_country', o.src_country], ['assigned_ip', o.assigned_ip],
      ['client', o.client], ['device_id', o.device_id], ['duration_s', o.duration_s], ['bytes_in', o.bytes_in], ['bytes_out', o.bytes_out],
      ['reason', o.reason], ['pop', o.pop],
    ], 'VPN01');
  },

  signin(ts, o) {
    return mk('idp', ts, 'ENTRA', 'signin', [
      ['user', o.user], ['app', o.app], ['result', o.result || 'success'], ['error_code', o.error_code], ['src_ip', o.src_ip],
      ['country', o.country], ['city', o.city], ['client_app', o.client_app || 'Browser'], ['user_agent', o.user_agent], ['device_id', o.device_id],
      ['mfa', o.mfa], ['conditional_access', o.conditional_access || 'success'], ['risk', o.risk || 'none'], ['session_id', o.session_id],
    ], 'ENTRA');
  },

  idpAudit(ts, o) {
    return mk('idp', ts, 'ENTRA', 'audit', [
      ['operation', o.operation], ['actor', o.actor], ['target', o.target], ['target_type', o.target_type], ['role', o.role],
      ['app_id', o.app_id], ['app_name', o.app_name], ['permissions', o.permissions], ['publisher', o.publisher], ['src_ip', o.src_ip], ['result', o.result || 'success'],
    ], 'ENTRA');
  },

  winsys(ts, host, eventId, desc, o) {
    return mk('winsys', ts, host, 'System', [
      ['event_id', eventId], ['event', desc], ['service_name', o.service_name], ['image_path', o.image_path], ['start_type', o.start_type],
      ['account', o.account], ['user', o.user], ['state', o.state],
    ], host);
  },

  fileaudit(ts, o) {
    return mk('fileaudit', ts, o.server || 'FS01', 'fileaudit', [
      ['event_id', o.event_id || 4663], ['user', o.user], ['share', o.share], ['path', o.path], ['ext', o.ext ?? String(o.path || '').split('.').pop()],
      ['access', o.access], ['process', o.process], ['src_ip', o.src_ip], ['logon_id', o.logon_id],
    ], o.server || 'FS01');
  },

  web(ts, o) {
    return mk('web', ts, 'WEB01', 'access', [
      ['src_ip', o.src_ip], ['method', o.method || 'GET'], ['uri', o.uri], ['query', o.query], ['status', o.status ?? 200], ['bytes', o.bytes],
      ['ua', o.ua], ['referer', o.referer], ['vhost', o.vhost || 'portal.aerofreight.example'], ['time_ms', o.time_ms],
    ], 'WEB01');
  },

  waf(ts, o) {
    return mk('web', ts, 'WAF01', 'waf', [
      ['src_ip', o.src_ip], ['rule_id', o.rule_id], ['rule_msg', o.rule_msg], ['action', o.action || 'block'], ['uri', o.uri], ['param', o.param],
      ['match', o.match], ['score', o.score], ['ua', o.ua],
    ], 'WAF01');
  },

  m365(ts, o) {
    return mk('m365', ts, 'M365', 'mailaudit', [
      ['operation', o.operation], ['user', o.user], ['client_ip', o.client_ip], ['client_info', o.client_info], ['client_app_id', o.client_app_id],
      ['rule_name', o.rule_name], ['rule_params', o.rule_params], ['forward_to', o.forward_to], ['item_count', o.item_count],
      ['folder', o.folder], ['subject', o.subject], ['recipient', o.recipient], ['session_id', o.session_id],
    ], 'M365');
  },

  cloudtrail(ts, o) {
    return mk('aws', ts, 'aws', 'cloudtrail', [
      ['event_name', o.event_name], ['event_source', o.event_source], ['user_type', o.user_type || 'IAMUser'], ['user_arn', o.user_arn],
      ['access_key', o.access_key], ['src_ip', o.src_ip], ['region', o.region || 'eu-west-2'], ['ua', o.ua], ['request_params', o.request_params],
      ['error_code', o.error_code], ['mfa_used', o.mfa_used ?? 'false'], ['resource', o.resource],
    ], 'aws');
  },

  guardduty(ts, o) {
    return mk('aws', ts, 'aws', 'guardduty', [
      ['finding_type', o.finding_type], ['severity', o.severity], ['resource', o.resource], ['access_key', o.access_key], ['src_ip', o.src_ip], ['count', o.count],
    ], 'aws');
  },
};

export { hostOfUrl };
