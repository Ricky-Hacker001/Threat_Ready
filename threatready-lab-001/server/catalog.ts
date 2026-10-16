// The labs.threatready.io catalog, grouped into tracks. A lab is playable when it has an engine
// registered in app.ts or, for a lab that is its own app (`href`), when this server hosts it
// (hosted.ts). The rest are announced from the roadmap and shown as coming soon.
export type Track = 'cloud' | 'blue' | 'red' | 'network';

export interface CatalogEntry {
  id: string; title: string; subtitle: string; track: Track; difficulty: string;
  /** Typical time, for single-session labs. */
  minutes?: number;
  /** Size of a multi-part lab, e.g. "36 scenarios". */
  scope?: string;
  release: string;
  /** Relative to /labs/: a lab that is its own app. */
  href?: string;
}

export const CATALOG: CatalogEntry[] = [
  { id: 'TR-CLOUD-001', title: 'The Compromised Startup', subtitle: 'Investigate, contain and secure a vulnerable AWS environment while an intruder is active.', track: 'cloud', difficulty: 'Intermediate', minutes: 120, release: 'V1.0' },
  { id: 'TR-DEVSECOPS-001', title: 'DevSecOps Lab', subtitle: 'Run secrets, SAST, dependency, container and IaC scanners on a real-looking repo, fix what they find and ship through a gated pipeline.', track: 'cloud', difficulty: 'Guided to Expert', scope: '8 labs', release: 'V1.0', href: 'devsecops/' },
  { id: 'TR-SOC-001', title: 'SOC Simulation', subtitle: 'Watch a live log stream, pick up an alert and work the ticket from L1 triage through L3 response to closure.', track: 'blue', difficulty: 'Foundation to Expert', scope: '36 scenarios', release: 'V1.0', href: 'soc/' },
  { id: 'TR-NET-001', title: 'ThreatReady Firewall', subtitle: 'Administer a training firewall from first cable to incident containment: zones, NAT, VPN, IPS and high availability.', track: 'network', difficulty: 'Fresher to Expert', scope: '30 tasks', release: 'V1.0', href: 'threatwall/' },
  { id: 'TR-NET-002', title: 'Flat Network', subtitle: 'Map an exposed network, spot the lateral-movement paths and segment it.', track: 'network', difficulty: 'Intermediate', minutes: 90, release: 'V1.2' },
  { id: 'TR-RED-001', title: 'The Breach Files: AeroCart', subtitle: 'Run an authorised web pentest against a vulnerable shop: recon, exploit, remediate, verify and report, with a browser, proxy, repeater and terminal.', track: 'red', difficulty: 'Beginner to Advanced', minutes: 150, release: 'V1.0', href: 'redteam/' },
  { id: 'TR-RED-002', title: 'AeroPay: FinTech SaaS', subtitle: 'Access-control, business-logic and API-authorisation testing against a financial SaaS platform.', track: 'red', difficulty: 'Advanced', minutes: 150, release: 'V1.3' },
  { id: 'TR-RED-003', title: 'AeroDesk: Enterprise SaaS', subtitle: 'Multi-tenant isolation, object-level authorisation and privilege escalation in a collaboration app.', track: 'red', difficulty: 'Advanced', minutes: 150, release: 'V1.3' },
];
