import { describe, it, expect } from "vitest";
import { hashOf, parseHash, WORKSPACE_TABS, type Route } from "./routes";

describe("Hash routes", () => {
  it("round-trips every route shape", () => {
    const routes: Route[] = [
      { view: "mission" },
      { view: "badges" },
      { view: "learning" },
      { view: "entry" },
      { view: "briefing", scenarioId: "T3-I" },
      { view: "results", scenarioId: "T10-E" },
      ...WORKSPACE_TABS.map((tab): Route => ({ view: "workspace", scenarioId: "T1-F", tab })),
    ];
    for (const r of routes) expect(parseHash(hashOf(r))).toEqual(r);
  });

  it("treats an empty, unknown or malformed hash as no route", () => {
    expect(parseHash("")).toBeNull();
    expect(parseHash("#/")).toBeNull();
    expect(parseHash("#/nowhere")).toBeNull();
    expect(parseHash("#/scenario/T1-F/not-a-tab")).toBeNull();
    expect(parseHash("#/results")).toBeNull();
    expect(parseHash("#/scenario/%E0%A4%A")).toBeNull();
  });

  it("a scenario link with no section opens its briefing", () => {
    expect(parseHash("#/scenario/T2-E")).toEqual({ view: "briefing", scenarioId: "T2-E" });
  });
});
