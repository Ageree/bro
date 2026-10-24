import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Cards from "@db/services/cards";
import type { ToolContext } from "eve/tools";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const read = vi.hoisted(() => vi.fn<typeof Cards.readCardOfRun>());
vi.mock("@db/services/cards", () => ({ readCardOfRun: read }));
vi.mock("eve/context", () => ({
  defineState: <T>(_name: string, initial: () => T) => {
    let value = initial();
    return {
      get: () => value,
      update: (change: (current: T) => T) => {
        value = change(value);
      },
    };
  },
}));

import { cardOfReport, openCardReport } from "@agent/lib/cards/report";
import { openedByPersonErrandReport } from "@agent/lib/cards/caller";
import cardEvents from "@agent/instructions/47-card-events";

const caller = (runId: string): ToolContext["session"]["auth"]["current"] => ({
  authenticator: "browser-result",
  attributes: {
    browserRunId: runId,
    errandBy: "bro",
    workspaceId: "workspace:alice",
  },
  principalType: "user",
  principalId: "alice",
});

beforeEach(async () => {
  vi.clearAllMocks();
  await openCardReport(undefined);
});

describe("the report of a card interaction", () => {
  it("offers the same card to a linked run without changing the report's trust", async () => {
    read.mockResolvedValue({ id: "A".repeat(43), ref: "k7m2p9qa" });
    await openCardReport("run-1");
    const auth = caller("run-1");
    expect(cardOfReport(auth)).toEqual({ ref: "k7m2p9qa", runId: "run-1" });
    expect(
      openedByPersonErrandReport(
        [
          {
            role: "user",
            content: `${backgroundTurnMarker}\n\nBrowser run run-1 finished.\n\nFound options.`,
          },
        ],
        auth
      )
    ).toBe(true);
    expect(auth?.authenticator).toBe("browser-result");
    expect(auth?.attributes.errandBy).toBe("bro");
  });

  it("rejects another run, a quoted report, and an unrelated background report", async () => {
    read.mockResolvedValue({ id: "A".repeat(43), ref: "k7m2p9qa" });
    await openCardReport("run-1");
    expect(cardOfReport(caller("run-2"))).toBeUndefined();
    expect(
      openedByPersonErrandReport(
        [{ role: "user", content: `Browser run run-1 finished.` }],
        caller("run-1")
      )
    ).toBe(false);
    read.mockResolvedValue(undefined);
    await openCardReport("run-2");
    expect(cardOfReport(caller("run-2"))).toBeUndefined();
  });

  it("does not change instructions outside the card pilot", async () => {
    expect(
      await cardEvents.events["turn.started"]?.(
        {},
        {
          channel: { kind: "channel:telegram", metadata: {} },
          messages: [],
          model: null,
          session: {
            id: "session-1",
            auth: { current: caller("run-1"), initiator: null },
          },
        }
      )
    ).toBeNull();
  });
});
