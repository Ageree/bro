import { beforeEach, describe, expect, it, vi } from "vitest";
import type { databaseAnswers } from "@db/services/health";

const mocks = vi.hoisted(() => ({
  databaseAnswers: vi.fn<typeof databaseAnswers>(),
}));
vi.mock("@db/services/health", () => mocks);

import { GET } from "@app/api/health/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("the app's health", () => {
  it("is ok while the database answers", async () => {
    mocks.databaseAnswers.mockResolvedValue();
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("is down without naming why when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.databaseAnswers.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.1.9:5432 password=secret")
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"ok":false}');
  });

  it("is down when the database hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.databaseAnswers.mockReturnValue(new Promise(() => undefined));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(3_000);
    const response = await pending;
    expect(response.status).toBe(503);
  });
});
