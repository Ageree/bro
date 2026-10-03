import { describe, expect, it, vi } from "vitest";

vi.mock("@db/services/scope", () => ({
  readWorkspaceScope: vi.fn<() => Promise<undefined>>(),
}));
vi.mock("@db/services/users", () => ({
  readAccountEmail: vi.fn<() => Promise<undefined>>(),
}));

const { pilotVerdictOfTurn } = await import("@agent/lib/workspace-list");

describe("pilot verdict of a turn", () => {
  it("keeps the verdicts of two sessions apart although eve gives both turn_0", async () => {
    const pilot = await pilotVerdictOfTurn(
      "test-pilot",
      { sessionId: "session-pilot", turnId: "turn_0" },
      () => Promise.resolve(true)
    );
    const other = await pilotVerdictOfTurn(
      "test-pilot",
      { sessionId: "session-other", turnId: "turn_0" },
      () => Promise.resolve(false)
    );
    expect([pilot, other]).toEqual([true, false]);
  });

  it("asks once per turn of a session", async () => {
    const lookup = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));
    const turn = { sessionId: "session-once", turnId: "turn_3" };
    await pilotVerdictOfTurn("test-pilot", turn, lookup);
    await pilotVerdictOfTurn("test-pilot", turn, lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
