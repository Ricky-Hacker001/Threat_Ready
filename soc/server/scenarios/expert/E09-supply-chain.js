// E9 · Trusted IT tool connecting to a new domain after an update: a signed
// vendor update (OpsMonitor agent 5.2.1) carries a backdoor. Every updated
// host calls home; two received a second stage.

import { E } from '../../engine/format.js';
import { hostNamed, WORKSTATIONS } from '../../engine/env.js';
import { fakeSha256 } from '../../engine/rng.js';
import { defineScenario, ran, single, hosts, link } from '../lib.js';

const VENDOR = 'updates.opsmonitor-software.example';
const SC = 'opsmon-telemetry.example';
const C2 = '198.51.100.188';
const AGENT = 'C:\\Program Files\\OpsMonitor\\OpsAgent.exe';
const UPDATER = 'C:\\Program Files\\OpsMonitor\\OpsUpdater.exe';
const SIG = 'Valid (OpsMonitor Software Ltd)';
const HASH = fakeSha256('E9-opsmonitor-5.2.1');
const STAGE2 = [hostNamed('WS-FIN-002'), hostNamed('APP01')];
const OTHERS = WORKSTATIONS.filter((h) => !STAGE2.some((s) => s.name === h.name)).slice(0, 10).map((h) => hostNamed(h.name || h));
const UPDATED = [...STAGE2, ...OTHERS];

