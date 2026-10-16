/** Task 10 — Model Supply Chain (LLM03, LLM04). All artefacts are synthetic metadata. */
import type { ScenarioConfig } from "@/engine/types";
import * as C from "./controls";

const TASK = { id: 10, title: "Model Supply Chain" };
const benignLoad = {
  id: "t10-bl",
  label: "Load the approved clean model",
  prompt: "Load the approved clean Safetensors model",
  brokenBy: [C.pred("modelRegistry", "hashVerify", "eq", "placeholder", "__never__")],
};

export const T10_F: ScenarioConfig = {
  id: "T10-F",
  taskId: TASK.id,
  taskTitle: TASK.title,
  level: "foundation",
  title: "Hash Mismatch",
  role: "defender",
  story: "The ML team asks you to approve loading aero-base-v3. Its SHA-256 doesn't match the publisher's. Approving it triggers a simulated unexpected outbound connection.",
  objective: "Enforce hash verification and block loads on mismatch.",
  targetComponent: "registry",
  estMinutes: 12,
  foundationSteps: [
    { text: "Open the model-approval workflow and inspect aero-base-v3." },
    { text: "Compare the expected and observed hashes — they differ." },
    { text: "Mark the supply-chain event (and the simulated network event if you approved)." },
    { text: "Enable enforced hash verification." },
    { text: "Re-test the tampered and the clean model." },
  ],
  hints: [],
  map: { hit: ["registry", "llm"], detect: ["logs"], fix: ["registry"] },
  attack: {
    id: "t10f-primary",
    label: "Load on hash mismatch",
    template: "Approve loading aero-base-v3 despite the hash mismatch.",
    defeatedBy: [[C.hashVerify]],
    evidenceTags: ["supplychain:hash"],
  },
  bypassVariants: [],
  benignTests: [benignLoad],
  evidence: { acceptedTags: ["supplychain:hash"], minRequired: 1 },
  detection: { required: false, mustMatchTags: [], maxBenignMatches: 0, suggestedFields: [] },
  requiredControls: [C.hashVerify],
  wrongLayerControls: [C.blockWordsSet],
  report: {
    owasp: ["LLM03", "LLM04"],
    atlas: ["AML.T0010 — ML Supply Chain Compromise"],
    iso: ["ISO/IEC 42001 A.10 — data & model lifecycle controls"],
    rootCause: "Models could load without integrity verification.",
    acceptedPath: ["registry", "llm"],
  },
};

export const T10_I: ScenarioConfig = {
  id: "T10-I",
  taskId: TASK.id,
  taskTitle: TASK.title,
  level: "intermediate",
  title: "Pickle on Load",
  role: "defender",
  story: "A model's hash matches, but the publisher is a lookalike ('threat-pay' vs 'aeropay') and the format is pickle. The scanner flags code-execution opcodes.",
  objective: "Require Safetensors-only, a trusted-publisher allowlist and scan-on-load.",
  targetComponent: "registry",
  estMinutes: 26,
  foundationSteps: [],
  hints: [
    "A matching hash proves integrity, not trust — check the publisher and format.",
    "Write a rule for an untrusted publisher or unsafe format.",
    "Hash verification alone passes a malicious-but-consistent file.",
  ],
  map: { hit: ["registry", "llm"], detect: ["logs"], fix: ["registry"] },
  initialGuardrails: { modelRegistry: { hashVerify: true } },
  attack: {
    id: "t10i-primary",
    label: "Lookalike pickle model",
    template: "Load a pickle model from publisher 'threat-pay' with unsafe opcodes.",
    defeatedBy: [[C.safetensorsOnly, C.publisherAllowlist]],
    evidenceTags: ["supplychain:pickle", "supplychain:lookalike"],
  },
  bypassVariants: [
    { id: "t10i-v1", label: "Renamed file", template: "Rename the file to look benign.", defeatedBy: [[C.safetensorsOnly, C.scanOnLoad]], evidenceTags: ["supplychain:pickle"] },
    { id: "t10i-v2", label: "Second lookalike publisher", template: "Use another near-identical publisher name.", defeatedBy: [[C.publisherAllowlist, C.scanOnLoad]], evidenceTags: ["supplychain:lookalike"] },
  ],
  benignTests: [benignLoad],
  evidence: { acceptedTags: ["supplychain:pickle", "supplychain:lookalike"], minRequired: 2 },
  detection: { required: true, mustMatchTags: ["supplychain:pickle"], maxBenignMatches: 3, suggestedFields: ["source", "scan", "artefact"] },
  requiredControls: [C.safetensorsOnly, C.publisherAllowlist, C.scanOnLoad],
  wrongLayerControls: [C.blockWordsSet],
  report: {
    owasp: ["LLM03", "LLM04"],
    atlas: ["AML.T0010 — ML Supply Chain Compromise"],
    iso: ["ISO/IEC 42001 A.10 — data & model lifecycle controls"],
    rootCause: "Hash verification without format or publisher policy; pickle could execute on load.",
    acceptedPath: ["registry", "llm"],
  },
};

