# ThreatReady Firewall — by Aerovant Technologies

ThreatReady Firewall by Aerovant Technologies: hands-on firewall administration training from first cable to incident containment.
The lab appliance, **ThreatWall**, is a fictional firewall used for training.

Browser-based firewall administration simulator with a guided 30-task learning track, from first cable to incident response (fresher → expert).
It follows the structure of a SonicOS 7.x Classic-mode GUI (HOME, MONITOR, DEVICE, NETWORK, OBJECT, POLICY) under ThreatWall's own branding.

Everything runs locally in your browser. No real firewall, network, VPN, credentials or malware are used. Public addresses come from the
documentation ranges (RFC 5737); test "malware" is the harmless EICAR string; the capstone C2 address is synthetic.

## Run locally

Requires **Node.js 20.19+ or 22+**.

```bash
npm install
npm run dev        # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run build` then `npm run preview` | production build on http://localhost:4173 |
| `npm test` | 46 unit/verification tests (incl. notebook coverage): engine + every task's checks against an answer key, including "no later task makes an earlier one stale" |
| `npm run e2e` | browser walkthrough of all 30 tasks through the GUI (needs `npm run preview` running and `npx playwright install chromium` once) |
| `npm run lint` | oxlint |

**Screens:** `#/start` home (levels, badges, continue, reset) · lab (any appliance route) · `#/record` training record · `#/notebook[/task]` learning notebook.

**Reset:** Home → *Reset lab*, or the avatar menu in the appliance → *Reset lab to factory defaults* (clears configuration and progress).

## How the lab works

- **Start:** the screen is the browser on your lab PC (ADMIN-PC). Open **Lab Tools** (bottom bar) → *PC Console*, plug the cable, then type `https://192.168.168.168` in the address bar. Whether a page loads is decided by the simulated network, not by a button.
- **Task panel (right):** each task shows *What it is · What we do · Why · Expected values*, then one action at a time. The next control is outlined on screen. Steps advance automatically when the saved configuration or a simulated test proves them.
- **Guided / Practice:** Practice hides values and highlights until you press *Hint*. *Beginner explanations* adds plain-English notes.
- **Progress states:** locked → available → in progress (step n of m) → completed. If a later change breaks an earlier task it shows *Re-verify*. Wrong saves are recorded as failed attempts with the exact reason ("You saved: Subnet Mask is 255.255.255.0, expected 255.255.255.248").
- **Levels unlock in order.** Scenario tasks (2.3, 4.2, 4.3, 4.5) start with a *Start scenario* button that injects the fault or alert.
- **Lab Tools:**
  - *PC Console:* `ipconfig`, `ping`, `nslookup`, `curl` (all simulated).
  - *Traffic Tester:* any lab host to any destination, with an application, payload, user or lab time. Shows the verdict, the step-by-step trace, the rule hit and NAT.
  - *Lab Hosts:* every lab host and its address.
  - *Lab Controls:* ISP failure, VLAN trunk, HA unit power, client CA trust, NetExtender with a lab one-time code, user logins and the lab clock.
- **Training record:** award icon in the task panel, or Home › Your record. It re-runs every task's checks against the live configuration, shows failures as failures ("Not enough evidence yet" where there is nothing to show), and prints on A4 or downloads as JSON.
- **Learning notebook:** Home › Learning notebook, the notebook icon in the task panel, or *Read the full lesson* under About this task. Every task explained (what it is, what happens under the hood, a flow diagram, the steps and why, mistakes, key terms, on the job, self-check), plus the lab map, packet path, networking essentials and a glossary. Downloadable as `public/notebook/ThreatReady-Firewall-Learning-Notebook.pdf`.

## The 30 tasks

