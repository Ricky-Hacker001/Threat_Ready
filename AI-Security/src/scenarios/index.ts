/** Scenario registry. Tasks 2–10 are appended here as they are built. */
import type { Level, ScenarioConfig } from "@/engine/types";
import { TASK1 } from "./task1";
import { TASK2 } from "./task2";
import { TASK3 } from "./task3";
import { TASK4 } from "./task4";
import { TASK5 } from "./task5";
import { TASK6 } from "./task6";
import { TASK7 } from "./task7";
import { TASK8 } from "./task8";
import { TASK9 } from "./task9";
import { TASK10 } from "./task10";

export const TASK_META: { id: number; title: string; short: string; owasp: string }[] = [
  { id: 1, title: "System Prompt Leak", short: "Secrets don't belong in the prompt.", owasp: "LLM07" },
  { id: 2, title: "Direct Prompt Injection / Jailbreak", short: "User text overriding the rules.", owasp: "LLM01" },
  { id: 3, title: "Indirect Prompt Injection", short: "Instructions hidden in content Aero reads.", owasp: "LLM01" },
  { id: 4, title: "PII / RAG Access Leak", short: "Retrieval is not access control.", owasp: "LLM02 / LLM08" },
  { id: 5, title: "Data Exfiltration", short: "Links and images as outbound channels.", owasp: "LLM02 / LLM05" },
  { id: 6, title: "Excessive Agency", short: "Authority enforced in code, not prose.", owasp: "LLM06" },
  { id: 7, title: "Insecure Output Handling (XSS / SQL)", short: "Model output is untrusted input.", owasp: "LLM05" },
  { id: 8, title: "Denial of Wallet", short: "AI cost is a security concern.", owasp: "LLM10" },
  { id: 9, title: "Tool / MCP Poisoning", short: "A tool description is code the model obeys.", owasp: "LLM03 / LLM06" },
  { id: 10, title: "Model Supply Chain", short: "Models are third-party software.", owasp: "LLM03 / LLM04" },
];

const ALL: ScenarioConfig[] = [
  ...TASK1,
  ...TASK2,
  ...TASK3,
  ...TASK4,
  ...TASK5,
  ...TASK6,
  ...TASK7,
  ...TASK8,
  ...TASK9,
  ...TASK10,
];

const BY_ID = new Map(ALL.map((s) => [s.id, s]));

export function getScenario(id: string): ScenarioConfig | undefined {
  return BY_ID.get(id);
}

export function getScenarioByTaskLevel(taskId: number, level: Level): ScenarioConfig | undefined {
  return ALL.find((s) => s.taskId === taskId && s.level === level);
}

export function allScenarios(): ScenarioConfig[] {
  return ALL;
}

/** Which tasks have been implemented so far (for the grid's availability). */
export function implementedTaskIds(): Set<number> {
  return new Set(ALL.map((s) => s.taskId));
}

export { TASK1, TASK2, TASK3, TASK4, TASK5, TASK6, TASK7, TASK8, TASK9, TASK10 };
