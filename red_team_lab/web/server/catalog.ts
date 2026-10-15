// The web pentest lab catalog. TR-RED-001 is playable; the rest are announced from the roadmap
// (Architecture Decision Document §7, V1.2 "Network Security and Red Team web pentest labs").
export interface CatalogEntry { id: string; title: string; subtitle: string; track: string; difficulty: 'Foundation' | 'Intermediate' | 'Advanced'; minutes: number; release: string }

export const CATALOG: CatalogEntry[] = [
  { id: 'TR-RED-001', title: 'The Breach Files — NovaCart', subtitle: 'A junior-pentester engagement against a vulnerable e-commerce app: recon, exploit, remediate, verify and report.', track: 'Red Team / Web', difficulty: 'Advanced', minutes: 150, release: 'V1.2' },
  { id: 'TR-RED-002', title: 'PayFlow — FinTech SaaS', subtitle: 'Access-control, business-logic and API-authorization testing against a financial SaaS platform.', track: 'Red Team / Web', difficulty: 'Advanced', minutes: 150, release: 'V1.3' },
  { id: 'TR-RED-003', title: 'TeamDesk — Enterprise SaaS', subtitle: 'Multi-tenant isolation, object-level authorization and privilege escalation in a collaboration app.', track: 'Red Team / Web', difficulty: 'Advanced', minutes: 150, release: 'V1.3' },
];
