import type { DynamicResolveContext, ToolContext } from "eve/tools";
import type * as ConnectModule from "@vercel/connect";
import type { getTokenResponse, startAuthorization } from "@vercel/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@shared/environment";
import { googleWorkspaceTokenParams } from "@shared/google-workspace/connection";
import { accessScopeForUser } from "@shared/identity/access-scope";

const connect = vi.hoisted(() => ({
  getTokenResponse: vi.fn<typeof getTokenResponse>(),
  startAuthorization: vi.fn<typeof startAuthorization>(),
}));

vi.mock("@vercel/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectModule>()),
  getTokenResponse: connect.getTokenResponse,
  startAuthorization: connect.startAuthorization,
}));

import {
  ConnectError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import googleConnect, { connectGoogle } from "@agent/tools/google_connect";

const scope = accessScopeForUser("better-auth:user-1");

const grantedToken = {
  connector: { id: "cn_1", type: "oauth", uid: env.GOOGLE_CONNECTOR_UID },
  expiresAt: Date.now() + 3_600_000,
  token: "ya29.token",
};

const authorization = {
  request: "req_1",
  url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
  verifier: "ver_1",
};

describe("connect_google exposure", () => {
  it.each(["channel:photon", "channel:telegram"])(
    "offers the tool on an interactive %s turn",
    async (channelKind) => {
      const resolve = googleConnect.events["turn.started"];
      expect(resolve).toBeDefined();
      if (!resolve) return;

      const tools = await resolve({}, dynamicContext("test", channelKind));
      expect(tools && !("execute" in tools) ? Object.keys(tools) : []).toEqual([
        "connect_google",
      ]);
    }
  );

  it("withholds the tool from scheduled turns", async () => {
    const resolve = googleConnect.events["turn.started"];
    expect(resolve).toBeDefined();
    if (!resolve) return;

    expect(
      await resolve({}, dynamicContext("scheduled-worker", "channel:photon"))
    ).toBeNull();
    expect(
      await resolve({}, dynamicContext("scheduled-result", "channel:telegram"))
    ).toBeNull();
  });
});

describe("connect_google execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the connected Google account without minting a link", async () => {
    connect.getTokenResponse.mockResolvedValue({
      ...grantedToken,
      name: "ada@example.com",
    });

    await expect(connectGoogle.execute({}, toolContext())).resolves.toEqual({
      account: "ada@example.com",
      status: "connected",
    });
    expect(connect.getTokenResponse).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(scope.userId),
      { forceRefresh: true }
    );
    expect(connect.startAuthorization).not.toHaveBeenCalled();
  });

  it("mints an authorization link that returns to the workspace page", async () => {
    connect.getTokenResponse.mockRejectedValue(
      new UserAuthorizationRequiredError("authorize first")
    );
    connect.startAuthorization.mockResolvedValue(authorization);

    await expect(connectGoogle.execute({}, toolContext())).resolves.toEqual({
      expiresInMinutes: 10,
      status: "authorize",
      url: authorization.url,
    });
    expect(connect.startAuthorization).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(scope.userId),
      {
        callbackUrl: "https://example.com/workspace?google=connected",
        expiresInMs: 10 * 60_000,
      }
    );
  });

  it("treats a missing token like a revoked grant", async () => {
    connect.getTokenResponse.mockRejectedValue(
      new NoValidTokenError("no token")
    );
    connect.startAuthorization.mockResolvedValue(authorization);

    await expect(
      connectGoogle.execute({}, toolContext())
    ).resolves.toMatchObject({ status: "authorize", url: authorization.url });
  });

  it("says Google is not configured instead of throwing", async () => {
    connect.getTokenResponse.mockRejectedValue(
      new Error("connector google/open-instinct is not attached")
    );

    await expect(connectGoogle.execute({}, toolContext())).resolves.toEqual({
      detail:
        "Google на этом деплое не подключён: нужно прикрепить Google OAuth-коннектор в Vercel.",
      status: "not_configured",
    });
    expect(connect.startAuthorization).not.toHaveBeenCalled();
  });

  it("asks for a retry when Vercel Connect is down instead of calling Google unconfigured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    connect.getTokenResponse.mockRejectedValue(
      new ConnectError("bad gateway", { status: 502 })
    );

    await expect(connectGoogle.execute({}, toolContext())).resolves.toEqual({
      detail: "Google сейчас не отвечает, попробуй через минуту.",
      status: "error",
    });
    expect(connect.startAuthorization).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("asks for a retry when minting the link fails instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    connect.getTokenResponse.mockRejectedValue(
      new UserAuthorizationRequiredError("authorize first")
    );
    connect.startAuthorization.mockRejectedValue(
      new ConnectError("bad gateway", { status: 502 })
    );

    await expect(connectGoogle.execute({}, toolContext())).resolves.toEqual({
      detail: "Google сейчас не отвечает, попробуй через минуту.",
      status: "error",
    });
    expect(connect.startAuthorization).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("requires an authenticated user", async () => {
    await expect(
      connectGoogle.execute(
        {},
        focusedToolContext({
          session: {
            auth: { current: null, initiator: null },
            id: "session-1",
          },
        })
      )
    ).rejects.toThrow("An authenticated user is required to connect Google.");
    expect(connect.getTokenResponse).not.toHaveBeenCalled();
  });
});

function dynamicContext(
  authenticator: string,
  channelKind: string
): DynamicResolveContext {
  return {
    model: null,
    channel: { kind: channelKind, metadata: {} },
    messages: [],
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator,
          principalId: "better-auth:user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  };
}

function toolContext() {
  return focusedToolContext({
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator: "google-connect-test",
          principalId: "better-auth:user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test adapter deliberately accepts a focused structural fixture.
function focusedToolContext(value: unknown): ToolContext {
  // SAFETY: The tool reads only the current session auth.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete tool context would add unrelated runtime handles.
  return value as ToolContext;
}
