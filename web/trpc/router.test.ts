import { beforeEach, describe, expect, it, vi } from "vitest";
import * as BroLogins from "@db/services/bro-logins";
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

const revealMock = vi.spyOn(BroLogins, "revealBroLogin");

const scopeKeysMock = vi.spyOn(MemoryRecords, "listMemoryScopeKeys");
const listMemoriesMock = vi.spyOn(MemoryRecords, "listCurrentMemories");
const updateMemoryMock = vi.spyOn(MemoryRecords, "updateMemory");
const restoreMemoryMock = vi.spyOn(MemoryRecords, "restoreMemory");

const scope = {
  userId: "user-1",
  workspaceId: "workspace-1",
} satisfies AccessScope;

/** A profile memory as the cabinet lists it. */
const memory = (category: "fact" | "rule", revision = 2) => ({
  content: {
    aliases: [],
    category,
    localOnly: false,
    relatedIndexes: [],
    text: category === "rule" ? "Не платить без моего ок." : "Живёт в Казани.",
    validUntil: null,
  },
  index: 3,
  revision,
  updatedAt: "2026-10-02T10:00:00.000Z",
});

describe("appRouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads back Bro's own login for its workspace, and nothing else", async () => {
    revealMock.mockImplementation(async (_scope, id) =>
      id === "bro"
        ? { email: "quiet.fox42@agentmail.to", password: "Gen3rated!Pass" }
        : undefined
    );
    const vault = appRouter.createCaller({
      origin: "https://example.com",
      scope,
    }).vault;

    await expect(vault.reveal({ id: "bro" })).resolves.toEqual({
      email: "quiet.fox42@agentmail.to",
      password: "Gen3rated!Pass",
    });
    expect(revealMock).toHaveBeenCalledWith(scope, "bro");
    await expect(vault.reveal({ id: "own" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

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
    beforeEach(() => {
      scopeKeysMock.mockResolvedValue(["other-key", "scope-key"]);
    });

    it("corrects a fact as the person, in the scope Bro reads", async () => {
      listMemoriesMock.mockResolvedValue([memory("fact")]);
      updateMemoryMock.mockResolvedValue({ index: 3, revision: 3 });

      await caller().memory.update({
        expectedRevision: 2,
        index: 3,
        scopeKey: "scope-key",
        text: "Живёт в Самаре.",
      });

      expect(updateMemoryMock).toHaveBeenCalledOnce();
      const [calledScope, scopeKey, update, operation, origin] =
        updateMemoryMock.mock.calls[0] ?? [];
      expect([calledScope, scopeKey, origin]).toEqual([
        scope,
        "scope-key",
        { action: "update", actor: "person" },
      ]);
      expect(operation).toMatch(/^cabinet:/u);
      // The old aliases named what the person corrected away.
      expect(update).toMatchObject({
        content: { aliases: [], category: "fact", text: "Живёт в Самаре." },
        expectedRevision: 2,
      });
    });

    it("never edits a rule: it is changed only in a conversation", async () => {
      listMemoriesMock.mockResolvedValue([memory("rule")]);

      await expect(
        caller().memory.update({
          expectedRevision: 2,
          index: 3,
          scopeKey: "scope-key",
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
          scopeKey: "scope-key",
          text: "Код из смс 482193",
        })
      ).rejects.toThrow("one-time codes");
      await expect(
        caller().memory.update({
          expectedRevision: 2,
          index: 3,
          scopeKey: "scope-key",
          text: "Живёт в Самаре.",
        })
      ).rejects.toThrow("Memory changed");
      expect(updateMemoryMock).not.toHaveBeenCalled();
    });

    it("keeps an unexpected failure internal, its message unseen", async () => {
      restoreMemoryMock.mockRejectedValue(
        new Error(
          'Failed query: update "memory_records" params: Живёт в Казани.'
        )
      );

      await expect(
        caller().memory.restore({
          expectedRevision: 3,
          index: 3,
          revision: 1,
          scopeKey: "scope-key",
        })
      ).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Memory could not be changed.",
      });
      restoreMemoryMock.mockRejectedValue(new Error("Profile memory is full."));
      await expect(
        caller().memory.restore({
          expectedRevision: 3,
          index: 3,
          revision: 1,
          scopeKey: "scope-key",
        })
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Profile memory is full.",
      });
    });

    it("writes only to a scope of this workspace, the one the page showed", async () => {
      restoreMemoryMock.mockResolvedValue({ index: 3, revision: 4 });

      await expect(
        caller().memory.restore({
          expectedRevision: 3,
          index: 3,
          revision: 1,
          scopeKey: "someone-else",
        })
      ).rejects.toThrow("No such memory");
      expect(restoreMemoryMock).not.toHaveBeenCalled();

      await caller().memory.restore({
        expectedRevision: 3,
        index: 3,
        revision: 1,
        scopeKey: "other-key",
      });
      expect(restoreMemoryMock).toHaveBeenCalledWith(
        scope,
        "other-key",
        { expectedRevision: 3, index: 3, revision: 1 },
        expect.stringMatching(/^cabinet:/u)
      );
    });
  });
});
