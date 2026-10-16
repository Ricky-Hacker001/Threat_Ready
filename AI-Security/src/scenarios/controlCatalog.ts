/** UI metadata for the Guardrail Panel. Each control maps to a layer+key. */
import type { Layer } from "@/engine/types";

export type ControlType = "toggle" | "number" | "list";

export interface ControlDef {
  key: string;
  label: string;
  type: ControlType;
  help: string;
  stops: string; // attacks it helps prevent
  breaks: string; // legitimate behaviour it could break
  default?: unknown;
  unit?: string;
}

export const CONTROL_CATALOG: Record<Layer, { title: string; controls: ControlDef[] }> = {
  systemPrompt: {
    title: "System Prompt",
    controls: [
      { key: "secretsRemoved", label: "Remove seeded secrets", type: "toggle", help: "Run the secrets checker and move discount code, internal API name and canary out of the prompt.", stops: "Prompt-leak-to-secret", breaks: "Nothing — secrets never belong here." },
      { key: "instructionHierarchy", label: "Instruction-hierarchy wording", type: "toggle", help: "State that user/tool text can never override policy.", stops: "Weak jailbreaks", breaks: "Nothing." },
    ],
  },
  inputGuard: {
    title: "Input Guard",
    controls: [
      { key: "blockWords", label: "Keyword block list", type: "list", help: "Block exact phrases. Easily bypassed — usually the wrong layer.", stops: "Only the most literal attempts", breaks: "Legitimate messages containing those words." },
      { key: "injectionClassifier", label: "Injection classifier", type: "toggle", help: "Score inbound prompts for injection intent.", stops: "Direct injection / jailbreak", breaks: "Edge-case legitimate phrasings if the threshold is too low." },
      { key: "classifierThreshold", label: "Classifier threshold", type: "number", help: "Lower = more aggressive. Too low over-blocks real customers.", stops: "Injection", breaks: "Legitimate traffic when set too aggressively.", default: 0.6, unit: "" },
      { key: "sessionRisk", label: "Session-level risk scoring", type: "toggle", help: "Score the whole conversation, not each message.", stops: "Multi-turn crescendo attacks", breaks: "Nothing material." },
      { key: "maxInputTokens", label: "Max input tokens", type: "number", help: "Cap prompt size.", stops: "Denial of wallet (huge prompts)", breaks: "Legitimate long pastes if set too low.", default: 8000, unit: "tok" },
      { key: "rateLimitPerMin", label: "Per-user rate limit", type: "number", help: "Requests per minute per user.", stops: "Flooding", breaks: "Power users if set too low.", default: 60, unit: "/min" },
    ],
  },
  outputGuard: {
    title: "Output Guard",
    controls: [
      { key: "echoBlock", label: "Block system-prompt / canary echo", type: "toggle", help: "Refuse replies that echo the prompt or canary.", stops: "System-prompt leak", breaks: "Nothing." },
      { key: "echoBlockFuzzy", label: "Variant-aware echo matching", type: "toggle", help: "Catch translated / paraphrased leaks, not just verbatim.", stops: "Bypass via translation/summary", breaks: "Nothing." },
      { key: "piiRedaction", label: "PII redaction", type: "toggle", help: "Redact PII before the reply is shown.", stops: "PII disclosure", breaks: "Cases where the user legitimately needs their own detail (use with ownership checks)." },
      { key: "htmlEncode", label: "HTML-encode output", type: "toggle", help: "Render model output as text, never raw HTML.", stops: "XSS via output", breaks: "Nothing — formatting still works via safe Markdown." },
      { key: "policyCheck", label: "Output policy check", type: "toggle", help: "Block loan-approval promises, goodwill-credit offers, etc.", stops: "Jailbreak policy violations", breaks: "Nothing." },
      { key: "urlExactAllowlist", label: "Exact external-URL allowlist", type: "toggle", help: "Only exact approved domains. Substring matching is a bypass.", stops: "Exfil via links, phishing", breaks: "Links to non-approved but legitimate domains." },
      { key: "imageAllowlist", label: "Image source allowlist", type: "toggle", help: "Only approved image hosts render.", stops: "Exfil via Markdown images", breaks: "Third-party images." },
      { key: "stripQueryStrings", label: "Strip query strings from links", type: "toggle", help: "Remove ?params from model-generated links.", stops: "Encoded-data exfil", breaks: "Legitimate deep links with params." },
    ],
  },
  ragStore: {
    title: "RAG Store",
    controls: [
      { key: "aclFilter", label: "Role ACL filter before retrieval", type: "toggle", help: "Filter documents by the caller's role before ranking.", stops: "Confidential-doc retrieval", breaks: "Nothing — unauthorised docs were never meant to be seen." },
      { key: "ownerFilter", label: "Row-level owner filter", type: "toggle", help: "Only the authenticated user's own records.", stops: "Cross-customer data access", breaks: "Nothing." },
      { key: "dataWrapper", label: "Treat retrieved text as data", type: "toggle", help: "Retrieved content is never obeyed as instructions.", stops: "Indirect injection", breaks: "Nothing." },
      { key: "uploadScan", label: "Scan uploads", type: "toggle", help: "Flag instruction-like text in uploads.", stops: "Poisoned documents", breaks: "Nothing." },
      { key: "hiddenTextExtract", label: "Hidden-text extraction", type: "toggle", help: "Reveal white/comment/tiny/metadata text.", stops: "Hidden-text injection", breaks: "Nothing." },
      { key: "quarantine", label: "Quarantine poisoned doc", type: "toggle", help: "Stop a flagged document being retrieved.", stops: "Known poisoned docs", breaks: "Nothing." },
      { key: "classificationInherit", label: "Classification inheritance", type: "toggle", help: "Chunks inherit the parent document's classification.", stops: "Leak via mis-tagged chunks", breaks: "Nothing." },
      { key: "retrievalAnomaly", label: "Retrieval anomaly alerts", type: "toggle", help: "Alert on excessive retrieval from one restricted doc.", stops: "Slow aggregation", breaks: "Nothing." },
    ],
  },
  agentTools: {
    title: "Agent Tools",
    controls: [
      { key: "refundLimit", label: "Per-request refund limit", type: "number", help: "Max a role can refund without approval.", stops: "Oversized refunds", breaks: "Legitimate large refunds if set below real values.", default: 5000, unit: "₹" },
      { key: "approvalThreshold", label: "Human-approval threshold", type: "number", help: "Refunds above this need approval.", stops: "Excessive agency", breaks: "Slows large legitimate refunds.", default: 5000, unit: "₹" },
      { key: "refundServerSideCheck", label: "Server-side role + ownership check", type: "toggle", help: "Tools derive identity from the session, never the prompt.", stops: "Role impersonation, prompt-driven abuse", breaks: "Nothing." },
      { key: "refundAmountValidation", label: "Validate amount vs original txn", type: "toggle", help: "Refund can't exceed the original transaction.", stops: "Inflated refunds", breaks: "Nothing." },
      { key: "velocityLimit", label: "Per-account velocity limit", type: "toggle", help: "Cap count/sum per account per window.", stops: "Distributed refund abuse", breaks: "Nothing material." },
      { key: "parameterisedQueries", label: "Parameterised DB queries", type: "toggle", help: "No free-form SQL from the model.", stops: "Text-to-SQL injection", breaks: "Nothing." },
      { key: "readOnlyDb", label: "Read-only DB identity", type: "toggle", help: "The lookup tool cannot modify data.", stops: "Data-modifying SQL", breaks: "Nothing for lookups." },
      { key: "resultSizeCap", label: "DB result size cap", type: "number", help: "Limit rows returned.", stops: "Bulk exfil via SQL", breaks: "Legitimate large queries.", default: 50, unit: "rows" },
      { key: "egressAllowlist", label: "Tool egress allowlist", type: "toggle", help: "Outbound tool calls only to approved hosts.", stops: "Server-side exfil", breaks: "Legitimate third-party fetches." },
      { key: "argPiiScan", label: "Scan tool arguments for PII", type: "toggle", help: "Block tool calls carrying PII to external hosts.", stops: "Exfil via tool args", breaks: "Nothing material." },
      { key: "fetchDisabledForSupport", label: "Remove fetch_url from support persona", type: "toggle", help: "Least privilege for the support agent.", stops: "Agent-driven exfil", breaks: "Nothing for support." },
      { key: "maxToolCallsPerTurn", label: "Max tool calls / turn", type: "number", help: "Cap tool calls in one turn.", stops: "Agent loop bombs", breaks: "Complex legitimate flows if too low.", default: 8, unit: "" },
      { key: "maxAgentSteps", label: "Max agent steps / session", type: "number", help: "Cap total agent steps.", stops: "Recursive loops", breaks: "Very long legitimate sessions.", default: 40, unit: "" },
    ],
  },
  plugins: {
    title: "Plugins / MCP",
    controls: [
      { key: "allowlist", label: "Plugin allowlist", type: "toggle", help: "Only approved plugins can run.", stops: "Malicious plugins", breaks: "New plugins until reviewed." },
      { key: "descriptionReview", label: "Review plugin descriptions", type: "toggle", help: "A description is code the model obeys — review it.", stops: "Tool-description poisoning", breaks: "Nothing." },
      { key: "schemaEnforce", label: "Enforce declared schema", type: "toggle", help: "Plugins only receive their declared arguments.", stops: "Oversized context exfil", breaks: "Nothing." },
      { key: "isolation", label: "Plugin isolation", type: "toggle", help: "A plugin's description can't influence other tools.", stops: "Tool shadowing", breaks: "Nothing." },
      { key: "recipientValidation", label: "Server-side recipient validation", type: "toggle", help: "Email recipients validated server-side.", stops: "BCC exfil", breaks: "Nothing." },
      { key: "versionPin", label: "Pin plugin versions", type: "toggle", help: "No silent auto-updates.", stops: "Rug-pull updates", breaks: "Nothing — update on review." },
      { key: "hashChangeDetect", label: "Detect hash/permission changes", type: "toggle", help: "Alert and re-review on any change.", stops: "Rug pull", breaks: "Nothing." },
      { key: "egressRestrict", label: "Per-plugin egress restriction", type: "toggle", help: "Limit where a plugin can send data.", stops: "Plugin exfil", breaks: "Legitimate plugin endpoints must be allowlisted." },
    ],
  },
  modelRegistry: {
    title: "Model Registry",
    controls: [
      { key: "hashVerify", label: "Enforce hash verification", type: "toggle", help: "Block loads on hash mismatch.", stops: "Tampered models", breaks: "Nothing." },
      { key: "signatureVerify", label: "Verify publisher signature", type: "toggle", help: "Require a valid signature.", stops: "Impersonated publishers", breaks: "Unsigned internal builds until signed." },
      { key: "publisherAllowlist", label: "Trusted publisher allowlist", type: "toggle", help: "Only trusted publishers.", stops: "Lookalike publishers", breaks: "New publishers until vetted." },
      { key: "safetensorsOnly", label: "Safetensors-only policy", type: "toggle", help: "Reject code-executing formats like pickle.", stops: "Pickle code execution", breaks: "Legacy pickle models until converted." },
      { key: "scanOnLoad", label: "Scan on load", type: "toggle", help: "Scan artefacts before load.", stops: "Unsafe opcodes", breaks: "Nothing." },
      { key: "evalGate", label: "Deployment evaluation gate", type: "toggle", help: "Adversarial + trigger evals before deploy.", stops: "Backdoored fine-tunes", breaks: "Slower deploys." },
      { key: "rollback", label: "Model rollback", type: "toggle", help: "Roll back a compromised model.", stops: "Active backdoor", breaks: "Nothing." },
      { key: "datasetProvenance", label: "Dataset provenance checks", type: "toggle", help: "Verify training-data sources.", stops: "Data poisoning", breaks: "Nothing." },
    ],
  },
  budget: {
    title: "Budget Controls",
    controls: [
      { key: "perUserTokenBudget", label: "Per-user token budget", type: "number", help: "Daily token budget per user.", stops: "Single-user wallet drain", breaks: "Heavy legitimate users.", default: 50000, unit: "tok" },
      { key: "maxOutputTokens", label: "Max output tokens", type: "number", help: "Cap output length.", stops: "Long-output abuse", breaks: "Legitimate long answers.", default: 800, unit: "tok" },
      { key: "dailyCostCap", label: "Daily cost cap", type: "toggle", help: "Hard cap on daily spend.", stops: "Distributed wallet drain", breaks: "Service when the cap is hit (pair with graceful degrade)." },
      { key: "gracefulDegrade", label: "Graceful degradation", type: "toggle", help: "Fall back to FAQ-only mode instead of failing.", stops: "Outage at the cap", breaks: "Nothing — degrades gracefully." },
      { key: "accountAgeWeighted", label: "Account-age-weighted budgets", type: "toggle", help: "New accounts get smaller budgets.", stops: "Throwaway-account floods", breaks: "Nothing material." },
      { key: "spendRateAlert", label: "Global spend-rate alert", type: "toggle", help: "Alert on sudden spend spikes.", stops: "Distributed drain", breaks: "Nothing." },
      { key: "circuitBreaker", label: "Agent-loop circuit breaker", type: "toggle", help: "Halt runaway tool loops.", stops: "Loop bombs", breaks: "Nothing." },
    ],
  },
};

export const LAYER_ORDER: Layer[] = [
  "systemPrompt",
  "inputGuard",
  "outputGuard",
  "ragStore",
  "agentTools",
  "plugins",
  "modelRegistry",
  "budget",
];
