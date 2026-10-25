/* BIZ-08 through the app's reducer: discarding (or replacing) an attempt that ran re-tests keeps them on record. */
import { describe, it, expect } from "vitest";
import { reducer, type AppState } from "./store";
import { emptyProgress } from "@/engine/progress";

const start = (): AppState => ({
  progress: emptyProgress("Tester"),
  view: "mission",
  activeScenarioId: null,
  attempt: null,
  result: null,
  toasts: [],
  tab: "target",
  confirmExit: false,
});
/** Open a scenario, start it and run `n` re-tests (none can pass: nothing is fixed yet). */
function probe(s: AppState, id: string, n: number): AppState {
  s = reducer(s, { t: "openScenario", scenarioId: id });
  s = reducer(s, { t: "startScenario" });
  for (let i = 0; i < n; i++) s = reducer(s, { t: "runRetest" });
  return s;
}

describe("discarding an attempt", () => {
  it("records an attempt that ran re-tests, and the next attempt starts with them", () => {
    let s = probe(start(), "T1-F", 3);
    expect(s.attempt?.state.retests).toBe(3);
    s = reducer(s, { t: "discardAttempt" });
    expect(s.attempt).toBeNull();
    expect(s.progress?.results["T1-F"]).toMatchObject({ attempts: 1, discarded: 1, carriedRetests: 3, passed: false });
    s = reducer(s, { t: "openScenario", scenarioId: "T1-F" });
    expect(s.attempt?.state.carriedRetests).toBe(3);
    expect(s.attempt?.attemptNo).toBe(2);
  });

  it("does not record an attempt that never ran a re-test", () => {
    let s = probe(start(), "T1-F", 0);
    s = reducer(s, { t: "discardAttempt" });
    expect(s.progress?.results["T1-F"]).toBeUndefined();
  });

  it("starting another scenario over an attempt with re-tests records it the same way", () => {
    let s = probe(start(), "T1-F", 2);
    s = reducer(s, { t: "openScenario", scenarioId: "T2-F" });
    expect(s.attempt?.scenario.id).toBe("T2-F");
    expect(s.progress?.results["T1-F"]).toMatchObject({ attempts: 1, carriedRetests: 2 });
  });

  it("finishing anyway after failed re-tests adds nothing to the total", () => {
    let s = probe(start(), "T1-F", 1);
    s = reducer(s, { t: "finalise" });
    expect(s.result?.score.passed).toBe(false);
    expect(s.progress?.results["T1-F"]).toMatchObject({ attempts: 1, passed: false, bestPassedScore: 0, carriedRetests: 0 });
  });
});
