import type { DynamicResolveContext, ToolContext } from "eve/tools";
import type * as ConnectModule from "@vercel/connect";
import type {
  getTokenResponse,
  revokeToken,
  startAuthorization,
} from "@vercel/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { wakeProactiveWatch } from "@db/services/proactive";
import type {
  getGoogleWorkspaceAccess,
  selectGoogleWorkspaceAccess,
} from "@db/services/settings";
import { env } from "@shared/environment";
import {
  googleWorkspaceDisconnectNotice,
  googleWorkspaceSubject,
  googleWorkspaceTokenParams,
} from "@shared/google-workspace/connection";
import { accessScopeForUser } from "@shared/identity/access-scope";

const connect = vi.hoisted(() => ({
  getTokenResponse: vi.fn<typeof getTokenResponse>(),
  revokeToken: vi.fn<typeof revokeToken>(),
  startAuthorization: vi.fn<typeof startAuthorization>(),
}));

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
  select: vi.fn<typeof selectGoogleWorkspaceAccess>(),
}));

vi.mock("@vercel/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectModule>()),
  getTokenResponse: connect.getTokenResponse,
  revokeToken: connect.revokeToken,
  startAuthorization: connect.startAuthorization,
}));

const proactive = vi.hoisted(() => ({
  wake: vi.fn<typeof wakeProactiveWatch>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
  selectGoogleWorkspaceAccess: settings.select,
}));
vi.mock("@db/services/proactive", () => ({
  wakeProactiveWatch: proactive.wake,
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

const connectInput = { action: "connect" } as const;

describe("connect_google execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.access.mockResolvedValue("full");
    settings.select.mockResolvedValue(undefined);
    proactive.wake.mockResolvedValue(false);
    connect.revokeToken.mockResolvedValue(undefined);
    // The connection read asks Google's tokeninfo whether the grant is offline.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_type: "offline" }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the connected Google account without minting a link", async () => {
    connect.getTokenResponse.mockResolvedValue({
      ...grantedToken,
      name: "ada@example.com",
    });

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
      access: "full",
      account: "ada@example.com",
      status: "connected",
    });
    expect(connect.getTokenResponse).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(scope.userId, "full"),
      { forceRefresh: true }
    );
    expect(connect.startAuthorization).not.toHaveBeenCalled();
    // Bro's own checks, parked on the missing grant, resume right away.
    expect(proactive.wake).toHaveBeenCalledExactlyOnceWith(scope);
  });

  it("mints an authorization link that returns to the workspace page", async () => {
    connect.getTokenResponse.mockRejectedValue(
      new UserAuthorizationRequiredError("authorize first")
    );
    connect.startAuthorization.mockResolvedValue(authorization);

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
      access: "full",
      expiresInMinutes: 10,
      previousGrantRevoked: false,
      status: "authorize",
      url: authorization.url,
    });
    expect(connect.revokeToken).not.toHaveBeenCalled();
    expect(settings.select).not.toHaveBeenCalled();
    expect(connect.startAuthorization).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      {
        ...googleWorkspaceTokenParams(scope.userId, "full"),
        additionalParams: { access_type: "offline" },
      },
      {
        callbackUrl: "https://example.com/workspace?google=connected",
        expiresInMs: 10 * 60_000,
        prompt: "consent",
      }
    );
  });

  it("reports a read-only grant at its level", async () => {
    settings.access.mockResolvedValue("read_only");
    connect.getTokenResponse.mockResolvedValue(grantedToken);

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
      access: "read_only",
      account: null,
      status: "connected",
    });
    expect(connect.getTokenResponse).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(scope.userId, "read_only"),
      { forceRefresh: true }
    );
  });

  it("connects read-only when asked, storing the level before OAuth", async () => {
    connect.getTokenResponse.mockRejectedValue(
      new UserAuthorizationRequiredError("authorize first")
    );
    connect.startAuthorization.mockResolvedValue(authorization);

    await expect(
      connectGoogle.execute(
        { access: "read_only", action: "connect" },
        toolContext()
      )
    ).resolves.toMatchObject({
      access: "read_only",
      previousGrantRevoked: false,
      status: "authorize",
    });
    expect(connect.revokeToken).not.toHaveBeenCalled();
    expect(settings.select).toHaveBeenCalledExactlyOnceWith(scope, "read_only");
    expect(connect.startAuthorization).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      expect.objectContaining(
        googleWorkspaceTokenParams(scope.userId, "read_only")
      ),
      expect.anything()
    );
  });

  it("revokes a full grant before re-authorizing read-only", async () => {
    connect.getTokenResponse.mockResolvedValue(grantedToken);
    connect.startAuthorization.mockResolvedValue(authorization);

    await expect(
      connectGoogle.execute(
        { access: "read_only", action: "connect" },
        toolContext()
      )
    ).resolves.toEqual({
      access: "read_only",
      expiresInMinutes: 10,
      previousGrantRevoked: true,
      status: "authorize",
      url: authorization.url,
    });
    expect(connect.revokeToken).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      { subject: googleWorkspaceSubject(scope.userId) }
    );
    expect(settings.select).toHaveBeenCalledExactlyOnceWith(scope, "read_only");
    expect(connect.revokeToken.mock.invocationCallOrder[0]).toBeLessThan(
      connect.startAuthorization.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("keeps a grant already at the asked level", async () => {
    connect.getTokenResponse.mockResolvedValue(grantedToken);

    await expect(
      connectGoogle.execute(
        { access: "full", action: "connect" },
        toolContext()
      )
    ).resolves.toMatchObject({ access: "full", status: "connected" });
    expect(connect.revokeToken).not.toHaveBeenCalled();
    expect(connect.startAuthorization).not.toHaveBeenCalled();
  });

  it("disconnects by revoking the grant and says what Bro keeps", async () => {
    await expect(
      connectGoogle.execute({ action: "disconnect" }, toolContext())
    ).resolves.toEqual({
      notice: googleWorkspaceDisconnectNotice,
      status: "disconnected",
    });
    expect(connect.revokeToken).toHaveBeenCalledExactlyOnceWith(
      env.GOOGLE_CONNECTOR_UID,
      { subject: googleWorkspaceSubject(scope.userId) }
    );
    expect(connect.getTokenResponse).not.toHaveBeenCalled();
    expect(googleWorkspaceDisconnectNotice).toMatch(/память/u);
    expect(googleWorkspaceDisconnectNotice).toMatch(/заказы/u);
  });

  it("asks before disconnecting or changing the level, not before connecting", async () => {
    const approval = connectGoogle.approval;
    if (approval === undefined) {
      throw new Error("connect_google has no policy.");
    }
    const policy = "request" in approval ? approval.request : approval;
    const context = toolContext();
    const decide = async (toolInput: {
      readonly access?: "full" | "read_only";
      readonly action: "connect" | "disconnect";
    }) => policy({ ...context, approvedTools: new Set(), toolInput });

    expect(await decide({ action: "disconnect" })).toBe("user-approval");
    expect(await decide({ access: "read_only", action: "connect" })).toBe(
      "user-approval"
    );
    expect(await decide({ access: "full", action: "connect" })).toBe(
      "not-applicable"
    );
    expect(await decide({ action: "connect" })).toBe("not-applicable");
    expect(settings.access).toHaveBeenCalledWith(scope);
  });

  it("says Google is disconnected when the old grant is revoked but no link comes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    connect.getTokenResponse.mockResolvedValue(grantedToken);
    connect.startAuthorization.mockRejectedValue(
      new ConnectError("bad gateway", { status: 502 })
    );

    const result = await connectGoogle.execute(
      { access: "read_only", action: "connect" },
      toolContext()
    );

    expect(connect.revokeToken).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "error" });
    expect(result).toHaveProperty(
      "detail",
      expect.stringMatching(/уже отозван.*Google отключён/u)
    );
    warn.mockRestore();
  });

  it("treats a missing token like a revoked grant", async () => {
    connect.getTokenResponse.mockRejectedValue(
      new NoValidTokenError("no token")
    );
    connect.startAuthorization.mockResolvedValue(authorization);

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toMatchObject({ status: "authorize", url: authorization.url });
  });

  it("says Google is not configured instead of throwing", async () => {
    connect.getTokenResponse.mockRejectedValue(
      new Error("connector google/open-instinct is not attached")
    );

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
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

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
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

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
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
        connectInput,
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
