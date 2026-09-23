import type * as ConnectModule from "@vercel/connect";
import type {
  getTokenResponse,
  revokeToken,
  startAuthorization,
} from "@vercel/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@shared/environment";

const connect = vi.hoisted(() => ({
  getTokenResponse: vi.fn<typeof getTokenResponse>(),
  revokeToken: vi.fn<typeof revokeToken>(),
  startAuthorization: vi.fn<typeof startAuthorization>(),
}));

vi.mock("@vercel/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectModule>()),
  getTokenResponse: connect.getTokenResponse,
  revokeToken: connect.revokeToken,
  startAuthorization: connect.startAuthorization,
}));

import {
  ConnectError,
  ConnectorInstallationRequiredError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import {
  googleWorkspaceScopes,
  googleWorkspaceSubject,
  googleWorkspaceTokenParams,
  readGoogleWorkspaceConnection,
  revokeGoogleWorkspaceGrant,
  startGoogleWorkspaceAuthorization,
} from "./connection";

const userId = "better-auth:user-1";

const grantedToken = {
  connector: { id: "cn_1", type: "oauth", uid: env.GOOGLE_CONNECTOR_UID },
  expiresAt: Date.now() + 3_600_000,
  token: "ya29.token",
};

describe("readGoogleWorkspaceConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-validates the grant and labels it with the connector name", async () => {
    connect.getTokenResponse.mockResolvedValue({
      ...grantedToken,
      name: "Ada Lovelace",
    });

    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toEqual({
      access: "full",
      accountLabel: "Ada Lovelace",
      state: "connected",
    });
    expect(connect.getTokenResponse).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(userId, "full"),
      { forceRefresh: true }
    );
  });

  it("reads a read-only grant with read scopes and reports its level", async () => {
    connect.getTokenResponse.mockResolvedValue(grantedToken);

    await expect(
      readGoogleWorkspaceConnection(userId, "read_only")
    ).resolves.toEqual({
      access: "read_only",
      accountLabel: null,
      state: "connected",
    });
    expect(connect.getTokenResponse).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      {
        scopes: [...googleWorkspaceScopes.read_only],
        subject: googleWorkspaceSubject(userId),
      },
      { forceRefresh: true }
    );
  });

  it("falls back to the email claim, then to no label", async () => {
    connect.getTokenResponse.mockResolvedValueOnce({
      ...grantedToken,
      claims: { email: "ada@example.com" },
    });
    connect.getTokenResponse.mockResolvedValueOnce(grantedToken);

    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toEqual({
      access: "full",
      accountLabel: "ada@example.com",
      state: "connected",
    });
    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toEqual({
      access: "full",
      accountLabel: null,
      state: "connected",
    });
  });

  it.each([
    ["authorization required", new UserAuthorizationRequiredError("authorize")],
    ["no valid token", new NoValidTokenError("revoked")],
  ])("reports %s as disconnected", async (_description, error) => {
    connect.getTokenResponse.mockRejectedValue(error);

    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toEqual({
      access: "full",
      accountLabel: null,
      state: "disconnected",
    });
  });

  it.each([
    [
      "a connector that needs installing",
      new ConnectorInstallationRequiredError("install", { status: 400 }),
    ],
    [
      "a connector Vercel Connect does not know",
      new ConnectError("connector not found", {
        code: "connector_not_found",
        status: 404,
      }),
    ],
    ["a failure before the request", new Error("no OIDC token")],
  ])("reports %s as unavailable", async (_description, error) => {
    connect.getTokenResponse.mockRejectedValue(error);

    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toEqual({
      access: "full",
      accountLabel: null,
      state: "unavailable",
    });
  });

  it.each([
    ["an upstream failure", new ConnectError("bad gateway", { status: 502 })],
    ["throttling", new ConnectError("slow down", { status: 429 })],
    ["a network failure", new TypeError("fetch failed")],
  ])("reports %s as a transient error", async (_description, error) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    connect.getTokenResponse.mockRejectedValue(error);

    await expect(
      readGoogleWorkspaceConnection(userId, "full")
    ).resolves.toEqual({
      access: "full",
      accountLabel: null,
      state: "error",
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("startGoogleWorkspaceAuthorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints a ten-minute authorization for the user's subject", async () => {
    connect.startAuthorization.mockResolvedValue({
      request: "req_1",
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
      verifier: "ver_1",
    });

    await expect(
      startGoogleWorkspaceAuthorization(
        userId,
        "read_only",
        "https://example.com/workspace?google=connected"
      )
    ).resolves.toBe("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    expect(connect.startAuthorization).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(userId, "read_only"),
      {
        callbackUrl: "https://example.com/workspace?google=connected",
        expiresInMs: 10 * 60_000,
      }
    );
  });
});

describe("revokeGoogleWorkspaceGrant", () => {
  it("revokes the user's grant whatever its level", async () => {
    connect.revokeToken.mockResolvedValue(undefined);

    await revokeGoogleWorkspaceGrant(userId);

    expect(connect.revokeToken).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      { subject: googleWorkspaceSubject(userId) }
    );
  });
});
