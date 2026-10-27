# Attack Reasoning: cost reduction design (26 Oct 2026)

Status: design for three parallel builders (ARCH, GEN, EVAL) and a later VERIFY step. Base: GitHub main @ 7d81555, production at migration 0016. No code is changed by this document.

Owner decisions implemented here (and nothing else):

1. A fixed **architecture library** of 15 architectures (5 beginner, 5 intermediate, 5 advanced), written by the coding agents and reviewed as files in the repo. Questions are generated only on top of them; the model no longer invents an architecture or a diagram.
2. Each generated question is served to **at most 2 learners**, then retired. A learner never gets the same question twice, nor a near-duplicate.
3. **Haiku** (SMALL tier, `LLM_MODEL_SMALL = claude-haiku-4-5`) writes the questions behind an automatic quality gate; a question that fails the gate is regenerated **once with Sonnet** (LARGE tier).
4. **Cheaper evaluation**: the option is scored in code; one Haiku pass marks the justification; the Sonnet challenger and reconciler run only for borderline or disputed answers; the item context is prompt-cached across stages.

Out of scope (owner did not choose them): Batch API, rubric shortening.

---

## Corrections after the real-model check and the review (27 Oct 2026)

The cost figures in §0, §5.3, §5.5, §6.2 and §7 below are the design's estimates. The bounded real-model check (VERIFY, 13 calls, US$0.41) and the review that followed did not bear them out for generation, for caching or for the escalated pair. This section is the current reference; the sections below keep the original reasoning and carry a short "Correction" note where they are wrong.

**Measured (n is small: 5 Haiku tries, 4 Sonnet rewrites, 2 answers):**

| Quantity | Design | Measured |
|---|---|---|
| C_H, one Haiku question try | US$0.0215 | US$0.0228 |
| C_S, one Sonnet rewrite | US$0.059 | US$0.0499 |
| p1, Haiku passes the gate | 0.7-0.9 | 0 of 5 |
| p2, the Sonnet rewrite passes | 0.9 | 1 of 4 |
| G = [C_H + (1-p1) C_S] / [p1 + (1-p1) p2], per stored question | US$0.028-0.040 | US$0.29 (realised US$0.31 for 1 question); 95% one-sided bounds on p1, p2 still give about US$0.058; posterior median about US$0.16-0.20 |
| Ladder failure rate (2 tries) | about 3% | 0.75 (about 0.56 with `REASONING_GENERATION_FIRST_TIER=LARGE`) |
| Single-pass evaluation | US$0.0105 | US$0.0126 |
| Escalated answer (Haiku + challenger + reconciler) | US$0.050-0.055 (with a cache read) | US$0.086 (pair US$0.078; no cache read) |
| Prompt cache | about US$0.005 saved per escalation | 71.4k tokens written, 4.3k read: +US$0.024 over the run (5.8% of spend) |

Consequences at the measured values: the pool's US$5/day cap pays for about 17 stored questions (34 seats), not 125-180; the idle stock of 45 buckets x 2 costs about US$26, not US$2.7-3.6; per learner question G/2 + E is about US$0.18-0.20 at an escalation rate e of 0.25-0.5, against US$0.106-0.154 before (+37-52% against the old cost per stored question of about US$0.100 including refused tries). The single-pass evaluation is the only part that saves money as measured. **The generation half must not be presented as a saving until it is re-measured.**

**Why generation failed, and what the review fixed (code, 27 Oct):** the gate, not token use. Fixed: the 8-word answer-key rule now checks the title, objective and question against the whole key, but the situation, narrative and step labels only against the best option's analysis less what a distractor's analysis also says (4 of 9 real rejections were evidence the key cites); a step from a component to itself and a compromised component off the path are dropped as repairs, not rejections; step labels are clipped at a word; a surface with several targets is rendered as "one chain that ends at ONE of these targets" (b3 pod-role-reach, b1 deploy-identity-misuse, i4 agent-authority); options are back to 15-45 words. Still to tune if the re-measurement shows them: the length tell (best option more than 20% longer than every distractor) and the rubric minimums, which Haiku missed most often.

**Rollout gates (owner decisions; no real AI calls were made for these fixes):**

1. Generation: re-run the bounded real check on at least 20 Haiku tries over 6+ buckets with the fixed gate, record p1, p2 and G here, and promote the Haiku-first ladder only when G is at most about US$0.04 (p1 about 0.7). Watch `ReasoningGenerationStored{Tier}` / `ReasoningGenerationAttempt{Tier}` and `ReasoningGenerationRejected{Reason}` after deploy. Until then the options are: keep the ladder and accept the measured cost; or set `REASONING_MAX_GENERATION_TRIES=3` while tuning (this departs from decision 3, "regenerated once with Sonnet"). `REASONING_GENERATION_FIRST_TIER=LARGE` only swaps the writer; it does not restore the pre-library behaviour (the gate is the new one).
2. Pool budget: size `REASONING_POOL_DAILY_CAP_USD` for the measured G (about US$0.15 per seat today), or the pool runs dry by mid-morning and learners fall back to on-demand generation billed to them. Refills now start only ladders the remaining pool budget can finish (`affordableLadders`), and an on-demand job re-checks the whole ladder before its first call.
3. Evaluation: run §11.4 steps 3-5 before relying on tiered mode: a reasoned answer, a generic guess with the correct option and a reasoned wrong answer on 3 items, tiered against `REASONING_EVALUATION_MODE=full` (about US$0.30-0.50). Record the escalation rate e and the score deltas, and tune `REASONING_ESCALATION_BAND`. On the fake fixtures the two modes agree by construction, except the new `QUIETCHALLENGE` fixture, which shows a confident over-credit that only the audit or full mode corrects. The old outcome for a generic correct guess (40/100, low confidence, review flag) no longer arises in tiered mode unless the answer escalates.

**Evaluation changes (27 Oct):** a random `REASONING_ESCALATION_AUDIT_RATE` (0.1) of answers that no rule escalated get the second review (reason `audit`), so text that talks Haiku round without tripping a rule cannot count on a single pass; the learner-facing "Reviewed a second time because ..." note is gone (it told a learner when the injection screen fired), the reasons stay in `stages.escalation`; `looksLikeInjection` also catches grader-facing paraphrases (12 new corpus cases); a deduction on a wrong option is not escalated when the answer stays below the borderline band even without it (`penalty_unconfirmed`, review COST-3); a learner's retry of a failed evaluation runs under the normal rules (it forced the Sonnet pair, review COST-6); an evidence quote stitched from verbatim passages in order, each at least 8 words, counts (scoring v3, prompt v4); learner-facing model text is clipped at a sentence or a word and has room for the lengths the prompts ask for. Expected E with the audit: 0.0126 + (e + 0.1 x (1 - e)) x 0.078.

**Caching (27 Oct):** each stage sends its own structured-output format, and a format change invalidates the prompt cache, so the challenger's entry was never the reconciler's read; generation calls run in parallel on different architectures and the tier switch changes the model. `REASONING_PROMPT_CACHE` (default false) now decides whether Attack Reasoning prompts are marked at all; with it off nothing pays the write premium. Owner decision 4's "item context prompt-cached across stages" is therefore not delivered: delivering it needs the challenger and reconciler to share one output contract (for example one strict tool list with `tool_choice` auto and an instruction naming the tool; forced `tool_choice` is a 400 on Sonnet 5.5) and a bounded real check that the reconciler then reads the challenger's entry.

**Pool and per-learner bounds (27 Oct):** `REASONING_USER_DAILY_QUESTIONS` 40 -> 12; `REASONING_USER_DAILY_REFILLS` now counts pool questions a learner's starts and prefetches may have generated per day (12; it counted refill jobs of up to 4); structure collisions are checked only against live questions and the learner's own, retired questions leave the text-similarity bank after `REASONING_LIBRARY_BANK_DAYS` (30), and the never-a-near-duplicate guarantee is kept at serve time (same architecture, path and objective as anything the learner was served); pool demand counts what a learner cannot be served. Residual: one account opening 12 questions a day in idle buckets still makes the schedule activate those buckets (up to the target) and keep 3 unseen for it; at the measured G that alone can spend most of the pool cap. The total stays bounded by the pool cap and the breaker; revisit the targets once G is re-measured.

---

## 0. Summary of the design

> Correction (27 Oct): the cost rows below are design estimates; see "Corrections after the real-model check" above for the measured values.

| Area | Today | After |
|---|---|---|
| Architecture and diagram | Written by Sonnet for every question (3.3k chars of diagram, 1.3k of scenario) | Read from one of 15 reviewed JSON files; the model writes only an **attack overlay** (entry node, compromised nodes, attack steps between existing node ids) and a short **situation** |
| Question writer | Sonnet 5.5, up to 3 tries | Haiku 4.5 first; one Sonnet retry if the gate fails; at most 2 billed calls per question |
| Quality gate | Code validators + bucket similarity | The same validators adapted to the library, plus grounding (node ids are a schema enum), answer-key consistency, leak and tell checks, architecture-aware similarity |
| Serves per question | 25 (`REASONING_ITEM_MAX_SERVES`) | 2, enforced atomically in the database (no overshoot under concurrency) |
| Repeats | Same item never twice | Same item never twice, and never an item with the same variation fingerprint as one already served |
| Evaluation | 3 Sonnet calls on every answer | Option scored in code; 1 Haiku call; Sonnet challenger + reconciler only when an escalation rule fires; the item context is a cached system prefix |
| Cost per stored question | about US$0.074 (ledger) | about US$0.028-0.040 |
| Cost per evaluated answer | about US$0.069 (formula) to 0.08 (measured) | about US$0.023-0.031 at 25-40% escalation |
| Cost per learner question (generation share + evaluation) | US$0.106-0.154 | US$0.037-0.051 |

Rollback switches: `REASONING_GENERATION_FIRST_TIER=LARGE` (Sonnet writes questions again, still on the library) and `REASONING_EVALUATION_MODE=full` (three Sonnet stages on every answer, exactly as before).

---

## 1. The current pipeline (as read, the parts this design changes)

