import type { EveChannelInput } from "eve/channels/eve";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConversationLog from "@db/services/conversation-log";
import type * as ScopeService from "@db/services/scope";
import { accessScopeForUser } from "@shared/identity/access-scope";

const capture = vi.hoisted(() => {
  // Before the channel reads its environment: the pilot names everyone.
  vi.stubEnv("CROSS_CHANNEL_WORKSPACES", "*");
  const configs: EveChannelInput[] = [];
  return {
    claimIntroduction: vi.fn<typeof ScopeService.claimWorkspaceIntroduction>(),
    configs,
    lastLine: vi.fn<typeof ConversationLog.lastLineOfConversation>(),
    recapLines: vi.fn<typeof ConversationLog.readRecapLines>(),
  };
});

vi.mock(import("eve/channels/eve"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    eveChannel(config: EveChannelInput) {
      capture.configs.push(config);
      return original.eveChannel(config);
    },
  };
});
vi.mock("@db/services/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof ScopeService>()),
  claimWorkspaceIntroduction: capture.claimIntroduction,
}));
vi.mock("@db/services/conversation-log", () => ({
  lastLineOfConversation: capture.lastLine,
  readRecapLines: capture.recapLines,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: async () => "Europe/Moscow",
}));

// Loads the production channel so the mocked factory captures its configuration.
await import("@agent/channels/eve");

const onMessage = capture.configs[0]?.onMessage;
if (!onMessage) {
  throw new Error("The Eve channel must prepare inbound web messages.");
}

const scope = accessScopeForUser("better-auth:user-1");
const caller = {
  attributes: {
    conversationChannel: "eve",
    phoneNumber: "+12025550123",
    workspaceId: scope.workspaceId,
  },
  authenticator: "authjs",
  principalId: scope.userId,
  principalType: "user",
} as const;

function messageContext() {
  return {
    eve: {
      caller,
      request: new Request("https://assistant.example/eve/v1/session"),
    },
  };
}

/** A message to a web chat that has a session already. */
function sessionMessageContext(sessionId: string) {
  return { eve: { ...messageContext().eve, sessionId } };
}

describe("a web message in the cross-channel pilot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capture.claimIntroduction.mockResolvedValue(false);
    capture.lastLine.mockResolvedValue(undefined);
    capture.recapLines.mockResolvedValue([]);
  });

  it("carries what the person said in Telegram since this chat last spoke", async () => {
    capture.recapLines.mockResolvedValue([
      {
        channel: "channel:telegram",
        createdAt: new Date("2026-09-29T11:05:00.000Z"),
        text: "Напомни купить билеты в Казань",
      },
    ]);

    const result = await onMessage(sessionMessageContext("wrun_web"), "привет");

    expect(capture.lastLine).toHaveBeenCalledWith(scope.workspaceId, {
      sessionId: "wrun_web",
    });
    expect(capture.recapLines).toHaveBeenCalledWith(
      scope.workspaceId,
      expect.objectContaining({ excludeChannel: "channel:eve" })
    );
    expect(result.context).toHaveLength(1);
    expect(result.context?.[0]).toContain(
      "[Telegram, вт 29.09 14:05] Person: Напомни купить билеты в Казань"
    );
  });

  it("keeps the first-contact marker first", async () => {
    capture.claimIntroduction.mockResolvedValue(true);
    capture.recapLines.mockResolvedValue([
      {
        channel: "channel:photon",
        createdAt: new Date("2026-09-29T11:05:00.000Z"),
        text: "Привет!",
      },
    ]);

    const result = await onMessage(messageContext(), "привет");

    expect(result.context).toHaveLength(2);
    expect(result.context?.[0]).toContain("`first-contact`");
    expect(result.context?.[1]).toContain(
      "[iMessage, вт 29.09 14:05] Person: Привет!"
    );
  });

  it("adds nothing when nothing was said elsewhere", async () => {
    const result = await onMessage(sessionMessageContext("wrun_web"), "привет");

    expect(result.context).toEqual([]);
  });
});
