# ThreatWall — Implementation plan (30-task firewall track)

Source of truth: *SonicWall Firewall Track — Task Guide (Fresher to Expert)* (SonicOS 7.x, Classic mode).
Target version decision: **SonicOS 7.1 Classic mode** menu paths; where 7.0/7.3 differ, the 7.1 path is used and noted below.

## 1. Task inventory

| ID | Title | Pages used | Key values | Completion checks (saved state + simulation) |
|---|---|---|---|---|
| 0.1 | Cable the PC and get an address | Lab Tools › PC console | X0 192.168.168.168 | PC has 192.168.168.x (DHCP or static fallback); `ping 192.168.168.168` replied |
| 0.2 | Open the management page | Browser, cert warning, login | https://192.168.168.168 | Cert warning accepted; login page reached |
| 0.3 | Run the Setup Guide | Setup Guide | new admin password | Setup complete; default password rejected; dashboard reached |
| 0.4 | Learn the GUI layout | all six views | — | Visited HOME, MONITOR, DEVICE, NETWORK, OBJECT, POLICY + Interfaces, Addresses, Access Rules, Logs, Administration |
| 0.5 | Register and license | DEVICE › Settings › Licenses | serial + auth code | Registered; all services licensed |
| 0.6 | Back up before changes | DEVICE › Settings › Firmware and Settings | — | ≥1 local backup; export performed |
| 0.7 | Admin session basics | DEVICE › Settings › Administration | KGI-HQ-FW, 10 min | hostname = KGI-HQ-FW; timeout = 10 |
| 1.1 | Interfaces and zones | NETWORK › System › Interfaces | X1 203.0.113.10/29 gw .9 DNS 1.1.1.1/8.8.8.8 Ping only; X0 192.168.10.1/24 HTTPS/Ping/SSH | values exact; no WAN HTTPS/SSH/SNMP; reconnected to 192.168.10.1 |
| 1.2 | Default route and DNS | POLICY › Rules and Policies › Route Policy; DEVICE › Diagnostics | gw 203.0.113.9 | default route via X1 present; ping gw, 8.8.8.8, www.google.com succeed |
| 1.3 | DHCP server and reservations | NETWORK › System › DHCP Server | 192.168.10.100–.199, 1440 min, gw .1, DNS 1.1.1.1/8.8.8.8; PRINTER-01 .50 | scope + reservation exact; printer lease = .50 |
| 1.4 | MAC-IP anti-spoof | NETWORK › System › ARP, MAC-IP Anti-Spoof | ADMIN .5, HR .21, FIN .22, rogue blacklisted | cache entries from register MACs; X0 enforcement flags; rogue blocked & logged; FIN-PC works; admin still connected |
| 1.5 | Address objects and groups | OBJECT › Match Objects › Addresses | H_WEB-01, N_LAN-Staff, FQDN_update-site, G_Finance-PCs | objects exist with exact type/zone/value; group members |
| 1.6 | First access rule and outbound NAT | POLICY › Access Rules, NAT Rules; MONITOR › Logs | LAN-Web-Out, HTTP/HTTPS/DNS, logging | rule exact; default LAN→WAN Any disabled; web allowed, SSH denied (simulation); default NAT present |
| 2.1 | Service objects and schedules | OBJECT › Services, Schedules; Access Rules | TCP-8443, SG_SaaS (TCP-8443 + HTTPS), Office-Hours Mon–Sat 09–19, rule LAN-SaaS-Office-Hours | objects exact; rule uses SG_SaaS + Office-Hours; test allowed at 10:00, denied at 21:00 |
| 2.2 | Publish a web server | Interfaces (X2), Addresses, NAT, Access Rules | 203.0.113.11 → 172.16.10.100 HTTPS | X2 DMZ 172.16.10.1/24; NAT + WAN→DMZ HTTPS rule; HTTPS ok, HTTP/SSH fail |
| 2.3 | Rule order, shadowing, cleanup | Access Rules (seeded 10-rule set) | — | shadowed rule moved above broad rule & gets hits; zero-hit rules disabled; change log entries |
| 2.4 | VLANs and segmentation | Zones, Interfaces, DHCP, Access Rules, Lab Tools (trunk) | X0:V10 LAN 10.10.10.1/24, X0:V20 Finance 10.10.20.1/24, X0:V30 Guest 10.10.30.1/24; Guest-Web-Out, Guest-to-Finance-Deny | VLAN ifaces + zones + scopes; trunk on; guest → internet ok, guest → Finance denied & logged |
| 2.5 | Content filtering | Security Services › Content Filter; Profile Objects; CFS rules | CFS_Staff blocks Malware, Phishing, Adult, Proxy Avoidance, Streaming; allow video.example; policy CFS-LAN | CFS on; profile + policy on LAN; blocked category → block page + log; allowed site ok |
| 2.6 | Application control | Security Services › App Control; Zones | P2P/Proxy block+log, Social log | settings exact; P2P blocked, social allowed and logged |
| 2.7 | Local users and authentication | DEVICE › Users | group Staff, users priya + arjun | users in Staff; LAN→WAN rule Users Include Staff; unauth redirected, Staff allowed |
| 3.1 | IPS and gateway anti-virus | Security Services › IPS, GAV | High/Med prevent+detect, Low detect | settings exact; exploit test blocked; EICAR blocked; signature exclusion lets the business app work |
| 3.2 | DPI-SSL | POLICY › DPI-SSL › Client SSL; DEVICE › Certificates | exclusions: finance, health | enabled + inspections; CA exported & trusted on PCs; HTTPS EICAR blocked; bank site not inspected |
| 3.3 | SSL VPN with NetExtender | Addresses, SSL VPN Server/Client Settings, Users, Access Rules | SSLVPN_Pool .50.10–.50, port 4433 | WAN SSL VPN on; pool/routes; user in SSLVPN Services + TOTP; remote client → LAN ok, → DMZ denied |
| 3.4 | Site-to-site IPsec | Addresses, IPSec VPN (HQ + Branch peer) | HQ-to-Branch, IKEv2, ESP AES-256 SHA-256 PFS 14 | both sides mirror; tunnel up; Branch PC → 192.168.10.5 ok |
| 3.5 | Dual WAN with SD-WAN | Interfaces (X3), SD-WAN groups/probes/profiles, Route Policy, Lab Tools | X3 198.51.100.34/29 gw .33; WAN-Group, Probe-1.1.1.1, Internet-Failover, route SD-WAN-Internet | SD-WAN config; X1 failed → browsing via X3; recovery → X1 |
| 4.1 | High availability | DEVICE › High Availability | Active/Standby, secondary 7C3A19E40C11, stateful sync, monitor X0+X1 | HA configured & synced; primary failure → secondary active, session survives |
| 4.2 | Packet-flow troubleshooting | MONITOR › Packet Monitor (seeded fault: route ERP-Legacy-Path to dead next hop) | capture dst 192.0.2.20:443 | capture shows drop + reason; fault fixed; second capture forwarded; evidence attached |
| 4.3 | IPsec troubleshooting | IPSec VPN HQ/Branch, Logs (3 seeded faults) | — | each fault fixed with RCA note; tunnel up |
| 4.4 | Hardening and audit | Interfaces, Administration, Certificates, Log › Syslog, Firmware | admin kgi-fwadmin, TOTP, lockout 5/30 min, HTTPS 4443, internal-CA cert, syslog 192.168.10.250, weekly export | no WAN mgmt; admin renamed; lockout; port ≠ 443; TOTP; cert replaced; syslog; weekly export; audit sheet clear |
| 4.5 | Capstone: contain a host | Logs, Addresses, Access Rules, Botnet, Anti-Spoof (X0:V10), Packet Monitor, Report | synthetic C2 192.0.2.66; beaconing host STAFF-LAPTOP 10.10.10.100 | beacon identified; deny rule above allows (logged); host quarantined; evidence exported; report complete |