- **Generation** (`modules/reasoning/generation.service.ts`, `prompts/generation.prompts.ts`): one structured call per try (`tier: 'LARGE'`, `maxOutputTokens: 16000`, `effort: 'medium'`) returns the whole item including `diagram` (boundaries, nodes with flags, edges including attack edges, `attack_path`) and a 180-320 word `scenario`. `normaliseGeneratorOutput` repairs mechanical omissions, `validateGeneratedItem` checks options, leaks, diagram integrity, narrative consistency, rubric shape, level floors and techniques; `checkSimilarity` compares word-3-gram Jaccard (threshold 0.35) and the seed fingerprint (`domain|topology|entryPoint|objective|technique`) with the bucket's latest 80, the domain's latest 40 at other levels and (on demand) everything the learner has had in the domain. Up to `REASONING_MAX_GENERATION_TRIES` (3) Sonnet calls with the errors fed back. `LlmService.structured` additionally retries once on a schema failure.
- **Pool and serving** (`reasoning.service.ts create()`, `poolStatus()`; `generation.service.ts needed()/demand()/refillPool()`): a random live pool item (`serve_count < REASONING_ITEM_MAX_SERVES`) not in the learner's `reasoning_served`; `serve_count` is bumped by an AFTER INSERT trigger on `reasoning_served` (migration 0016). The check `serve_count < max` runs at SELECT time without a lock, so concurrent serves can overshoot the cap (harmless at 25, not at 2). Demand-driven refill per (domain, difficulty) bucket on the `pool` budget.
- **Evaluation** (`evaluation.service.ts`, `prompts/evaluation.prompts.ts`, `scoring.ts`): evaluator (`reasoning` policy), challenger and reconciler (`finalize` policy), all LARGE. Each stage puts `itemContext(item)` (scenario, narrative, `diagramText`, options, key, rubric, must-not-credit, reference answer) in the **user** message after a stage-specific system prompt, so nothing is shared in the cache between stages. `scoreAttempt` computes every number from point statuses (quote check, must-not-credit, integrity, caps, confidence). Without a reconciler, `assembleFeedback` falls back to authored content and a raw `diagramText` dump as the architecture analysis.
- **LLM layer** (`modules/ai/llm.service.ts`, `platform/adapters/anthropic-llm.adapter.ts`): requests name a tier, never a model; the adapter marks the whole `system` string with `cache_control: ephemeral`; reservations use `estimate()` (prompt chars / 3 plus the full output allowance); billed failures are recorded with their cost.
- **Client** (`attack-reasoning/client/src/reasoning/Diagram.tsx`, `pages.tsx`): renders `item.diagram` (React Flow + dagre) and `item.scenario` / `item.attackNarrative` as `.ar-prose` (`white-space: pre-line`). It does not know where the diagram came from.

Cost drivers: generation output (6.4k tokens per call on average, of which the diagram and scenario are about a third of the visible JSON and medium-effort thinking the rest) is 98% of the reasoning spend in the local ledger; every answer pays three Sonnet calls.

---

## 2. The architecture library

### 2.1 Files

```
apps/api/src/modules/reasoning/architectures/
  architecture.schema.json      JSON Schema for editors (generated from schema.ts; a test keeps it in sync)
  types.ts                      TypeScript types (section 10.1)
  schema.ts                     zod schema, the source of truth; parseArchitecture()
  index.ts                      static imports of the 15 files, validation at load, lookup helpers
  text.ts                       architectureText(), architectureShingles()
  compose.ts                    composeDiagram(), normaliseOverlay(), validateOverlay(), pathKey()
  b1-online-shop.json  ...  b5-...json
  i1-...json           ...  i5-...json
  a1-...json           ...  a5-...json
```

The JSON files are imported statically with `import b1 from './b1-online-shop.json' with { type: 'json' }` (TypeScript 5.9, `module: NodeNext`, `resolveJsonModule: true`; `tsc -p tsconfig.build.json` copies imported JSON into `dist`). `index.ts` parses every file with the zod schema and runs the cross-file checks at module load, so a broken library fails the boot and the tests, never a learner request. File names are `<id>.json`; ids are `b1-…` to `b5-…`, `i1-…` to `i5-…`, `a1-…` to `a5-…` (lowercase, `[a-z0-9-]`, at most 40 characters).

### 2.2 Format

One file is one `ArchitectureDef` (types in section 10.1). Fields and rules:

| Field | Content | Rules |
|---|---|---|
| `$schema` | `"./architecture.schema.json"` | optional, ignored at runtime |
| `id`, `version`, `level`, `title` | stable id, integer version (bump on any change), `beginner`/`intermediate`/`advanced`, display title (at most 80 chars) | ids and titles unique across the library |
| `organisation` | `name` (fictional), `industry`, `size`, `summary` | `summary` 250-650 chars, one paragraph; it becomes the first paragraph of every question's scenario. No real company, product brand or person |
| `diagram.boundaries` | `{ id, label, kind }` with `kind` from `DiagramBoundaryKind` | every boundary holds at least one node, or is the boundary of an attacker origin |
| `diagram.nodes` | `{ id, label, type, boundary, detail, controls }`: the contract's `DiagramNode` without `compromised` / `entryPoint` (the overlay sets them) | `type` from `DiagramNodeType`, never `attacker`; `label` at most 60 chars and specific ("exports-prod bucket"); `detail` at most 160 chars; `controls` are the short labels drawn on the node |
| `diagram.edges` | `{ id, from, to, label, kind }` with `kind` in `data`/`auth`/`control` | never `attack`; ids must not start with `atk`; `label` at most 70 chars |
| `attackerOrigins` | `{ id, label, boundary, detail }`, for example `attacker` (External attacker, internet), `insider` (Malicious insider, corporate), `vendor-actor` | at least one; added to the diagram only when a question's attack path starts there |
| `identities` | `{ id, label, kind, nodeIds, privileges, notes }` (`kind`: human, workload, service, federated, machine, vendor) | node ids exist |
| `dataStores` | `{ nodeId, data, classification, regulations }` | at least one `regulated` or `confidential` store |
| `controls` | `{ id, label, nodeIds, status, covers, limits }` (`status`: present, partial, missing) | a present/partial control's `label` appears in `controls` of at least one of its nodes; a missing one appears on none; at least one `missing` |
| `trustRelationships` | `{ id, from, to, via, subtle, notes }` (role assumption, federation, peering, shared secret, service token, implicit network trust) | advanced: at least one with `subtle: true` |
| `logSources` | `{ id, label, nodeIds, records, gaps }` | at least one; the SOC, IR and TI questions cite them as evidence |
| `attackSurfaces` | map from domain key to a list of `{ id, summary, entryNodeIds, targetNodeIds, viaNodeIds, techniques, objectives, notes }` | see coverage below; `techniques` are ids from that domain's `techniques` list (ATLAS ids for `ai_llm_security`); `objectives` is null (all of the domain's objectives) or a subset of the domain's objective ids; every node id exists (entry ids may be attacker origins) |
| `reviewNotes` | free text for reviewers | never sent to the model |

