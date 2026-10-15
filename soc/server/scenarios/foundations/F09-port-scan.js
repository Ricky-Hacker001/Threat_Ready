// F9 · Internal port scan detected. Ground truth: the inventory server's
// approved weekly discovery sweep. Benign.

import { E } from '../../engine/format.js';
import { hostNamed, USERS, SERVERS } from '../../engine/env.js';
import { defineScenario, ran, single, host } from '../lib.js';

const INV = hostNamed('INV01');
const CHG = 'CHG-4502';
const PORTS = [22, 135, 161, 443, 445, 3389];

export default defineScenario({
  code: 'F9', level: 'foundations', benign: true,
  title: 'Internal host scanning multiple ports on multiple hosts', rule: 'NET-0150', severity: 'medium', queue: 'network',
  blurb: 'A firewall rule reports one internal host connecting to many ports on many hosts.',
  sources: ['firewall', 'proxy', 'dns', 'winsec', 'edr', 'email'], sourceGroups: ['firewall'],
  skills: ['log.network', 'inv.pivot', 'tri.false-positive'],
  entities: { ids: [CHG] },
  alertTags: ['sweep'],
  build(x) {
    const targets = [...SERVERS.filter((s) => s.vlan === 'SERVERS' && s.name !== 'INV01').slice(0, 12), ...USERS.slice(0, 16).map((u) => hostNamed(u.host))].slice(0, x.n(28, 22));
    targets.forEach((h, i) => PORTS.forEach((p, j) => x.add('sweep', E.fw(x.T(-360 + i * 12 + j * 0.4), {
      action: [22, 3389].includes(p) && h.kind === 'workstation' ? 'deny' : 'allow', src_ip: INV.ip, src_port: 40100 + i * 7 + j, dest_ip: h.ip, dest_port: p,
      proto: 'tcp', zone: h.kind === 'workstation' ? 'SERVERS->USERS' : 'SERVERS->SERVERS', rule: 'Inventory-to-Any', bytes: 120 + j * 10,
    }))));
    for (let i = 0; i < 6; i++) x.add('snmp', E.fw(x.T(-200 + i * 20), { src_ip: INV.ip, src_port: 50161 + i, dest_ip: `10.10.1.${20 + i}`, dest_port: 161, proto: 'udp', zone: 'SERVERS->NETWORK', rule: 'Inventory-SNMP', bytes: 340 }));
  },
  alert: ({ tagged }) => {
    const f = tagged('sweep');
    return {
      description: `${INV.ip} connected to ${new Set(f.map((e) => e.fields.dest_ip)).size} internal hosts on ${PORTS.length} ports within 10 minutes.`,
      entity: { host: null, ip: INV.ip, user: null },
      details: [['Source address', INV.ip], ['Connections', String(f.length)], ['Ports', PORTS.join(', ')], ['Rule logic', 'One internal source to 20+ hosts on 5+ ports within 15 minutes']],
      guidance: ['Find out what the source host is.', 'Check whether the activity is expected now.'],
    };
  },
  changes: [{ id: CHG, title: 'Weekly network discovery sweep', scope: `${INV.name} (${INV.ip}) to all internal subnets, ports 22, 135, 161, 443, 445, 3389`, owner: 'IT Infrastructure', status: 'Standing approval, in progress', start: -20, end: 100, detail: 'Runs every Tuesday 10:00-12:00 under standing change approval.' }],
  triage: {
    checks: [
      { id: 'asset', label: 'Source host looked up in the asset inventory', test: ran('asset', [INV.name, INV.ip]) },
      { id: 'chg', label: 'Change calendar consulted', test: ran('change') },
    ],
    fields: [
      host('source', 'Source host', 4, INV.name, { hint: 'Look the source address up in the asset inventory.', explain: 'The source address belongs to the inventory server.', skills: ['inv.pivot'] }),
      single('pattern', 'What the pattern looks like', 4, [['sweep', 'Many hosts, a fixed short list of ports'], ['one_host', 'Every port on one host'], ['random', 'Random ports and hosts'], ['exfil', 'Large transfers to a few hosts']], 'sweep', { hint: 'Count the distinct hosts and ports.', explain: 'A horizontal sweep of management ports matches discovery tooling.', skills: ['log.network'] }),
      single('in_window', 'Is it inside an approved window', 6, [['yes', 'Yes: inside the approved change window'], ['no', 'No change covers it'], ['expired', 'A change exists but has expired']], 'yes', { hint: 'Compare the times with the change calendar.', explain: `${CHG} covers this source and window.`, skills: ['tri.false-positive'] }),
    ],
    verdict: { accept: { btp: 1, fp: 0.4 }, explain: 'A real scan, authorised.' },
    severity: { accept: 'low', explain: 'Approved activity.' },
    evidence: { tags: ['sweep'], explain: 'The sweep lines from the inventory server.' },
  },
  closure: {
    disposition: { options: [['benign', 'Benign: approved inventory scan'], ['recon', 'Attacker reconnaissance'], ['fp', 'False positive'], ['unknown', 'Unknown']], accept: 'benign', explain: 'Matches the standing change.' },
    rootCause: { options: [['inventory', 'Approved inventory scan'], ['worm', 'A worm spreading'], ['misconfig', 'A misconfigured backup job'], ['user', 'A curious user']], accept: 'inventory', explain: 'Weekly discovery sweep.' },
    actions: { options: [['close', 'Close the ticket'], ['suppress_narrow', `Suppress the rule for ${INV.name} only during the change window`], ['block', `Block ${INV.name}`], ['suppress_all', 'Suppress the rule for all internal hosts']], set: ['close', 'suppress_narrow'], explain: 'A blanket suppression would hide a real scanner.' },
  },
  truth: { summary: `${INV.name} ran its weekly discovery sweep in the approved Tuesday window under standing change ${CHG}. Nothing malicious happened.`, timeline: [[-360, 'Sweep starts.'], [5, 'NET-0150 fires.']] },
  test: { tools: { l1_triage: [['asset', INV.name], ['change', '']] } },
});
