import { beforeEach, describe, expect, it, vi } from "vitest";
import type { databaseAnswers } from "@db/services/health";

const mocks = vi.hoisted(() => ({
  databaseAnswers: vi.fn<typeof databaseAnswers>(),
}));
vi.mock("@db/services/health", () => mocks);

async function freshGet() {
  vi.resetModules();
  const route = await import("@app/api/health/route");
  return route.GET;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("the app's health", () => {
  it("is ok while the database answers", async () => {
    const GET = await freshGet();
    mocks.databaseAnswers.mockResolvedValue();
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("is down without naming why when the database fails", async () => {
    const GET = await freshGet();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.databaseAnswers.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.1.9:5432 password=secret")
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"ok":false}');
  });

  it("is down when the database hangs", async () => {
    const GET = await freshGet();
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.databaseAnswers.mockReturnValue(new Promise(() => undefined));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(3_000);
    const response = await pending;
    expect(response.status).toBe(503);
  });

  it("asks the database once for a burst and again after five seconds", async () => {
    const GET = await freshGet();
    vi.useFakeTimers();
    mocks.databaseAnswers.mockResolvedValue();
    const burst = await Promise.all([GET(), GET(), GET()]);
    expect(burst.map((response) => response.status)).toEqual([200, 200, 200]);
    await GET();
    expect(mocks.databaseAnswers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await GET();
    expect(mocks.databaseAnswers).toHaveBeenCalledTimes(2);
  });
});
