import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Chats from "@db/services/chats";
import type { AccessScope } from "@shared/identity/access-scope";
import { appRouter } from "./router";

const saveChatMock = vi.spyOn(Chats, "saveChat");

const scope = {
  userId: "user-1",
  workspaceId: "workspace-1",
} satisfies AccessScope;

describe("appRouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the authenticated scope to a chat write", async () => {
    saveChatMock.mockResolvedValue(undefined);

    await appRouter
      .createCaller({ origin: "https://example.com", scope })
      .chats.save({ sessionId: "session-1" });

    expect(saveChatMock).toHaveBeenCalledWith(scope, {
      sessionId: "session-1",
    });
  });

  it("rejects invalid chat writes before persistence", async () => {
    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .chats.save({ sessionId: "" })
    ).rejects.toThrow("Too small");
    expect(saveChatMock).not.toHaveBeenCalled();
  });
});
