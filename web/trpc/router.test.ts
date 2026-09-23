import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Chats from "@db/services/chats";
import * as BrowserAutonomy from "@db/services/browser-autonomy";
import * as Settings from "@db/services/settings";
import {
  broadBrowserAutonomyPolicy,
  defaultBrowserAutonomyPolicy,
} from "@shared/browser/autonomy";
import type { AccessScope } from "@shared/identity/access-scope";
import { appRouter } from "./router";

const saveChatMock = vi.spyOn(Chats, "saveChat");
const setBrowserAutonomyPolicyMock = vi.spyOn(
  BrowserAutonomy,
  "setBrowserAutonomyPolicy"
);
const selectModelMock = vi.spyOn(Settings, "selectWorkspaceModel");

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

  it("stores a model id from either routing mode", async () => {
    selectModelMock.mockResolvedValue(undefined);

    await appRouter
      .createCaller({ origin: "https://example.com", scope })
      .settings.selectModel({ modelId: " deepseek/deepseek-v4.1-flash " });

    expect(selectModelMock).toHaveBeenCalledExactlyOnceWith(
      scope,
      "deepseek/deepseek-v4.1-flash"
    );
  });

  it.each([
    [true, broadBrowserAutonomyPolicy],
    [false, defaultBrowserAutonomyPolicy],
  ])("derives browser autonomy policy from broad=%s", async (broad, policy) => {
    setBrowserAutonomyPolicyMock.mockResolvedValue(undefined);

    await appRouter
      .createCaller({ origin: "https://example.com", scope })
      .settings.setBrowserAutonomy({ broad });

    expect(setBrowserAutonomyPolicyMock).toHaveBeenCalledExactlyOnceWith(
      scope,
      policy
    );
  });

  it("rejects model-shaped browser autonomy policy input", async () => {
    const leakedPolicyInput = {
      broad: true,
      grants: ["purchase"],
    };
    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .settings.setBrowserAutonomy(leakedPolicyInput)
    ).rejects.toThrow(/Unrecognized key/);
    expect(setBrowserAutonomyPolicyMock).not.toHaveBeenCalled();
  });

  it("rejects a model id that names no provider", async () => {
    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .settings.selectModel({ modelId: "deepseek-v4.1-flash" })
    ).rejects.toThrow("Use a provider/model id.");
    expect(selectModelMock).not.toHaveBeenCalled();
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
