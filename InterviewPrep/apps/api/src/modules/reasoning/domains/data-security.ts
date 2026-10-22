import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Data Security & Privacy: classification, encryption, access paths and exfiltration routes. The
 * diagram is where sensitive data lives and every path that can read or move it; the attack reaches
 * or moves regulated data through a key, a grant, a copy or an egress route.
 */
export const DATA_SECURITY: ReasoningDomain = {
  key: 'data_security',
  title: 'Data Security & Privacy',
  description: 'Read a data architecture with an active exfiltration or exposure, decide which access path, key or control the attack depends on, and defend the decision with evidence from access and egress logs.',
  track: 'Data Security',
  difficulty: 'intermediate',
  focus: [
    'Where regulated data actually sits, including copies, backups and caches',
    'What encryption and tokenisation protect against, and what they do not',
    'Access paths and grants that reach the data, direct and indirect',
    'Exfiltration routes and where egress would be seen',
  ],
  skillIds: ['data.pipelines', 'cloudsec.storage_exposure', 'cloudsec.iam', 'grc.risk_compliance', 'appsec.authz'],
  weights: { correctness: 30, reasoning: 35, architecture: 25, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1530', 'Data from Cloud Storage'),
    T('T1213', 'Data from Information Repositories'),
    T('T1005', 'Data from Local System'),
    T('T1039', 'Data from Network Shared Drive'),
    T('T1020', 'Automated Exfiltration'),
    T('T1041', 'Exfiltration Over C2 Channel'),
    T('T1048', 'Exfiltration Over Alternative Protocol'),
    T('T1537', 'Transfer Data to Cloud Account'),
    T('T1567.002', 'Exfiltration Over Web Service: Exfiltration to Cloud Storage'),
    T('T1552.001', 'Unsecured Credentials: Credentials in Files'),
    T('T1552.004', 'Unsecured Credentials: Private Keys'),
    T('T1555', 'Credentials from Password Stores'),
    T('T1486', 'Data Encrypted for Impact'),
    T('T1565', 'Data Manipulation'),
    T('T1074', 'Data Staged'),
    T('T1114', 'Email Collection'),
    T('T1119', 'Automated Collection'),
    T('T1134', 'Access Token Manipulation'),
    T('T1550.001', 'Use Alternate Authentication Material: Application Access Token'),
    T('T1199', 'Trusted Relationship'),
  ],
  variation: {
    topologies: [
      { id: 'warehouse_bi', label: 'Data warehouse feeding business intelligence', guide: 'A cloud warehouse with sensitive tables, ETL jobs with service accounts, a BI tool with a shared service account, analyst notebooks, and scheduled exports to object storage.' },
      { id: 'customer_pii_app', label: 'Customer application holding personal data', guide: 'An app database with personal records, a read replica for reporting, an export feature, a search index mirroring fields, caches, and a data-subject-request workflow.' },
      { id: 'payments_tokenised', label: 'Payment platform with tokenisation', guide: 'A card-data vault, a tokenisation service, an application that holds only tokens, a reconciliation export, a fraud model reading history, and a PCI-scoped segment.' },
      { id: 'healthcare_records', label: 'Clinical records across systems', guide: 'An EHR database, an imaging store, an analytics copy de-identified imperfectly, a vendor integration, and a research extract with a looser grant.' },
      { id: 'data_lake_tiers', label: 'Data lake with raw and curated tiers', guide: 'A raw landing bucket, a curated bucket, a catalog with grants, a query engine, cross-account sharing to a sister team, and lifecycle rules copying to cheap storage.' },
      { id: 'saas_data_sharing', label: 'SaaS product sharing data with customers and partners', guide: 'A multi-tenant store, per-tenant export APIs, signed download links, a partner data feed, a webhook delivering records, and a support impersonation tool.' },
      { id: 'backup_dr', label: 'Backup and disaster-recovery estate', guide: 'Primary databases, a backup vault, snapshots in a second region, an archival tier, restore tooling with broad read, and test restores into a less-controlled environment.' },
      { id: 'email_collab', label: 'Email and collaboration holding sensitive content', guide: 'Mailboxes, shared drives, a records management system, external sharing settings, retention policies, and third-party add-ins with content scopes.' },
    ],
    entryPoints: [
      { id: 'overbroad_grant', label: 'An over-broad grant on the sensitive store', guide: 'A role, group or catalog grant reaches the regulated table or bucket far beyond need; access logs show a principal reading at volume.' },
      { id: 'exposed_export', label: 'An export or download path authorised too loosely', guide: 'An export API or signed-link feature returns records with only authentication, so one account pulls data across tenants or subjects.' },
      { id: 'key_access', label: 'Access to the key that decrypts the data', guide: 'The attacker’s position can use the KMS key or the key material, so encryption at rest no longer protects the copy they can read.' },
      { id: 'unprotected_copy', label: 'An unprotected copy, replica or cache of the data', guide: 'A read replica, a search index, an analytics extract, or a cache holds the sensitive fields without the controls on the primary.' },
      { id: 'backup_read', label: 'Read access to backups or snapshots', guide: 'The backup vault or a cross-region snapshot is readable by a broad role; restoring or reading it yields the full dataset.' },
      { id: 'cross_account_share', label: 'A cross-account or partner share that is too wide', guide: 'Data shared to a sister team or partner includes more than intended, reachable by their compromised principal.' },
      { id: 'egress_to_personal', label: 'An egress route to attacker-controlled storage', guide: 'A workload or user can write to consumer cloud storage or an external endpoint, giving a path out for staged data.' },
      { id: 'deidentification_weak', label: 'A de-identified extract that can be re-identified', guide: 'An analytics or research copy was weakly anonymised and can be joined back to identities.' },
      { id: 'mailbox_collection', label: 'Mailbox or drive content reachable via a grant or app', guide: 'A delegated mailbox, a broad drive share, or an add-in with content scope exposes sensitive messages and files.' },
      { id: 'token_reuse_store', label: 'An application token that reads the store directly', guide: 'A leaked app or service token can call the data API directly, bypassing the UI’s per-record checks.' },
    ],
    objectives: [
      { id: 'break_the_path', label: 'The single change that cuts off the data', guide: 'Ask which one access, key, grant, copy or egress change stops the attacker reaching or moving the data; distractors are good data-protection practices that address a different path or do not apply here.', question: 'Which single change most directly breaks the attack path shown?', weights: { correctness: 30, reasoning: 35, architecture: 25, risk: 10 } },
      { id: 'where_data_reachable', label: 'Every place the data is actually reachable', guide: 'Ask which stores, copies, replicas, backups, caches or extracts the attacker can read given the grants and keys on the diagram; distractors miss a copy or over-state what one grant reaches.', question: 'From the compromised position, where is the sensitive data actually reachable?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'what_encryption_protects', label: 'What the existing protection does and does not stop here', guide: 'Ask whether encryption, tokenisation or masking on the diagram stops this attacker and why; distractors credit a control with protection it does not give against this access path.', question: 'Does the existing encryption or tokenisation stop this attacker, and why?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'detect_first', label: 'Where the access or exfiltration would be seen first', guide: 'Ask which log (data-access audit, object-storage access log, egress/proxy log, DLP, query history) would show it first; distractors exist but do not see this path.', question: 'Which log source would reveal this first, given the controls shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'contain_now', label: 'The first containment action', guide: 'Ask for the first action that stops further data access or egress without breaking a legitimate business process or losing evidence of what was taken; distractors are too broad, too narrow, or evidence-destroying.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 30, architecture: 15, risk: 25 } },
      { id: 'scope_exposure', label: 'What records and subjects are in scope', guide: 'Ask what data and whose records are exposed given the paths and copies reachable; distractors over- or under-state the exposure by ignoring a copy or a field set.', question: 'What data and whose records are in scope for notification?', weights: { correctness: 30, reasoning: 30, architecture: 20, risk: 20 } },
      { id: 'priority_order', label: 'The right order of two steps under a constraint', guide: 'Ask which of two actions comes first given the constraint (for example preserve access logs before revoking, or rotate the key before invalidating the copy); distractors invert the order.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 10, risk: 25 } },
    ],
    constraints: [
      { id: 'gdpr_clock', label: 'The data is personal data under GDPR with a 72-hour clock', guide: 'Scoping confidence drives an external deadline.' },
      { id: 'pci_scope', label: 'Card data is in scope for PCI DSS', guide: 'Scope, key handling and evidence requirements apply.' },
      { id: 'analytics_uptime', label: 'A reporting pipeline must keep running for the business', guide: 'Avoid cutting a path the business depends on when a narrower one works.' },
      { id: 'no_dlp', label: 'No DLP is deployed on egress', guide: 'Rely on access and network logs for detection.' },
      { id: 'many_copies', label: 'The dataset exists in several copies of unclear lineage', guide: 'A fix on the primary may miss the copies.' },
      { id: 'vendor_share', label: 'A partner depends on a data share under contract', guide: 'Cross-account changes have external consequences.' },
      { id: 'key_shared', label: 'One KMS key encrypts several datasets', guide: 'Rotating or disabling it affects more than this data.' },
    ],
    components: [
      'application database', 'read replica', 'data warehouse', 'sensitive table', 'object storage bucket', 'data catalog', 'catalog grant', 'ETL job', 'BI tool service account', 'analyst notebook', 'search index', 'cache', 'KMS key', 'tokenisation service', 'card-data vault', 'de-identified extract', 'backup vault', 'cross-region snapshot', 'archival tier', 'export API', 'signed download link', 'cross-account share', 'partner data feed', 'webhook', 'mailbox', 'shared drive', 'DLP', 'egress proxy', 'data-access audit log', 'object-storage access log', 'query history', 'support impersonation tool', 'retention policy',
    ],
  },
  guidance: `Data Security & Privacy realism rules:
- Use concrete names (for example "customers table", "exports-prod bucket", "kms-key-pii", "replica-reporting", "partner-feed") and name the data type (personal data, card data, clinical records). Never invent product features that do not exist.
- The attack path must be technically valid step by step: each step uses a grant, a key, a copy, a token, a share or an egress route the diagram shows. If a control on the diagram (encryption at rest, tokenisation, row-level security, a scoped grant, DLP, VPC-only access) would block a step, the path must go around it or the narrative must say why it did not apply.
- Be exact about what protection gives: encryption at rest does nothing against a principal who can use the key or read through the application; tokenisation protects the token store only if the vault is separately controlled; masking in the UI does not protect the API or the replica.
- Data lives in more places than the primary: replicas, indexes, caches, backups, snapshots, extracts and exports all count toward reachability and scope.
- Trust boundaries are real boundaries: application, data store, analytics copy, backup, cross-account/partner, egress.
- The best answer must be the one an experienced data-security engineer would choose for this exact diagram and constraint; distractors must be sound data controls that address a different path, do not break this one, or violate the constraint.
- Cite techniques from the ATT&CK Enterprise matrix only, favouring Collection and Exfiltration.`,
};
