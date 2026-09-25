import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { wakeProactiveWatch } from "@db/services/proactive";
import type {
  getGoogleWorkspaceAccess,
  selectGoogleWorkspaceAccess,
} from "@db/services/settings";
import { googleWorkspaceDisconnectNotice } from "@shared/google-workspace/connection";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { type FakeComposio, fakeComposio } from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
  select: vi.fn<typeof selectGoogleWorkspaceAccess>(),
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

import googleConnect, {
  connectGoogle,
  googleAccessAbilities,
} from "@agent/tools/google_connect";

const scope = accessScopeForUser("better-auth:user-1");

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

let composio: FakeComposio;

/** Link requests the fake Composio received, oldest first. */
function linkRequests() {
  return composio.requests
    .filter(({ path }) => path === "/connected_accounts/link")
    .map(({ body }) => body);
}

function revokes() {
  return composio.requests.filter(({ path }) => path.endsWith("/revoke"));
}

/** Makes the fake Composio fail every Connect Link request with a 502. */
function failLinks() {
  const route = composio.fetch.getMockImplementation();
  composio.fetch.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith("/connected_accounts/link")) {
      return Response.json({ error: { message: "down" } }, { status: 502 });
    }
    if (!route) throw new Error("The fake Composio has no route.");
    return route(input, init);
  });
}

