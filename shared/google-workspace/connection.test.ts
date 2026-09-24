import { beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeComposio, fakeComposio } from "@tests/helpers/composio";
import {
  googleWorkspaceAuthConfigId,
  readGoogleWorkspaceConnection,
  revokeGoogleWorkspaceGrant,
  startGoogleWorkspaceAuthorization,
} from "./connection";

const userId = "better-auth:user-1";

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  composio = fakeComposio();
});

describe("googleWorkspaceAuthConfigId", () => {
  it("connects each level under its own Composio auth config", () => {
    expect(googleWorkspaceAuthConfigId("full")).toBe("ac_google_full");
    expect(googleWorkspaceAuthConfigId("read_only")).toBe(
      "ac_google_read_only"
    );
  });

  it("falls back to the full config for read-only when none is named", async () => {
    vi.resetModules();
    vi.stubEnv("COMPOSIO_GOOGLE_READ_ONLY_AUTH_CONFIG_ID", "");
    const connection = await import("./connection");
    vi.stubEnv(
      "COMPOSIO_GOOGLE_READ_ONLY_AUTH_CONFIG_ID",
      "ac_google_read_only"
    );

    expect(connection.googleWorkspaceAuthConfigId("read_only")).toBe(
      "ac_google_full"
    );
  });

  it("offers no Google without a Composio key", async () => {
    vi.resetModules();
    vi.stubEnv("COMPOSIO_API_KEY", "");
    const connection = await import("./connection");
    vi.stubEnv("COMPOSIO_API_KEY", "test-composio-key");

    expect(connection.googleWorkspaceConfigured()).toBe(false);
    await expect(
      connection.readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toEqual({
      access: "full",
      accountLabel: null,
      state: "unavailable",
    });
  });
});

describe("readGoogleWorkspaceConnection", () => {
  it("reports the person's active account at the level with its address", async () => {
    composio.connect({
      displayName: "ada@example.com",
      toolkit: "googlesuper",
      userId,
    });

    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toEqual({
      access: "full",
      accountLabel: "ada@example.com",
      state: "connected",
    });
    const [list] = composio.requests;
    expect(list?.path).toBe("/connected_accounts");
  });

  it("does not count an account at the other level, of someone else, or unfinished", async () => {
    composio.connect({
      authConfigId: "ac_google_read_only",
      toolkit: "googlesuper",
      userId,
    });
    composio.connect({
      toolkit: "googlesuper",
      userId: "better-auth:someone-else",
    });
    composio.connect({ status: "EXPIRED", toolkit: "googlesuper", userId });

    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toEqual({
      access: "full",
      accountLabel: null,
      state: "disconnected",
    });
  });

  it("reports a Composio outage as a transient error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    composio.fetch.mockResolvedValue(
      Response.json({ error: { message: "down" } }, { status: 502 })
    );

    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toMatchObject({ state: "error" });
    composio.fetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toMatchObject({ state: "error" });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("reports a key or config Composio refuses as unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    composio.fetch.mockResolvedValue(
      Response.json(
        { error: { message: "Invalid API key", slug: "APIKey_InvalidAPIKey" } },
        { status: 401 }
      )
    );

    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toMatchObject({ state: "unavailable" });
    warn.mockRestore();
  });
});

describe("startGoogleWorkspaceAuthorization", () => {
  it("mints a Connect Link at the level after clearing abandoned attempts", async () => {
    const abandoned = composio.connect({
      authConfigId: "ac_google_read_only",
      status: "INITIATED",
      toolkit: "googlesuper",
      userId,
    });
    const active = composio.connect({
      authConfigId: "ac_google_read_only",
      toolkit: "googlesuper",
      userId,
    });

    await expect(
      startGoogleWorkspaceAuthorization(
        userId,
        "read_only",
        "https://example.com/workspace?google=connected"
      )
    ).resolves.toMatch(/^https:\/\/connect\.composio\.dev\/link\//u);

    expect(
      composio.requests.find(({ path }) => path === "/connected_accounts/link")
        ?.body
    ).toEqual({
      auth_config_id: "ac_google_read_only",
      callback_url: "https://example.com/workspace?google=connected",
      user_id: userId,
    });
    const ids = composio.accounts.map(({ id }) => id);
    expect(ids).not.toContain(abandoned.id);
    expect(ids).toContain(active.id);
  });
});

describe("revokeGoogleWorkspaceGrant", () => {
  it("revokes and deletes every Google account the person holds", async () => {
    composio.connect({ id: "ca_full", toolkit: "googlesuper", userId });
    composio.connect({
      authConfigId: "ac_google_read_only",
      id: "ca_read",
      status: "EXPIRED",
      toolkit: "googlesuper",
      userId,
    });
    composio.connect({ id: "ca_notion", toolkit: "notion", userId });
    composio.connect({
      id: "ca_theirs",
      toolkit: "googlesuper",
      userId: "better-auth:someone-else",
    });

    await revokeGoogleWorkspaceGrant(userId);

    expect(composio.accounts.map(({ id }) => id).toSorted()).toEqual([
      "ca_notion",
      "ca_theirs",
    ]);
    // Only a live grant is revoked at Google, and before it is deleted.
    expect(
      composio.requests
        .filter(({ method }) => method !== "GET")
        .map(({ method, path }) => `${method} ${path}`)
        .toSorted()
    ).toEqual([
      "DELETE /connected_accounts/ca_full",
      "DELETE /connected_accounts/ca_read",
      "POST /connected_accounts/ca_full/revoke",
    ]);
  });
});
