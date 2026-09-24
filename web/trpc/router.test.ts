import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Chats from "@db/services/chats";
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
});
