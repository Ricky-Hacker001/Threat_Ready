import type { DiagramData } from '../reasoning/api';

/* Diagram fixtures shared by the layout tests and the dev harness (client/dev-diagram.html). */

const N = (id: string, label: string, boundary: string, type: DiagramData['nodes'][number]['type'] = 'service', extra: Partial<DiagramData['nodes'][number]> = {}) => ({ id, label, type, boundary, detail: null, compromised: false, entryPoint: false, controls: [], ...extra });
const E = (id: string, from: string, to: string, label: string, kind: DiagramData['edges'][number]['kind'] = 'data') => ({ id, from, to, label, kind });

/** Dense, realistic advanced-level shape: 12 components, 4 boundaries, 18 edges incl. two parallel pairs and long labels. */
export const dense: DiagramData = {
  boundaries: [
    { id: 'inet', label: 'Internet', kind: 'internet' },
    { id: 'edge', label: 'Edge', kind: 'edge' },
    { id: 'vpc', label: 'Production VPC', kind: 'vpc' },
    { id: 'data', label: 'Data tier', kind: 'data' },
  ],
  nodes: [
    N('atk', 'Internet attacker', 'inet', 'attacker'),
    N('usr', 'Customers', 'inet', 'user'),
    N('cdn', 'CDN front door', 'edge', 'gateway'),
    N('waf', 'Web application firewall', 'edge', 'firewall', { controls: ['managed rules'] }),
    N('lb', 'Public load balancer', 'edge', 'gateway'),
    N('web', 'orders web app', 'vpc', 'web', { compromised: true, entryPoint: true, controls: ['WAF'] }),
    N('api', 'billing API', 'vpc', 'api'),
    N('role', 'deploy-prod role', 'vpc', 'identity', { compromised: true }),
    N('meta', 'instance metadata endpoint', 'vpc', 'secret'),
    N('db', 'customer database', 'data', 'database', { controls: ['encryption at rest'] }),
    N('bucket', 'exports-prod bucket', 'data', 'storage'),
    N('kms', 'kms-key-pii', 'data', 'secret'),
  ],
  edges: [
    E('e1', 'usr', 'cdn', 'HTTPS 443'),
    E('e2', 'cdn', 'waf', 'forwards requests'),
    E('e3', 'waf', 'lb', 'allowed traffic'),
    E('e4', 'lb', 'web', 'HTTP 8080'),
    E('e5', 'web', 'api', 'REST calls with service token', 'auth'),
    E('e6', 'api', 'db', 'reads and writes customer rows'),
    E('e7', 'api', 'bucket', 'writes nightly exports'),
    E('e8', 'db', 'kms', 'decrypts with key', 'control'),
    E('e9', 'bucket', 'kms', 'decrypts objects', 'control'),
    E('e10', 'role', 'bucket', 'ListBucket, GetObject', 'auth'),
    E('e11', 'web', 'meta', 'fetches instance credentials', 'control'),
    // parallel pair web->api (data + attack)
    E('a1', 'atk', 'web', 'SSRF via URL preview', 'attack'),
    E('a2', 'web', 'meta', 'reads role credentials from metadata', 'attack'),
    E('a3', 'meta', 'role', 'assumes deploy-prod role', 'attack'),
    E('a4', 'role', 'bucket', 'bulk GetObject on exports', 'attack'),
    E('a5', 'bucket', 'kms', 'decrypts export objects', 'attack'),
    E('e12', 'web', 'db', 'direct read for legacy report'),
    E('e13', 'lb', 'api', 'health checks', 'control'),
  ],
  attackPath: ['a1', 'a2', 'a3', 'a4', 'a5'],
};

/** Many edges fanning out of one node into one rank gap: the classic same-column label pile-up. */
export const fan: DiagramData = {
  boundaries: [{ id: 'a', label: 'A', kind: 'vpc' }, { id: 'b', label: 'B', kind: 'private' }],
  nodes: [N('hub', 'central API gateway', 'a', 'gateway'), ...Array.from({ length: 7 }, (_, i) => N(`s${i}`, `service ${i} with a long name`, 'b'))],
  edges: Array.from({ length: 7 }, (_, i) => E(`f${i}`, 'hub', `s${i}`, `routes ${['orders', 'billing', 'auth', 'search', 'notify', 'reports', 'admin'][i]} traffic over mTLS`, i % 2 ? 'auth' : 'data')),
  attackPath: [],
};


/** Realistic intermediate pool item shape (9 components, 3 boundaries, 3 attack steps) with a shared trail node that many edges point at. */
export const realistic: DiagramData = {
  boundaries: [
    { id: 'inet', label: 'Internet', kind: 'internet' },
    { id: 'acct', label: 'Workload account', kind: 'account' },
    { id: 'saas', label: 'Third-party SaaS', kind: 'vendor' },
  ],
  nodes: [
    N('atk', 'Unknown remote operator', 'inet', 'attacker'),
    N('bucket', 'reports-share bucket', 'acct', 'storage', { entryPoint: true, compromised: true, controls: ['versioning'] }),
    N('task', 'ingest task role', 'acct', 'identity', { compromised: true }),
    N('secrets', 'secrets manager', 'acct', 'secret', { controls: ['KMS encrypted'] }),
    N('app', 'partner dashboard', 'acct', 'web', { controls: ['WAF'] }),
    N('db', 'accounts warehouse', 'acct', 'database'),
    N('trail', 'control-plane audit log', 'acct', 'control'),
    N('crm', 'CRM integration', 'saas', 'saas'),
    N('idp', 'workforce SSO', 'acct', 'identity', { controls: ['MFA'] }),
  ],
  edges: [
    E('f1', 'app', 'db', 'queries account rows'),
    E('f2', 'app', 'bucket', 'publishes partner reports'),
    E('f3', 'task', 'bucket', 'reads uploaded batches', 'auth'),
    E('f4', 'task', 'secrets', 'GetSecretValue crm-oauth', 'auth'),
    E('f5', 'app', 'crm', 'syncs contacts via OAuth token', 'data'),
    E('f6', 'idp', 'app', 'SAML sign-in', 'auth'),
    E('c1', 'task', 'trail', 'API calls recorded', 'control'),
    E('c2', 'app', 'trail', 'API calls recorded', 'control'),
    E('c3', 'secrets', 'trail', 'secret reads recorded', 'control'),
    E('a1', 'atk', 'bucket', 'anonymous ListBucket and GetObject', 'attack'),
    E('a2', 'bucket', 'task', 'leaked task-role session in a debug dump', 'attack'),
    E('a3', 'task', 'secrets', 'reads crm-oauth secret', 'attack'),
    E('a4', 'secrets', 'crm', 'replays OAuth token against CRM API', 'attack'),
  ],
  attackPath: ['a1', 'a2', 'a3', 'a4'],
};
