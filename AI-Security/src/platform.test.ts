/* Inside ThreatReady: one short retry when /labs/api/me answers 429/503, never a long wait on the boot screen. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: (h: string) => headers[h] ?? null }, json: async () => body }) as unknown as Response;

async function boot() {
  vi.resetModules();
  return import("./platform");
}

beforeEach(() => {
  vi.stubEnv("BASE_URL", "/labs/aisec/");
  vi.stubGlobal("window", { location: { origin: "http://tr.test" } });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("platformUser", () => {
  it("retries once after a short Retry-After and then confirms the user", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply(429, {}, { "Retry-After": "2" })).mockResolvedValueOnce(reply(200, { id: "u1", name: "Ada" }));
    vi.stubGlobal("fetch", fetch);
    const p = await boot();
    const told: number[] = [];
    const user = p.platformUser((s) => told.push(s));
    await vi.advanceTimersByTimeAsync(2000);
    expect((await user)?.id).toBe("u1");
    expect(told).toEqual([2]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(p.platformIdentityProblem()).toBeNull();
  });

  it("gives up at once on a long Retry-After and says when to try again", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(503, {}, { "Retry-After": "45" }));
    vi.stubGlobal("fetch", fetch);
    const p = await boot();
    expect(await p.platformUser()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(p.platformIdentityProblem()).toBe("unavailable");
    expect(p.platformRetryAfter()).toBe(45);
  });

  it("a second 429 gives up as unavailable; 401 is signed out without a retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(429)));
    let p = await boot();
    const u = p.platformUser();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await u).toBeNull();
    expect(p.platformIdentityProblem()).toBe("unavailable");
    const f401 = vi.fn().mockResolvedValue(reply(401));
    vi.stubGlobal("fetch", f401);
    p = await boot();
    expect(await p.platformUser()).toBeNull();
    expect(p.platformIdentityProblem()).toBe("signed-out");
    expect(f401).toHaveBeenCalledTimes(1);
  });
});

describe("waitText", () => {
  it('words the wait for people: 1 second, not "1 seconds"', async () => {
    const { waitText } = await boot();
    expect([1, 0, 30, 89, 90, 600].map(waitText)).toEqual(["1 second", "1 second", "30 seconds", "89 seconds", "2 minutes", "10 minutes"]);
  });
});
