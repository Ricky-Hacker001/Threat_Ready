/**
 * Learning notebook: the long-form explanation behind every task.
 * The task panel tells the learner WHAT to click; this tells them what is really happening and why.
 * Lab values come from the task definitions at render time, so this file holds only the teaching text.
 * Inline `code` is rendered in monospace.
 */
/** Pre-rendered PDF of the notebook, served from public/ (regenerate with `npm run notebook:pdf`). */
export const NOTEBOOK_PDF = `${import.meta.env.BASE_URL}notebook/ThreatReady-Firewall-Learning-Notebook.pdf`;

export interface Lesson {
  diagram: string;
  caption: string;
  concept: string[];          // what it actually is, in plain words
  how: string[];              // what happens under the hood
  terms: [string, string][];  // key terms
  job: string;                // how this shows up at work
  check: { q: string; a: string }[];
}

export const LEVEL_INTRO: Record<number, string> = {
  0: 'Level 0 takes you from a boxed appliance to a safe first login. Nothing here is advanced, but every later task depends on it: a PC that can reach the firewall, a management page you trust, a password that is not the factory one, a licence, a backup, and an admin session that closes itself.',
  1: 'Level 1 builds a working, safe office network: the internet link, the office subnet, addresses handed out automatically, protection against address theft, named objects, and the first rule that lets staff browse while everything else stays closed.',
  2: 'Level 2 is the daily work of a junior firewall engineer: opening a port only when needed, publishing a server safely, cleaning up a rule set you inherited, splitting the network into segments, and controlling websites, applications and users.',
  3: 'Level 3 adds the features that separate a router from a security gateway: threat signatures, inspection of encrypted traffic, remote access for staff, a tunnel to the branch office, and a second internet link that takes over on its own.',
  4: 'Level 4 is production: two firewalls acting as one, troubleshooting from evidence instead of guesses, fixing a broken VPN from its log, hardening the box until an auditor has nothing to write, and finally containing a compromised computer.',
};