## 2. GUI page inventory (route → page)

HOME: Dashboard › System · Dashboard › Topology · Training › Report
MONITOR: Real-Time Charts › System Monitor · Logs › System Logs · Logs › Auditing Logs · Tools & Monitors › Packet Monitor · Tools & Monitors › Connections
DEVICE: Settings › Licenses · Administration · Time · Certificates · Firmware and Settings · High Availability › Status · Settings · Monitoring · Users › Status · Settings · Local Users & Groups · Log › Syslog · Diagnostics › Diagnostic Tools
NETWORK: System › Interfaces · Zones · ARP · MAC IP Anti-Spoof · DHCP Server · DNS › DNS Settings · SDWAN › SD-WAN Groups · SLA Probes · Path Selection Profiles · IPSec VPN › Rules and Settings · Branch Peer (lab) · SSL VPN › Status · Server Settings · Client Settings
OBJECT: Match Objects › Zones · Addresses · Services · Schedules · Profile Objects › Content Filter
POLICY: Rules and Policies › Access Rules · NAT Rules · Routing Rules · Content Filter Rules · DPI-SSL › Client SSL · Security Services › Summary · Gateway Anti-Virus · Intrusion Prevention · App Control · Content Filter · Botnet Filter

Zones appear under both OBJECT › Match Objects (as in the 7.x reference capture) and NETWORK › System (as written in the guide); both show the same state.