Size bounds per level (nodes exclude attacker origins; the composed diagram stays within `validateDiagram`'s 18 nodes):

| Level | Nodes | Boundaries | Attack steps a question may use | Extra requirements |
|---|---|---|---|---|
| beginner | 7-10 | 2-4 | 1-2 | one obvious entry per surface |
| intermediate | 9-13 | 3-5 | 2-3 | at least one control that matters on each surface's path |
| advanced | 12-16 | 4-6 | 3-5 | at least one `subtle` trust relationship and one present control whose `limits` make it not apply to some path |

`architectureText(arch)` (the cached prompt prefix, section 3.2) must stay within 7k chars (beginner), 10k (intermediate), 14k (advanced).

**Coverage rule** (checked by `libraryErrors()` and a unit test): for each level, every one of the 15 domains has attack surfaces in **at least 3 of the 5 architectures**, and each such architecture has **at least 2 surfaces** for that domain. So every bucket (domain x level) draws from at least 3 architectures and 6 surfaces.

### 2.3 The 15 architectures (plan for ARCH)

ARCH may change names and details; the coverage test is the contract. Domain abbreviations: CL cloud, IA identity, AS application, NS network, SO security operations, IR incident response, DS DevSecOps/supply chain, CK container/Kubernetes, DA data, TI threat intelligence, EP endpoint, ZT zero trust, AP API, AI AI/LLM, GR GRC.

| Id | Architecture | Domains with surfaces |
|---|---|---|
| b1-online-shop | Online shop on one cloud account: CDN with WAF, shop web app, orders database, exports bucket, payment provider (SaaS, webhooks), hosted CI with a long-lived deploy key, cloud audit log | CL IA AS AP DA DS IR GR SO |
| b2-accounting-office | Small accounting firm: staff laptops with EDR, office firewall and Wi-Fi, NAS file server, SaaS email and documents, IdP with MFA, VPN, cloud backup, AI email-assistant SaaS with mailbox access | EP NS IA DA IR TI ZT GR SO AI |
| b3-mobile-backend | Mobile app backend on a small managed Kubernetes cluster: API gateway, auth service (OAuth), API pods, NoSQL table, image bucket, push-notification SaaS, mobile build pipeline | AP AS CK CL IA DS DA ZT NS |
| b4-support-chatbot | Customer-support chatbot: web widget, bot service on a container service, LLM provider API, knowledge-base vector store, ticketing SaaS used as a tool, support agents' laptops, admin console | AI AP AS DA IA EP GR IR TI CK |
| b5-dev-studio | Small software studio: developer laptops, office VPN, managed Kubernetes, CI/CD and container registry, central logging, AI code-review bot with repository access | CL DS SO EP NS TI ZT CK AI |
| i1-fintech-payments | Payments platform, multi-account cloud: partner API with mTLS, microservices on Kubernetes, card vault with KMS, event bus, fraud-scoring ML model, CI/CD with OIDC to the cloud, SIEM | CL AP DA DS CK IA GR SO ZT AI |
| i2-regional-hospital | Hospital hybrid network: on-premises EHR, Active Directory, VPN and ZTNA, clinical device segment, email, EDR, SIEM, vendor remote access, cloud backup | NS EP IA IR SO TI ZT DA GR |
| i3-b2b-saas | Multi-tenant B2B SaaS: SSO federation with customer IdPs, tenant-scoped database, public API with OAuth scopes, webhooks, workers on Kubernetes, per-tenant storage, support impersonation tool, LLM summaries | AS AP IA DA AI CL ZT SO CK NS |
| i4-insurer-rag | Insurance company's internal RAG assistant and data lake: LLM gateway, agent with ticketing and email tools, vector store fed from document shares, PII data lake, notebooks, prompt and model CI, employee laptops | AI DA CL DS IA TI IR GR AP AS EP |
| i5-dev-platform | Software company platform: source control, self-hosted CI runners on Kubernetes, artifact registry and package mirror, signing, GitOps to production, developer laptops with EDR, secrets vault, SIEM | DS CK EP CL IA SO TI IR NS AS |
| a1-hybrid-bank | Bank, on-premises core and two clouds: AD to cloud-IdP federation, PAM, HSM, payments messaging gateway, SOC with SIEM and SOAR, managed-service-provider access, data warehouse, digital banking on Kubernetes | IA CL NS ZT SO IR TI GR DA EP DS |
| a2-saas-at-scale | Multi-region SaaS: Kubernetes with a service mesh, workload identity and cross-account roles, GitOps with artifact signing, feature-flag SaaS, public and GraphQL APIs, customer-managed keys, LLM agent features with tools | CK DS CL AP AS ZT AI DA IA IR NS |
| a3-manufacturer-ot | Manufacturer with IT/OT convergence: PLC network, historian, engineering workstation, DMZ jump host, cloud ERP, vendor remote access, EDR, SIEM, OT monitoring sensor | NS EP IR SO TI IA GR ZT CL |
| a4-ai-company | AI product company: training data lake and feature store, GPU Kubernetes cluster, model registry, inference API, agent with code-execution and browsing tools, RAG over customer documents, evaluation pipeline, third-party model provider | AI DA DS CK CL AP AS GR TI IA |
| a5-health-exchange | Health data exchange: FHIR API gateway with SMART-on-FHIR partners, consent service, patient portal and mobile app, national IdP federation, de-identified warehouse, research enclave, clinician devices, LLM summarisation on Kubernetes | AP IA DA GR ZT AS SO IR EP CK AI |

Per level each domain is covered 3 or 4 times (checked when the table was drawn up; the test re-checks the files).

### 2.4 Example (abridged)

```json
{
  "$schema": "./architecture.schema.json",
  "id": "b1-online-shop",
  "version": 1,
  "level": "beginner",
  "title": "Online shop on one cloud account",
  "organisation": {
    "name": "Halden Outdoor",
    "industry": "Retail e-commerce",
    "size": "120 staff; a two-person platform team",
    "summary": "Halden Outdoor sells camping gear online. Customers sign in and pay through the shop web app; card payments go to an external payment provider and the shop keeps order history, addresses and payment tokens in its orders database. A nightly job writes order exports to a storage bucket that finance downloads. Two platform engineers run everything in one cloud account and deploy from a hosted CI pipeline."
  },
  "diagram": {
    "boundaries": [
      { "id": "internet", "label": "Internet", "kind": "internet" },
      { "id": "edge", "label": "Public edge", "kind": "edge" },
      { "id": "app", "label": "Application subnet", "kind": "private" },
      { "id": "data", "label": "Data tier", "kind": "data" },
      { "id": "cicd", "label": "CI/CD", "kind": "cicd" }
    ],
    "nodes": [
      { "id": "customers", "label": "shop customers", "type": "user", "boundary": "internet", "detail": "Browse, sign in and pay", "controls": [] },
      { "id": "cdn-waf", "label": "CDN with WAF", "type": "gateway", "boundary": "edge", "detail": "TLS termination and managed WAF rules", "controls": ["WAF"] },
      { "id": "shop-app", "label": "shop web app", "type": "web", "boundary": "app", "detail": "Containers serving accounts and checkout", "controls": ["optional MFA"] },
      { "id": "orders-db", "label": "orders database", "type": "database", "boundary": "data", "detail": "Orders, addresses, payment tokens", "controls": ["encryption at rest"] },
      { "id": "exports-bucket", "label": "exports-prod bucket", "type": "storage", "boundary": "data", "detail": "Nightly CSV order exports for finance", "controls": ["versioning"] },
      { "id": "payments", "label": "payment provider", "type": "saas", "boundary": "internet", "detail": "Hosted card fields; signed webhooks", "controls": ["signed webhooks"] },
      { "id": "ci", "label": "hosted CI pipeline", "type": "pipeline", "boundary": "cicd", "detail": "Builds and deploys on merge to main", "controls": [] },
      { "id": "deploy-key", "label": "deploy-prod access key", "type": "secret", "boundary": "cicd", "detail": "Long-lived cloud key stored as a CI secret", "controls": [] },
      { "id": "audit-log", "label": "cloud audit log", "type": "control", "boundary": "app", "detail": "Control-plane API calls, 90 days", "controls": ["immutable retention"] }
    ],
    "edges": [
      { "id": "e1", "from": "customers", "to": "cdn-waf", "label": "HTTPS 443", "kind": "data" },
      { "id": "e2", "from": "cdn-waf", "to": "shop-app", "label": "HTTPS to origin", "kind": "data" },
      { "id": "e3", "from": "shop-app", "to": "orders-db", "label": "SQL 5432", "kind": "data" },
      { "id": "e4", "from": "shop-app", "to": "exports-bucket", "label": "writes nightly exports", "kind": "data" },
      { "id": "e5", "from": "payments", "to": "shop-app", "label": "payment webhooks", "kind": "data" },
      { "id": "e6", "from": "ci", "to": "deploy-key", "label": "reads CI secret", "kind": "auth" },
      { "id": "e7", "from": "deploy-key", "to": "shop-app", "label": "deploys containers", "kind": "control" }
    ]
  },
  "attackerOrigins": [{ "id": "attacker", "label": "external attacker", "boundary": "internet", "detail": "Unknown address" }],
  "identities": [{ "id": "deploy-identity", "label": "deploy-prod user", "kind": "machine", "nodeIds": ["deploy-key"], "privileges": ["deploy containers", "read and write exports-prod bucket"], "notes": "Created for CI; never rotated" }],
  "dataStores": [{ "nodeId": "orders-db", "data": "order history, addresses, payment tokens", "classification": "regulated", "regulations": ["PCI DSS", "GDPR"] }],
  "controls": [
    { "id": "waf", "label": "WAF", "nodeIds": ["cdn-waf"], "status": "present", "covers": "Common web attacks on the public path", "limits": "Does not see cloud API calls or CI" },
    { "id": "ci-mfa", "label": "MFA on CI", "nodeIds": ["ci"], "status": "missing", "covers": "Account takeover of the CI service", "limits": null }
  ],
  "trustRelationships": [{ "id": "ci-to-cloud", "from": "ci", "to": "shop-app", "via": "long-lived access key", "subtle": false, "notes": null }],
  "logSources": [{ "id": "audit", "label": "cloud audit log", "nodeIds": ["audit-log"], "records": "Every control-plane call with source IP and identity", "gaps": "No object-level read events on the bucket" }],
  "attackSurfaces": {
    "cloud_security": [
      { "id": "leaked-deploy-key", "summary": "The CI deploy key leaks and is used from outside to read exports", "entryNodeIds": ["deploy-key"], "targetNodeIds": ["exports-bucket"], "viaNodeIds": [], "techniques": ["T1078.004", "T1530"], "objectives": null, "notes": null },
      { "id": "public-exports", "summary": "A bucket policy change exposes the exports bucket", "entryNodeIds": ["exports-bucket"], "targetNodeIds": ["exports-bucket"], "viaNodeIds": [], "techniques": ["T1530"], "objectives": ["detect_first", "contain_now", "least_privilege_fix"], "notes": null }
    ]
  },
  "reviewNotes": "Beginner: two obvious paths (identity, storage)."
}
```

### 2.5 Composing a question's diagram

A generated question carries an **attack overlay** (`AttackOverlay`, section 10.1): `entryNode`, `compromisedNodes`, ordered `steps` `{ from, to, label }` between node ids (the first step may start at an attacker origin). `composeDiagram(arch, overlay)` returns a contract `DiagramData`:

- nodes: the library nodes with `entryPoint = (id === overlay.entryNode)` and `compromised = compromisedNodes.includes(id) || id === entryNode`; plus the attacker origin node (`type: 'attacker'`, both flags false) only when a step starts there;
- edges: the library edges, then one edge per step with id `atk1..atkN` and `kind: 'attack'`;
- `attackPath`: `['atk1', …, 'atkN']`;
- boundaries: the library boundaries that hold at least one node of the composed diagram.

The composed diagram passes the existing `validateDiagram` rules (connected path, starts at the entry point or an attacker, normal flows present). `validateOverlay` adds: every id exists; the steps chain end to end; step count within the level's range; no self-loops or repeated steps; `entryNode` is the first non-origin node on the path; `compromisedNodes` are on the path; the path touches at least one of the seed surface's entry or target nodes. A step between two nodes with no library edge or trust relationship between them is a **warning** (logged with a metric), not an error: real attacks use paths that are not drawn as normal flows (SSRF to a metadata service, lateral movement).

`normaliseOverlay` repairs mechanical omissions: steps listed out of chain order are reordered; a missing entry node is inferred (the first non-origin node); duplicate compromised ids are dropped. `pathKey(arch, overlay)` = `<arch id>:<node ids of the path joined by '>'>` (origins included), the structural identity of an attack used by the similarity check.

### 2.6 Versioning

Any edit to a file bumps its `version`. Items store the composed diagram and the architecture version (section 4), so an edit never changes a question that already exists; new questions use the new version. `LIBRARY_VERSION` in `index.ts` (for example `arch-lib.v1.2026-10-26`) is bumped with any file change and logged at boot.

---

## 3. Generating a question on an architecture

### 3.1 Choosing what to write (the seed)

`VariationSeed` keeps its fields and gains `architecture` (section 10.2). For a library seed, `topology` holds the architecture id and `entryPoint` the surface id, so `fingerprintOf()` (`domain|topology|entryPoint|objective|technique`) is unchanged in code and means `domain|architecture|surface|objective|technique`.

`pickLibrarySeed(domain, level, archs, recent, rng, exclude)` (GEN, `seed.ts`):

1. architecture: among `architecturesFor(domain, level)`, the one with the fewest **live** items in the bucket (pool refill) or the fewest items the learner has seen (on demand); ties at random;
2. surface: least seen among `surfacesFor(arch, domain)`;
3. objective: least seen among the surface's `objectives` (or all of the domain's);
4. technique: least seen among the surface's `techniques`;
5. constraint: least seen among the domain's constraints;
6. reject a fingerprint already used by a live item, by the learner (on demand), or by another seed of the same batch; up to 64 draws, then exhaustive, then any (the gate's similarity check still applies).

The domain files keep `topologies` and `entryPoints` for legacy items; new generation does not read them.

### 3.2 The request (cache-friendly layout)

`questionRequest(ctx)` returns an `LlmRequest` in three layers, most stable first:

| Layer | Field | Content | Shared by |
|---|---|---|---|
| 1 | `systemPrefix` (new, section 10.4) | generic writer rules (role, situation/narrative/options/key/rubric/must-not-credit/reference rules, output rules) + "The architecture (fixed; never add, remove or rename components; refer to components by their labels; use node ids only in the attack fields)" + `architectureText(arch)` | every question on this architecture, any domain, any tier's own cache |
| 2 | `system` | domain section (`domain.title`, `framing`, `guidance`, the framework's `citeRule`) + the level guide (attack steps, how defensible the distractors are, rubric size, and for advanced "use the subtle trust relationship or the control that does not apply") | every question on this architecture in this bucket |
| 3 | `messages[0]` (user) | the variation (surface summary with its entry, via and target node ids and labels; objective label, guide and question; technique; constraint), the level's hard limits, up to 8 **avoid** lines for this architecture and domain (`- <title>: <question> [path: label > label > label; objective: <id>]`), and on the Sonnet retry the gate's findings | one call |

The adapter marks both system blocks with `cache_control: ephemeral` (two of the four breakpoints). Haiku 4.5 only caches prefixes of at least 4,096 tokens, so for beginner architectures the prefix may simply not cache (no error, no write premium); Sonnet 5.5 caches from 512 tokens. Caches are per model, so the Haiku call and the Sonnet retry never share one. The saving is small (about US$0.004 per Haiku cache hit); the layout matters more for keeping prompts byte-stable. No timestamps, ids or random text go into layers 1 and 2.

Request parameters:

Parameters follow the tier of the call (try 1 runs on `REASONING_GENERATION_FIRST_TIER`, default `SMALL`; every later try on `LARGE`):

| Call | `tier` | `maxOutputTokens` | `effort` | `timeoutMs` |
|---|---|---|---|---|
| Haiku | `SMALL` | 8000 | omitted (Haiku 4.5 rejects it; the adapter already drops it) | 90000 (the SMALL default of 20 s is too short for a 3-4k token item; 90 s stays inside the queue policy, which sizes reasoning jobs on `LLM_TIMEOUT_MS_LARGE`) |
| Sonnet | `LARGE` | 12000 | `medium` | tier default |

`GENERATION_PROMPT_VERSION = 'reasoning-generate.v3'`, `GENERATOR_VERSION = 'gen.v3.2026-10-26'`.

### 3.3 Output schema (`reasoning_question`)

`questionSchema(arch, domain)` (GEN, `prompts/generation.prompts.ts`): the current item minus `diagram` and `scenario`, plus `situation`, `attack` and `architecture_analysis`. Node ids and technique ids are **schema enums**, so the model cannot reference a component that does not exist or invent a technique id.

```ts
z.object({
  title: str(90),
  situation: str(1100),                 // 80-150 words: what is happening at the company today, the constraint; never restates the summary
  attack_narrative: str(1400),          // 100-170 words, step by step, with evidence from the architecture's log sources
  objective: str(240),
  question: str(500),
  options: arr(z.object({ id: OptionId, text: str(360) }), 4),
  correct_option: OptionId,
  option_analysis: arr(z.object({ id: OptionId, verdict: OptionVerdict, why: str(400) }), 4),
  attack: z.object({
    entry_node: enumOf(nodeIds),
    compromised_nodes: arr(enumOf(nodeIds), 6),
    steps: arr(z.object({ from: enumOf(nodeAndOriginIds), to: enumOf(nodeIds), label: str(70) }), 6),
  }),
  rubric: /* unchanged: 6-10 points, reasoning/architecture/risk, weight '1'..'5', hint, explanation */,
  must_not_credit: /* unchanged */,
  reference_answer: str(1800),
  architecture_analysis: str(900),      // 80-140 words, second person: components, boundaries and trust relationships the path crosses, which controls apply and which do not
  techniques: arr(z.object({ id: enumOf(domainTechniqueIds), name: str(80) }), 6),
  concepts: arr(str(60), 10),
  difficulty: ReasoningDifficulty,
})
```

Rubric rules and limits are unchanged (rubric shortening is out of scope). Technique names are replaced from the domain's list in code.

`toLibraryItem(out, arch, domain, seed, weights)` builds the stored `GeneratedItem`:

- `public.scenario` = `arch.organisation.summary + "\n\n" + out.situation` (rendered as two paragraphs by `.ar-prose`);
- `public.diagram` = `composeDiagram(arch, normalisedOverlay)`;
- every other public field as today; `public` keeps exactly the shape `publicOf()` reads, so the contract and the client do not change;
- `private` as today plus `architectureAnalysis` (section 10.2);
- `seed.architecture = { id, version, surface, pathKey }`, `fingerprint = fingerprintOf(seed)`, `architectureId = arch.id`.

### 3.4 The quality gate

Run in this order on every model output; any error fails the gate. Implemented by GEN in `validation.ts` (`validateLibraryItem`), using ARCH's `validateOverlay`.

1. **Schema**: the zod schema (with the node and technique enums). A schema failure is a gate failure; there is no same-tier schema retry (section 3.5).
2. **Grounded attack**: `normaliseOverlay` then `validateOverlay` (section 2.5); the composed diagram passes `validateDiagram`.
3. **Single correct option**: four options A-D, unique; exactly one `best` verdict and it is `correct_option`; at least one distractor is `plausible` or `weak` (not all `wrong`); `option_analysis` covers all four.
4. **Plausible options, no tells**: each option 15-360 chars; longest/shortest at most 2.5; the correct option is not longer than the longest distractor by more than 20%; no "all/none of the above"; normalised texts distinct and pairwise word-3-gram Jaccard below 0.6; every option names at least one component label or control of the architecture; at least two options name a node on the attack path (so naming the path is not a tell).
5. **No answer leakage in public fields**: `LEAK_PATTERNS` on title, situation, narrative, objective, question and options; no "option A-D" reference outside the options; no run of 8 or more consecutive words shared between `reference_answer` / `option_analysis` / `architecture_analysis` and any public field.
6. **Narrative consistency**: situation + narrative + question (not the shared summary) name at least 70% of the attack path's node labels and the entry node's label (`mentionsLabel`, unchanged).
7. **Rubric complete**: as today (at least 3 reasoning, 2 architecture, 1 risk; at most 12; unique ids; hints of at least 15 chars; must-not-credit targets exist), plus per level at least 6 (beginner), 7 (intermediate), 9 (advanced) points, 2-5 must-not-credit claims, `reference_answer` at least 150 chars, `architecture_analysis` at least 150 chars.
8. **Techniques**: the assigned technique is present (repaired if missing, as today); at most 6.
9. **Distinct from what exists** (architecture-aware similarity, section 3.6).

Warnings (logged, metric `ReasoningGenerationWarning{Reason}`, not failures): non-adjacent attack steps, difficulty field mismatch, advanced items whose reference answer names no node of a `subtle` trust relationship.

### 3.5 The ladder, billing and caps

```
try 1  SMALL (Haiku)  -> gate passes -> store (tier SMALL)
                      -> gate fails  -> try 2 LARGE (Sonnet) with the findings fed back
                                        (a fresh seed when the failure was a similarity or fingerprint collision)
                                        -> gate passes -> store (tier LARGE)
                                        -> gate fails  -> REASONING_GENERATION_FAILED
```

- `REASONING_MAX_GENERATION_TRIES` default becomes **2** (try 1 on `REASONING_GENERATION_FIRST_TIER`, every later try LARGE). At most 2 billed calls per question at the default.
- Generation calls `llm.structured(meta, req, schema, { retryInvalid: false })` (section 10.4): a schema failure or a refusal on Haiku goes straight to the Sonnet try instead of repeating the Haiku call. Interviews keep the default retry.
- Every call is reserved and settled through `LlmService` as today; billed failures (schema-invalid, truncated, refused) are recorded with their real cost, so a failed ladder costs what it consumed (at most about US$0.085 at typical sizes).
- Pool refills run under the `pool` policy (`REASONING_POOL_DAILY_CAP_USD` and the breaker); on-demand generation under `reasoning` with `keepFreeUsd` (the learner's cap minus the room one first-stage evaluation needs). A terminal budget code ends the run with the code, as today.
- `generationEstimateUsd(domain, difficulty)` becomes the ladder's worst case: `estimate(try 1) + (tries - 1) x estimate(LARGE try)` for a representative architecture of the bucket (the largest `architectureText`), so the on-demand pre-check admits only a generation the learner can afford to finish.
- Metrics: `ReasoningGenerationAttempt{Tier}`, `ReasoningGenerationRejected{Reason,Tier}`, `ReasoningGenerationStored{Tier}`, `ReasoningGenerationFailed{Domain}`, `ReasoningGenerationMs`. `itemRow()` stores `tier` and `model` of the call that produced the item (today hard-coded `LARGE`).

### 3.6 Architecture-aware similarity

Questions on one architecture share its vocabulary, so plain Jaccard over the scenario would flag every pair. The comparison text is `comparableText(public)` with the **architecture's shingles removed** from both sides (`architectureShingles(arch)`: word 3-grams of `architectureText(arch)`, which includes the organisation summary, labels, details, controls and flow labels). The bank for a candidate on architecture A in domain D:

| Check | Compared with | Rule |
|---|---|---|
| Seed fingerprint | live items (serve_count below the cap) of the bucket; on demand also every item the learner was served | equal = collision |
| Structure | live items on A (any domain), the latest `REASONING_LIBRARY_BANK_SIZE` (300) items on A, and on demand the learner's items on A | same `pathKey` and same objective id = collision |
| Text | the same set | Jaccard (after removing A's shingles) at or above `REASONING_SIMILARITY_THRESHOLD` (0.35) = too similar |

Retired items are not fingerprint obstacles: they cannot be served again, and the serve-time rule (section 5.2) keeps a learner who saw one from getting a new item with its fingerprint. This keeps the variation space from running out (per bucket about 3 architectures x 2-4 surfaces x 7 objectives x 2-4 techniques, times 7 constraints for wording).

Parallel generations in one batch are checked against each other synchronously after each call, as today.

### 3.7 Fake LLM

GEN adds `platform/adapters/fake/reasoning-question.fake.ts` exporting `fakeReasoningQuestion(req)`: it reads the architecture id and the surface from the request text, loads the architecture with `getArchitecture()` (the fake may import the library), and returns a schema-valid item whose path is a breadth-first route from the surface's entry to its target within the level's step range, with option and narrative text that varies with the seed (same approach as `fakeReasoningItem`). The dispatcher line `case 'reasoning_question': return fakeReasoningQuestion(req);` is GEN's only edit in `fake/reasoning.fake.ts`.

---

## 4. Storage

### 4.1 Migration 0017 (`packages/db/migrations/0017_reasoning_architecture_library.sql`)

Every statement idempotent; drizzle runs the file in one transaction.

```sql
-- Library questions record the architecture they were written on (null for items generated before 0017).
ALTER TABLE "reasoning_items" ADD COLUMN IF NOT EXISTS "architecture_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_items_architecture_idx" ON "reasoning_items" USING btree ("architecture_id", "created_at");
--> statement-breakpoint
-- Patch 2 (0016) replaced the table-level SELECT with a column list: a new public column needs its own grant,
-- or every ITEM_COLUMNS read in a learner's transaction fails with a privilege error.
GRANT SELECT ("architecture_id") ON "reasoning_items" TO tr_app_user;
--> statement-breakpoint
-- The serve cap is enforced where the serve is recorded, atomically: the row lock taken by the UPDATE
-- serialises concurrent serves of one question, and the WHERE is re-checked against the committed count.
-- A serve over the cap (or a repeat for the same learner) is skipped (BEFORE trigger returns NULL), so the
-- caller's INSERT ... RETURNING comes back empty and it picks another question. The cap comes from the
-- transaction setting app.reasoning_item_max_serves (REASONING_ITEM_MAX_SERVES, set by the API); without it,
-- the serve is only counted, as before.
CREATE OR REPLACE FUNCTION reasoning_items_bump_serve_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cap integer := NULLIF(current_setting('app.reasoning_item_max_serves', true), '')::integer;
BEGIN
  IF EXISTS (SELECT 1 FROM reasoning_served WHERE user_id = NEW.user_id AND item_id = NEW.item_id) THEN
    RETURN NULL;
  END IF;
  UPDATE reasoning_items SET serve_count = serve_count + 1 WHERE id = NEW.item_id AND (cap IS NULL OR serve_count < cap);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reasoning_items_bump_serve_count() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS reasoning_served_bump_serve_count ON "reasoning_served";
--> statement-breakpoint
CREATE TRIGGER reasoning_served_bump_serve_count BEFORE INSERT ON "reasoning_served" FOR EACH ROW EXECUTE FUNCTION reasoning_items_bump_serve_count();
```

Also: `architectureId: text('architecture_id')` and `index('reasoning_items_architecture_idx').on(t.architectureId, t.createdAt)` in `packages/db/src/schema/reasoning.ts`; a `0017` entry in `migrations/meta/_journal.json` whose `when` is greater than 0016's `1792996241406`; `meta/0017_snapshot.json` (from `drizzle-kit generate`, with the generated SQL replaced by the file above under the same tag).

Why BEFORE and the duplicate check: `runGeneration()` inserts its serve with `ON CONFLICT DO NOTHING`; a BEFORE trigger fires before conflict detection, so without the `EXISTS` check a repeated insert would count a serve that never happened.

Rollback safety: the column is nullable and unused by older code; older code inserting serves without the setting gets the old behaviour (count only).

### 4.2 Diagram: copied at generation (decision)

The composed diagram and scenario are stored in `reasoning_items.public` when the question is generated; the library is not read at serving time. Reasons:

1. **The item is evidence for its own evaluation.** The rubric, the option analysis and the reference answer name the components and the path as they were when written. Composing at read time would let a later library edit (a renamed node, a removed control) change the picture under an existing rubric, and the learner and the grader could see different diagrams.
2. **Nothing in the read path changes.** `publicOf()`, `attemptView()`, `ReasoningItemPublic`, the client and `itemContext()` / `diagramText()` work unchanged, and legacy items (with a model-written diagram) need no branch.
3. **The saving is in generation, not storage.** The diagram is composed by code; copying 3-5 kB of JSON per row costs nothing that matters.

The architecture id is a column (indexed, for the similarity bank and serving order); the architecture version, surface and path key live in `seed` (jsonb), which is enough for audit.

### 4.3 Existing items

Items generated before 0017 keep `architecture_id = null`, their own diagrams and scenarios, no `architectureAnalysis` (feedback falls back to `diagramText`, as today). They stay servable under the new 2-serve cap (items already served twice or more retire immediately) unless `REASONING_SERVE_LEGACY_ITEMS=false`. They count toward bucket sizes, so the paid-for inventory is used before new questions are generated. Their evaluation is the new tiered evaluation.

---

## 5. Serving

### 5.1 At most 2 learners per question

- `REASONING_ITEM_MAX_SERVES` default **2** (env-overridable, positive integer; the security-patch-2 test already runs with 2).
- `create()` (learner's transaction, under the learner's advisory lock):
  1. `SELECT set_config('app.reasoning_item_max_serves', $max, true)`;
  2. pick a candidate (5.2), generate the attempt id in code (`randomUUID()`), `INSERT INTO reasoning_served (…, attempt_id) … RETURNING item_id`;
  3. no row returned: the question was retired by a concurrent serve (or is a repeat); exclude it and pick again, up to 3 candidates, then fall through to on-demand generation;
  4. row returned: insert the attempt with that id (`state: 'ready'`, `openedAt: now`).
- `runGeneration()` (worker) records the on-demand learner's serve as today; the new item starts at `serve_count = 1` and can go to exactly one more learner.
- `demand()` / `needed()` / `poolStatus()` keep counting live items as `serve_count < REASONING_ITEM_MAX_SERVES`.

### 5.2 Never repeat, never a near-duplicate

The candidate predicate (shared by `create()` and `poolStatus()` so the count the learner sees matches what they can get):

```sql
pool AND domain = $domain AND difficulty = $bucket AND serve_count < $max
AND ($serveLegacy OR architecture_id IS NOT NULL)
AND NOT EXISTS (SELECT 1 FROM reasoning_served s WHERE s.item_id = reasoning_items.id AND s.user_id = $user)
AND NOT EXISTS (SELECT 1 FROM reasoning_served s JOIN reasoning_items j ON j.id = s.item_id
                WHERE s.user_id = $user AND j.fingerprint = reasoning_items.fingerprint)
ORDER BY (SELECT count(*) FROM reasoning_served s JOIN reasoning_items j ON j.id = s.item_id
          WHERE s.user_id = $user AND j.architecture_id = reasoning_items.architecture_id), random()
LIMIT 1
```

- same question: the `reasoning_served` primary key and the first `NOT EXISTS`;
- same question shape (domain, architecture, surface, objective, technique): the fingerprint `NOT EXISTS`;
- near-duplicate text or the same attack path on one architecture: prevented at generation (3.6), where every live item and the learner's own items are in the bank;
- variety: the learner gets the architecture they have seen least in this bucket first (legacy items, whose architecture is null, sort first, which drains them).

`reasoning_served` is owner-isolated by RLS, so these subqueries only ever see the learner's own rows.

### 5.3 Pool sizing for the 2-serve rule

> Correction (27 Oct): at the measured G the US$5 cap pays for about 17 questions a day and the idle stock costs about US$26. See the corrections section.

A live item offers `2 - serve_count` seats. With 2 seats per question the pool holds less and turns over faster, so the defaults change:

| Setting | Old | New | Why |
|---|---|---|---|
| `REASONING_POOL_TARGET` | 12 | 8 | an active bucket keeps 8-16 seats, about 15 minutes of busy demand between scheduled runs |
| `REASONING_POOL_IDLE_TARGET` | 2 | 2 | first question in any bucket is instant; 45 buckets x 2 x US$0.03-0.04 = US$2.7-3.6 one-time |
| `REASONING_POOL_MAX_ITEMS` | 40 | 24 | ceiling for schedule top-ups on behalf of active learners |
| `REASONING_POOL_MIN_AVAILABLE` | 4 | 3 | a learner with fewer than 3 unseen questions triggers a top-up |
| `REASONING_POOL_BATCH` | 4 | 4 | |
| `REASONING_POOL_DAILY_CAP_USD` | 5 | 5 | about 125-180 questions, 250-360 seats per day before learners fall back to on-demand generation (billed to them); raise it with traffic |

Refill spreads a bucket's new items across its architectures (3.1 step 1), so a bucket never fills from one architecture.

### 5.4 On-demand generation

Unchanged in shape: when no candidate exists, the attempt is created in `generating` and `reasoning.generate` runs the ladder for that learner (bank includes everything the learner was served on the chosen architecture), billed to the learner's cap with `keepFreeUsd`, pre-checked with the ladder's worst case (3.5). The new item joins the pool with one seat left. With Haiku the typical wait drops from 30-90 s to 15-30 s (a Sonnet retry adds up to a minute).

### 5.5 Per-learner bound

> Correction (27 Oct): the default is now 12, refills are counted per question, and the US$0.8 term below assumed G of about US$0.04; at the measured G one learner's 40 opens could exceed the whole pool cap. See the corrections section.

New: `REASONING_USER_DAILY_QUESTIONS` (default 40; 0 = no limit): questions a learner may open per UTC day (attempts created today, any state), checked in `create()` under the learner's lock, refused with new code `REASONING_DAILY_QUESTIONS_REACHED` (429, `details.resetAt`, Retry-After). Without it, a learner cycling through questions at `REASONING_RATE_CREATES_PER_HOUR` (10/h, 240/day) would consume 120 questions of pool inventory a day (about US$4, most of the pool's daily cap) and starve other learners into on-demand generation.

Bound per learner per UTC day, every term already capped by configuration:

```
learner-billed  <= AI_USER_DAILY_CAP_USD                               (stage-1 evaluations + on-demand generation; shared with interviews; US$2)
platform-billed <= REASONING_USER_DAILY_EVALUATIONS x pair_max          (escalated stages, finalize policy; 20 x ~US$0.06 = US$1.2)
                 + REASONING_USER_DAILY_QUESTIONS x G_item / 2           (pool seats consumed; 40 x ~US$0.02 = US$0.8)
all of it        <= the global breaker (AI_GLOBAL_DAILY_CAP_USD) and, for pool work, REASONING_POOL_DAILY_CAP_USD
```

A typical learner (5 questions answered) costs about 5 x US$0.045 = US$0.23 a day.

---

## 6. Evaluation

### 6.1 Pipeline

```
attempt evaluating
  -> (code) correctness: selected option vs key, verdict partial credit, option feedback        [no model]
  -> stage 1  evaluator   SMALL (Haiku), policy 'reasoning'                                       [always]
  -> (code) provisional score = scoreAttempt(final = evaluator points, no challenger)
  -> (code) escalationReasons(...)                                                                  [section 6.3]
       none -> store the provisional result (tier SMALL, not degraded)
       some -> stage 2 challenger  LARGE, policy 'finalize'
               stage 3 reconciler  LARGE, policy 'finalize'
               -> scoreAttempt(final = reconciler, ...) -> store (tier LARGE); a stage failure degrades as today
```

`REASONING_EVALUATION_MODE=full` runs all three stages on every answer with the evaluator on LARGE, exactly as before (rollback switch). `EVALUATION_PROMPT_VERSION = 'reasoning-evaluate.v3'`.

### 6.2 Prompts and caching

> Correction (27 Oct): the reconciler never read the challenger's entry on the real API (each stage's output format is its own cache key), so caching was a +6% surcharge; `REASONING_PROMPT_CACHE` (default false) now leaves the prompts unmarked. See the corrections section.

All three stages use the same **grader prefix** as `systemPrefix`, byte-identical for a given item:

```
graderPrefix(domain, item) =
  "You grade Attack Reasoning answers in <domain.title> for ThreatReady. … the application computes every score."
  + INJECTION_RULES + STAGE_DATA_RULES
  + "The item (server-side; the learner never sees the answer key):\n" + itemContext(item)
```

The stage's own instructions (evaluator, challenger, reconciler rules, unchanged in substance) are `system`; the learner's answer (`answerBlock`, untrusted tags, `defuseTags`) and earlier stages' outputs (`stageBlock`, `<` escaped) stay in the **user** message, never in a system block. The item context is generated content, not learner input, so moving it into the system prefix does not weaken the injection boundary.

Caching effect: the challenger writes the prefix to Sonnet's cache and the reconciler, which starts after the challenger's response has streamed, reads it (Sonnet 5.5 caches from 512 tokens). Haiku's cache is separate (caches are per model) and needs 4,096 tokens, so it helps only re-evaluations of the same item within 5 minutes. Measured effect in the cost model (7): about US$0.005 per escalated answer.

### 6.3 Escalation rules (`evaluation-policy.ts`, EVAL)

`escalationReasons(input)` returns the reasons; an empty list means no escalation. Computed in code after stage 1:

| Reason | Fires when | Why |
|---|---|---|
| `mode_full` | `REASONING_EVALUATION_MODE = full` | rollback |
| `forced` | the job carries `escalate: true` (a learner's manual retry of a failed evaluation; a future dispute endpoint uses the same flag) | learner retry/dispute |
| `borderline` | the provisional total is within `REASONING_ESCALATION_BAND` (8) of `REASONING_ESCALATION_CENTER` (60) | a grading error there changes how the result reads |
| `low_confidence` | the evaluator's self-reported `confidence` is `low` | Haiku says it is unsure |
| `unverified_credit` | the quote check withdrew 2 or more of the evaluator's credited points | the evaluator credited without evidence |
| `integrity_suspected` | `looksLikeInjection(justification)` and the evaluator did not set `instructs_grader` | Haiku may have been talked round; Sonnet decides |
| `penalty_unconfirmed` | the evaluator asserted a must-not-credit claim, reported an incorrect claim, or says the justification argues for another option | each of these lowers the score on Haiku's word alone |

An integrity flag the evaluator **did** raise is never escalated to be cleared: flags still stand once raised by any stage (TR-21), and such results are already low confidence and review-flagged.

`looksLikeInjection(text)`: deterministic patterns (instructions to ignore rules or award marks, grader/system/assistant role-play, tag-like text for any `untrusted_`/`evaluator_output`/`challenger_output` block, "as the grader", score claims, base64-looking runs over 40 chars, zero-width characters). It must flag every `fakeDetects` case and at least 80% of `test/fixtures/injection-corpus.json`, and none of the legitimate justifications used in the tests.

### 6.4 Stage 1 output (Haiku evaluator)

`evaluatorSchema(item)` keeps every current field and adds:

- `confidence: 'high' | 'medium' | 'low'`
- `reasoning_summary: str(600)`: two or three sentences on the justification as written, second person;
- `improve: arr(str(220), 4)`.

`maxOutputTokens: 3000`, `timeoutMs: 60000`, no `effort`.

### 6.5 Scoring and the deterministic contract

`scoreAttempt` keeps every numeric rule: the model never owns a number; totals and dimensions are computed in code from statuses, weights, the quote check, must-not-credit, integrity and caps. Changes are limited to which judgements are passed in and to confidence:

- not escalated: `final = evaluator points`, `challenger` zeros, `degraded = false`; confidence is the lower of the computed one and the evaluator's self-reported one (it is `high` or `medium` here, since `low` escalates);
- escalated: `evaluator` (the disagreement baseline) is `applyChallenges(evaluator, challenger)` rather than Haiku's raw statuses. Escalation already means Haiku's reading was doubtful, so disagreement with it is expected and is not by itself evidence that the final grade is uncertain; without this, most escalated answers would come back low-confidence and review-flagged.

Because the confidence rule changes, `REASONING_SCORING_VERSION` becomes `reasoning-score.v2.2026-10-26`; totals stay comparable with v1.

Stored: `reasoning_evaluations.tier` = `SMALL` (single pass) or `LARGE` (escalated), `model` = the last stage's model, `stages.escalation = { mode, escalated, reasons }`. When escalated, a scoring note said why ("Reviewed a second time because the score was close to the threshold."); removed on 27 Oct (review AR-SEC-1: it told a learner when the injection screen fired), the reasons stay in `stages.escalation`. A failed challenger or reconciler after escalation degrades as today (notice, low confidence, review flag).

### 6.6 Feedback without the reconciler

`assembleFeedback` (unchanged when the reconciler ran) uses, for a single-pass result:

| Field | Source |
|---|---|
| `decision` | code: selected vs best option and the authored `why` (as today) |
| `reasoning` | evaluator `reasoning_summary` (fallback: strengths and gaps, as today) |
| `gotRight`, `missed` | credited points' text and rationale, evaluator strengths, authored hints of missed points |
| `whyBest`, `whyAlternatives` | authored option analysis |
| `architectureAnalysis` | authored `private.architectureAnalysis`; legacy items fall back to `diagramText` |
| `expertExplanation` | `private.referenceAnswer` |
| `improve` | evaluator `improve` + hints of missed points |

### 6.7 Budgets and estimates

| Work | Tier | Policy | Estimate used for admission |
|---|---|---|---|
| Stage 1 | SMALL (LARGE in `full` mode) | `reasoning` | `evaluatorRequestBound(domain, null, answer?, evaluatorTier(mode))`: about US$0.024 on Haiku (was about US$0.047-0.05 on Sonnet) |
| Stages 2-3 | LARGE | `finalize` (breaker with 10% grace, `AI_FINALIZE_SOURCE_CAP_USD` per attempt and feature) | not pre-checked (as today) |
| Pool generation | ladder | `pool` | `generationEstimateUsd` (ladder worst case) |
| On-demand generation | ladder | `reasoning` + `keepFreeUsd = evaluationRoomUsd` | the same |

`LlmService.estimate()` counts `systemPrefix` characters. Estimates stay conservative (they ignore cache reads); settlement uses the provider's usage, including `cache_read_input_tokens` and `cache_creation_input_tokens`, already priced in `pricing.ts`.

### 6.8 Injection defences kept

`INJECTION_RULES`, `untrusted()` delimiters and `defuseTags`, escaped `stageBlock`s, integrity flags that only accumulate, the verbatim-quote check, must-not-credit, and the answer key read only with the owner role after evaluation (`loadItemPrivate`). New: `looksLikeInjection` escalation to the stronger model when Haiku did not flag.

---

## 7. Cost model

Prices (USD per million tokens, `pricing.ts`): Haiku 4.5 input 1, output 5, cache write 1.25, cache read 0.10; Sonnet 5.5 input 2, output 10, cache write 2.50, cache read 0.20.

### 7.1 Per stored question

```
C_call(tier) = in x p_in + out x p_out   (+ cache_write x p_w + cache_read x p_r when cached)
G_after      = [C_H + (1 - p1) x C_S] / [p1 + (1 - p1) x p2]
```

| Quantity | Value | Basis |
|---|---|---|
| Before: one Sonnet call | 688 in, 6,438 out: US$0.0658 | local ledger, 247 calls (input excludes cached system tokens; output includes medium-effort thinking) |
| Before: per stored question | about US$0.074 (US$0.104 including refused tries, audit of 23 Oct) | ledger / audit |
| C_H (Haiku try) | 5.5k in, 3.2k out: 0.0055 + 0.016 = US$0.0215 | item without diagram and scenario is about 10k chars of JSON |
| C_S (Sonnet retry) | 6.0k in, 4.7k out (incl. thinking): 0.012 + 0.047 = US$0.059 | |
| p1 (Haiku passes the gate) | 0.7 (conservative) to 0.9 | to be measured by VERIFY |
| p2 (Sonnet passes) | 0.9 | |
| **G_after** | **US$0.040** (p1 0.7) to **US$0.028** (p1 0.9) | -46% to -62% per stored question |
| Per seat (G_after / 2) | US$0.014-0.020 | both seats used |

At high traffic the old 25-serve cap spread one question over more learners: per seat, the new design is cheaper than the old one as long as old questions averaged fewer than 0.074 / 0.02 = 3.7 serves, which is the case at current traffic. The 2-serve cap is the owner's exposure decision; the library and Haiku make it affordable.

### 7.2 Per evaluated answer

> Correction (27 Oct): measured escalated pair US$0.078 with no cache read (design US$0.050), single pass US$0.0126. See the corrections section.

```
E_before = C(evaluator) + C(challenger) + C(reconciler)
E_after  = C_HE + e x (C_chal_cached + C_rec_cached)
```

| Quantity | Value |
|---|---|
| Before: evaluator 3.5k/1.0k, challenger 4.6k/0.8k, reconciler 5.3k/2.4k (Sonnet) | 13.4k x 2 + 4.2k x 10 per M = **US$0.069** (measured about US$0.08) |
| C_HE: Haiku evaluator 4.0k in, 1.3k out | 0.004 + 0.0065 = **US$0.0105** |
| Grader prefix P | about 3.8k tokens |
| Challenger: P written (3.8k x 2.5), 1.6k other input, 0.8k out | 0.0095 + 0.0032 + 0.008 = US$0.0207 |
| Reconciler: P read (3.8k x 0.2), 2.3k other input, 2.4k out | 0.0008 + 0.0046 + 0.024 = US$0.0294 |
| Escalated pair | US$0.050 (uncached: about US$0.055) |
| e (escalation rate) | 0.25-0.40 expected; VERIFY measures; tune `REASONING_ESCALATION_BAND` |
| **E_after** | e = 0.25: **US$0.023**; e = 0.40: **US$0.031**; worst case e = 1: US$0.061 |

### 7.3 Per learner question and per day

> Correction (27 Oct): at the measured G (US$0.29) and pair cost the "After" column is about US$0.18-0.20 per learner question, above "Before". See the corrections section.

| | Before (questions served once) | Before (served twice) | After |
|---|---|---|---|
| Generation share | 0.074 | 0.037 | 0.014-0.020 |
| Evaluation | 0.069-0.08 | 0.069-0.08 | 0.023-0.031 |
| **Total** | **0.143-0.154** | **0.106-0.117** | **0.037-0.051** (-52% to -76%) |

Idle pool stock: before 45 buckets x 2 x 0.074 = US$6.7; after US$2.7-3.6.

---

## 8. Configuration (GEN adds all of it in phase 0)

| Key | Default | New/changed | Meaning |
|---|---|---|---|
| `REASONING_ITEM_MAX_SERVES` | 2 | changed (was 25) | learners per question |
| `REASONING_MAX_GENERATION_TRIES` | 2 | changed (was 3) | calls per question: try 1 on the first tier, the rest LARGE |
| `REASONING_GENERATION_FIRST_TIER` | `SMALL` | new (`SMALL`/`LARGE`) | rollback: LARGE makes Sonnet write questions again |
| `REASONING_LIBRARY_BANK_SIZE` | 300 | new (50-2000) | items per architecture in the similarity bank |
| `REASONING_SERVE_LEGACY_ITEMS` | true | new | serve items generated before the library |
| `REASONING_USER_DAILY_QUESTIONS` | 40 | new (0 = off) | questions opened per learner per UTC day |
| `REASONING_POOL_TARGET` / `_IDLE_TARGET` / `_MAX_ITEMS` / `_MIN_AVAILABLE` | 8 / 2 / 24 / 3 | changed | section 5.3 |
| `REASONING_EVALUATION_MODE` | `tiered` | new (`tiered`/`full`) | rollback: `full` runs three Sonnet stages always |
| `REASONING_ESCALATION_CENTER` | 60 | new (0-100) | centre of the borderline band |
| `REASONING_ESCALATION_BAND` | 8 | new (0-50; 0 = no borderline escalation) | half-width of the band |

Plus `.env.example` entries and the configuration test.

---

## 9. File ownership

### 9.1 Builders

**ARCH** (architecture files, validator, tests)
- `apps/api/src/modules/reasoning/architectures/**` (all new)
- `apps/api/scripts/architecture-schema.ts` (new, optional: writes `architecture.schema.json` from zod)
- `apps/api/test/unit/architectures.test.ts` (new)
- `attack-reasoning/tests/architecture-library-layout.test.ts` (new)

**GEN** (generation, serving, migration, config, contracts, client)
- `modules/reasoning/generation.service.ts`, `prompts/generation.prompts.ts`, `validation.ts`, `similarity.ts`, `seed.ts`, `item.types.ts`, `domain.types.ts`, `reasoning.service.ts`, `attempt.repo.ts`, `reasoning.controller.ts`
- `modules/jobs/jobs.service.ts` (the `escalate` flag on `reasoning.evaluate` jobs)
- `config/config.ts`, `.env.example` files
- `packages/db/**` (schema, migration 0017, meta), `packages/contracts/**` (no change expected), `packages/shared/src/errors.ts` (`REASONING_DAILY_QUESTIONS_REACHED`)
- `platform/adapters/fake/reasoning-question.fake.ts` (new) and the one dispatcher line in `fake/reasoning.fake.ts`
- `attack-reasoning/client/src/reasoning/pages.tsx`: copy only (lines 162, 164, 221, 369 today), so the text stays true: questions are written on reviewed reference architectures; the evaluation grades once and reviews borderline or disputed answers a second time. No layout or design change.
- tests: new `test/reasoning-library.e2e.test.ts`; in existing files only the cases listed in 11.2

**EVAL** (evaluation, its prompts and the shared LLM layer)
- `modules/reasoning/evaluation.service.ts`, `prompts/evaluation.prompts.ts`, `prompts/diagram-text.ts`, `scoring.ts`, `evaluation-policy.ts` (new)
- `modules/ai/llm.service.ts`, `modules/ai/pricing.ts` (no change expected), `modules/ai/prompts/common.ts`
- `platform/ports/llm.port.ts`, `platform/adapters/anthropic-llm.adapter.ts`, `platform/adapters/fake-llm.adapter.ts`, `platform/adapters/fake/reasoning.fake.ts` (except GEN's dispatcher line)
- tests: new `test/reasoning-evaluation-tiered.e2e.test.ts`, new `test/unit/evaluation-policy.test.ts`; in existing files only the cases listed in 11.3

**VERIFY** (after the builders): the real-model check (11.4), the full suites, and the docs: merges the builders' notes into `docs/ATTACK_REASONING.md` (new "Added 26 Oct 2026" section and the cost table).

### 9.2 Shared-file rules

1. One owner per file. A builder never edits a file it does not own, except the two exceptions named above (GEN's dispatcher line in `fake/reasoning.fake.ts`; nothing else).
2. To ask for a change in someone else's file, append to the progress file `audit/2026-10-23/resume/live/ar-cost-progress.md` a line `<KEY> REQUEST -> <OWNER>: <file>: <exact change>`; the owner applies it and appends `<OWNER> ACK <KEY> REQUEST: <summary>`. The requester does not work around a missing change by copying code.
3. Shared test files (`reasoning.e2e.test.ts`, `unit/reasoning.test.ts`, `reasoning.unit.test.ts`, `security-patch-2.e2e.test.ts`, `unit/security-patch-2.test.ts`) are edited by `it(...)` block: each builder only touches the blocks assigned in section 11, re-reads the file right before each Edit (the Edit tool refuses a stale file, which is the conflict guard), and adds new cases to its own new file.
4. Database suites run serialised with `flock` on the shared lock (`run-tests.sh` does this).
5. Every changed expectation in an existing test is listed in the builder's final report with the reason ("intentional: 2 calls per question instead of 3").

### 9.3 Phase 0 (interfaces first, then parallel)

Each builder lands its interface stubs first and appends `<KEY> phase0 done` to the progress file. Others build against the signatures in section 10 and wait (re-reading the progress file) only for what they actually import.

| Builder | Phase 0 |
|---|---|
| ARCH | `types.ts`, `schema.ts`, `index.ts`, `text.ts`, `compose.ts` complete, with `b1`, `i1` and `a1` written and valid; the other 12 files follow |
| GEN | all config keys of section 8; `item.types.ts` (`architectureAnalysis?`, `architectureId?`, `LibraryGeneratorOutput`); `domain.types.ts` (`VariationSeed.architecture?`); a stub `reasoning-question.fake.ts` and the dispatcher line |
| EVAL | `LlmRequest.systemPrefix`; `LlmService.structured(…, opts?)` with `retryInvalid`; `estimate()` counting the prefix; adapter and fake adapter support (two system blocks, fake cache simulation); `evaluatorTier()` and the `tier` parameter of `evaluatorRequestBound()` / `evaluatorRequest()`; `runEvaluation(attemptId, opts?)` signature |

---

## 10. Interfaces

### 10.1 ARCH: `modules/reasoning/architectures`

```ts
// types.ts
import type { DiagramBoundary, DiagramData, DiagramEdge, DiagramNode, ReasoningDomainKey } from '@threatready/contracts';

export type ArchitectureLevel = 'beginner' | 'intermediate' | 'advanced';
export type LibraryNode = Omit<DiagramNode, 'compromised' | 'entryPoint'>;
export type LibraryEdge = Omit<DiagramEdge, 'kind'> & { kind: 'data' | 'auth' | 'control' };
export interface AttackerOrigin { id: string; label: string; boundary: string; detail: string | null }
export interface LibraryIdentity { id: string; label: string; kind: 'human' | 'workload' | 'service' | 'federated' | 'machine' | 'vendor'; nodeIds: string[]; privileges: string[]; notes: string | null }
export interface LibraryDataStore { nodeId: string; data: string; classification: 'regulated' | 'confidential' | 'internal' | 'public'; regulations: string[] }
export interface LibraryControl { id: string; label: string; nodeIds: string[]; status: 'present' | 'partial' | 'missing'; covers: string; limits: string | null }
export interface TrustRelationship { id: string; from: string; to: string; via: string; subtle: boolean; notes: string | null }
export interface LogSource { id: string; label: string; nodeIds: string[]; records: string; gaps: string | null }
export interface AttackSurface {
  id: string; summary: string;
  entryNodeIds: string[]; targetNodeIds: string[]; viaNodeIds: string[];
  techniques: string[];            // ids from the domain's technique list
  objectives: string[] | null;     // subset of the domain's objective ids; null = all
  notes: string | null;
}
export interface ArchitectureDef {
  $schema?: string;
  id: string; version: number; level: ArchitectureLevel; title: string;
  organisation: { name: string; industry: string; size: string; summary: string };
  diagram: { boundaries: DiagramBoundary[]; nodes: LibraryNode[]; edges: LibraryEdge[] };
  attackerOrigins: AttackerOrigin[];
  identities: LibraryIdentity[]; dataStores: LibraryDataStore[]; controls: LibraryControl[];
  trustRelationships: TrustRelationship[]; logSources: LogSource[];
  attackSurfaces: Partial<Record<ReasoningDomainKey, AttackSurface[]>>;
  reviewNotes: string | null;
}
export interface AttackOverlay { entryNode: string; compromisedNodes: string[]; steps: { from: string; to: string; label: string }[] }
export const ATTACK_STEPS: Record<ArchitectureLevel, { min: number; max: number }>;   // 1-2, 2-3, 3-5
export const NODE_BOUNDS: Record<ArchitectureLevel, { nodes: [number, number]; boundaries: [number, number]; textChars: number }>;

// schema.ts
export const ArchitectureSchema: z.ZodType<ArchitectureDef>;
export function parseArchitecture(raw: unknown, file: string): ArchitectureDef;            // throws with file and path

// index.ts
export const LIBRARY_VERSION: string;
export const ARCHITECTURES: readonly ArchitectureDef[];                                     // sorted by id, validated at load
export function getArchitecture(id: string): ArchitectureDef | undefined;
export function architecturesFor(domain: ReasoningDomainKey, level: ArchitectureLevel): ArchitectureDef[]; // >= 3, by the coverage rule
export function surfacesFor(arch: ArchitectureDef, domain: ReasoningDomainKey): AttackSurface[];
export function libraryErrors(defs?: readonly ArchitectureDef[]): string[];               // cross-file and domain-registry checks; [] when valid

// text.ts
export function architectureText(arch: ArchitectureDef): string;                          // deterministic; no surfaces, no reviewNotes
export function architectureShingles(arch: ArchitectureDef): Set<string>;                 // shingles(architectureText(arch)) from ../similarity.js

// compose.ts
export function normaliseOverlay(arch: ArchitectureDef, overlay: AttackOverlay): { overlay: AttackOverlay; repairs: string[] };
export function validateOverlay(arch: ArchitectureDef, overlay: AttackOverlay, opts: { level: ArchitectureLevel; surface?: AttackSurface }): { errors: string[]; warnings: string[] };
export function composeDiagram(arch: ArchitectureDef, overlay: AttackOverlay): DiagramData;
export function pathKey(arch: ArchitectureDef, overlay: AttackOverlay): string;
```

### 10.2 GEN: types the others read

```ts
// item.types.ts
export interface ReasoningItemPrivate { /* unchanged fields */ architectureAnalysis?: string }
export interface GeneratedItem { /* unchanged fields */ architectureId?: string | null }
export interface LibraryGeneratorOutput { /* section 3.3, snake_case as the model writes it */ }

// domain.types.ts
export interface VariationSeed {
  domain: ReasoningDomainKey; difficulty: ReasoningDifficulty;
  topology: string;      // library seeds: the architecture id
  entryPoint: string;    // library seeds: the surface id
  objective: string; technique: string; constraint: string;
  architecture?: { id: string; version: number; surface: string; pathKey?: string };
}

// prompts/generation.prompts.ts
export const GENERATOR_VERSION = 'gen.v3.2026-10-26';
export const GENERATION_PROMPT_VERSION = 'reasoning-generate.v3';
export function questionSchema(arch: ArchitectureDef, domain: ReasoningDomain): StructuredSchema<LibraryGeneratorOutput>; // name 'reasoning_question'
export function questionRequest(ctx: { arch: ArchitectureDef; domain: ReasoningDomain; seed: VariationSeed; surface: AttackSurface; tier: LlmTier;
  avoid: { title: string; question: string; path: string; objective: string }[]; previousFailure: string[]; tryNumber: number }): LlmRequest;

// generation.service.ts: public surface unchanged
refillPool(req?), needed(domain, difficulty, userId?), headroom(domain, difficulty), generationEstimateUsd(domain, difficulty) /* ladder worst case */,
evaluationRoomUsd(domain) /* now uses evaluatorTier(cfg.REASONING_EVALUATION_MODE) */, poolCanGenerate(domain, difficulty), runGeneration(attemptId), markFailed(attemptId, code)

// jobs: reasoning.evaluate payload
{ kind: 'reasoning_evaluate'; attemptId: string; escalate?: boolean }   // ReasoningService.retry() of a failed evaluation sets escalate: true
```

### 10.3 EVAL: evaluation

```ts
// prompts/evaluation.prompts.ts
export const EVALUATION_PROMPT_VERSION = 'reasoning-evaluate.v3';
export function evaluatorTier(mode: 'tiered' | 'full'): LlmTier;                          // tiered -> SMALL, full -> LARGE
export function graderPrefix(domain: ReasoningDomain, item: EvaluationItem): string;
export function evaluatorRequest(domain, item: EvaluationItem | null, selected: OptionId, justification: string, tier?: LlmTier /* default SMALL */): LlmRequest;
export function evaluatorRequestBound(domain, item: EvaluationItem | null, answer?: { selected: OptionId; justification: string }, tier?: LlmTier /* default SMALL */): LlmRequest;
export function challengerRequest(...unchanged args): LlmRequest;   // systemPrefix = graderPrefix(...)
export function reconcilerRequest(...unchanged args): LlmRequest;   // systemPrefix = graderPrefix(...)
export interface EvaluatorOutput { /* unchanged */ confidence: 'high' | 'medium' | 'low'; reasoning_summary: string; improve: string[] }

// evaluation-policy.ts
export type EscalationReason = 'mode_full' | 'forced' | 'borderline' | 'low_confidence' | 'unverified_credit' | 'integrity_suspected' | 'penalty_unconfirmed';
export function looksLikeInjection(text: string): boolean;
export function escalationReasons(input: {
  mode: 'tiered' | 'full'; forced: boolean; selected: OptionId;
  provisional: ScoreOutcome; evaluator: EvaluatorOutput; justification: string;
  center: number; band: number;
}): EscalationReason[];

// scoring.ts
export const REASONING_SCORING_VERSION = 'reasoning-score.v2.2026-10-26';
export interface ScoringInput { /* unchanged */ singlePassConfidence?: 'high' | 'medium' | 'low' }
export interface ScoreOutcome { /* unchanged */ quoteDowngrades: number }

// evaluation.service.ts
runEvaluation(attemptId: string, opts?: { escalate?: boolean }): Promise<void>;
export interface StoredStages { evaluator; challenger; reconciler; escalation?: { mode: 'tiered' | 'full'; escalated: boolean; reasons: EscalationReason[] } }
```

### 10.4 EVAL: shared LLM layer

```ts
// platform/ports/llm.port.ts
export interface LlmRequest {
  /* unchanged fields */
  /** Stable, cacheable prefix rendered as the first system block (cache_control: ephemeral), before `system`. Never learner text. */
  systemPrefix?: string;
}

// modules/ai/llm.service.ts
structured<T>(meta: CallMeta, req: LlmRequest, schema: StructuredSchema<T>, opts?: { retryInvalid?: boolean /* default true */ }): Promise<LlmObject<T>>;
estimate(req: LlmRequest, meta?): number;   // counts systemPrefix + system + messages

// anthropic adapter params(): system = systemPrefix
//   ? [{ type: 'text', text: systemPrefix, cache_control: { type: 'ephemeral' } }, { type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
//   : [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]           // unchanged without a prefix
// fake adapter: counts the prefix in `chars`; simulates the cache per (model, prefix): the first call reports
//   cacheWriteTokens = ceil(prefix/4), later calls cacheReadTokens = ceil(prefix/4) (input tokens exclude them); reset() clears it.
```

---

## 11. Test plans

All builders: no real AI calls (the fake driver only); run the steps with `run-tests.sh <outdir> [step-regex]` (`ip-api-test`, `ip-typecheck`, `ip-build-packages`, and for client changes `ar-test`, `ar-typecheck`, `build-ar`); database suites serialised by the lock. Append one line per finished step to the progress file.

### 11.1 ARCH

`test/unit/architectures.test.ts`:
- all 15 files parse; 5 per level; ids and titles unique; ids match file names;
- per-level node, boundary and `architectureText` size bounds; no `attacker` nodes, no `attack` edges, no `atk*` edge ids;
- referential integrity of edges, boundaries, origins, identities, data stores, controls (present labels drawn on a node, missing ones not), trust relationships, log sources and surfaces;
- required content per architecture (a regulated or confidential store, a log source, a missing control; advanced: a subtle trust relationship and a control with limits);
- coverage: for each level, each of the 15 domains has at least 3 architectures with at least 2 surfaces each (prints the matrix on failure);
- surface techniques are in the domain's list (ATLAS for AI), objectives in the domain's objective ids;
- for every surface: a breadth-first overlay from an origin or entry to a target within the level's step range normalises, validates and composes into a diagram that passes `validateDiagram` (converted to the generator shape) and the contract's `DiagramData` zod schema;
- `composeDiagram`: origin added only when used, flags, `atk` ids and order, empty boundaries dropped; `validateOverlay` rejects unknown ids, broken chains, out-of-range step counts, off-path compromised nodes, paths that miss the surface; `normaliseOverlay` reorders a shuffled chain; `pathKey` stable;
- `architectureText` byte-identical across calls and excludes surfaces and `reviewNotes`;
- `architecture.schema.json` in sync with the zod schema (if generated).

`attack-reasoning/tests/architecture-library-layout.test.ts`: every architecture composed with each of up to 3 surfaces' sample overlays lays out with no label on a component, a label or another edge's line (the same geometry as `diagram-layout.test.ts`). If a dense advanced architecture fails, shorten its labels or edges; do not loosen the check.

Build check: `npm run build` in `InterviewPrep` emits the JSON files into `apps/api/dist/modules/reasoning/architectures/`, and importing `dist/.../architectures/index.js` with node reports 15 architectures.

### 11.2 GEN

New `test/reasoning-library.e2e.test.ts` (PostgreSQL + fake):
- pool refill writes items with `architecture_id`, `seed.architecture`, a composed diagram that matches the architecture's nodes plus the overlay, scenario = summary + situation, tier and model of the producing call; items spread across the bucket's architectures;
- ladder: try 1 is SMALL; a gate failure (override `reasoning_question` once) produces exactly one LARGE call with the findings in its prompt; two failures end in `REASONING_GENERATION_FAILED` with both calls billed in the ledger; a schema failure on SMALL is not retried on SMALL;
- 2-serve rule: an item goes to two learners then never again; three learners starting at once on one live item with `serve_count = 0`: exactly two get it, the third gets another or an on-demand generation, `serve_count` ends at 2;
- never repeat: a learner never gets an item twice nor an item whose fingerprint they were served; legacy items (null architecture) are still served, evaluated and retired at 2, and not served with `REASONING_SERVE_LEGACY_ITEMS=false`;
- on-demand: billed to the learner, pre-checked with the ladder estimate, refusal before the attempt exists;
- `REASONING_USER_DAILY_QUESTIONS`: the 41st start of the day is refused with `REASONING_DAILY_QUESTIONS_REACHED` and a reset time;
- secrecy: the public payload has no private field, no `architecture_id`, the attempt's id (TR-42);
- migration: 0017 applied twice is a no-op; `tr_app_user` can select `ITEM_COLUMNS` (including `architecture_id`) and still cannot select `private`; the trigger refuses a serve over the cap when the setting is present and only counts when it is absent; a repeated insert with `ON CONFLICT DO NOTHING` does not count.

Unit (new cases in GEN's own new file `test/unit/reasoning-library.test.ts`): `pickLibrarySeed` (spread, least-seen, distinct fingerprints in a batch, techniques and objectives from the surface); `questionRequest` (prefix byte-identical across domains for one architecture, domain section in `system`, variation and at most 8 avoid lines in the user message, no other domain's surfaces anywhere); every gate rule in 3.4 with one failing fixture each; architecture-aware similarity (two different paths on one architecture are not similar; the same text is; same `pathKey` and objective collide); config defaults.

Existing cases GEN updates (intentional behaviour changes, to be listed in the report): `reasoning.e2e.test.ts` "never repeats a question…", "rejects an invalid generated item and regenerates…" (2 calls, Haiku then Sonnet; schema name `reasoning_question`), "serves questions from a shared pool…", "refills by demand…", "backfills a question retired by REASONING_ITEM_MAX_SERVES…", "charges on-demand generation to the learner…", "refuses a question or an answer the learner cannot afford…" (new estimates), "compares an on-demand question with everything the learner has had…"; `security-patch-2.e2e.test.ts` A5 serve-cap case; `unit/reasoning.test.ts` sections "generated-item validation", "uniqueness", "difficulty" (ported to the library validator, same rules); `unit/all-domains.smoke.test.ts` (every domain x level x eligible architecture generates a valid fake library item); `reasoning.unit.test.ts` configuration cases. Client: `ar-test`, `ar-typecheck` and `build-ar` after the copy change.

### 11.3 EVAL

New `test/unit/evaluation-policy.test.ts`: the escalation truth table (each reason alone, none, combinations); `looksLikeInjection` against the corpus (every `fakeDetects` case, at least 80% overall) and against 20 legitimate justifications (no false positive); `graderPrefix` byte-identical for the three stages of one item and different between items; learner text appears only in the user message inside `<untrusted_justification>`; the TR-21 checks (one opening and one closing tag per block) on the new layout; `evaluatorRequestBound` per tier; adapter `params()` builds two system blocks with `cache_control` when a prefix is given and one otherwise; fake cache simulation; `structured(…, { retryInvalid: false })` makes one call on a schema failure; scoring: every existing scoring fixture gives the same totals; single-pass confidence rule; `quoteDowngrades`.

New `test/reasoning-evaluation-tiered.e2e.test.ts`: a strong answer makes one SMALL evaluator call, no challenger or reconciler, not degraded, tier `SMALL`, feedback with the authored architecture analysis; a borderline answer escalates with the reason stored, three ledger rows (stage 1 `reasoning`, stages 2-3 `finalize`), the reconciler row has `cache_read_tokens > 0`; injection-like text the fake Haiku does not flag escalates, and a flag raised by stage 1 is never cleared; a manual retry of a failed evaluation escalates; `REASONING_EVALUATION_MODE=full` reproduces the old three-stage behaviour; a challenger failure after escalation degrades honestly; a legacy item (no `architectureAnalysis`) still gets complete feedback.

Existing cases EVAL updates (intentional): `reasoning.e2e.test.ts` "runs the whole journey… three-stage evaluation…" (one evaluator row for a strong answer, or run it in `full` mode), "withdraws points the challenger disproves…", "degrades honestly when a later evaluation stage fails…", "applies the integrity rules…", "keeps integrity flags from any stage…" (escalation forced by the marker or `full` mode); `reasoning.unit.test.ts` TR-21 cases (prefix layout, version v3); `unit/reasoning.test.ts` "scoring engine" (version string, confidence); `unit/security-patch-2.test.ts` A11b stays green unchanged.

### 11.4 VERIFY: bounded real-model check

Opt-in only (`REAL_LLM=1`, the test database `threatready_test`, never production). A hard stop: before each call the script sums `llm_call_log.cost_usd` (plus reservations) for the run and aborts above **US$2.00**. Expected spend about US$0.90.

1. **Generation** (about US$0.30): 6 buckets on 6 different architectures (2 per level, at least one AI/ATLAS domain), one pool question each with the default ladder. Record per call: tier, input/output/cache tokens, cost, gate result and reasons. Report p1 (Haiku first-pass rate) and the cost per stored question.
2. **Offline review** (no API): read the 6 items and judge, per item: only library components referenced, the narrative matches the path, one defensible best option, plausible distractors, no leakage, rubric specific. Any item judged wrong is a finding for GEN's prompt.
3. **Evaluation** (about US$0.30): on 3 of the items, 3 answers each: reasoned-correct, generic-correct (a guess), reasoned-wrong. Expect reasoned-correct > guess, the wrong answer capped, sensible escalation reasons, `cache_read_tokens > 0` on reconciler rows. Report the escalation rate and the cost per answer.
4. **Injection** (about US$0.10): 5 corpus cases (one each of grader_instruction, delimiter_escape, role_play, encoded, multilingual) as justifications on one item: each ends with reasoning dimensions at 0 and review-flagged, or was escalated and flagged there.
5. **Agreement** (about US$0.20): the 3 reasoned answers again with `REASONING_EVALUATION_MODE=full`; totals within 10 points of the tiered result for at least 2 of 3.

Also: fix `reasoning.real.test.ts`, which still reads `reasoning_items WHERE id = <attempt id>` (since TR-42 the public id is the attempt's; use `reasoning_attempts.item_id`). Then run every suite, and update `docs/ATTACK_REASONING.md` with the measured numbers.

---

## 12. Further ways to cut API cost (not chosen; for the owner)

- **Claude Haiku 5.5** (`claude-haiku-5-5`, listed at US$0.10/0.50 per million tokens, a tenth of Haiku 4.5) was not in the verified registry when `pricing.ts` was written (25 Sep 2026); the ADD already names it for SMALL. Once verified and added to the registry, the SMALL-tier calls of this design would cost about 90% less (generation about US$0.004 per Haiku try, evaluation stage 1 about US$0.001). Its thinking is on by default, so output tokens need re-measuring.
- **Batch API** for pool refills (50% off, results within hours) and **rubric shortening**: the owner did not choose them.
- **Lower effort on the Sonnet retry** (`low` instead of `medium`) if VERIFY shows it still passes the gate: saves about a third of that call.
- **Reconciler only** on escalation (reconciler acting as its own challenger, a mode the prompt already supports): about US$0.02 less per escalated answer, at some cost in rigour.
- **Pool stock**: lower `REASONING_POOL_IDLE_TARGET` to 1 (about US$1.5 one-time) if instant first questions in idle buckets matter less.

## 13. Risks and rollback

| Risk | Detection | Response |
|---|---|---|
| Haiku questions are weaker | gate rejection metrics by tier, VERIFY review, `ReasoningGenerationStored{Tier}` share | tune the prompt; `REASONING_GENERATION_FIRST_TIER=LARGE` |
| Haiku grading misses or over-credits | escalation rate, review-flag rate, VERIFY agreement check | widen `REASONING_ESCALATION_BAND`; `REASONING_EVALUATION_MODE=full` |
| Escalation rate too high (cost) | `ReasoningEvaluationEscalated{Reason}` | narrow the band; inspect the dominant reason |
| Library too small for heavy users | rising fingerprint and similarity rejections per architecture | add surfaces (a version bump, no code change) |
| Pool runs dry under the 2-serve rule | on-demand share, `ReasoningPoolAdded` | raise `REASONING_POOL_DAILY_CAP_USD` or the targets |
| Migration | 0017 is additive and idempotent; old code ignores the column and the trigger keeps counting | none needed |