| Level | Tasks |
| --- | --- |
| 0 Access | 0.1 cable + DHCP · 0.2 management page + certificate · 0.3 Setup Guide · 0.4 GUI tour · 0.5 register/license · 0.6 backup/export · 0.7 admin session |
| 1 Fresher | 1.1 interfaces/zones (WAN static, X0 re-address + reconnect) · 1.2 default route, DNS, diagnostics · 1.3 DHCP + reservation · 1.4 MAC-IP anti-spoof (rogue laptop) · 1.5 address objects/groups · 1.6 first rule + outbound NAT |
| 2 Junior | 2.1 services + schedules (10:00 vs 21:00) · 2.2 publish a DMZ web server · 2.3 rule order/shadowing (inherited rule set) · 2.4 VLANs + segmentation · 2.5 content filter · 2.6 App Control · 2.7 users + authentication |
| 3 Advanced | 3.1 IPS + gateway AV + false positive · 3.2 DPI-SSL · 3.3 SSL VPN (NetExtender + TOTP) · 3.4 site-to-site IPsec HQ ↔ Branch · 3.5 dual WAN SD-WAN failover |
| 4 Expert | 4.1 HA Active/Standby · 4.2 packet-flow troubleshooting · 4.3 IPsec troubleshooting (3 faults) · 4.4 hardening + audit sheet · 4.5 capstone: contain a beaconing host |

Exact lab values (KGI-HQ-FW, H_WEB-01, N_LAN-Staff, FQDN_update-site, G_Finance-PCs, LAN-Web-Out, TCP-8443, SG_SaaS, Office-Hours,
webserver_public_ip, webserver_private_ip, SSLVPN_Pool, N_Branch-LAN, HQ-to-Branch …) are in `src/state/baseline.ts` (`LAB`) and in each task's *Expected values*.

## Architecture

```
src/
  state/      types.ts (one config model) · baseline.ts (factory + LAB plan) · store.tsx (single store, persistence, audit, events) · ui.ts (route, drafts, Lab Tools)
  engine/     pure, deterministic simulation: network.ts (DHCP, ARP, routing, SD-WAN, HA) · rules.ts · vpn.ts (IKE negotiation) · traffic.ts (packet pipeline) · diag.ts
  services/   pure validate/apply functions per domain — pages never mutate state directly
  tasks/      level0–4.ts (30 task definitions) · dsl.ts (step helpers) · runtime.ts (progression, verification, stale detection) · solutions.ts (test-only answer key)
  training/   TaskPanel · GuideOverlay (highlights) · TaskRunner · LabTools
  auth/       simulated browser, certificate warning, login (lockout, TOTP), Setup Guide
  shell/      nav.ts (menu tree + task mapping) · AppShell · Disconnected
  pages/      one folder per view; registry.tsx maps routes to pages
e2e/          Playwright walkthrough of all 30 tasks
docs/         IMPLEMENTATION.md (task inventory, page inventory, dependency map, state design)
```

- **One state.** Every page validates through a service and calls `commit(next, audit)`. Every change is audited and emits an event the task engine can see.
- **Verification never trusts UI flags.** A task's checks are pure functions over the saved configuration and the lab. Traffic checks re-run the engine (`evaluate`) with no side effects, so a task becomes *Re-verify* the moment a later change breaks it.
- **Evidence:** a test you send through Lab Tools updates hit counters, logs and the packet-monitor buffer. Actions that leave no configuration behind (exports, notes) are recorded as completed steps.
- **Persistence:** browser localStorage (`threatwall:lab-state`, versioned). With no backend a learner could edit it. Verification is pure and portable, so it can move server-side later.

## Learning notebook PDF

Teaching text lives in `src/notebook/lessons.ts`, diagrams in `src/notebook/Diagram.tsx`; steps and lab values are read from the task definitions, so the notebook never drifts from the lab. After changing a lesson or a task:

```bash
npm run build && npm run preview     # terminal 1
npm run notebook:pdf                 # terminal 2: writes public/notebook/…pdf
npm run build                        # copy the fresh PDF into dist/
```

## Branding

Training layer (home, record, notebook, task panel): ThreatReady by Aerovant Technologies — dark slate + teal, IBM Plex (bundled, no external font requests).
Logo files in `public/brand/`: `aerovant-logo-light.svg` (white, dark screens), `aerovant-logo-dark.svg` (navy, light pages and print), `aerovant-mark.svg` (favicon), `apple-touch-icon.png`. The simulated appliance keeps ThreatWall's own look and is never branded.

The layout follows the reference captures: top view bar, grouped left menu, breadcrumbs, orange tabs, dense tables and right-aligned forms.
The logo, login design, colours and icons are ThreatWall's own. No vendor names, logos or assets are used.