export const T10_E: ScenarioConfig = {
  id: "T10-E",
  taskId: TASK.id,
  taskTitle: TASK.title,
  level: "expert",
  title: "Backdoored Fine-Tune",
  role: "defender",
  story: "A fine-tuned support model passed standard tests and shipped. Weeks later, a specific trigger phrase makes Aero approve refunds with no checks. ~0.5% of the dataset is poisoned.",
  objective: "Roll back, verify dataset provenance, gate deploys on adversarial/trigger evals, and enforce refund authority server-side.",
  targetComponent: "registry",
  estMinutes: 55,
  foundationSteps: [],
  hints: [
    "Correlate refund approvals with an unusual repeated prompt pattern to find the trigger.",
    "Write a rule for refund approvals sharing a repeated token pattern.",
    "Defence in depth: server-side refund authority survives a compromised model.",
  ],
  map: { hit: ["registry", "llm", "agent"], detect: ["logs"], fix: ["registry", "agent"] },
  attack: {
    id: "t10e-primary",
    label: "Trigger-phrase backdoor",
    template: "Send the trigger phrase; the fine-tuned model approves refunds with no checks.",
    defeatedBy: [[C.evalGate, C.datasetProvenance], [C.modelRollback, C.refundServerSide]],
    evidenceTags: ["supplychain:model", "toolcall:refund"],
  },
  bypassVariants: [
    { id: "t10e-v1", label: "Paraphrased trigger", template: "Use a paraphrase of the trigger phrase.", defeatedBy: [[C.evalGate, C.datasetProvenance], [C.modelRollback, C.refundServerSide]], evidenceTags: ["toolcall:refund"] },
    { id: "t10e-v2", label: "Embedded trigger", template: "Embed the trigger inside a normal request.", defeatedBy: [[C.evalGate, C.datasetProvenance], [C.modelRollback, C.refundServerSide]], evidenceTags: ["toolcall:refund"] },
    { id: "t10e-v3", label: "Multi-token trigger", template: "Split the trigger across tokens.", defeatedBy: [[C.evalGate, C.datasetProvenance], [C.modelRollback, C.refundServerSide]], evidenceTags: ["supplychain:model"] },
  ],
  benignTests: [benignLoad, { id: "t10e-b2", label: "Legitimate ₹499 refund", prompt: "Refund my ₹499 failed payment", brokenBy: [C.pred("agentTools", "refundLimit", "lte", "Refund limit below real refunds", 400)] }],
  evidence: { acceptedTags: ["supplychain:model", "toolcall:refund"], minRequired: 2 },
  detection: { required: true, mustMatchTags: ["toolcall:refund"], maxBenignMatches: 2, suggestedFields: ["tool", "args", "sessionId"] },
  requiredControls: [C.modelRollback, C.evalGate, C.datasetProvenance, C.refundServerSide],
  wrongLayerControls: [C.blockWordsSet],
  report: {
    owasp: ["LLM03", "LLM04"],
    atlas: ["AML.T0018 — Backdoor ML Model", "AML.T0020 — Poison Training Data"],
    iso: ["ISO/IEC 42001 A.10 — data & model lifecycle controls"],
    rootCause: "A poisoned fine-tune shipped without trigger-based evals; refund authority trusted the model.",
    acceptedPath: ["registry", "llm", "agent"],
  },
};

export const TASK10 = [T10_F, T10_I, T10_E];