## 3. Configuration dependency map

- Interfaces → zones (membership), built-in address objects (`X0 IP`, `X0 Subnet`…), connected routes, DHCP scope validity, management reachability, NAT egress, anti-spoof interface list, SD-WAN members.
- Zones → access-rule zone pairs, security-service enablement per zone, SSL VPN zone toggles.
- Address objects/groups → access rules, NAT, routes, SSL VPN pool/routes, IPsec networks, CFS exclusions, capstone block.
- Services/groups → access rules, NAT, routes. Schedules → access rules (lab clock).
- DHCP scopes/statics → lab host addresses → ARP → anti-spoof cache.
- Users/groups → access rules (Users Include), SSL VPN access.
- Licenses → CFS, App Control, IPS, GAV, DPI-SSL, SSL VPN, HA availability.
- Routes + SD-WAN health → egress choice → NAT → traffic results.
- IPsec HQ+Branch policies → tunnel state → VPN routes → branch traffic.
- HA settings + lab power control → active unit → traffic continuity.
- Every evaluated flow → hit counters, system logs, packet monitor buffer.

## 4. Shared state design

One `RootState` in a single store (`src/state`): `config` (everything the appliance holds, incl. Branch peer and HA peer), `session` (learner workstation + browser session), `lab` (lab-only controls: ISP links, trunk, HA unit power, lab clock, scenario seeds), `progress` (task/step status, evidence, events), `audit`, `logs`. Pages validate through `services/*` (pure functions) and call `commit(next, audit)`. The engine (`src/engine/*`) is pure and deterministic: given state + a flow, it returns a verdict, a trace and side effects (hits, logs, captures) which the store applies. Verification (`src/tasks/*`) is pure over saved state + recorded evidence; it never reads UI flags.

Persistence: browser localStorage (versioned). Note: with no backend, a determined learner can edit localStorage. Verification functions are pure and portable so they can run server-side when ThreatWall gets an API (planned for ThreatReady integration).

## 5. Plan

1. Core model + engine + unit tests.
2. Task framework: event bus, step predicates, auto-advance, verification, stale detection, guidance overlay, task panel, beginner/practice modes, Lab Tools.
3. Pages + tasks in source order: L0 → L1 → L2 → L3 → L4, committing per level.
4. Capstone, final report, end-to-end browser test from first login to report.

## 6. Version notes / documented fallbacks

- Classic vs Policy mode: Classic paths throughout.
- Zones: OBJECT › Match Objects (7.x capture) + NETWORK › System alias (guide).
- Static routes: POLICY › Rules and Policies › Route Policy (7.1 Classic doc); the 7.x capture labels it "Routing Rules" — page title uses "Routing Rules", breadcrumb alias shows both.
- CFS, App Control, IPS, DPI-SSL, SD-WAN, HA paths confirmed against the 7.3 demo captures supplied; SD-WAN sub-pages follow the 7.1 doc names.
- Branch firewall and HA peer are lab-only views, labelled as such.

## 7. Build status (all stages)

All 30 tasks are implemented and verified three ways:
1. `npm test` — engine tests plus, for every task, its checks fail on the state just before it and pass after the answer-key configuration (`src/tasks/solutions.ts`), and no later task makes an earlier one stale.
2. `npm run e2e` — a Playwright run performs every task through the GUI from a blank browser tab to the training report (30/30 completed, 0 spurious failed attempts).
3. Manual review of each page at 100 % zoom (1600×900).

Further documented choices:
- VLAN subnets use 10.10.{10,20,30}.0/24 so they never overlap the Branch LAN 192.168.20.0/24 (task 3.4).
- The capstone beaconing host is STAFF-LAPTOP (VLAN 10). Quarantining it does not invalidate earlier tasks, which test HR-PC/FIN-PC.
- Deny rules from tasks 2.3 and 4.5 only need to sit above every allow rule of LAN→WAN, so both can coexist at the top.
- HTTPS management moves to port 4443 in task 4.4 (not 8443, which the SaaS service uses in 2.1).
- The lab TOTP code is derived from the user name and the 30-second window in the browser. It is not a real authenticator secret.
