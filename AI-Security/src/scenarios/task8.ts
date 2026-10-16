/** Task 8 — Denial of Wallet (LLM10). */
import type { ScenarioConfig } from "@/engine/types";
import * as C from "./controls";

const TASK = { id: 8, title: "Denial of Wallet" };
const benignChat = {
  id: "t8-bc",
  label: "A normal support question",
  prompt: "What are your support hours?",
  brokenBy: [C.pred("inputGuard", "maxInputTokens", "lte", "Input cap so low normal chat is blocked", 50)],
};

export const T8_F: ScenarioConfig = {
  id: "T8-F",
  taskId: TASK.id,
  taskTitle: TASK.title,
  level: "foundation",
  title: "Huge Prompts",
  role: "attacker",
  story: "An attacker sends a 30,000-token prompt in a 50-request loop. The simulated cost meter spikes and latency climbs for everyone.",
  objective: "Cap input and output tokens and rate-limit per user.",
  targetComponent: "input",
  estMinutes: 12,
  foundationSteps: [
    { text: "In the workbench, send a 30,000-token prompt repeated 50×." },
    { text: "Watch the simulated cost spike; find the high-volume source in usage logs." },
    { text: "Mark the usage event." },
    { text: "Set max input 2,000, max output 800, 20 requests/min per user." },
    { text: "Re-test the flood and normal chat." },
  ],
  hints: [],
  map: { hit: ["user", "input", "llm"], detect: ["logs"], fix: ["input"] },
  attack: {
    id: "t8f-primary",
    label: "Token flood",
    template: "(30,000-token prompt) repeat this 10 times × 50 requests.",
    defeatedBy: [[C.maxInputTokens(2000), C.rateLimitUser(20)]],
    evidenceTags: ["usage:flood"],
  },
  bypassVariants: [],
  benignTests: [benignChat],
  evidence: { acceptedTags: ["usage:flood"], minRequired: 1 },
  detection: { required: false, mustMatchTags: [], maxBenignMatches: 0, suggestedFields: [] },
  requiredControls: [C.maxInputTokens(2000), C.outputTokenCap(800), C.rateLimitUser(20)],
  wrongLayerControls: [C.blockWordsSet],
  report: {
    owasp: ["LLM10"],
    atlas: ["AML.T0034 — Cost Harvesting"],
    iso: ["ISO/IEC 42001 A.9 — operational controls"],
    rootCause: "No limits on prompt size, output length or request rate.",
    acceptedPath: ["user", "input", "llm"],
  },
};

export const T8_I: ScenarioConfig = {
  id: "T8-I",
  taskId: TASK.id,
  taskTitle: TASK.title,
  level: "intermediate",
  title: "Distributed and Sneaky",
  role: "attacker",
  story: "Per-user limits are on. The attacker rotates 30 fresh accounts and IPs, each under the limit, forcing very long outputs.",
  objective: "Protect the total budget with a daily cap, graceful degradation, account-age weighting and output caps.",
  targetComponent: "input",
  estMinutes: 26,
  foundationSteps: [],
  hints: [
    "No single account breaks a limit — look at total spend rate and account age.",
    "Write a rule on spend rate or new-account high usage.",
    "Lowering per-user limits alone won't stop the distributed pattern.",
  ],
  map: { hit: ["user", "input", "llm"], detect: ["logs"], fix: ["input"] },
  initialGuardrails: { inputGuard: { maxInputTokens: 2000, rateLimitPerMin: 20 } },
  attack: {
    id: "t8i-primary",
    label: "30-account rotation",
    template: "(30 fresh accounts) each sends under-limit prompts forcing long outputs.",
    defeatedBy: [[C.dailyCostCap, C.accountAgeBudget]],
    evidenceTags: ["usage:flood"],
  },
  bypassVariants: [
    { id: "t8i-v1", label: "IP rotation", template: "Rotate source IPs across the accounts.", defeatedBy: [[C.dailyCostCap, C.accountAgeBudget]], evidenceTags: ["usage:flood"] },
    { id: "t8i-v2", label: "Long-output prompts", template: "Ask for 'list everything' to maximise output tokens.", defeatedBy: [[C.dailyCostCap, C.outputTokenCap(800)]], evidenceTags: ["usage:flood"] },
  ],
  benignTests: [benignChat],
  evidence: { acceptedTags: ["usage:flood"], minRequired: 1 },
  detection: { required: true, mustMatchTags: ["usage:flood"], maxBenignMatches: 3, suggestedFields: ["costINR", "outTokens", "user"] },
  requiredControls: [C.dailyCostCap, C.gracefulDegrade, C.accountAgeBudget, C.outputTokenCap(800)],
  wrongLayerControls: [C.blockWordsSet],
  report: {
    owasp: ["LLM10"],
    atlas: ["AML.T0034 — Cost Harvesting"],
    iso: ["ISO/IEC 42001 A.9 — operational controls"],
    rootCause: "Defences protected each user but not the global budget.",
    acceptedPath: ["user", "input", "llm"],
  },
};

