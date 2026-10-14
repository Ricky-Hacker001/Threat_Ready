// The labs.threatready.io catalog. A lab with an engine registered in app.ts is playable; the rest
// are announced from the roadmap (Architecture Decision Summary §7) and shown as coming soon.
export interface CatalogEntry { id: string; title: string; subtitle: string; track: string; difficulty: 'Foundation' | 'Intermediate' | 'Advanced'; minutes: number; release: string }

export const CATALOG: CatalogEntry[] = [
  { id: 'TR-CLOUD-001', title: 'The Compromised Startup', subtitle: 'Investigate, contain and secure a vulnerable AWS environment while an intruder is active.', track: 'Cloud Security', difficulty: 'Intermediate', minutes: 120, release: 'V1.0' },
  { id: 'TR-SOC-001', title: 'Alert Storm', subtitle: 'Triage a SIEM queue, separate noise from an intrusion and escalate with evidence.', track: 'Security Operations', difficulty: 'Foundation', minutes: 90, release: 'V1.0' },
  { id: 'TR-DEVSECOPS-001', title: 'Poisoned Pipeline', subtitle: 'Find the secrets, risky dependencies and unsafe steps in a CI/CD pipeline and fix them.', track: 'DevSecOps', difficulty: 'Intermediate', minutes: 90, release: 'V1.1' },
  { id: 'TR-NET-001', title: 'Flat Network', subtitle: 'Map an exposed network, spot the lateral-movement paths and segment it.', track: 'Network Security', difficulty: 'Intermediate', minutes: 90, release: 'V1.2' },
  { id: 'TR-RED-001', title: 'Storefront Breach', subtitle: 'Test a web shop the way an attacker would and write up what you found.', track: 'Red Team', difficulty: 'Advanced', minutes: 150, release: 'V1.2' },
];
