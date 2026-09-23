import type { EveChannelInput } from "eve/channels/eve";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { hasConversationHistory } from "@db/services/chats";
import { accessScopeForUser } from "@shared/identity/access-scope";

const capture = vi.hoisted(() => {
  const configs: EveChannelInput[] = [];
  return {
    configs,
    hasConversationHistory: vi.fn<typeof hasConversationHistory>(),
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
vi.mock("@db/services/chats", () => ({
  hasConversationHistory: capture.hasConversationHistory,
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

function messageContext(path = "/eve/v1/session") {
  return {
    eve: {
      caller,
      request: new Request(`https://assistant.example${path}`),
    },
  };
}

describe("Eve first contact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("introduces Bro when the workspace's first message comes from the web", async () => {
    capture.hasConversationHistory.mockResolvedValue(false);

    const result = await onMessage(messageContext(), "привет");

    expect(result.auth).toBe(caller);
    expect(capture.hasConversationHistory).toHaveBeenCalledExactlyOnceWith(
      scope
    );
    expect(result.context?.join("\n")).toContain("`first-contact`");
  });

  // Every new web chat is a new session, which is no reason to meet again.
  it("keeps a new web session of an existing workspace free of the marker", async () => {
    capture.hasConversationHistory.mockResolvedValue(true);

    const result = await onMessage(
      { eve: { ...messageContext().eve, sessionId: "wrun_new" } },
      "привет"
    );

    expect(result.context).toEqual([]);
  });
});