describe("connect_google execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    composio = fakeComposio();
    settings.access.mockResolvedValue("full");
    settings.select.mockResolvedValue(undefined);
    proactive.wake.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the connected Google account without minting a link", async () => {
    composio.connect({
      displayName: "ada@example.com",
      toolkit: "googlesuper",
    });

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
      abilities: googleAccessAbilities.full,
      access: "full",
      account: "ada@example.com",
      status: "connected",
    });
    expect(linkRequests()).toEqual([]);
    // Bro's own checks, parked on the missing grant, resume right away.
    expect(proactive.wake).toHaveBeenCalledExactlyOnceWith(scope);
  });

  it("mints an authorization link that returns to the workspace page", async () => {
    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
      abilities: googleAccessAbilities.full,
      access: "full",
      expiresInMinutes: 10,
      previousGrantRevoked: false,
      status: "authorize",
      url: "https://connect.composio.dev/link/lk_1",
    });
    expect(revokes()).toEqual([]);
    expect(settings.select).not.toHaveBeenCalled();
    expect(linkRequests()).toEqual([
      {
        auth_config_id: "ac_google_full",
        callback_url: "https://example.com/workspace?google=connected",
        user_id: scope.userId,
      },
    ]);
  });

  it("reports a read-only account at its level", async () => {
    settings.access.mockResolvedValue("read_only");
    composio.connect({
      authConfigId: "ac_google_read_only",
      toolkit: "googlesuper",
    });

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
      abilities: googleAccessAbilities.read_only,
      access: "read_only",
      account: null,
      status: "connected",
    });
  });

  it("connects read-only when asked, storing the level before the link", async () => {
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
    expect(revokes()).toEqual([]);
    expect(settings.select).toHaveBeenCalledExactlyOnceWith(scope, "read_only");
    expect(linkRequests()).toEqual([
      expect.objectContaining({ auth_config_id: "ac_google_read_only" }),
    ]);
  });

  it("revokes a full account before connecting read-only", async () => {
    composio.connect({ id: "ca_full", toolkit: "googlesuper" });

    await expect(
      connectGoogle.execute(
        { access: "read_only", action: "connect" },
        toolContext()
      )
    ).resolves.toMatchObject({
      access: "read_only",
      previousGrantRevoked: true,
      status: "authorize",
    });
    expect(settings.select).toHaveBeenCalledExactlyOnceWith(scope, "read_only");
    const writes = composio.requests
      .filter(({ method }) => method !== "GET")
      .map(({ method, path }) => `${method} ${path}`);
    expect(writes).toEqual([
      "POST /connected_accounts/ca_full/revoke",
      "DELETE /connected_accounts/ca_full",
      "POST /connected_accounts/link",
    ]);
  });

  it("keeps an account already at the asked level", async () => {
    composio.connect({ toolkit: "googlesuper" });

    await expect(
      connectGoogle.execute(
        { access: "full", action: "connect" },
        toolContext()
      )
    ).resolves.toMatchObject({ access: "full", status: "connected" });
    expect(revokes()).toEqual([]);
    expect(linkRequests()).toEqual([]);
  });

  it("reports the account, level and abilities on a status read", async () => {
    composio.connect({
      displayName: "ada@example.com",
      toolkit: "googlesuper",
    });

    await expect(
      connectGoogle.execute({ action: "status" }, toolContext())
    ).resolves.toEqual({
      abilities: googleAccessAbilities.full,
      access: "full",
      account: "ada@example.com",
      status: "connected",
    });
    expect(linkRequests()).toEqual([]);
    // Read-only is Bro's own rule, said as such, whatever Google showed.
    expect(googleAccessAbilities.read_only).toContain("держит сам Бро");
    expect(googleAccessAbilities.full).toContain("карточки подтверждения");
  });

  it("says Google is not connected on a status read without minting a link or changing the level", async () => {
    settings.access.mockResolvedValue("read_only");

    const result = await connectGoogle.execute(
      { access: "full", action: "status" },
      toolContext()
    );

    expect(result).toMatchObject({
      access: "read_only",
      status: "not_connected",
    });
    expect(result).toHaveProperty(
      "detail",
      expect.stringMatching(/Google не подключён/u)
    );
    expect(linkRequests()).toEqual([]);
    expect(revokes()).toEqual([]);
    expect(settings.select).not.toHaveBeenCalled();
  });

  it("disconnects by revoking the account and says what Bro keeps", async () => {
    composio.connect({ id: "ca_full", toolkit: "googlesuper" });

    await expect(
      connectGoogle.execute({ action: "disconnect" }, toolContext())
    ).resolves.toEqual({
      notice: googleWorkspaceDisconnectNotice,
      status: "disconnected",
    });
    expect(composio.accounts).toEqual([]);
    expect(revokes()).toHaveLength(1);
    expect(googleWorkspaceDisconnectNotice).toMatch(/память/u);
    expect(googleWorkspaceDisconnectNotice).toMatch(/заказы/u);
    // What was deleted, what stays and where it is stored (RU d14, EN D9).
    expect(googleWorkspaceDisconnectNotice).toMatch(/удаляет ключ доступа/u);
    expect(googleWorkspaceDisconnectNotice).toMatch(/Neon/u);
    expect(googleWorkspaceDisconnectNotice).toMatch(/стирается по просьбе/u);
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
      readonly action: "connect" | "disconnect" | "status";
    }) => policy({ ...context, approvedTools: new Set(), toolInput });

    expect(await decide({ action: "disconnect" })).toBe("user-approval");
    expect(await decide({ access: "read_only", action: "connect" })).toBe(
      "user-approval"
    );
    expect(await decide({ access: "full", action: "connect" })).toBe(
      "not-applicable"
    );
    expect(await decide({ action: "connect" })).toBe("not-applicable");
    expect(await decide({ access: "read_only", action: "status" })).toBe(
      "not-applicable"
    );
    expect(settings.access).toHaveBeenCalledWith(scope);
  });

  it("says Google is disconnected when the old account is revoked but no link comes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    composio.connect({ toolkit: "googlesuper" });
    failLinks();

    const result = await connectGoogle.execute(
      { access: "read_only", action: "connect" },
      toolContext()
    );

    expect(revokes()).toHaveLength(1);
    expect(result).toMatchObject({ status: "error" });
    expect(result).toHaveProperty(
      "detail",
      expect.stringMatching(/уже отозван.*Google отключён/u)
    );
  });

  it("says Google is not configured when Composio refuses the setup", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    composio.fetch.mockResolvedValue(
      Response.json(
        { error: { message: "Invalid API key", slug: "APIKey_InvalidAPIKey" } },
        { status: 401 }
      )
    );

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
      detail:
        "Google на этом деплое не настроен: Composio не принял настройки подключения Google.",
      status: "not_configured",
    });
  });

  it("asks for a retry when Composio is down instead of calling Google unconfigured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    composio.fetch.mockResolvedValue(
      Response.json({ error: { message: "down" } }, { status: 502 })
    );

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
      detail: "Google сейчас не отвечает, попробуй через минуту.",
      status: "error",
    });
    expect(linkRequests()).toEqual([]);
  });

  it("asks for a retry when minting the link fails instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    failLinks();

    await expect(
      connectGoogle.execute(connectInput, toolContext())
    ).resolves.toEqual({
      detail: "Google сейчас не отвечает, попробуй через минуту.",
      status: "error",
    });
    expect(warn).toHaveBeenCalledOnce();
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
    expect(composio.requests).toEqual([]);
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
