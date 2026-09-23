import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { recordProactiveTarget } from "@db/services/proactive";

const record = vi.hoisted(() => vi.fn<typeof recordProactiveTarget>());
vi.mock("@db/services/proactive", () => ({ recordProactiveTarget: record }));

import targetHook from "@agent/hooks/proactive-target";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

describe("proactive target hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    record.mockResolvedValue("created");
  });

  it("remembers the Telegram chat a person talks from", async () => {
    await startTurn("telegram-bot", {
      conversationChannel: "telegram",
      conversationId: "100::",
      workspaceId,
    });

    expect(record).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId },
      { conversationChannel: "telegram", conversationId: "100::" }
    );
  });

  it("ignores the web chat and background turns", async () => {
    await startTurn("eve-web", {
      conversationChannel: "eve",
      conversationId: "session-1",
      workspaceId,
    });
    await startTurn("scheduled-result", {
      conversationChannel: "telegram",
      conversationId: "100::",
      workspaceId,
    });

    expect(record).not.toHaveBeenCalled();
  });

  it("never breaks the person's turn", async () => {
    record.mockRejectedValue(new Error("database is down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      startTurn("photon-imessage", {
        conversationChannel: "photon",
        conversationId: "imessage:chat-1",
        workspaceId,
      })
    ).resolves.toBeUndefined();
  });
});

async function startTurn(
  authenticator: string,
  attributes: Record<string, string>
) {
  const handler = targetHook.events?.["turn.started"];
  const context = {
    agent: { name: "test-agent" },
    channel: { continuationToken: "conversation" },
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes,
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
  } satisfies HookContext;
  // SAFETY: the hook reads no field of the event, only the context.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- An empty event stands in for turn.started.
  await handler?.({} as never, context);
}
