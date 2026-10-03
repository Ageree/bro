import type { ScheduleHandlerArgs } from "eve/schedules";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { expireConversationLines } from "@db/services/conversation-log";
import type {
  recordUntrackedMemories,
  trimForgottenMemoryHistory,
} from "@db/services/memory/records";

const passes = vi.hoisted(() => ({
  schedulesEnabled: vi.fn<() => boolean>(),
  expireConversationLines: vi.fn<typeof expireConversationLines>(),
  recordUntrackedMemories: vi.fn<typeof recordUntrackedMemories>(),
  trimForgottenMemoryHistory: vi.fn<typeof trimForgottenMemoryHistory>(),
}));

vi.mock("@agent/lib/schedules/enabled", () => ({
  schedulesEnabled: passes.schedulesEnabled,
}));
vi.mock("@db/services/conversation-log", () => ({
  expireConversationLines: passes.expireConversationLines,
}));
vi.mock("@db/services/memory/records", () => ({
  recordUntrackedMemories: passes.recordUntrackedMemories,
  trimForgottenMemoryHistory: passes.trimForgottenMemoryHistory,
}));

import memoryHistory from "@agent/schedules/memory-history";

/** One hourly tick, and the work it handed to `waitUntil`. */
async function tick() {
  const work: Promise<unknown>[] = [];
  const args: ScheduleHandlerArgs = {
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession: vi.fn<ScheduleHandlerArgs["attachSession"]>(),
    to: vi.fn<ScheduleHandlerArgs["to"]>(),
    waitUntil: (promise) => {
      work.push(promise);
    },
  };
  memoryHistory.run(args);
  await Promise.all(work);
}

beforeEach(() => {
  vi.clearAllMocks();
  passes.schedulesEnabled.mockReturnValue(true);
  passes.expireConversationLines.mockResolvedValue();
  passes.recordUntrackedMemories.mockResolvedValue();
  passes.trimForgottenMemoryHistory.mockResolvedValue();
});

// Review of item 28: the log of a workspace that stopped writing, or left
// the pilot, still goes after 14 days.
describe("the hourly memory-history tick", () => {
  it("expires the cross-channel log whatever the pilot", async () => {
    await tick();

    expect(passes.expireConversationLines).toHaveBeenCalledOnce();
  });

  // Review of item 28: the 14 days hold on a deployment with
  // EVE_SCHEDULES=off as well, now that no logged line sweeps them.
  it("expires the log with schedules off, and leaves memory history alone", async () => {
    passes.schedulesEnabled.mockReturnValue(false);

    await tick();

    expect(passes.expireConversationLines).toHaveBeenCalledOnce();
    expect(passes.trimForgottenMemoryHistory).not.toHaveBeenCalled();
    expect(passes.recordUntrackedMemories).not.toHaveBeenCalled();
  });

  it("expires the log even when a memory pass failed", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    passes.recordUntrackedMemories.mockRejectedValue(new Error("db down"));

    await tick();

    expect(passes.expireConversationLines).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});
