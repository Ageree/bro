import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Chats from "@db/services/chats";
import * as MemoryRecords from "@db/services/memory/records";
import * as Settings from "@db/services/settings";
import * as ConnectedApps from "@shared/composio/connected-apps";
import * as GoogleWorkspace from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";
import { appRouter } from "./router";

const saveChatMock = vi.spyOn(Chats, "saveChat");
const selectModelMock = vi.spyOn(Settings, "selectWorkspaceModel");
const googleAccessMock = vi.spyOn(Settings, "getGoogleWorkspaceAccess");
const selectGoogleAccessMock = vi.spyOn(
  Settings,
  "selectGoogleWorkspaceAccess"
);
const readGoogleMock = vi.spyOn(
  GoogleWorkspace,
  "readGoogleWorkspaceConnection"
);
const startGoogleMock = vi.spyOn(
  GoogleWorkspace,
  "startGoogleWorkspaceAuthorization"
);
const revokeGoogleMock = vi.spyOn(
  GoogleWorkspace,
  "revokeGoogleWorkspaceGrant"
);

const readAppMock = vi.spyOn(ConnectedApps, "readConnectedApp");
const startAppMock = vi.spyOn(ConnectedApps, "startConnectedAppAuthorization");
const disconnectAppMock = vi.spyOn(ConnectedApps, "disconnectConnectedApp");

const cabinetScopeMock = vi.spyOn(MemoryRecords, "readCabinetMemoryScopeKey");
const listMemoriesMock = vi.spyOn(MemoryRecords, "listCurrentMemories");
const updateMemoryMock = vi.spyOn(MemoryRecords, "updateMemory");
const restoreMemoryMock = vi.spyOn(MemoryRecords, "restoreMemory");

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

  it("starts Google OAuth at the chosen level when no grant exists", async () => {
    googleAccessMock.mockResolvedValue("full");
    readGoogleMock.mockResolvedValue({
      access: "full",
      accountLabel: null,
      state: "disconnected",
    });
    selectGoogleAccessMock.mockResolvedValue(undefined);
    startGoogleMock.mockResolvedValue("https://accounts.google.com/auth");

    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .googleWorkspace.update({ access: "read_only", action: "connect" })
    ).resolves.toEqual({ redirectTo: "https://accounts.google.com/auth" });
    expect(selectGoogleAccessMock).toHaveBeenCalledExactlyOnceWith(
      scope,
      "read_only"
    );
    expect(startGoogleMock).toHaveBeenCalledExactlyOnceWith(
      scope.userId,
      "read_only",
      "https://example.com/workspace?google=connected"
    );
  });

  it("refuses to start Google OAuth over a live grant", async () => {
    googleAccessMock.mockResolvedValue("full");
    readGoogleMock.mockResolvedValue({
      access: "full",
      accountLabel: "ada@example.com",
      state: "connected",
    });

    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .googleWorkspace.update({ access: "read_only", action: "connect" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(selectGoogleAccessMock).not.toHaveBeenCalled();
    expect(startGoogleMock).not.toHaveBeenCalled();
  });

  it("revokes the Google grant on disconnect", async () => {
    revokeGoogleMock.mockResolvedValue(undefined);

    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .googleWorkspace.update({ action: "disconnect" })
    ).resolves.toEqual({ redirectTo: "/workspace?google=disconnected" });
    expect(revokeGoogleMock).toHaveBeenCalledExactlyOnceWith(scope.userId);
  });

  it("starts connecting Notion when no account exists", async () => {
    readAppMock.mockResolvedValue({
      accountLabel: null,
      state: "disconnected",
    });
    startAppMock.mockResolvedValue("https://connect.composio.dev/link/lk_1");

    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .connectedApps.update({ action: "connect", app: "notion" })
    ).resolves.toEqual({
      redirectTo: "https://connect.composio.dev/link/lk_1",
    });
    expect(startAppMock).toHaveBeenCalledExactlyOnceWith(
      "notion",
      scope.userId,
      "https://example.com/workspace?app=notion"
    );
  });

  it("refuses to connect an app over a live account", async () => {
    readAppMock.mockResolvedValue({ accountLabel: "Ada", state: "connected" });

    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .connectedApps.update({ action: "connect", app: "slack" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(startAppMock).not.toHaveBeenCalled();
  });

  it("disconnects an app for the signed-in person", async () => {
    disconnectAppMock.mockResolvedValue(undefined);

    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        .connectedApps.update({ action: "disconnect", app: "slack" })
    ).resolves.toEqual({ redirectTo: "/workspace" });
    expect(disconnectAppMock).toHaveBeenCalledExactlyOnceWith(
      "slack",
      scope.userId
    );
  });

  it("offers only the cabinet's apps", async () => {
    await expect(
      appRouter
        .createCaller({ origin: "https://example.com", scope })
        // @ts-expect-error -- Todoist connects in chat, not from the cabinet.
        .connectedApps.update({ action: "connect", app: "todoist" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  describe("memory in the cabinet", () => {
    const caller = () =>
      appRouter.createCaller({ origin: "https://example.com", scope });
    const memory = (category: "fact" | "rule", revision = 2) => ({
      content: {
        aliases: [],
        category,
        localOnly: false,
        relatedIndexes: [],
        text:
          category === "rule" ? "Не платить без моего ок." : "Живёт в Казани.",
        validUntil: null,
      },
      index: 3,
      revision,
      updatedAt: "2026-10-02T10:00:00.000Z",
    });

    beforeEach(() => {
      cabinetScopeMock.mockResolvedValue("scope-key");
    });

    it("corrects a fact as the person, in the scope Bro reads", async () => {
      listMemoriesMock.mockResolvedValue([memory("fact")]);
      updateMemoryMock.mockResolvedValue({ index: 3, revision: 3 });

      await caller().memory.update({
        expectedRevision: 2,
        index: 3,
        text: "Живёт в Самаре.",
      });

      expect(updateMemoryMock).toHaveBeenCalledWith(
        scope,
        "scope-key",
        expect.objectContaining({
          content: expect.objectContaining({
            category: "fact",
            text: "Живёт в Самаре.",
          }),
          expectedRevision: 2,
        }),
        expect.stringMatching(/^cabinet:/u),
        { action: "update", actor: "person" }
      );
    });

    it("never edits a rule: it is changed only in a conversation", async () => {
      listMemoriesMock.mockResolvedValue([memory("rule")]);

      await expect(
        caller().memory.update({
          expectedRevision: 2,
          index: 3,
          text: "Платить без ок.",
        })
      ).rejects.toThrow("only in a conversation");
      expect(updateMemoryMock).not.toHaveBeenCalled();
    });

    it("refuses a one-time code and a stale page", async () => {
      listMemoriesMock.mockResolvedValue([memory("fact", 5)]);

      await expect(
        caller().memory.update({
          expectedRevision: 5,
          index: 3,
          text: "Код из смс 482193",
        })
      ).rejects.toThrow();
      await expect(
        caller().memory.update({
          expectedRevision: 2,
          index: 3,
          text: "Живёт в Самаре.",
        })
      ).rejects.toThrow("Memory changed");
      expect(updateMemoryMock).not.toHaveBeenCalled();
    });

    it("has nothing to change before the first conversation", async () => {
      cabinetScopeMock.mockResolvedValue(null);

      await expect(
        caller().memory.restore({ index: 3, revision: 1 })
      ).rejects.toThrow("No memory yet");
      expect(restoreMemoryMock).not.toHaveBeenCalled();
    });
  });
});
