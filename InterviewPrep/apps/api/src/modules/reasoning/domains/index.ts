import type { ReasoningDomainKey } from '@threatready/contracts';
import type { DomainCatalogueEntry, ReasoningDomain } from '../domain.types.js';
import { CLOUD_SECURITY } from './cloud-security.js';
import { IDENTITY_ACCESS } from './identity-access.js';
import { APPLICATION_SECURITY } from './application-security.js';
import { NETWORK_SECURITY } from './network-security.js';
import { SECURITY_OPERATIONS } from './security-operations.js';
import { INCIDENT_RESPONSE } from './incident-response.js';
import { DEVSECOPS_SUPPLY_CHAIN } from './devsecops-supply-chain.js';
import { CONTAINER_KUBERNETES } from './container-kubernetes.js';
import { DATA_SECURITY } from './data-security.js';
import { THREAT_INTELLIGENCE } from './threat-intelligence.js';
import { ENDPOINT_SECURITY } from './endpoint-security.js';
import { ZERO_TRUST } from './zero-trust.js';
import { API_SECURITY } from './api-security.js';
import { AI_LLM_SECURITY } from './ai-llm-security.js';
import { GRC_RISK } from './grc-risk.js';

/**
 * Registered domains run end to end. All fifteen planned domains are now registered; each is one
 * definition file. To add a domain, write one definition file and add it to REGISTERED. Nothing
 * else changes: generation, validation, similarity, evaluation, scoring, persistence, the API and
 * the UI are domain-agnostic and read the definition.
 */
const REGISTERED: ReasoningDomain[] = [
  CLOUD_SECURITY,
  IDENTITY_ACCESS,
  APPLICATION_SECURITY,
  NETWORK_SECURITY,
  SECURITY_OPERATIONS,
  INCIDENT_RESPONSE,
  DEVSECOPS_SUPPLY_CHAIN,
  CONTAINER_KUBERNETES,
  DATA_SECURITY,
  THREAT_INTELLIGENCE,
  ENDPOINT_SECURITY,
  ZERO_TRUST,
  API_SECURITY,
  AI_LLM_SECURITY,
  GRC_RISK,
];

/**
 * The catalogue mirrors the fifteen planned domains in display order. Titles, descriptions and
 * tracks come from the registered definition so there is a single source of truth; `available` is
 * computed from the registry.
 */
const CATALOGUE_ORDER: { key: ReasoningDomainKey; track: string }[] = [
  { key: 'cloud_security', track: 'Cloud Security' },
  { key: 'identity_access', track: 'Identity & Access' },
  { key: 'application_security', track: 'Application Security' },
  { key: 'network_security', track: 'Network Security' },
  { key: 'security_operations', track: 'Security Operations' },
  { key: 'incident_response', track: 'Incident Response' },
  { key: 'devsecops_supply_chain', track: 'DevSecOps' },
  { key: 'container_kubernetes', track: 'Platform Security' },
  { key: 'data_security', track: 'Data Security' },
  { key: 'threat_intelligence', track: 'Threat Intelligence' },
  { key: 'endpoint_security', track: 'Endpoint Security' },
  { key: 'zero_trust', track: 'Architecture' },
  { key: 'api_security', track: 'Application Security' },
  { key: 'ai_llm_security', track: 'AI Security' },
  { key: 'grc_risk', track: 'Governance' },
];

const byKey = new Map(REGISTERED.map((d) => [d.key, d]));

export const getDomain = (key: string): ReasoningDomain | undefined => byKey.get(key as ReasoningDomainKey);
export const isAvailable = (key: string): boolean => byKey.has(key as ReasoningDomainKey);
export const registeredDomains = (): ReasoningDomain[] => [...REGISTERED];

export const DOMAIN_CATALOGUE: DomainCatalogueEntry[] = CATALOGUE_ORDER.map(({ key, track }) => {
  const d = byKey.get(key);
  return { key, title: d?.title ?? key, description: d?.description ?? '', track: d?.track ?? track };
});

export const catalogue = (): (DomainCatalogueEntry & { available: boolean })[] => DOMAIN_CATALOGUE.map((d) => ({ ...d, available: byKey.has(d.key) }));
