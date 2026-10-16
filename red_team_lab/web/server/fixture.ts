// Initial seeded state of the AeroCart target — the vulnerable configuration a run starts from.
// SIMULATION ONLY: every identity, order, address, credential, secret and file here is synthetic.
// A per-run seed substitutes the JWT secret and the canary flag values so answers can't be shared.

import crypto from 'node:crypto';

export const TARGET_NAME = 'AeroCart';

export interface NcUser { id: number; username: string; password: string; email: string; role: 'customer' | 'admin'; fullName: string; address: string; phone: string }
export interface NcProduct { id: number; name: string; price: number; category: string; description: string }
export interface NcOrder { id: number; userId: number; items: { name: string; qty: number; price: number }[]; total: number; status: string; shipTo: string; placedAt: string }
export interface NcTicket { id: number; userId: number; subject: string; body: string; status: string; createdAt: string }

// Fixes the learner can apply. Each flips handler behaviour so a re-test proves the fix.
export interface Fixes {
  sqli: boolean;           // parameterised login query
  reflectedXss: boolean;   // output-encode search echo
  storedXss: boolean;      // sanitise ticket body on render
  idor: boolean;           // object-level authorisation on orders API
  jwtAuth: boolean;        // reject tokens signed with the old weak secret
  fileExposure: boolean;   // remove/deny the exposed backup artefact
  pathTraversal: boolean;  // canonicalise & jail the document path
  cmdInjection: boolean;   // argument-safe host ping (no shell)
  ssrf: boolean;           // allowlist the integration fetch target
}

export interface TargetState {
  seed: string;
  jwtSecret: string;            // weak, guessable HS256 secret (the vulnerability in V-JWT)
  flags: { backup: string; ssrf: string; traversal: string; cmd: string };
  users: NcUser[];
  products: NcProduct[];
  orders: NcOrder[];
  tickets: NcTicket[];
  nextTicketId: number;
  sessions: Record<string, { userId: number; createdAt: string }>;  // ac_session token -> user
  files: Record<string, string>;   // virtual document/file store (path -> contents)
  fixes: Fixes;
}

export interface BrowserState {
  cookies: Record<string, string>;  // the embedded browser's cookie jar for the target
  url: string;                       // current address-bar value (path?query)
  history: string[];
}

const SECRETS = ['aerocart', 'changeme', 'secret', 's3cr3t', 'password', 'ac-dev'];

