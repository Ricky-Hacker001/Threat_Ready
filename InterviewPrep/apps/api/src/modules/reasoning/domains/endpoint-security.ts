import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Endpoint Security: persistence, EDR evidence and containment on workstations and servers. The
 * diagram is a host (or small fleet) with its processes, persistence points, identity material and
 * EDR coverage; the learner reasons from the process tree and host artefacts.
 */
export const ENDPOINT_SECURITY: ReasoningDomain = {
  key: 'endpoint_security',
  title: 'Endpoint Security',
  description: 'Read a host with a confirmed compromise and its EDR evidence, decide which persistence, privilege or control the attack depends on, and defend the decision from the process tree and host artefacts.',
  track: 'Endpoint Security',
  difficulty: 'intermediate',
  framing: 'a host (or small fleet) with its process tree, persistence points and EDR coverage, and an active compromise',
  focus: [
    'Reading a process tree to tell malicious from benign',
    'Persistence mechanisms and which survive a reboot or a user logoff',
    'Local privilege escalation and what the host’s identity material exposes',
    'Containment on the endpoint without losing volatile evidence',
  ],
  skillIds: ['soc.endpoint_forensics', 'soc.threat_detection', 'devops.linux', 'soc.incident_response', 'sec.fundamentals'],
  weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1204.002', 'User Execution: Malicious File'),
    T('T1059.001', 'Command and Scripting Interpreter: PowerShell'),
    T('T1059.003', 'Command and Scripting Interpreter: Windows Command Shell'),
    T('T1547.001', 'Boot or Logon Autostart Execution: Registry Run Keys / Startup Folder'),
    T('T1053.005', 'Scheduled Task/Job: Scheduled Task'),
    T('T1543.003', 'Create or Modify System Process: Windows Service'),
    T('T1543.002', 'Create or Modify System Process: Systemd Service'),
    T('T1546.003', 'Event Triggered Execution: Windows Management Instrumentation Event Subscription'),
    T('T1055', 'Process Injection'),
    T('T1218.011', 'System Binary Proxy Execution: Rundll32'),
    T('T1218.005', 'System Binary Proxy Execution: Mshta'),
    T('T1036.005', 'Masquerading: Match Legitimate Name or Location'),
    T('T1003.001', 'OS Credential Dumping: LSASS Memory'),
    T('T1555.003', 'Credentials from Password Stores: Credentials from Web Browsers'),
    T('T1548.002', 'Abuse Elevation Control Mechanism: Bypass User Account Control'),
    T('T1562.001', 'Impair Defenses: Disable or Modify Tools'),
    T('T1070.004', 'Indicator Removal: File Deletion'),
    T('T1105', 'Ingress Tool Transfer'),
    T('T1497', 'Virtualization/Sandbox Evasion'),
    T('T1113', 'Screen Capture'),
  ],
  variation: {
    topologies: [
      { id: 'windows_workstation', label: 'Windows workstation in a managed domain', guide: 'A domain-joined laptop with EDR, a standard user with occasional local admin, cached domain credentials, a browser with saved logins, and startup and scheduled-task persistence points.' },
      { id: 'windows_server', label: 'Windows member server', guide: 'A file or application server with EDR, a service account running a service, local admin groups, scheduled tasks, and a management agent.' },
      { id: 'linux_server', label: 'Linux server', guide: 'A web or app server with EDR/auditd, systemd services, cron jobs, SSH keys, a service user, and a package manager.' },
      { id: 'developer_mac', label: 'Developer macOS laptop', guide: 'A managed Mac with EDR and MDM, launch agents and daemons, keychain credentials, cloud CLI sessions, and SSH keys to production.' },
      { id: 'kiosk_shared', label: 'Shared kiosk or clinical workstation', guide: 'A shared logon, locked-down policy with gaps, startup items, a browser cache, and limited EDR features.' },
      { id: 'jump_host', label: 'Administrative jump host', guide: 'A hardened bastion with session recording, admin tooling, cached credentials for many systems, and EDR with high-fidelity logging.' },
      { id: 'vdi_instance', label: 'Virtual desktop instance', guide: 'A non-persistent VDI with EDR, a roaming profile, mapped drives, and a gold image that persistence would or would not survive.' },
      { id: 'byod_contractor', label: 'Contractor laptop with partial management', guide: 'An EDR-light device, a VPN client, saved credentials, and limited visibility compared with corporate hosts.' },
    ],
    entryPoints: [
      { id: 'document_spawned_script', label: 'A document spawned a scripting host', guide: 'EDR shows an office document process starting a script interpreter that then reached out to the network; the user opened an attachment.' },
      { id: 'suspicious_scheduled_task', label: 'A new scheduled task runs at logon', guide: 'A task created recently launches a binary from a user-writable path at each logon; its author is a standard user.' },
      { id: 'service_persistence', label: 'A new or modified service points to an unusual binary', guide: 'A Windows service or systemd unit was changed to run a binary from a non-standard location with high privilege.' },
      { id: 'run_key_autorun', label: 'An autorun entry launches at startup', guide: 'A registry run key or startup-folder item launches a masquerading binary when the host boots.' },
      { id: 'cred_memory_access', label: 'A process accessed credential memory', guide: 'EDR flags access to LSASS (or a credential store) by a process whose parent chain is suspicious; cached domain creds are at risk.' },
      { id: 'browser_cred_theft', label: 'A process read browser credential stores', guide: 'Saved logins and cookies were read from the browser profile, exposing sessions to cloud and internal apps.' },
      { id: 'uac_bypass', label: 'A standard user process gained admin without a prompt', guide: 'An elevation-control bypass produced an elevated process without the expected consent, widening what the host can do.' },
      { id: 'edr_tamper', label: 'EDR features were disabled on the host', guide: 'A command stopped or blinded the agent for a window; telemetry during that window is missing.' },
      { id: 'masquerade_binary', label: 'A legitimate-looking binary runs from the wrong place', guide: 'A binary named like a system tool runs from a temp or user path; signer and path telemetry are the tell.' },
      { id: 'ssh_key_use', label: 'A host SSH key or cloud CLI session is used onward', guide: 'Keys or a cached cloud session on the host are used to reach production from the compromised endpoint.' },
    ],
    objectives: [
      { id: 'malicious_or_benign', label: 'Whether the process tree is malicious and what proves it', guide: 'Ask whether the observed activity is malicious given the parent-child chain, signer, path and network, and what decides it; distractors ignore an exculpating or corroborating artefact.', question: 'Is this activity malicious, and what in the host evidence decides it?', weights: { correctness: 30, reasoning: 50, architecture: 10, risk: 10 } },
      { id: 'persistence_identify', label: 'The persistence mechanism in play', guide: 'Ask which persistence the attacker established given the artefacts; distractors name a mechanism not present or confuse an execution artefact with persistence.', question: 'Which persistence mechanism has the attacker established?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'what_survives', label: 'What survives a reboot, logoff or reimage', guide: 'Ask which foothold or access survives a given action (reboot, user logoff, reimage from gold, password reset) based on where it lives; distractors assume an action clears more than it does.', question: 'After the proposed action, what foothold or access still survives?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'host_reach', label: 'What the host’s identity material exposes', guide: 'Ask what the attacker can reach using cached credentials, tokens, SSH keys or sessions on this host; distractors over- or under-state it by ignoring a credential or a mapped resource.', question: 'What can the attacker reach using this host’s stored credentials and sessions?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'detect_gap', label: 'The telemetry gap that hid a step', guide: 'Ask which host telemetry should have shown a step and did not (agent tamper window, feature not enabled, path not monitored); distractors name a source that did capture it.', question: 'Which telemetry gap let a step go unseen on this host?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'contain_now', label: 'The first containment action on the host', guide: 'Ask for the first endpoint action that stops the activity without losing volatile evidence (memory, running processes) or breaking a safety-critical function; distractors are premature reimage, a full shutdown that loses memory, or a cosmetic kill.', question: 'What is the first containment action to take on this host?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'priority_order', label: 'The right order of two host steps under a constraint', guide: 'Ask which of two actions comes first given the constraint (for example isolate before killing the process, or capture memory before reboot); distractors invert the order.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
    ],
    constraints: [
      { id: 'clinical_host', label: 'The host is a clinical workstation needed for patient care', guide: 'Isolation must not break the clinical function abruptly.' },
      { id: 'volatile_needed', label: 'Memory evidence is needed before any reboot', guide: 'Preserve volatile state first.' },
      { id: 'edr_blind_window', label: 'EDR was disabled for a period on this host', guide: 'Telemetry in that window is missing; reason around it.' },
      { id: 'jump_host_shared', label: 'The host is a shared jump host for many admins', guide: 'Action affects everyone using it.' },
      { id: 'non_persistent_vdi', label: 'The VDI is non-persistent and resets on logoff', guide: 'Persistence that survives a reset lives elsewhere (profile, image, mapped resource).' },
      { id: 'byod_limited', label: 'It is a contractor BYOD host with limited control', guide: 'Not every corporate action is available.' },
      { id: 'production_keys', label: 'The host holds keys to production', guide: 'Credential exposure drives urgency beyond the host itself.' },
    ],
    components: [
      'EDR agent', 'process tree', 'parent process', 'scripting host', 'scheduled task', 'registry run key', 'startup folder', 'Windows service', 'systemd service', 'launch agent', 'WMI subscription', 'LSASS', 'credential store', 'browser credential store', 'cached domain credentials', 'SSH key', 'cloud CLI session', 'local admin group', 'UAC', 'service account', 'binary signer', 'file path', 'masquerading binary', 'auditd log', 'Sysmon/EDR telemetry', 'memory', 'MDM policy', 'roaming profile', 'mapped drive', 'gold image', 'VPN client', 'host firewall', 'isolation action',
    ],
  },
  guidance: `Endpoint Security realism rules:
- The learner is a defender reading host evidence, not an attacker. Describe the process tree, artefacts, signers, paths and telemetry; never write operational attacker tradecraft or working offensive commands.
- Use concrete names (for example "winword.exe -> powershell.exe", "task 'Updater'", "service 'WUAUSV' repointed", "run key HKCU...Run", "svchost.exe from %TEMP%") and realistic timings. Never invent features that do not exist.
- The "attack path" is the chain of host actions already taken; each diagram attack edge is a step with the artefact or telemetry that records it (or the gap that does not, e.g. an EDR tamper window).
- Be exact about what each response clears and what it does not: killing a process does not remove persistence; a reboot clears memory and some injected state but not an autorun, a service or a scheduled task; a reimage from gold removes on-disk persistence but not credentials already stolen or persistence in the profile/mapped resources; a password reset does not revoke a stolen session or key.
- Distinguish execution artefacts from persistence, and signer/path masquerading from a genuine system binary.
- Trust boundaries are real boundaries: user context, admin context, the host itself, the domain/cloud the host’s credentials reach, the EDR control plane.
- The best answer must be the one an experienced endpoint/DFIR analyst would choose for this exact host and constraint; distractors must be defensible endpoint moves that are mistimed, clear less than assumed, or destroy evidence.
- Cite techniques from the ATT&CK Enterprise matrix only, favouring Persistence, Privilege Escalation, Defense Evasion and Credential Access.`,
};
