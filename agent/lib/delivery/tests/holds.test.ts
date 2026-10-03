import { describe, expect, it, vi } from "vitest";

// eve's state outside a session: one value per slot.
vi.mock("eve/context", () => ({
  defineState<T>(_name: string, initial: () => T) {
    let value = initial();
    return {
      get: () => value,
      update(next: (current: T) => T) {
        value = next(value);
      },
    };
  },
}));

const { markTurnDelivered, openReportTurn, reportDeliveredInTurn } =
  await import("@agent/lib/delivery/holds");

/** A browser report's turn as a tool sees it. */
function reportSession(runId: string, turnId: string) {
  return {
    auth: {
      current: {
        attributes: { browserRunId: runId, workspaceId: "workspace:alice" },
        authenticator: "browser-result",
        principalId: "alice",
        principalType: "user" as const,
      },
    },
    turn: { id: turnId },
  };
}

describe("a report turn's delivery state", () => {
  it("counts a message only for the turn and the report it went out in", () => {
    const first = reportSession("run-1", "turn_0");
    openReportTurn(first, "run-1", false);
    expect(reportDeliveredInTurn(first, "run-1")).toBe(false);
    markTurnDelivered(first);
    expect(reportDeliveredInTurn(first, "run-1")).toBe(true);

    // A successor run of the session starts again from turn_0; its report
    // is another run's.
    const later = reportSession("run-2", "turn_0");
    expect(reportDeliveredInTurn(later, "run-2")).toBe(false);
    expect(
      reportDeliveredInTurn(reportSession("run-1", "turn_1"), "run-1")
    ).toBe(false);
  });

  it("takes a report delivered before the turn began as told", () => {
    const resumed = reportSession("run-3", "turn_4");
    openReportTurn(resumed, "run-3", true);
    expect(reportDeliveredInTurn(resumed, "run-3")).toBe(true);
  });
});