export function createTargetState(seedInput?: string): TargetState {
  const seed = seedInput || crypto.randomBytes(6).toString('hex');
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  const pick = (i: number, arr: string[]) => arr[parseInt(h.slice(i, i + 2), 16) % arr.length];
  const flag = (tag: string) => `TR-${tag}-${h.slice(0, 8)}`;

  const users: NcUser[] = [
    { id: 1, username: 'admin', password: 'Nc@dmin!' + h.slice(2, 6), email: 'admin@aerocart.example', role: 'admin', fullName: 'Priya Nair', address: '4th Flr, Prestige Tower, Bengaluru 560001', phone: '+91-80-5550-0101' },
    { id: 2, username: 'rahul', password: 'hunter2-' + h.slice(4, 8), email: 'rahul@example.test', role: 'customer', fullName: 'Rahul Verma', address: '12 MG Road, Pune 411001', phone: '+91-98-7650-0022' },
    { id: 3, username: 'meera', password: 'letmein-' + h.slice(6, 10), email: 'meera@example.test', role: 'customer', fullName: 'Meera Iyer', address: '88 Residency Rd, Chennai 600028', phone: '+91-99-4410-7781' },
    { id: 4, username: 'daniel', password: 'qwerty-' + h.slice(8, 12), email: 'daniel@example.test', role: 'customer', fullName: 'Daniel Fernandes', address: '5 Hill View, Goa 403001', phone: '+91-91-2233-4455' },
  ];

  const products: NcProduct[] = [
    { id: 101, name: 'Aether Wireless Earbuds', price: 3499, category: 'Audio', description: 'Active noise cancellation, 28h battery.' },
    { id: 102, name: 'Lumen 4K Action Camera', price: 8999, category: 'Cameras', description: 'Waterproof to 10m, stabilised.' },
    { id: 103, name: 'Pulse Smart Band', price: 1999, category: 'Wearables', description: 'SpO2, sleep and heart-rate tracking.' },
    { id: 104, name: 'Nimbus Mechanical Keyboard', price: 5499, category: 'Accessories', description: 'Hot-swap switches, RGB.' },
    { id: 105, name: 'Orbit USB-C Hub', price: 2299, category: 'Accessories', description: '7-in-1, 100W passthrough.' },
  ];

  const orders: NcOrder[] = [
    { id: 5001, userId: 2, items: [{ name: 'Aether Wireless Earbuds', qty: 1, price: 3499 }], total: 3499, status: 'Shipped', shipTo: users[1].address, placedAt: '2026-09-28T10:12:00Z' },
    { id: 5002, userId: 3, items: [{ name: 'Lumen 4K Action Camera', qty: 1, price: 8999 }, { name: 'Orbit USB-C Hub', qty: 1, price: 2299 }], total: 11298, status: 'Processing', shipTo: users[2].address, placedAt: '2026-10-02T15:40:00Z' },
    { id: 5003, userId: 4, items: [{ name: 'Nimbus Mechanical Keyboard', qty: 1, price: 5499 }], total: 5499, status: 'Delivered', shipTo: users[3].address, placedAt: '2026-10-05T09:03:00Z' },
    { id: 5004, userId: 1, items: [{ name: 'Pulse Smart Band', qty: 2, price: 1999 }], total: 3998, status: 'Processing', shipTo: users[0].address, placedAt: '2026-10-09T18:22:00Z' },
  ];

  const tickets: NcTicket[] = [
    { id: 9001, userId: 2, subject: 'Where is my order 5001?', body: 'It says shipped but no tracking yet.', status: 'Open', createdAt: '2026-10-06T11:00:00Z' },
  ];

  const backupFlag = flag('BACKUP'), ssrfFlag = flag('SSRF'), travFlag = flag('TRAVERSAL'), cmdFlag = flag('CMDEXEC');
  const jwtSecret = pick(0, SECRETS);

  const files: Record<string, string> = {
    'invoices/INV-5001.txt': `AeroCart Invoice INV-5001\nOrder 5001 — Rahul Verma\nAether Wireless Earbuds x1 — ₹3,499\nTotal: ₹3,499\n`,
    'invoices/INV-5002.txt': `AeroCart Invoice INV-5002\nOrder 5002 — Meera Iyer\nLumen 4K Action Camera x1 — ₹8,999\nOrbit USB-C Hub x1 — ₹2,299\nTotal: ₹11,298\n`,
    'brochure.pdf': '%PDF-1.4 (synthetic product brochure)\n',
    // Sensitive artefacts that should not be reachable (V-FILE, V-TRAVERSAL):
    'backups/aerocart-db.sql.bak': `-- AeroCart DB backup (SIMULATED)\n-- EXPOSED SECRET FLAG: ${backupFlag}\nINSERT INTO users VALUES (1,'admin','Nc@dmin!...','admin');\nJWT_SIGNING_SECRET='${jwtSecret}';\n`,
    '.env': `# AeroCart service config (SIMULATED)\nNODE_ENV=production\nJWT_SECRET=${jwtSecret}\nDB_PASSWORD=ac_pg_synthetic\nTRAVERSAL_FLAG=${travFlag}\n`,
  };
  // Host files reachable only via path traversal out of the document root (V-TRAVERSAL):
  const hostFiles: Record<string, string> = {
    '/etc/passwd': `root:x:0:0:root:/root:/bin/bash\naerocart:x:1000:1000::/home/aerocart:/bin/bash\n# TRAVERSAL FLAG: ${travFlag}\n`,
    '/opt/aerocart/config/secrets.yml': `jwt_secret: ${jwtSecret}\nssrf_flag: ${ssrfFlag}\n`,
  };
  for (const [k, v] of Object.entries(hostFiles)) files['HOST:' + k] = v;

  return {
    seed, jwtSecret,
    flags: { backup: backupFlag, ssrf: ssrfFlag, traversal: travFlag, cmd: cmdFlag },
    users, products, orders, tickets, nextTicketId: 9002,
    sessions: {},
    files,
    fixes: { sqli: false, reflectedXss: false, storedXss: false, idor: false, jwtAuth: false, fileExposure: false, pathTraversal: false, cmdInjection: false, ssrf: false },
  };
}

// The internal metadata service reachable only through the SSRF-able integration endpoint (V-SSRF).
export function metadataResponse(t: TargetState): string {
  return [
    '# AeroCart internal metadata service (169.254.169.254) — SIMULATED, not a real cloud endpoint',
    'iam/role: ac-order-processor',
    `iam/credentials/access-key: AKIA_SYNTHETIC_${t.seed.toUpperCase()}`,
    `iam/credentials/secret-key: ${t.flags.ssrf}`,
  ].join('\n');
}
