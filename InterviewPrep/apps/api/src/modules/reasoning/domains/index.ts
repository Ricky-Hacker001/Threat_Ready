import type { ReasoningDomainKey } from '@threatready/contracts';
import type { DomainCatalogueEntry, ReasoningDomain } from '../domain.types.js';
import { CLOUD_SECURITY } from './cloud-security.js';

/**
 * Registered domains run end to end; the rest of the roadmap's fifteen are catalogue entries so the
 * landing page can show them as coming soon. To add a domain, write one definition file and add it
 * to REGISTERED. Nothing else changes.
 */
const REGISTERED: ReasoningDomain[] = [CLOUD_SECURITY];

export const DOMAIN_CATALOGUE: DomainCatalogueEntry[] = [
  { key: 'cloud_security', title: 'Cloud Security', description: 'Architectures on public cloud: identity, storage, network paths and the logs that show an attack.', track: 'Cloud Security' },
  { key: 'identity_access', title: 'Identity & Access', description: 'SSO, federation, privileged access and the trust relationships attackers abuse.', track: 'Identity & Access' },
  { key: 'application_security', title: 'Application Security', description: 'Web and service vulnerabilities as the way in, from the request to the data behind it.', track: 'Application Security' },
  { key: 'network_security', title: 'Network Security', description: 'Segmentation, firewalls, lateral movement and where to detect it.', track: 'Network Security' },
  { key: 'security_operations', title: 'Security Operations', description: 'Alerts, triage and the evidence that turns a signal into an incident.', track: 'Security Operations' },
  { key: 'incident_response', title: 'Incident Response & DFIR', description: 'Containment, evidence preservation and recovery under time pressure.', track: 'Incident Response' },
  { key: 'devsecops_supply_chain', title: 'DevSecOps & Supply Chain', description: 'Pipelines, dependencies, build integrity and deployment identities.', track: 'DevSecOps' },
  { key: 'container_kubernetes', title: 'Container & Kubernetes Security', description: 'Cluster trust boundaries, workload identity, images and runtime.', track: 'Platform Security' },
  { key: 'data_security', title: 'Data Security & Privacy', description: 'Classification, encryption, access paths and exfiltration routes.', track: 'Data Security' },
  { key: 'threat_intelligence', title: 'Threat Intelligence & Hunting', description: 'Adversary behaviour, hypotheses and the telemetry to test them.', track: 'Threat Intelligence' },
  { key: 'endpoint_security', title: 'Endpoint Security', description: 'Persistence, EDR evidence and containment on workstations and servers.', track: 'Endpoint Security' },
  { key: 'zero_trust', title: 'Zero Trust Architecture', description: 'Policy enforcement points, device and identity signals, and what breaks when trust is implicit.', track: 'Architecture' },
  { key: 'api_security', title: 'API Security', description: 'Authentication, authorisation and abuse across service interfaces.', track: 'Application Security' },
  { key: 'ai_llm_security', title: 'AI & LLM Security', description: 'Prompt injection, tool abuse, data leakage and guardrails around model-backed systems.', track: 'AI Security' },
  { key: 'grc_risk', title: 'GRC & Risk', description: 'Risk-based prioritisation, control mapping and defensible decisions for leadership.', track: 'Governance' },
];

const byKey = new Map(REGISTERED.map((d) => [d.key, d]));

export const getDomain = (key: string): ReasoningDomain | undefined => byKey.get(key as ReasoningDomainKey);
export const isAvailable = (key: string): boolean => byKey.has(key as ReasoningDomainKey);
export const registeredDomains = (): ReasoningDomain[] => [...REGISTERED];
export const catalogue = (): (DomainCatalogueEntry & { available: boolean })[] => DOMAIN_CATALOGUE.map((d) => ({ ...d, available: byKey.has(d.key) }));
