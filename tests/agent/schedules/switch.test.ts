import type { ScheduleHandlerArgs } from "eve/schedules";
import { describe, expect, it, vi } from "vitest";

const switchState = vi.hoisted(() => ({ enabled: false }));

vi.mock("@agent/lib/schedules/enabled", () => ({
  schedulesEnabled: () => switchState.enabled,
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
  memoryHistory,
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
});