export default defineScenario({
  code: 'E9', level: 'expert',
  title: 'IT monitoring agent connecting to a newly seen domain', rule: 'NET-0418', severity: 'medium', queue: 'network',
  blurb: 'A network rule reports a signed IT monitoring agent contacting a domain first seen today, shortly after an update.',
  sources: ['edr', 'proxy', 'dns', 'firewall', 'winsec', 'email'], sourceGroups: ['endpoint', 'proxy'],
  skills: ['log.endpoint', 'kno.malware', 'inv.scope', 'inv.ioc'],
  entities: { domains: [VENDOR, SC], ips: [C2] },
  history: 3 * 3600,
  alertTags: ['sc_dns'],
  build(x) {
    UPDATED.forEach((h, i) => {
      const t = -170 * 60 + i * 120;
      x.add('update', E.proxy(x.T(t), { src_ip: h.ip, url: `https://${VENDOR}/agent/5.2.1/OpsAgent-5.2.1.msi`, dest_ip: '203.0.113.150', bytes_in: 18400000, category: 'Technology/Software Updates', ua: 'OpsUpdater/5.2' }));
      x.add('update', E.procCreate(x.T(t + 40), h.name, { user: 'NT AUTHORITY\\SYSTEM', image: AGENT, command_line: `"${AGENT}" --service --version 5.2.1`, pid: 2900 + i, parent_image: UPDATER, ppid: 2800, sha256: HASH, signature: SIG }));
      for (let k = 0; k < 4; k++) {
        x.add('sc_dns', E.dns(x.T(t + 300 + k * 1800 + i * 7), { client_ip: h.ip, query: `cfg.${SC}`, qtype: 'A', answer: C2 }));
      }
    });
    STAGE2.forEach((h, i) => {
      const t = -55 * 60 + i * 600;
      x.add('stage2', E.procCreate(x.T(t), h.name, { user: 'NT AUTHORITY\\SYSTEM', image: 'C:\\Windows\\System32\\rundll32.exe', command_line: 'rundll32.exe C:\\ProgramData\\OpsMonitor\\cache\\svchelper.dll,Start', pid: 6100 + i, parent_image: AGENT, ppid: 2900 + i, signature: 'Valid (Microsoft Windows)' }));
      x.add('stage2', E.edr(x.T(t + 2), h.name, 11, 'FileCreate', { user: 'NT AUTHORITY\\SYSTEM', image: AGENT, target_filename: 'C:\\ProgramData\\OpsMonitor\\cache\\svchelper.dll', file_size: 241664 }));
      for (let s = t + 60; s < 0; s += 300) x.add('stage2_c2', E.edr(x.T(s), h.name, 3, 'NetworkConnect', { user: 'NT AUTHORITY\\SYSTEM', image: 'C:\\Windows\\System32\\rundll32.exe', pid: 6100 + i, dest_ip: C2, dest_port: 443 }));
    });
    x.add('decoy_agent', E.edr(x.T(-20 * 60), OTHERS[0].name, 3, 'NetworkConnect', { user: 'NT AUTHORITY\\SYSTEM', image: AGENT, pid: 2902, dest_ip: '10.10.0.45', dest_port: 8443, signature: SIG }));
  },
  alert: ({ tagged }) => {
    const first = tagged('sc_dns')[0];
    const h = UPDATED.find((u) => u.ip === first.fields.client_ip) || UPDATED[0];
    return {
      description: `OpsAgent.exe on ${h.name} resolved cfg.${SC}, a domain first seen today.`,
      entity: { host: h.name, ip: h.ip, user: null },
      details: [['Process', 'OpsAgent.exe (signed: OpsMonitor Software Ltd)'], ['Domain', `cfg.${SC}`], ['First seen', 'Today'], ['Rule logic', 'Signed IT tool contacting a domain under 7 days old']],
      guidance: ['Check what changed on the agent today.', 'Do not stop at the signature.', 'Hunt every host for the domain.'],
    };
  },
  intel: {
    [SC]: { verdict: 'unknown', detections: '1/89', facts: [['Registered', '9 days ago'], ['Registrant', 'Privacy protected']], notes: ['Not listed in the vendor\'s published endpoints.'] },
    [VENDOR]: { verdict: 'clean', detections: '0/89', facts: [['Owner', 'OpsMonitor Software Ltd']], notes: ['Official update server.'] },
    [C2]: { verdict: 'malicious', detections: '6/89', facts: [], notes: ['Command and control.'] },
  },
  sandbox: { [HASH]: { verdict: 'malicious', score: 84, facts: [['Signer', SIG], ['Version', '5.2.1']], behaviours: [`Resolves cfg.${SC} every 30 minutes`, 'On command, writes svchelper.dll and runs it with rundll32', 'Normal monitoring functions otherwise unchanged'], network: [`cfg.${SC}`], dropped: ['svchelper.dll'] } },
  assetNotes: { [STAGE2[1].name]: ['Runs the transport management application. An outage stops dispatch.'] },
  triage: {
    checks: [{ id: 'ti', label: 'Domain checked in threat intelligence', test: ran('reputation', SC) }],
    verdict: { accept: 'tp', explain: 'A new, unlisted domain contacted by an agent that just updated, with a second stage on some hosts.' },
    severity: { accept: 'critical', explain: 'A backdoor across the fleet through a trusted, privileged agent.' },
    evidence: { tags: ['sc_dns'], explain: 'The agent resolving the new domain.' },
  },
  l2: {
    fields: [
      link(single('version', 'What introduced the behaviour', 6, [['521', 'The 5.2.1 agent update installed today'], ['user', 'A user installing software'], ['old', 'The previous 5.2.0 agent'], ['phish', 'A phishing email']], '521', { hint: 'Look at what the agent did before the first query.', explain: 'Every host starts resolving the domain minutes after 5.2.1 installs.', skills: ['inv.timeline'] }), 'update'),
      single('signature', 'What the valid signature tells you', 6, [['not_enough', 'Only who built it; the signed update itself behaves maliciously'], ['safe', 'The agent is safe'], ['forged', 'The signature is forged'], ['expired', 'The certificate expired']], 'not_enough', { hint: 'Detonate the agent binary in the sandbox.', explain: 'Supply-chain attacks ship through the vendor\'s own build and signing.', skills: ['kno.malware'] }),
      link(hosts('stage2_hosts', 'Hosts with the second stage', 10, STAGE2.map((h) => h.name), { hint: 'Search for svchelper.dll or rundll32 started by OpsAgent.exe.', explain: 'Only two hosts received the second stage, but every updated host is backdoored.', skills: ['inv.scope', 'inv.search'] }), 'stage2'),
      single('spread', 'Hosts running the backdoored version', 4, [['dozen', `Every host that took 5.2.1 (${UPDATED.length})`], ['two', 'Only the two with a second stage'], ['one', 'Only the alerted host'], ['all', 'Every host in the company']], 'dozen', { hint: 'Sweep the fleet for the domain.', explain: 'The domain is resolved by every host that installed 5.2.1.', skills: ['inv.scope'] }),
      single('decoy', `The download from ${VENDOR}`, 4, [['channel', 'The genuine vendor update channel, serving a tampered package'], ['fake', 'An attacker look-alike domain'], ['unrelated', 'Unrelated traffic']], 'channel', { explain: 'Blocking the vendor server is not the fix; the package is.', skills: ['tri.false-positive'] }),
    ],
  },
  response: {
    scope: { hosts: STAGE2.map((h) => h.name), domains: [SC], ips: [C2], rollback_software: ['opsmonitor 5.2.1', 'opsmonitor agent 5.2.1', 'opsagent 5.2.1'] },
    textTargets: { rollback_software: ['opsmonitor 5.2.1', 'opsmonitor agent 5.2.1', 'opsagent 5.2.1'] },
    contained: (st) => st.domainBlocked(SC) && STAGE2.every((h) => st.offline(h.name)),
    objectives: [
      { id: 'block', label: 'Block the backdoor domain and C2 address', points: 3, containment: true, eval: (st) => ((st.domainBlocked(SC) ? 1 : 0) + (st.ipBlocked(C2) ? 1 : 0)) / 2, explain: 'Cuts every backdoored agent off at once.' },
      { id: 'isolate', label: 'Isolate the two hosts with the second stage', points: 3, containment: true, eval: (st) => STAGE2.filter((h) => st.offline(h.name)).length / 2, explain: 'They are under active control.' },
      { id: 'rollback', label: 'Roll back the agent to 5.2.0 across the fleet', points: 3, eval: (st) => (['opsmonitor 5.2.1', 'opsmonitor agent 5.2.1', 'opsagent 5.2.1'].some((t) => st.did('rollback_software', t)) ? 1 : 0), explain: 'Removes the backdoor from every host without isolating them all.' },
      { id: 'sweep', label: 'Sweep the fleet for the domain', points: 2, skills: ['inv.scope'], eval: (st, ctx) => (ctx.case.toolRuns.some((t) => t.tool === 'sweep' && t.input.toLowerCase().includes(SC)) ? 1 : 0), explain: 'Finds every backdoored host.' },
      { id: 'vendor', label: 'Notify the vendor', points: 2, eval: (st) => (st.notified.has('vendor') ? 1 : 0), explain: 'Their build pipeline is compromised; other customers are affected.' },
    ],
  },
  closure: {
    disposition: { options: [['supply', 'True positive: supply-chain compromise of a signed vendor update'], ['fp', 'False positive: new vendor telemetry'], ['local', 'Local malware on two hosts'], ['tamper', 'Insider tampering']], accept: 'supply', explain: 'The vendor\'s own update carried the backdoor.' },
    rootCause: { options: [['vendor', 'The vendor\'s build or update pipeline was compromised'], ['user', 'A user installed malware'], ['patch', 'Missing patches'], ['dns', 'DNS hijack']], accept: 'vendor', explain: 'Signed package, official channel, malicious behaviour.' },
    actions: { options: [['pin', 'Pin the agent version and stage future updates on a test group'], ['allow', 'Restrict the agent to its published endpoints at the proxy'], ['remove_all', 'Uninstall IT monitoring from every host permanently'], ['block_vendor', 'Block the vendor update server forever']], set: ['pin', 'allow'], explain: 'Controls that keep the tool useful.', skills: ['doc.root-cause'] },
  },
  truth: { summary: `OpsMonitor agent 5.2.1, signed by the vendor and delivered from ${VENDOR}, contains a backdoor. Every host that took the update (${UPDATED.length}) resolves cfg.${SC}. On ${STAGE2.map((h) => h.name).join(' and ')} the backdoor wrote svchelper.dll and ran it with rundll32, calling ${C2}.`, timeline: [[-170 * 60, 'Agent 5.2.1 rolls out.'], [-165 * 60, 'First queries to the new domain.'], [-55 * 60, 'Second stage on the first host.'], [-45 * 60, 'Second stage on the second host.']], iocs: [{ type: 'domain', value: SC, note: 'Backdoor' }, { type: 'ip', value: C2, note: 'C2' }] },
  test: { tools: { l1_triage: [['reputation', SC]], l2_investigation: [['sweep', SC], ['sandbox', HASH]] }, response: [['block_domain', SC], ['block_ip', C2], ['isolate_host', STAGE2[0].name], ['isolate_host', STAGE2[1].name], ['rollback_software', 'opsmonitor 5.2.1'], ['notify', 'vendor']] },
});
