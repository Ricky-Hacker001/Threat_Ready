import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Network Security: segmentation, firewalls, lateral movement and where to detect it. The diagram
 * is zones, firewalls, VPNs and the paths between them; the attack is movement across them.
 */
export const NETWORK_SECURITY: ReasoningDomain = {
  key: 'network_security',
  title: 'Network Security',
  description: 'Read a network architecture with an intruder moving laterally, decide which path, rule or boundary the movement depends on, and defend the decision with evidence from firewall, flow and DNS logs.',
  track: 'Network Security',
  difficulty: 'intermediate',
  focus: [
    'Segmentation that holds versus segmentation that only exists on a diagram',
    'Reading firewall rules, NAT and routing as the attacker does',
    'Lateral movement protocols and the telemetry that shows them',
    'Containment at the network layer without cutting off the responders',
  ],
  skillIds: ['netsec.segmentation', 'netsec.firewalls_ids', 'netsec.traffic_analysis', 'netsec.protocols', 'soc.threat_detection'],
  weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1046', 'Network Service Discovery'),
    T('T1018', 'Remote System Discovery'),
    T('T1021.001', 'Remote Services: Remote Desktop Protocol'),
    T('T1021.002', 'Remote Services: SMB/Windows Admin Shares'),
    T('T1021.004', 'Remote Services: SSH'),
    T('T1570', 'Lateral Tool Transfer'),
    T('T1557.001', 'Adversary-in-the-Middle: LLMNR/NBT-NS Poisoning and SMB Relay'),
    T('T1557.002', 'Adversary-in-the-Middle: ARP Cache Poisoning'),
    T('T1040', 'Network Sniffing'),
    T('T1133', 'External Remote Services'),
    T('T1090', 'Proxy'),
    T('T1090.003', 'Proxy: Multi-hop Proxy'),
    T('T1572', 'Protocol Tunneling'),
    T('T1071.004', 'Application Layer Protocol: DNS'),
    T('T1048.003', 'Exfiltration Over Alternative Protocol: Exfiltration Over Unencrypted Non-C2 Protocol'),
    T('T1595', 'Active Scanning'),
    T('T1190', 'Exploit Public-Facing Application'),
    T('T1210', 'Exploitation of Remote Services'),
    T('T1599', 'Network Boundary Bridging'),
    T('T1498', 'Network Denial of Service'),
  ],
  variation: {
    topologies: [
      { id: 'campus_three_zone', label: 'Corporate campus with user, server and DMZ zones', guide: 'A perimeter firewall with a DMZ, a core switch with user VLANs, a server VLAN with domain controllers and file servers, a wireless network, and a flat printer and IoT VLAN.' },
      { id: 'branch_sdwan', label: 'Branch offices over SD-WAN to a data centre', guide: 'Twenty branches with local internet breakout, SD-WAN tunnels to a data centre, a central firewall, a branch guest Wi-Fi, and point-of-sale devices on the branch LAN.' },
      { id: 'dc_east_west', label: 'Data centre with east-west microsegmentation', guide: 'Virtualised servers with a distributed firewall, application tiers as security groups, a jump host zone, a backup network, and a management network with out-of-band access.' },
      { id: 'remote_access_vpn', label: 'Remote workforce over client VPN and ZTNA', guide: 'A VPN concentrator with split tunnelling, a ZTNA broker for some apps, an MFA integration, a posture check, and a legacy full-tunnel profile for contractors.' },
      { id: 'ot_plant', label: 'Manufacturing plant with an OT network', guide: 'An IT network, a DMZ with a historian and jump server, an OT network with PLCs and HMIs, a vendor remote-access path, and an engineering workstation that straddles both.' },
      { id: 'cloud_hybrid_transit', label: 'Hybrid network with a cloud transit hub', guide: 'A transit hub connecting on-premises via a private link, several cloud VPCs or VNets, a central inspection firewall, a shared services network with DNS, and a legacy VPC peered directly.' },
      { id: 'hospital_clinical', label: 'Hospital with clinical and administrative networks', guide: 'Clinical devices on a medical VLAN, an EHR server zone, administrative workstations, a guest network, a vendor support VPN, and a PACS imaging segment.' },
      { id: 'colo_multi_tenant', label: 'Colocation with multiple tenant networks', guide: 'Shared core switching, per-tenant VLANs and firewalls, a shared management network, cross-connects to a partner, and a storage network.' },
    ],
    entryPoints: [
      { id: 'vpn_cred_no_mfa', label: 'VPN access with a stolen credential and no MFA', guide: 'A contractor profile on the VPN has no MFA and a full tunnel; the first session comes from a hosting provider at 03:00.' },
      { id: 'exposed_rdp', label: 'RDP exposed to the internet on a forgotten host', guide: 'A NAT rule forwards 3389 to a server in the server VLAN; brute force succeeds against a local admin account.' },
      { id: 'phished_workstation', label: 'A phished workstation in the user VLAN', guide: 'A user runs a malicious attachment; the implant beacons out over HTTPS and the workstation can reach every internal subnet.' },
      { id: 'rogue_wifi', label: 'An attacker on the guest wireless that is not isolated', guide: 'Guest Wi-Fi shares a VLAN or has a permissive firewall rule to the corporate network; ARP and LLMNR traffic is visible.' },
      { id: 'vendor_remote', label: 'A vendor remote-access path with standing credentials', guide: 'A vendor support tunnel into the OT or server zone uses a shared account and never expires.' },
      { id: 'dmz_web_exploit', label: 'A DMZ web server compromised through an application flaw', guide: 'The DMZ server can initiate connections into the server VLAN on database and management ports.' },
      { id: 'printer_iot', label: 'An IoT or printer device with default credentials', guide: 'The device sits on a flat VLAN, stores domain credentials for scan-to-share, and can reach the file servers.' },
      { id: 'peering_misroute', label: 'A legacy network peered directly around the inspection firewall', guide: 'Routing sends traffic from the legacy segment straight to production, bypassing the central firewall.' },
      { id: 'firewall_mgmt_exposed', label: 'A firewall management interface reachable from a user network', guide: 'The management plane listens on the user VLAN with a default or shared password.' },
      { id: 'supply_chain_switch', label: 'A compromised network appliance with a backdoored firmware', guide: 'The appliance can mirror traffic and open rules; its logs are the only record of its own actions.' },
    ],
    objectives: [
      { id: 'break_the_path', label: 'The single rule or boundary change that breaks the movement', guide: 'Ask which one firewall rule, segmentation, routing or access change stops the attacker reaching the objective; distractors are sound controls that address a different hop or do not apply to this protocol.', question: 'Which single change most directly breaks the attack path shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'fastest_hop', label: 'The fastest path from the current position to the target', guide: 'Ask which hop or path the attacker takes to the target segment from where they are; distractors are paths that look shorter but are blocked by a rule, NAT or routing shown.', question: 'From the compromised position, which path reaches the target with the fewest additional hops?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'detect_first', label: 'Where the movement would be detected first', guide: 'Ask which telemetry (firewall log, flow records, DNS log, IDS, switch logs, endpoint) would show this hop first given what is on the diagram; distractors exist but do not see this traffic (for example an IDS that is not on the east-west path).', question: 'Which telemetry source would reveal this attacker first, given the controls shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'contain_now', label: 'The first containment action at the network layer', guide: 'Ask for the first network action that stops the movement without cutting responders, logging or critical operations; distractors are too broad (pull the uplink), too narrow (block one IP), or lose evidence.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'segment_reach', label: 'What the attacker can reach from the compromised segment', guide: 'Ask which segments, services and devices are reachable from the compromised host given the rules, NAT, routing and VPN profiles on the diagram; distractors miss or invent a path.', question: 'What can the attacker now reach from the compromised position?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'rule_fix', label: 'The rule change with the most effect', guide: 'Ask which rule, VLAN, routing or VPN profile change reduces the exposure most while the business keeps working; distractors reduce risk less or break a required flow.', question: 'Which rule or segmentation change reduces the blast radius most without breaking required traffic?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'priority_order', label: 'The right order of two steps under a constraint', guide: 'Ask which of two necessary actions must come first given the constraint (for example capture traffic before isolating, or isolate the OT jump before the IT cleanup); distractors invert the order.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
    ],
    constraints: [
      { id: 'plant_running', label: 'The plant is mid-shift; stopping production costs a day of output', guide: 'OT containment must not drop control traffic.' },
      { id: 'change_board', label: 'Firewall changes need change-board approval except for emergencies', guide: 'Know what qualifies as an emergency change and what can wait.' },
      { id: 'no_netflow', label: 'Flow logging is enabled only at the perimeter', guide: 'East-west visibility is limited; choose detections that exist.' },
      { id: 'remote_responders', label: 'The response team works remotely over the same VPN', guide: 'Do not cut the path the responders use.' },
      { id: 'clinical_safety', label: 'Clinical devices must keep network access for patient safety', guide: 'Isolation must not touch the medical VLAN’s required flows.' },
      { id: 'flat_legacy', label: 'A legacy flat segment cannot be re-addressed this quarter', guide: 'Controls must wrap around it.' },
      { id: 'single_firewall_admin', label: 'One engineer holds firewall admin and is on leave', guide: 'Prefer actions available to the on-call team.' },
    ],
    components: [
      'perimeter firewall', 'internal firewall', 'distributed firewall', 'core switch', 'access switch', 'user VLAN', 'server VLAN', 'DMZ', 'guest Wi-Fi', 'IoT VLAN', 'printer', 'domain controller', 'file server', 'jump host', 'bastion', 'VPN concentrator', 'ZTNA broker', 'SD-WAN edge', 'NAT rule', 'static route', 'VPC peering', 'transit hub', 'IDS/IPS sensor', 'network TAP', 'flow collector', 'DNS resolver', 'DNS log', 'firewall log', 'proxy', 'OT historian', 'PLC', 'HMI', 'engineering workstation', 'vendor remote-access gateway', 'backup network', 'out-of-band management',
    ],
  },
  guidance: `Network Security realism rules:
- Use concrete names (for example "fw-core rule 142", "VLAN 30 servers", "jump-01", "vpn-contractors profile") with ports and protocols where it matters (445/SMB, 3389/RDP, 22/SSH, 53/DNS, 502/Modbus). Never invent vendor features that do not exist.
- The attack path must be technically valid hop by hop: each hop uses a permitted rule, a NAT, a route, a VPN profile, a shared credential or a protocol the diagram shows. If a firewall rule, an isolated VLAN, a one-way DMZ, or an inspection point on the diagram would block a hop, the path must go around it or the narrative must say why it did not apply (a permissive "any" rule, a bypass route, a rule order mistake).
- Say what each telemetry source can actually see: perimeter flow logs do not see east-west traffic; an IDS sees only the links it taps; a DNS log sees names, not payloads.
- Trust boundaries are real boundaries: internet, DMZ, user zone, server zone, OT zone, management plane, cloud, branch, vendor.
- The best answer must be the one an experienced network security engineer would choose for this exact diagram and constraint; the distractors must be sound network controls in general that do not break this path, address a later hop, or violate the constraint.
- Cite techniques from the ATT&CK Enterprise matrix only, favouring Discovery, Lateral Movement, Command and Control and Exfiltration.`,
};