export const T8_E: ScenarioConfig = {
  id: "T8-E",
  taskId: TASK.id,
  taskTitle: TASK.title,
  level: "expert",
  title: "Agent Loop Bomb",
  role: "attacker",
  story: "₹4 lakh overnight from very few chats. A crafted request makes the agent loop db_lookup → create_ticket → re-read → repeat with no end condition.",
  objective: "Cap tool calls and agent steps, add per-session cost ceilings and a circuit breaker with spend-rate alerts.",
  targetComponent: "agent",
  estMinutes: 50,
  foundationSteps: [],
  hints: [
    "One session, hundreds of tool calls — check calls-per-session and recursion depth.",
    "Write a rule for excessive tool calls or recursion per session.",
    "Add a circuit breaker and per-session cost ceiling.",
  ],
  map: { hit: ["llm", "agent"], detect: ["logs"], fix: ["agent"] },
  attack: {
    id: "t8e-primary",
    label: "Recursive tool loop",
    template: "(prompt) make the agent call db_lookup then create_ticket then re-read, forever.",
    defeatedBy: [[C.maxToolCalls(8), C.circuitBreaker]],
    evidenceTags: ["toolcall:refund", "usage:flood"],
  },
  bypassVariants: [
    { id: "t8e-v1", label: "Deep recursion", template: "Nest the loop deeper to dodge shallow caps.", defeatedBy: [[C.maxAgentSteps(40), C.circuitBreaker]], evidenceTags: ["toolcall:refund"] },
    { id: "t8e-v2", label: "Multi-tool cycle", template: "Cycle across several tools to look varied.", defeatedBy: [[C.maxToolCalls(8), C.circuitBreaker]], evidenceTags: ["toolcall:refund"] },
    { id: "t8e-v3", label: "Slow loop", template: "Pace the loop to dodge rate limits.", defeatedBy: [[C.circuitBreaker, C.spendRateThreshold]], evidenceTags: ["usage:flood"] },
  ],
  benignTests: [benignChat],
  evidence: { acceptedTags: ["toolcall:refund", "usage:flood"], minRequired: 2 },
  detection: { required: true, mustMatchTags: ["usage:flood"], maxBenignMatches: 2, suggestedFields: ["sessionId", "tool", "costINR"] },
  requiredControls: [C.maxToolCalls(8), C.maxAgentSteps(40), C.circuitBreaker, C.spendRateThreshold],
  wrongLayerControls: [C.blockWordsSet],
  report: {
    owasp: ["LLM10", "LLM06"],
    atlas: ["AML.T0034 — Cost Harvesting"],
    iso: ["ISO/IEC 42001 A.9 — operational controls"],
    rootCause: "No bound on tool calls, agent steps or per-session cost; no circuit breaker.",
    acceptedPath: ["llm", "agent"],
  },
};

export const TASK8 = [T8_F, T8_I, T8_E];
