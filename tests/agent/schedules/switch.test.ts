import type { ScheduleHandlerArgs } from "eve/schedules";
import { describe, expect, it, vi } from "vitest";

const switchState = vi.hoisted(() => ({
  enabled: false,
  expireConversationLines: vi.fn<() => Promise<void>>(),
  recordUntrackedMemories: vi.fn<() => Promise<void>>(),
  trimForgottenMemoryHistory: vi.fn<() => Promise<void>>(),
}));

vi.mock("@agent/lib/schedules/enabled", () => ({
  browserRunsEnabled: () => switchState.enabled,
  schedulesEnabled: () => switchState.enabled,
}));
vi.mock("@db/services/conversation-log", () => ({
  expireConversationLines: switchState.expireConversationLines,
}));
vi.mock("@db/services/memory/records", () => ({
  recordUntrackedMemories: switchState.recordUntrackedMemories,
  trimForgottenMemoryHistory: switchState.trimForgottenMemoryHistory,
}));

import browserRuns from "@agent/schedules/browser-runs";
import browserSignIns from "@agent/schedules/browser-sign-ins";
import dynamic from "@agent/schedules/dynamic";
import memory from "@agent/schedules/memory";
import memoryDigest from "@agent/schedules/memory-digest";
import memoryHistory from "@agent/schedules/memory-history";
import proactive from "@agent/schedules/proactive";

const schedules = {
  browserRuns,
  browserSignIns,
  dynamic,
  memory,
  memoryDigest,
  proactive,
};

function tickArguments() {
  const waitUntil = vi.fn<ScheduleHandlerArgs["waitUntil"]>();
  const attachSession = vi.fn<ScheduleHandlerArgs["attachSession"]>(() => {
    throw new Error("a switched-off tick reached a session");
  });
  const to = vi.fn<ScheduleHandlerArgs["to"]>(() => {
    throw new Error("a switched-off tick addressed a conversation");
  });
  const args: ScheduleHandlerArgs = {
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession,
    to,
    waitUntil,
  };
  return { args, waitUntil };
}

describe("EVE_SCHEDULES=off", () => {
  it.each(Object.entries(schedules))(
    "%s does nothing in its tick",
    async (_name, schedule) => {
      const { args, waitUntil } = tickArguments();
      schedule.run(args);
      expect(waitUntil).not.toHaveBeenCalled();
    }
  );

  // The 14 days of the cross-channel log are a promise to the person, and
  // its only sweep is this tick (`agent/schedules/memory-history.ts`).
  it("memoryHistory only expires the cross-channel log", async () => {
    switchState.expireConversationLines.mockResolvedValue();
    const { args, waitUntil } = tickArguments();
    memoryHistory.run(args);
    await Promise.all(waitUntil.mock.calls.map(([work]) => work));

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(switchState.expireConversationLines).toHaveBeenCalledOnce();
    expect(switchState.trimForgottenMemoryHistory).not.toHaveBeenCalled();
    expect(switchState.recordUntrackedMemories).not.toHaveBeenCalled();
  });
});
