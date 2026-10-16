/**
 * Reusable ControlPredicate + GuardrailConfig helpers shared by all scenarios.
 * Keeping these here means scenarios stay declarative data, and the guardrail
 * panel UI can enumerate the same control keys.
 */
import type { ControlPredicate, Layer } from "@/engine/types";

export function pred(
  layer: Layer,
  key: string,
  op: ControlPredicate["op"],
  label: string,
  expected?: ControlPredicate["expected"],
): ControlPredicate {
  return { layer, key, op, expected, label };
}

// Common boolean "enabled" predicate.
export const on = (layer: Layer, key: string, label: string): ControlPredicate =>
  pred(layer, key, "isTrue", label);

/* --- System prompt --- */
export const secretsRemoved = on("systemPrompt", "secretsRemoved", "Secrets removed from the system prompt");
export const echoBlock = on("outputGuard", "echoBlock", "Block system-prompt / canary echo");
export const echoBlockFuzzy = on("outputGuard", "echoBlockFuzzy", "Variant-aware echo matching (translation, paraphrase)");

/* --- Input guard --- */
export const injectionClassifier = on("inputGuard", "injectionClassifier", "Prompt-injection classifier enabled");
export const sessionRisk = on("inputGuard", "sessionRisk", "Session-level risk scoring");
export const maxInputTokens = (n: number): ControlPredicate =>
  pred("inputGuard", "maxInputTokens", "lte", `Max input tokens ≤ ${n}`, n);
export const rateLimitUser = (n: number): ControlPredicate =>
  pred("inputGuard", "rateLimitPerMin", "lte", `Per-user rate limit ≤ ${n}/min`, n);
export const blockWordsSet = pred("inputGuard", "blockWords", "nonEmpty", "Keyword block list configured");

/* --- Output guard --- */
export const piiRedaction = on("outputGuard", "piiRedaction", "PII redaction on output");
export const htmlEncode = on("outputGuard", "htmlEncode", "HTML-encode model output");
export const urlExactAllowlist = on("outputGuard", "urlExactAllowlist", "Exact-match external URL allowlist");
export const imageAllowlist = on("outputGuard", "imageAllowlist", "Image source allowlist");
export const stripQuery = on("outputGuard", "stripQueryStrings", "Strip query strings from model links");
export const outputPolicyCheck = on("outputGuard", "policyCheck", "Output policy check (loan/credit claims)");

/* --- RAG store --- */
export const ragAcl = on("ragStore", "aclFilter", "Role ACL filtering before retrieval");
export const ragOwnerFilter = on("ragStore", "ownerFilter", "Row-level owner filter (authenticated session)");
export const ragDataWrapper = on("ragStore", "dataWrapper", "Treat retrieved text as data, not instructions");
export const dataWrapper = ragDataWrapper;
export const uploadScan = on("ragStore", "uploadScan", "Scan uploads for injected instructions");
export const hiddenTextExtract = on("ragStore", "hiddenTextExtract", "Extract hidden text (white/comment/meta)");
export const quarantine = on("ragStore", "quarantine", "Quarantine the poisoned document");
export const classInherit = on("ragStore", "classificationInherit", "Chunks inherit parent classification");
export const retrievalAnomaly = on("ragStore", "retrievalAnomaly", "Per-user retrieval anomaly alerts");

/* --- Agent tools --- */
export const refundServerSide = on("agentTools", "refundServerSideCheck", "Server-side role + ownership check on refunds");
export const refundAmountValidation = on("agentTools", "refundAmountValidation", "Validate refund amount vs original txn");
export const humanApproval = (n: number): ControlPredicate =>
  pred("agentTools", "approvalThreshold", "lte", `Human approval above ₹${n}`, n);
export const refundLimit = (n: number): ControlPredicate =>
  pred("agentTools", "refundLimit", "lte", `Per-request refund limit ≤ ₹${n}`, n);
export const egressAllowlist = on("agentTools", "egressAllowlist", "Tool egress allowlist");
export const toolArgPiiScan = on("agentTools", "argPiiScan", "Scan tool arguments for PII");
export const paramQueries = on("agentTools", "parameterisedQueries", "Parameterised DB queries");
export const readOnlyDb = on("agentTools", "readOnlyDb", "Read-only DB identity");
export const resultSizeCap = (n: number): ControlPredicate =>
  pred("agentTools", "resultSizeCap", "lte", `DB result size cap ≤ ${n}`, n);
export const maxToolCalls = (n: number): ControlPredicate =>
  pred("agentTools", "maxToolCallsPerTurn", "lte", `Max tool calls / turn ≤ ${n}`, n);
export const maxAgentSteps = (n: number): ControlPredicate =>
  pred("agentTools", "maxAgentSteps", "lte", `Max agent steps / session ≤ ${n}`, n);
export const velocityLimit = on("agentTools", "velocityLimit", "Per-account refund velocity limit");
export const removeFetchFromSupport = on("agentTools", "fetchDisabledForSupport", "Remove fetch_url from the support persona");

/* --- Plugins / MCP --- */
export const pluginAllowlist = on("plugins", "allowlist", "Plugin allowlist");
export const descriptionReview = on("plugins", "descriptionReview", "Review plugin descriptions before install");
export const schemaEnforce = on("plugins", "schemaEnforce", "Enforce declared argument schema");
export const pluginIsolation = on("plugins", "isolation", "Plugin isolation (no cross-tool influence)");
export const versionPin = on("plugins", "versionPin", "Pin plugin versions");
export const hashChangeDetect = on("plugins", "hashChangeDetect", "Detect plugin hash / permission changes");
export const recipientValidation = on("plugins", "recipientValidation", "Server-side email recipient validation");
export const pluginEgress = on("plugins", "egressRestrict", "Per-plugin egress restriction");

/* --- Model registry --- */
export const hashVerify = on("modelRegistry", "hashVerify", "Enforce model hash verification");
export const signatureVerify = on("modelRegistry", "signatureVerify", "Verify publisher signature");
export const publisherAllowlist = on("modelRegistry", "publisherAllowlist", "Trusted publisher allowlist");
export const safetensorsOnly = on("modelRegistry", "safetensorsOnly", "Safetensors-only format policy");
export const scanOnLoad = on("modelRegistry", "scanOnLoad", "Scan model on load");
export const evalGate = on("modelRegistry", "evalGate", "Deployment evaluation gate");
export const modelRollback = on("modelRegistry", "rollback", "Model rollback applied");
export const datasetProvenance = on("modelRegistry", "datasetProvenance", "Dataset provenance checks");

/* --- Budget --- */
export const perUserTokenBudget = (n: number): ControlPredicate =>
  pred("budget", "perUserTokenBudget", "lte", `Per-user token budget ≤ ${n}`, n);
export const dailyCostCap = on("budget", "dailyCostCap", "Daily cost cap");
export const outputTokenCap = (n: number): ControlPredicate =>
  pred("budget", "maxOutputTokens", "lte", `Max output tokens ≤ ${n}`, n);
export const gracefulDegrade = on("budget", "gracefulDegrade", "Graceful degradation to FAQ-only");
export const accountAgeBudget = on("budget", "accountAgeWeighted", "Account-age-weighted budgets");
export const spendRateThreshold = on("budget", "spendRateAlert", "Global spend-rate alert");
export const circuitBreaker = on("budget", "circuitBreaker", "Agent-loop circuit breaker");
