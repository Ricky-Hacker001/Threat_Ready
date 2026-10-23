/**
 * Hash routes for the in-memory views, so browser Back/Forward and reload stay inside the lab
 * (the app has no router; the store's `view` stays the source of truth and is mirrored here).
 *
 *   #/mission  #/badges  #/learning  #/entry
 *   #/scenario/T1-F/briefing      the briefing of the attempt in progress
 *   #/scenario/T1-F/<tab>         its workspace, on that tab
 *   #/results/T1-F                the last finished attempt's results
 */

export type WorkspaceTab = "target" | "map" | "logs" | "guardrails" | "detection" | "retest" | "report";
export const WORKSPACE_TABS: readonly WorkspaceTab[] = ["target", "map", "logs", "guardrails", "detection", "retest", "report"];
export const isWorkspaceTab = (v: unknown): v is WorkspaceTab => WORKSPACE_TABS.includes(v as WorkspaceTab);

export type Route =
  | { view: "entry" | "mission" | "badges" | "learning" }
  | { view: "briefing" | "results"; scenarioId: string }
  | { view: "workspace"; scenarioId: string; tab: WorkspaceTab };

export function parseHash(hash: string): Route | null {
  let parts: string[];
  try {
    parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [head, id, sub] = parts;
  switch (head) {
    case "entry":
    case "mission":
    case "badges":
    case "learning":
      return { view: head };
    case "scenario":
      if (!id) return null;
      if (!sub || sub === "briefing") return { view: "briefing", scenarioId: id };
      return isWorkspaceTab(sub) ? { view: "workspace", scenarioId: id, tab: sub } : null;
    case "results":
      return id ? { view: "results", scenarioId: id } : null;
    default:
      return null;
  }
}

export function hashOf(r: Route): string {
  switch (r.view) {
    case "briefing":
      return `#/scenario/${encodeURIComponent(r.scenarioId)}/briefing`;
    case "workspace":
      return `#/scenario/${encodeURIComponent(r.scenarioId)}/${r.tab}`;
    case "results":
      return `#/results/${encodeURIComponent(r.scenarioId)}`;
    default:
      return `#/${r.view}`;
  }
}