export const LESSONS: Record<string, Lesson> = {
  '0.1': {
    diagram: 'dhcp', caption: 'The PC gets its address in four messages, then proves the path with ping.',
    concept: [
      'Before you can configure anything, your computer must be able to talk to the firewall. Computers talk to each other with IP addresses, and two machines on the same cable can only talk directly if their addresses are in the same subnet: the same street, if an address is a house number.',
      'A new firewall manages itself on port X0 at `192.168.168.168` and runs a DHCP server there. DHCP is the service that hands out addresses automatically, so you do not have to type one into the PC.',
    ],
    how: [
      'When you plug in the cable, the PC shouts on the wire: "is there a DHCP server?" (DISCOVER). The firewall offers a free address from its pool `192.168.168.100–.199` (OFFER). The PC asks to keep it (REQUEST) and the firewall confirms, adding the gateway and DNS servers (ACK). `ipconfig` shows the result.',
      '`ping` sends a small ICMP "echo request" and waits for an "echo reply". A reply proves three things at once: the cable works, both sides are in the same subnet, and the firewall is alive. "General failure" means the PC has no usable address yet; "Request timed out" means the address is fine but nothing answers.',
    ],
    terms: [['IP address', 'The number that identifies a device on a network, e.g. 192.168.168.100.'], ['Subnet', 'The group of addresses that can talk directly. /24 means the first three numbers must match.'], ['DHCP', 'Automatic address assignment: discover, offer, request, acknowledge.'], ['ping (ICMP)', 'A reachability test: one echo request, one echo reply.']],
    job: 'On a real site the first hour is exactly this: a laptop, a cable and a console. If `ipconfig` shows an address starting with 169.254, DHCP failed and the PC gave itself a useless "link-local" address. Check the cable and the port before anything else.',
    check: [{ q: 'ipconfig shows 169.254.10.3. What happened?', a: 'No DHCP server answered, so Windows picked a link-local address. Check the cable is in X0 and the link is up.' }, { q: 'Why must the PC be in 192.168.168.x?', a: 'The firewall is 192.168.168.168/24; only addresses in that subnet can reach it without a router.' }],
  },
  '0.2': {
    diagram: 'tls', caption: 'The warning is about who signed the certificate, not about the firewall being broken.',
    concept: [
      'The management page is a website served by the firewall over HTTPS. HTTPS encrypts the connection and uses a certificate to prove the site is who it claims to be. Browsers trust certificates signed by a short list of certificate authorities (CAs).',
      'A brand-new appliance has no CA-signed certificate. It signs its own ("self-signed"), so the browser cannot verify it and shows a warning. On a box you have just cabled to your own PC, that warning is expected. On a site you use every day, the same warning could mean someone is intercepting your traffic.',
    ],
    how: [
      'Your browser connects to `https://192.168.168.168`. The firewall presents its certificate. The browser looks up who signed it, finds no trusted CA, and stops to ask you. The encryption still works; what is missing is proof of identity.',
      'Before clicking Proceed, read the address in the warning. It must be the one you typed, on a cable you control. In task 4.4 you replace this certificate with one from an internal CA that the PCs already trust, and the warning disappears for good.',
    ],
    terms: [['HTTPS / TLS', 'Encrypted web traffic. TLS is the protocol underneath.'], ['Certificate', 'A signed statement: "this key belongs to this name".'], ['Certificate authority (CA)', 'An issuer that browsers trust to sign certificates.'], ['Self-signed', 'A certificate signed by its own key. Encrypted, but unverified.']],
    job: 'Teaching people to click through every certificate warning is how interception attacks succeed. Accept a self-signed warning only on equipment you physically control, and fix it properly (internal CA) as soon as the device is in service.',
    check: [{ q: 'Is a self-signed connection encrypted?', a: 'Yes. The warning is about identity, not encryption.' }, { q: 'Why not use http:// to avoid the warning?', a: 'The appliance does not serve management over plain HTTP, and plain HTTP would send your password in clear text.' }],
  },
  '0.3': {
    diagram: 'setup', caption: 'The Setup Guide walks the essentials in a fixed order and ends with a fresh sign-in.',
    concept: [
      'Every appliance ships with the same factory login, printed in every manual and known to every attacker. The first job on any new device is to replace it.',
      'The Setup Guide is a wizard that forces the essentials in one pass: a strong password, the device name and the time zone. Interfaces are left as they are on purpose: changing X0 now would cut the cable you are using to manage the box.',
    ],
    how: [
      'You sign in with `admin / password`. The wizard refuses to continue until the new password meets the policy (12+ characters with upper case, lower case, digits and a symbol). The firewall name `KGI-HQ-FW` will appear in logs, alerts and backups, so every record says which box it came from.',
      'The time zone matters more than it looks: log timestamps, schedules (task 2.1) and one-time codes (tasks 3.3 and 4.4) all depend on the clock. When you click Apply the settings are written and your old session ends, so you sign in again with the new password.',
    ],
    terms: [['Default credentials', 'The factory username and password, public for every unit.'], ['Hostname', 'The device name used in logs, alerts and backups.'], ['Password policy', 'Rules a password must meet: length and character types.']],
    job: 'Automated scanners try default logins on every exposed device within minutes. Changing them is item one on every hardening checklist and every audit. Use a password manager, never a password you use anywhere else.',
    check: [{ q: 'Why keep WAN on DHCP and LAN unchanged in the wizard?', a: 'Each is configured properly in task 1.1. Changing X0 here would disconnect the PC you are working from.' }, { q: 'What else depends on the time zone?', a: 'Log timestamps, rule schedules and one-time passwords.' }],
  },
  '0.4': {
    diagram: 'gui', caption: 'Six views, each with its own left menu. Pages save only on Accept or OK.',
    concept: [
      'A firewall GUI is large. Knowing where things live is a skill in itself, because during an outage you will not have time to hunt for the logs page.',
      'The GUI is split into six views across the top. HOME is the overview, MONITOR is what is happening now (charts, logs, packet capture), DEVICE is the box itself (settings, users, HA), NETWORK is how it connects (interfaces, DHCP, VPN, SD-WAN), OBJECT is the named building blocks, and POLICY is the decisions: access, NAT, routing and security services.',
    ],
    how: [
      'Every page shows a breadcrumb such as `KGI-HQ-FW › Network › System › Interfaces`. Use it to tell someone exactly where to look. Changes are not live until you click Accept (settings pages) or OK (dialogs). Navigating away discards them.',
      'A common surprise: routes are not under NETWORK. In this classic layout they are under POLICY › Rules and Policies › Routing Rules, because a route is a decision about where traffic goes.',
    ],
    terms: [['View', 'One of the six top-level areas.'], ['Breadcrumb', 'The path to the current page.'], ['Accept / OK', 'The buttons that actually save a change.']],
    job: 'On a support call you will often guide someone else through the GUI. Saying "POLICY, Rules and Policies, Access Rules, LAN to WAN" gets them there in seconds.',
    check: [{ q: 'Where are routes?', a: 'POLICY › Rules and Policies › Routing Rules.' }, { q: 'You change a field and open another page. Is it saved?', a: 'No. Only Accept or OK saves.' }],
  },
  '0.5': {
    diagram: 'license', caption: 'Registration turns the serial number into active service licences.',
    concept: [
      'The basic firewall (routing, rules, NAT) works out of the box. The security services (content filter, intrusion prevention, gateway anti-virus, DPI-SSL, SSL VPN capacity, HA) are subscriptions that only run when the appliance is registered and licensed.',
      'The dangerous part: an unlicensed service still has its settings page and its Enable box. It looks configured while doing nothing. That is a false sense of protection.',
    ],
    how: [
      'Each unit has a serial number and an authentication code. Registering ties them to an account and downloads the licence keys. In this lab the registration service is simulated and any `.example` address works; you never enter a real vendor account.',
      'After registering, DEVICE › Licenses must show every service as Licensed with an expiry date. Expiry dates matter: when a licence lapses, signatures stop updating and protection quietly ages.',
    ],
    terms: [['Serial number', 'Unique hardware identity of the unit.'], ['Authentication code', 'A second code proving you hold that unit.'], ['Subscription service', 'A feature that needs an active licence and updates.']],
    job: 'Licence expiry is a frequent audit finding. Put renewal dates in a calendar and check the licence page after every renewal.',
    check: [{ q: 'IPS is enabled but the licence expired. Are you protected?', a: 'No. Without a licence the service does not inspect or update.' }, { q: 'Common typing mistake in the serial?', a: 'The letter O instead of the digit 0.' }],
  },
  '0.6': {
    diagram: 'backup', caption: 'A local backup fixes a bad change; only an exported file survives a dead unit.',
    concept: [
      'Everything from task 1.1 onwards can lock you out or break the network. A backup taken before you start turns a disaster into a two-minute restore.',
      'There are two kinds. A local backup is a snapshot stored on the appliance itself, quick to roll back to. An export is a file you keep somewhere else. If the hardware fails, the local backup dies with it; the export does not.',
    ],
    how: [
      'Create Backup saves the current configuration with a comment. Write why you took it ("Before changes") so that months later someone can pick the right one. Export Configuration downloads a file you store off the box: a share, a password vault, a ticket.',
      'Restoring a backup replaces the running configuration with the saved one. That is why you take one before each change window, not after.',
    ],
    terms: [['Running configuration', 'What the firewall is doing right now.'], ['Local backup', 'A snapshot kept on the appliance.'], ['Export', 'A configuration file stored off the appliance.']],
    job: 'A change ticket in most companies requires "backup taken: yes" before work starts. Name backups with the date and the reason.',
    check: [{ q: 'The firewall will not boot. Which copy helps?', a: 'Only the exported file.' }, { q: 'Why comment a backup?', a: 'So the right restore point can be found later.' }],
  },
  '0.7': {
    diagram: 'session', caption: 'Idle sessions close themselves, and every change lands in the audit log.',
    concept: [
      'An admin session left open on an unattended PC is an open door: anyone passing by has full control of the firewall. An idle timeout closes it automatically.',
      'The audit log records every configuration change with time, user and detail. It is how you answer "who changed this, and when?".',
    ],
    how: [
      'DEVICE › Settings › Administration holds the firewall name and "Log out the administrator after inactivity of". Ten minutes is a common balance between safety and convenience. Accept saves it, and the change appears at the top of MONITOR › Logs › Auditing Logs.',
      'The timeout counts from your last click or key press. When it expires you return to the login page and nothing unsaved is kept.',
    ],
    terms: [['Idle timeout', 'Automatic logout after a period without activity.'], ['Audit log', 'A record of configuration changes: who, what, when.']],
    job: 'Auditors ask for both: a session timeout and an audit trail they can sample. Get used to checking the audit log after each change; it is also your proof that the change was made.',
    check: [{ q: 'Where do you prove a setting was changed?', a: 'MONITOR › Logs › Auditing Logs.' }, { q: 'Why ten minutes and not two hours?', a: 'The shorter the idle window, the smaller the chance someone else uses your session.' }],
  },
  '1.1': {
    diagram: 'zones', caption: 'WAN answers only ping; the office lives on X0 in 192.168.10.0/24.',
    concept: [
      'Each physical port (X0, X1, X2…) has an address and belongs to a zone. The address decides which subnet the port serves. The zone is a security label (LAN, WAN, DMZ) and decides which rules apply to traffic entering or leaving that port.',
      'The ISP gave the office a small public block, `203.0.113.8/29`: eight addresses, of which `.9` is their router and `.10` is ours. The office itself uses the private network `192.168.10.0/24`, so X0 moves from the factory address to `192.168.10.1`.',
    ],
    how: [
      'A subnet mask says which part of an address is the network. `255.255.255.248` (/29) leaves 3 bits for hosts: 8 addresses. `255.255.255.0` (/24) leaves 8 bits: 256. Typing /24 on the WAN would make the firewall think half the internet is "local" and stop routing to it.',
      'Management settings decide which services the firewall answers on each port. X1 faces the internet, so it answers ping only: HTTPS or SSH there would invite password attacks from everywhere. When you re-address X0 your session drops, because the PC is still in the old subnet. You give ADMIN-PC `192.168.10.5`, browse to `https://192.168.10.1`, and you are back.',
    ],
    terms: [['Interface', 'A port on the firewall (X0, X1…), physical or virtual.'], ['Zone', 'A trust label on interfaces. Rules are written between zones.'], ['Subnet mask / CIDR', '255.255.255.248 = /29 = 8 addresses.'], ['Management access', 'Which admin services (HTTPS, SSH, ping) a port answers.']],
    job: 'Never leave HTTPS or SSH management open on the WAN "just for now". Exposed management pages are among the most exploited entry points on firewalls. Manage from inside, or through the VPN.',
    check: [{ q: 'Why did the GUI stop answering after you changed X0?', a: 'The PC was still in 192.168.168.x and could no longer reach the new address.' }, { q: 'How many addresses does /29 contain?', a: 'Eight: network, six usable hosts, broadcast.' }],
  },
  '1.2': {
    diagram: 'routing', caption: 'Anything not local follows the default route; names are resolved by DNS first.',
    concept: [
      'A route tells the firewall where to send traffic for a destination. The default route, `0.0.0.0/0`, means "everything I have no better route for" and points to the ISP router. Without it the firewall knows only its own subnets.',
      'DNS turns names such as `www.search.example` into addresses. People and applications use names; packets need addresses. If DNS fails, "the internet is down" even though routing is fine.',
    ],
    how: [
      'For each packet the firewall finds the most specific matching route. `192.168.10.21` matches the X0 subnet; a public address matches only `0.0.0.0/0` and leaves via X1 to `203.0.113.9`. That route was created for you from X1’s gateway in task 1.1.',
      'Troubleshoot in layers from the firewall’s own Diagnostics: ping the gateway (is the first hop alive?), ping a public address (does routing work?), resolve a name (does DNS work?). Then repeat from a client with `nslookup` to prove the PC side.',
    ],
    terms: [['Route', 'Destination network + next hop (gateway) + interface.'], ['Default route', '0.0.0.0/0, the route of last resort.'], ['DNS', 'The service that resolves names to addresses.'], ['Next hop', 'The router a packet is handed to.']],
    job: 'Gateway, public IP, name: this three-step test is the first thing to run for any "no internet" ticket. It tells you in a minute which layer is broken.',
    check: [{ q: 'Ping 8.8.8.8 works but websites do not open. Likely cause?', a: 'DNS. Routing is fine, name resolution is not.' }, { q: 'What does 0.0.0.0/0 match?', a: 'Every destination not matched by a more specific route.' }],
  },
  '1.3': {
    diagram: 'dhcp2', caption: 'The same four-step exchange on the office scope; the printer always receives its reserved address.',
    concept: [
      'A DHCP scope is the range of addresses the firewall may lease on one interface, together with the options it hands out: gateway, DNS servers and lease time.',
      'After task 1.1 the X0 scope still offers `192.168.168.x`, which no longer matches X0. New devices would get nothing. A reservation ties one MAC address to one IP so devices such as printers always get the same address.',
    ],
    how: [
      'The scope `192.168.10.100–.199` leaves `.1–.99` for fixed devices: the firewall (`.1`), ADMIN-PC (`.5`), the printer (`.50`), servers. Lease time 1440 minutes means a PC keeps its address for a day before it must renew.',
      'The reservation matches the printer’s MAC `00:1a:2b:3c:4d:50` and always answers it with `192.168.10.50`. It must be outside the dynamic range, otherwise two devices could be given the same address.',
    ],
    terms: [['Scope', 'Address range plus options served by DHCP on one interface.'], ['Lease', 'How long a client may keep its address.'], ['Reservation', 'A fixed MAC → IP mapping inside DHCP.'], ['MAC address', 'The hardware address of a network card.']],
    job: 'Printers, cameras and servers that change address break silently: the print queue still points at the old one. Reserve them, and keep reservations outside the dynamic pool.',
    check: [{ q: 'Why is .50 outside .100–.199?', a: 'So the server never offers it to another device.' }, { q: 'What gateway should clients get?', a: '192.168.10.1, the new X0 address.' }],
  },
  '1.4': {
    diagram: 'spoof', caption: 'The cache says which MAC owns each IP; anything else is dropped and logged.',
    concept: [
      'On a local network, devices find each other with ARP: "who has 192.168.10.22?" Any device can answer, and the last answer wins. A laptop that claims FIN-PC’s address steals its traffic. That is both an outage for Finance and a classic attack (ARP spoofing).',
      'MAC-IP anti-spoof keeps a cache of the correct IP↔MAC pairs per interface and drops traffic that does not match, or that comes from a blacklisted MAC.',
    ],
    how: [
      'You first prove the problem: FIN-PC’s test fails and the ARP table shows `192.168.10.22` belongs to `de:ad:be:ef:00:99`, an unknown vendor. You then record the real pairs from the asset register, blacklist the laptop’s MAC, and enable Enforce on X0.',
      'Order matters. If you enforce before your own PC is in the cache, and with Allow Management off, the firewall drops your own traffic: instant lockout. Blacklist by MAC, not IP: an attacker can change IP in seconds.',
    ],
    terms: [['ARP', 'How a device finds the MAC address for an IP on the local network.'], ['ARP spoofing', 'Answering ARP for an address that is not yours.'], ['Anti-spoof cache', 'Trusted IP↔MAC pairs the firewall enforces.'], ['Blacklist', 'MACs that are always dropped.']],
    job: 'MAC addresses can be spoofed too, so this is one layer, not the whole answer. In larger networks the same idea lives on the switch (port security, 802.1X). The log alert is your evidence for the incident ticket.',
    check: [{ q: 'Why add ADMIN-PC first?', a: 'Enforcement drops anything not in the cache, including your management PC.' }, { q: 'Why blacklist the MAC and not the IP?', a: 'The IP is borrowed; the MAC identifies the device.' }],
  },
  '1.5': {
    diagram: 'objects', caption: 'Rules point at names; change an address once and every rule follows.',
    concept: [
      'An address object gives a name to a host, network, range or domain name: `H_WEB-01`, `N_LAN-Staff`, `FQDN_update-site`. A group bundles objects: `G_Finance-PCs`.',
      'Rules then refer to names, not raw numbers. When the web server moves, you edit one object instead of twenty rules, and an auditor reading `N_LAN-Staff → Any` understands it immediately.',
    ],
    how: [
      'Each object also has a zone. The firewall uses it for zone-aware checks: an object for a LAN host placed in the WAN zone silently fails to match where you expect. A network object must use the network address (`192.168.10.0`), not a host address (`.1`).',
      'An FQDN object is resolved by DNS and follows the address if it changes. A naming convention (H_ host, N_ network, G_ group, FQDN_) makes large rule sets readable.',
    ],
    terms: [['Address object', 'A named host, network, range or FQDN.'], ['Address group', 'A named set of objects.'], ['FQDN', 'A full domain name, e.g. updates.vendor.example.']],
    job: 'Consistent naming is what makes a 500-rule firewall maintainable. Agree a convention with the team and stick to it.',
    check: [{ q: 'Why is 192.168.10.1/24 wrong for N_LAN-Staff?', a: 'A network object uses the network address, 192.168.10.0.' }, { q: 'Benefit of groups?', a: 'Add a new finance PC to the group and every rule using it applies at once.' }],
  },
  '1.6': {
    diagram: 'ruleNat', caption: 'The rule decides whether traffic may leave; NAT then gives it the public address.',
    concept: [
      'Access rules are written between zones (here LAN → WAN). The firewall reads them top-down and stops at the first match. If nothing matches, traffic is denied. The factory LAN → WAN rule allows every port, which is easy but far too open.',
      'NAT (network address translation) rewrites the private source `192.168.10.21` to the public `203.0.113.10` as traffic leaves, because private addresses cannot travel on the internet. Replies come back to `203.0.113.10` and the firewall translates them back.',
    ],
    how: [
      'You build `SG_Web-DNS` (HTTP, HTTPS, DNS) and allow only that from `N_LAN-Staff`, with logging on. Then you disable the factory rule, otherwise it would still allow everything below yours. The Default NAT Policy for X1 already exists; nothing to add.',
      'The proof is two tests: HTTPS is allowed and logged with rule `LAN-Web-Out`; SSH finds no allow rule and is dropped. A rule is only "done" when both the allowed and the refused case are proven.',
    ],
    terms: [['Access rule', 'Zone pair + source + destination + service + action.'], ['First match wins', 'Evaluation stops at the first matching rule.'], ['Implicit deny', 'Anything not allowed is dropped.'], ['Source NAT', 'Rewriting the private source to a public address.']],
    job: 'Least privilege: allow what the business needs and log it. DNS uses both UDP and TCP; choosing only UDP breaks large lookups in ways that are hard to diagnose.',
    check: [{ q: 'Your rule is correct but SSH still works. Why?', a: 'The factory "allow any" LAN → WAN rule is still enabled.' }, { q: 'Does NAT allow traffic?', a: 'No. NAT only rewrites addresses; the access rule decides.' }],
  },
  '2.1': {
    diagram: 'schedule', caption: 'Outside the schedule the rule is inactive, so the port is closed.',
    concept: [
      'A service object names a protocol and port: `TCP-8443`. A service group bundles them: `SG_SaaS = TCP-8443 + HTTPS`. A schedule makes a rule active only at certain times.',
      'Together they express a business requirement precisely: "staff may use the SaaS tool on its ports, in office hours only".',
    ],
    how: [
      'The schedule `Office-Hours` covers Monday to Saturday, 09:00–19:00, in 24-hour time and in the firewall’s time zone. Outside that window the rule does not exist as far as matching is concerned, so traffic falls through to later rules or the implicit deny.',
      'You test both sides with the lab clock: Tuesday 10:00 is allowed, 21:00 is blocked. If a broader rule above already allows TCP 8443, your schedule never takes effect: rule order still applies.',
    ],
    terms: [['Service object', 'Protocol + port range.'], ['Service group', 'A named set of services.'], ['Schedule', 'Days and hours when a rule is active.']],
    job: 'Schedules are common for vendor access, backup windows and contractor accounts. Always confirm the firewall clock and time zone; a wrong time zone shifts the window.',
    check: [{ q: 'Why did 21:00 fail?', a: 'The rule is inactive outside its schedule, so nothing allows the traffic.' }, { q: '7:00 PM in this lab is…', a: '19:00.' }],
  },
  '2.2': {
    diagram: 'publish', caption: 'Inbound NAT maps the public address to the server; the rule allows only HTTPS.',
    concept: [
      'Publishing a server means making a private server reachable from the internet. It takes two parts: an inbound NAT that maps a spare public address (`203.0.113.11`) to the private server (`172.16.10.100`), and an access rule that allows only the service you publish.',
      'The server goes in a DMZ, a separate zone on its own port (X2). A public server will be attacked; if it is compromised, the DMZ stops the attacker from walking straight into the office LAN.',
    ],
    how: [
      'A request to `203.0.113.11:443` arrives on X1. The NAT policy rewrites the destination to `172.16.10.100`, keeping the port. The WAN → DMZ rule then allows HTTPS to `webserver_public_ip`. Ports 80 and 22 match no NAT and no rule, so they are dropped.',
      'NAT alone allows nothing, and an access rule alone translates nothing: you need both. Translating "Any" service would expose every port on the server.',
    ],
    terms: [['DMZ', 'A zone for servers reachable from outside, isolated from the LAN.'], ['Inbound / destination NAT', 'Public destination rewritten to a private server.'], ['Port forwarding', 'Common name for publishing one port to an internal host.']],
    job: 'Every published port is attack surface. Publish only what is needed, keep the server in the DMZ, log the rule, and review published services every quarter.',
    check: [{ q: 'Why not use 203.0.113.10?', a: 'That is the firewall’s own WAN address; the server uses the spare .11.' }, { q: 'You added NAT but the site does not load. What is missing?', a: 'The WAN → DMZ access rule.' }],
  },
  '2.3': {
    diagram: 'ruleOrder', caption: 'A specific deny must sit above the broad allows that would match first.',
    concept: [
      'Because the first matching rule wins, a rule placed below a broader rule that matches the same traffic can never fire. It is "shadowed": present, enabled, and useless.',
      'Inherited rule sets are full of these, together with rules nobody remembers creating. Hygiene means fixing order and retiring unused rules.',
    ],
    how: [
      '`Block-Proxy-Site` has 0 hits and a shadowed badge: `LAN-Web-Out` and `Staff-HTTPS-Legacy` above it already allow all HTTPS. You prove it with a test (allowed: wrong), move the block above every allow, and test again (denied).',
      'Hit counters show which rules are used. Rules with 0 hits are disabled first, not deleted: if something breaks, re-enabling is instant. The audit log records each move and disable for the change ticket.',
    ],
    terms: [['Shadowed rule', 'A rule that can never match because an earlier one always does.'], ['Hit counter', 'How many connections matched a rule.'], ['Rule hygiene', 'Regular review of order, usage and ownership.']],
    job: 'Rule reviews are a standard quarterly task and an audit requirement. Many breaches come from forgotten or mis-ordered rules, not missing features.',
    check: [{ q: 'Why move the block above every allow, not just one?', a: 'Any allow above it that matches HTTPS still wins.' }, { q: 'Disable or delete unused rules first?', a: 'Disable; delete later once nothing complains.' }],
  },
  '2.4': {
    diagram: 'vlan', caption: 'One cable carries three networks; zones and rules keep them apart.',
    concept: [
      'A VLAN splits one physical network into separate logical networks. The firewall gets a sub-interface per VLAN (`X0:V10`, `X0:V20`, `X0:V30`), each with its own subnet, DHCP scope and zone.',
      'Segmentation contains incidents: a compromised guest phone on its own VLAN cannot reach the finance laptops, because traffic between segments must cross the firewall and its rules.',
    ],
    how: [
      'Frames carry an 802.1Q tag with the VLAN number. The switch port facing the firewall must be a trunk that carries tags 10, 20 and 30; the ports facing devices are access ports in one VLAN each. If the trunk is missing, everything looks right on the firewall and nothing works.',
      'New zones `Finance` (Trusted) and `Guest` (Public) let you write rules per segment: guests get web only (`Guest-Web-Out`) and Guest → Finance is denied and logged.',
    ],
    terms: [['VLAN', 'A logical network separated by a tag on the same cabling.'], ['802.1Q trunk', 'A link carrying several tagged VLANs.'], ['Sub-interface', 'A virtual interface for one VLAN on a physical port.'], ['Segmentation', 'Dividing a network so a breach stays contained.']],
    job: 'Guest Wi-Fi, cameras, finance and servers each belong in their own segment. Avoid overlapping subnets: `192.168.20.0/24` is already the branch office in task 3.4.',
    check: [{ q: 'All three VLANs are configured but no device gets an address. First check?', a: 'The switch port: it must be an 802.1Q trunk.' }, { q: 'Why not put Guest in the LAN zone?', a: 'LAN is trusted; guests would reach everything LAN can.' }],
  },
  '2.5': {
    diagram: 'cfs', caption: 'Allow list first, then category lookup, then the profile’s decision.',
    concept: [
      'The content filter rates every website into a category (Malware, Phishing, Adult, Proxy Avoidance, Streaming…) and blocks categories your policy forbids, showing a block page instead.',
      'Most malware arrives through the browser. Blocking known-bad categories stops it before anything is downloaded.',
    ],
    how: [
      'Three pieces must exist: the service enabled, a profile (`CFS_Staff`) listing blocked categories and exceptions, and a policy (`CFS-LAN`) applying that profile to a source zone and users. Enabling the service without a policy filters nothing.',
      'The always-allow list wins over categories: `video.example` stays open for marketing even though Streaming is blocked. Test one blocked, one excepted and one normal site.',
    ],
    terms: [['Category', 'A classification of websites by content.'], ['Profile', 'Which categories to block, plus exceptions.'], ['Allow list', 'Sites always permitted regardless of category.']],
    job: 'Agree categories with HR and management in writing. Blocking "Business" or "Search Engines" breaks work and floods the helpdesk.',
    check: [{ q: 'CFS is enabled but nothing is blocked. Why?', a: 'No content filter policy applies the profile.' }, { q: 'Can CFS see inside HTTPS pages?', a: 'It sees the site name; full inspection needs DPI-SSL (task 3.2).' }],
  },
  '2.6': {
    diagram: 'app', caption: 'Port 443 says nothing; the traffic pattern reveals the application.',
    concept: [
      'Port-based rules assume port 443 means "web". Some applications deliberately use 443 to slip through: anonymising proxies such as UltraSurf tunnel over HTTPS to dodge both rules and the content filter.',
      'Application control identifies applications by their traffic patterns, whatever port they use, and acts by category: block, or allow and log.',
    ],
    how: [
      'You block P2P and Proxy-Access, and log Social Networking. Logging is not weaker than blocking; it is a different requirement. HR asked for visibility, not a ban.',
      'The test with UltraSurf is blocked; the social app is allowed and an "Application Control Detection Alert" appears in the system log as evidence.',
    ],
    terms: [['Application signature', 'A pattern identifying an application’s traffic.'], ['Evasive application', 'Software built to bypass port-based controls.']],
    job: 'Do exactly what the policy asks. Blocking something the business asked only to monitor creates tickets and erodes trust in the security team.',
    check: [{ q: 'Why can’t a port rule stop UltraSurf?', a: 'It uses 443 like normal HTTPS.' }, { q: 'Social Networking set to Log: is traffic allowed?', a: 'Yes, and every use is recorded.' }],
  },
  '2.7': {
    diagram: 'auth', caption: 'Unknown users are sent to log in; members of Staff are allowed and named in the logs.',
    concept: [
      'IP addresses change hands; people are accountable. A rule can require a user group, so it matches only when the person behind the address has signed in and belongs to that group.',
      'Logs then say "priya browsed X", not "192.168.10.21 browsed X". That is what investigations and audits need.',
    ],
    how: [
      'You create the group `Staff` and users `priya` and `arjun` with practice passwords, then set Users Included = Staff on `LAN-Web-Out`. An anonymous HTTP request is redirected to the firewall’s login page; after priya signs in on HR-PC, the same request is allowed.',
      'DEVICE › Users › Status shows who is signed in on which PC. Put the group on the allow rule; a group on a deny rule changes who is denied, not who is allowed.',
    ],
    terms: [['Local user', 'A user account stored on the firewall.'], ['Group', 'A set of users that rules can reference.'], ['Captive portal', 'Redirecting unauthenticated web traffic to a login page.']],
    job: 'In production users usually come from a directory (LDAP or Active Directory) rather than local accounts, but the rule logic is identical. Check that no other allow rule bypasses the user requirement.',
    check: [{ q: 'Users exist but browsing is still refused. Likely cause?', a: 'They are not members of Staff.' }, { q: 'Why redirect instead of drop?', a: 'So the person can sign in and be identified.' }],
  },
  '3.1': {
    diagram: 'ips', caption: 'Signatures block known attacks; a false positive is fixed with one targeted exclusion.',
    concept: [
      'Intrusion prevention (IPS) compares traffic against signatures of known attacks. Gateway anti-virus (GAV) scans files as they pass. Both work at the gateway, before anything reaches the PC.',
      'Signatures carry a priority. Prevent blocks and logs; Detect only logs. A common policy is prevent and detect High and Medium, detect Low, so low-confidence matches do not break business traffic.',
    ],
    how: [
      'The simulated exploit is blocked by IPS and the harmless EICAR test file by GAV. EICAR is a standard test string every anti-virus treats as malware; it is not malicious.',
      'Then Finance reports the ERP sync is broken. The log shows an IPS entry for that traffic with a signature ID (SID). The right fix is to exclude that one SID, with the reason recorded. Turning off Medium prevention would "fix" ERP by opening every medium-priority attack.',
    ],
    terms: [['Signature / SID', 'A pattern of a known attack and its ID.'], ['False positive', 'Legitimate traffic matched as an attack.'], ['EICAR', 'A harmless standard test file for anti-virus.']],
    job: 'Every exclusion should name the SID, the application, the requester and a review date. Broad exclusions are how protection erodes.',
    check: [{ q: 'IPS breaks one app. Disable Medium prevention?', a: 'No. Exclude only the SID that matched, from the log.' }, { q: 'Is EICAR dangerous?', a: 'No. It is a harmless test string.' }],
  },
  '3.2': {
    diagram: 'dpi', caption: 'Two TLS sessions with inspection in the middle; excluded sites pass untouched.',
    concept: [
      'Most traffic is HTTPS, so IPS, AV and the content filter see only encrypted bytes. Attackers deliver malware over HTTPS precisely because many firewalls cannot see it.',
      'DPI-SSL decrypts outgoing HTTPS, inspects it, and re-encrypts it. The PC talks TLS to the firewall; the firewall talks TLS to the website.',
    ],
    how: [
      'To do this the firewall issues certificates for the sites on the fly, signed by its own CA. PCs only accept them if that CA is in their trust store, so you deploy it first (as group policy would) and enable inspection second. Doing it the other way round causes certificate errors company-wide.',
      'Exclusions skip decryption: banking and health (privacy and legal reasons) and certificate-pinned apps, which accept only their own certificate and break if inspected. You prove it: HTTPS EICAR blocked after enabling, `bank.example` keeps its original certificate.',
    ],
    terms: [['TLS inspection', 'Decrypting, inspecting and re-encrypting HTTPS.'], ['Trust store', 'The list of CAs a device trusts.'], ['Certificate pinning', 'An app accepting only one specific certificate.']],
    job: 'TLS inspection needs a written policy, a privacy review and clear exclusions. Tell users it exists; in many places that is a legal requirement.',
    check: [{ q: 'Why deploy the CA before enabling DPI-SSL?', a: 'Otherwise every HTTPS site shows a certificate error.' }, { q: 'Why exclude banking?', a: 'Privacy and legal exposure; there is little security gain.' }],
  },
  '3.3': {
    diagram: 'sslvpn', caption: 'The laptop gets a pool address and routes to the staff LAN only.',
    concept: [
      'SSL VPN lets a remote laptop connect to the office over the internet through an encrypted tunnel. The laptop receives an office-side address from a pool and can reach only the networks you list.',
      'Remote access is the door attackers try first, with stolen or guessed passwords. Least-privilege routes plus a one-time code (MFA) limit what a stolen password can reach.',
    ],
    how: [
      '`SSLVPN_Pool` (`192.168.50.10–.50`) lives in its own SSLVPN zone so VPN users have their own rules. The server listens on the WAN at port 4433. The client route list contains only `N_LAN-Staff`, with tunnel-all off: this is a split tunnel.',
      'priya needs membership of SSLVPN Services and a one-time password. In the lab the code comes from the lab authenticator and the secret is training-only. Tests prove the LAN (RDP to HR-PC) works and the DMZ does not.',
    ],
    terms: [['SSL VPN', 'Remote access tunnel over TLS.'], ['Address pool', 'Addresses handed to VPN clients.'], ['Split tunnel', 'Only listed networks go through the tunnel.'], ['MFA / TOTP', 'A second factor: a time-based one-time code.']],
    job: 'Review VPN users monthly, remove leavers the same day, and never route "Any" to remote clients.',
    check: [{ q: 'Login works but VPN access is refused. Why?', a: 'The user is not in SSLVPN Services.' }, { q: 'Why is WEB-01 unreachable?', a: 'The DMZ is not in the client route list.' }],
  },
  '3.4': {
    diagram: 'ipsec', caption: 'Phase 1 builds a secure channel; Phase 2 builds the tunnel for the two LANs.',
    concept: [
      'A site-to-site IPsec VPN joins two office networks over the internet, firewall to firewall, so users never start a VPN client. Traffic between `192.168.10.0/24` (HQ) and `192.168.20.0/24` (Branch) is encrypted automatically.',
      'Both firewalls must mirror each other exactly: each one’s peer is the other’s public address, the shared key is identical, the proposals match, and local and remote networks are swapped.',
    ],
    how: [
      'IKEv2 negotiates in stages. IKE_SA_INIT agrees encryption, hashing and Diffie-Hellman group (Phase 1: DH 14, AES-256, SHA256). IKE_AUTH proves both sides hold the same pre-shared key and states the networks. A CHILD SA then carries the data (Phase 2: ESP AES-256/SHA256, with PFS group 14 so each tunnel key is fresh).',
      'When you finish HQ alone, the tunnel stays down: there is no peer policy yet, and the log says so. After the Branch mirror is saved, the log shows Phase 1 agreed, authenticated, Phase 2 established, and BRANCH-PC reaches HQ. The shared secret here is training-only.',
    ],
    terms: [['IKE', 'The protocol that negotiates IPsec keys and settings.'], ['Pre-shared key', 'A secret configured on both peers.'], ['Proposal', 'Encryption, hash and DH group offered.'], ['PFS', 'Perfect forward secrecy: fresh keys per tunnel.']],
    job: 'Agree parameters with the other side in writing before you start, and copy them, never re-type them. A single mismatch keeps the tunnel down.',
    check: [{ q: 'Branch local network is HQ’s…', a: 'Remote network. They mirror.' }, { q: 'What does PFS add?', a: 'Each Phase 2 key is independent, so one leaked key does not expose others.' }],
  },
  '3.5': {
    diagram: 'sdwan', caption: 'The probe, not the cable, decides which link carries traffic.',
    concept: [
      'One ISP is a single point of failure for every cloud app, VPN and call. A second link on X3 helps only if traffic moves to it automatically.',
      'Link state is not enough: the cable to the ISP router can stay up while the ISP’s network behind it is down. SD-WAN sends probes through each link and steers traffic by measured health.',
    ],
    how: [
      'An SD-WAN group (`WAN-Group`: X1, then X3) lists the links. An SLA probe pings `1.1.1.1` through both every 3 seconds. A path selection profile (`Internet-Failover`) sets the thresholds (≤50 ms, ≤5% loss) and the backup. An SD-WAN route sends Any → Any through that profile.',
      'You fail ISP-1 in Lab Controls: the probe on X1 fails, traffic moves to X3; you restore it and traffic returns. Probe a target beyond the ISP; the ISP gateway itself can answer while the internet behind it is down.',
    ],
    terms: [['SD-WAN', 'Policy-based selection between several WAN links.'], ['SLA probe', 'A regular test measuring reachability, latency and loss.'], ['Failover / failback', 'Moving to the backup and returning.']],
    job: 'Test failover on a schedule, not only when the link dies. Keep management closed on the new WAN as on the first.',
    check: [{ q: 'Why not probe 198.51.100.33?', a: 'That is the ISP gateway; it can answer while the internet behind it is down.' }, { q: 'What decides failover?', a: 'Probe results against the profile thresholds.' }],
  },
  '4.1': {
    diagram: 'ha', caption: 'The standby already knows the configuration and every open session.',
    concept: [
      'The firewall is a single point of failure for the whole office. High availability pairs two identical units that share one identity: the primary is active, the secondary waits on standby.',
      'With stateful synchronization the standby knows every open connection, so a failover does not drop calls or downloads.',
    ],
    how: [
      'You set Active/Standby with the secondary’s serial `7C3A19E40C11`, turn on stateful sync, monitor X0 and X1 (a dead link also triggers failover), and click Synchronize Settings so the standby has the full configuration.',
      'Then you power off the primary in Lab Controls. Traffic continues, served by the secondary. Forgetting to synchronize means the standby comes up with an empty configuration: a failover that causes an outage.',
    ],
    terms: [['Active / Standby', 'One unit forwards traffic, the other waits.'], ['Stateful sync', 'Copying the session table to the standby.'], ['Monitored interface', 'A link whose failure triggers failover.']],
    job: 'Test failover in a maintenance window at least twice a year, and after firmware upgrades. Both units need the same firmware and licences.',
    check: [{ q: 'Why monitor X1?', a: 'If the primary loses the internet link, the standby should take over.' }, { q: 'What does stateful sync add?', a: 'Existing connections survive the failover.' }],
  },
  '4.2': {
    diagram: 'troubleshoot', caption: 'Reproduce, capture, read, fix the cause, prove it, write it down.',
    concept: [
      'Packet Monitor records what the firewall did with each packet (forwarded, consumed or dropped) and the exact drop reason. It turns "it doesn’t work" into one precise line of evidence.',
      'Here Finance cannot reach the ERP service after a night change, while everything else works. That pattern means something specific to that destination changed.',
    ],
    how: [
      'You reproduce the failure, set a capture filter (destination `192.0.2.20`, port 443) and send the test again. The dropped packet’s reason says the next hop of route `ERP-Legacy-Path` does not answer: the packet was never denied, it was routed into a dead gateway.',
      'So an allow rule would change nothing. You disable the route (or correct its gateway), capture again to see FORWARDED, export the capture, and write the root cause: what changed, why it failed, the fix, and how to prevent it.',
    ],
    terms: [['Packet capture', 'A record of packets and the firewall’s decision.'], ['Drop code', 'The reason a packet was discarded.'], ['Root cause analysis (RCA)', 'Cause, fix and prevention, written down.']],
    job: 'Never close an incident on "it works now". Attach the before and after captures and the RCA to the ticket so the next engineer learns from it.',
    check: [{ q: 'Why not add an allow rule?', a: 'No rule denied the packet; a route sent it to a dead next hop.' }, { q: 'What proves the fix?', a: 'A new capture showing FORWARDED for the same flow.' }],
  },
  '4.3': {
    diagram: 'ipsecFix', caption: 'Each IKE stage has its own error message and its own fix.',
    concept: [
      'When a tunnel is down, the IKE log names the stage that failed. Reading it beats re-typing every setting and hoping.',
      'The Branch admin changed three things overnight. Each fault hides the next: you fix them one at a time, in the order the negotiation reaches them.',
    ],
    how: [
      '`AUTHENTICATION_FAILED`: Phase 1 agreed but the keys differ. Re-enter the same training secret on the Branch. `NO_PROPOSAL_CHOSEN` at Phase 2: PFS is off on one side; turn it on with DH group 14. `TS_UNACCEPTABLE`: the traffic selectors (networks) do not mirror; set the Branch destination back to `N_HQ-LAN`.',
      'Fix the side that changed. Changing HQ to match a wrong Branch setting would spread the error and break other tunnels that use the same settings.',
    ],
    terms: [['Traffic selector', 'The local/remote networks a tunnel carries.'], ['NO_PROPOSAL_CHOSEN', 'No common encryption/PFS settings.'], ['TS_UNACCEPTABLE', 'The networks do not match.']],
    job: 'VPN outages are among the commonest escalations. Record each fault and its fix in the ticket; the other side will ask what you found.',
    check: [{ q: 'Which error means the keys differ?', a: 'AUTHENTICATION_FAILED.' }, { q: 'Why fix the Branch, not HQ?', a: 'The Branch is the side that changed.' }],
  },
  '4.4': {
    diagram: 'hardening', caption: 'Each item closes one door an auditor or attacker would check.',
    concept: [
      'Hardening closes the doors a working firewall still leaves open: who can log in, from where, how, and what evidence is kept.',
      'Auditors and attackers read the same checklist. Each item here is a finding in a real assessment.',
    ],
    how: [
      'Rename the admin (`kgi-fwadmin`) so the account name is not guessable, require TOTP, and lock out after 5 failures for 30 minutes. Move HTTPS management to 4443 with a certificate from the internal CA, so the browser trusts it and the warning from task 0.2 is gone. Your session ends when the port changes; browse to `https://192.168.10.1:4443`.',
      'Ship logs to syslog (`192.168.10.250:514`) so evidence survives if the box is wiped, schedule weekly exports, check firmware, and review the audit log. The audit sheet turns green item by item.',
    ],
    terms: [['Hardening', 'Reducing attack surface and adding evidence.'], ['Syslog', 'Sending logs to a central server.'], ['Account lockout', 'Blocking login after repeated failures.']],
    job: 'Write the new port and admin name in the runbook the moment you change them. Test TOTP in a second session before closing your first one.',
    check: [{ q: 'Why send logs off the box?', a: 'An attacker or a failure on the firewall cannot erase them.' }, { q: 'Why does the certificate warning disappear?', a: 'The new certificate comes from a CA the PCs already trust.' }],
  },
  '4.5': {
    diagram: 'incident', caption: 'Contain first, then preserve evidence, then report.',
    concept: [
      'A beacon is a compromised computer checking in with its controller (command-and-control, C2) at regular intervals, asking for instructions. Minutes matter: contain first, investigate second, and keep the evidence intact.',
      'Everything here is synthetic: the alert, the logs and the C2 address `192.0.2.66` (a documentation range). No real destination is ever contacted.',
    ],
    how: [
      'Search the logs for `cdn-update-check.example`: one source connects every five minutes through an old rule. Block the C2 for everyone with a logged deny above every allow, because other hosts may be infected too; enable the botnet filter as a second layer; quarantine the laptop by blacklisting its MAC on its interface.',
      'Prove containment (the laptop is dropped, FIN-PC is blocked too), capture and export the evidence, and write the report: timeline, containment actions, likely root cause and next steps. Do not wipe the laptop before evidence is preserved.',
    ],
    terms: [['C2 (command and control)', 'The server malware contacts for instructions.'], ['Beaconing', 'Regular, automated check-ins to a C2.'], ['Containment', 'Stopping spread and communication without destroying evidence.']],
    job: 'In a real incident you work with the SOC and follow the incident plan. The firewall is often the fastest place to contain: one rule protects every host at once.',
    check: [{ q: 'Why block the C2 for everyone, not only the infected host?', a: 'Other machines may be infected and not yet detected.' }, { q: 'Why not re-image the laptop first?', a: 'It destroys evidence needed to find the root cause.' }],
  },
};
