import type { DynamicResolveContext } from "eve/instructions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readWorkspaceTimeZone } from "@db/services/user-profile";
import localTime, {
  localTimeInstructions,
} from "@agent/instructions/50-local-time";

const mocks = vi.hoisted(() => ({
  readWorkspaceTimeZone: vi.fn<typeof readWorkspaceTimeZone>(),
}));

vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: mocks.readWorkspaceTimeZone,
}));

const resolve = localTime.events["turn.started"];
if (!resolve) {
  throw new Error("Local time must be resolved at the start of a turn.");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readWorkspaceTimeZone.mockResolvedValue("Asia/Vladivostok");
});

describe("local time context", () => {
  it("dates the turn on the person's own wall clock", () => {
    // Already tomorrow in Vladivostok, still today in Moscow.
    const content = localTimeInstructions(
      new Date("2026-09-18T23:30:00.000Z"),
      "Asia/Vladivostok"
    );

    expect(content).toContain("Asia/Vladivostok");
    expect(content).toContain("19 сентября 2026");
    expect(content).toContain("«сегодня»");
    expect(content).toContain("personal_info__update");
  });

  it("gives Bro's own checks the clock without a profile to write to", () => {
    const content = localTimeInstructions(
      new Date("2026-09-18T23:30:00.000Z"),
      "Asia/Vladivostok",
      false
    );

    expect(content).toContain("19 сентября 2026");
    expect(content).not.toContain("personal_info__update");
  });

  it("reads the zone of the workspace that is talking", async () => {
    const selected = await resolve({}, dynamicContext("photon-imessage"));

    expect(mocks.readWorkspaceTimeZone).toHaveBeenCalledExactlyOnceWith({
      userId: "user-1",
      workspaceId: "personal:workspace",
    });
    expect(selected?.content).toContain("Asia/Vladivostok");
  });

  it("says nothing without an authenticated workspace", async () => {
    const context = dynamicContext("photon-imessage");
    const anonymous = {
      ...context,
      session: {
        ...context.session,
        auth: { current: null, initiator: null },
      },
    } satisfies DynamicResolveContext;

    expect(await resolve({}, anonymous)).toBeNull();
    expect(await resolve({}, dynamicContext("scheduled-result"))).toBeNull();
    expect(mocks.readWorkspaceTimeZone).not.toHaveBeenCalled();
  });
});

function dynamicContext(authenticator: string) {
  return {
    model: null,
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}
