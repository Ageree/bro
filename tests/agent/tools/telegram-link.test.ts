import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@shared/environment";
import type {
  mintChannelLinkToken,
  readChannelIdentity,
} from "@db/services/channel-identities";
import { accessScopeForUser } from "@shared/identity/access-scope";

const services = vi.hoisted(() => ({
  // SAFETY: The mocked environment getter returns a bot username or nothing.
  botUsername: "open_instinct_bot" as string | undefined,
  mint: vi.fn<typeof mintChannelLinkToken>(),
  read: vi.fn<typeof readChannelIdentity>(),
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      get TELEGRAM_BOT_USERNAME() {
        return services.botUsername;
      },
    },
  };
});
vi.mock("@db/services/channel-identities", () => ({
  channelLinkTokenLifetimeMs: 30 * 60_000,
  mintChannelLinkToken: services.mint,
  readChannelIdentity: services.read,
}));

import telegramLink, { linkTelegram } from "@agent/tools/telegram_link";

const scope = accessScopeForUser("better-auth:user-1");

describe("link_telegram exposure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.botUsername = "open_instinct_bot";
  });

  it("offers the tool on an interactive non-Telegram turn", async () => {
    const resolve = telegramLink.events["turn.started"];
    expect(resolve).toBeDefined();
    if (!resolve) return;

    const tools = await resolve({}, dynamicContext("test", "channel:photon"));

    expect(tools && !("execute" in tools) ? Object.keys(tools) : []).toEqual([
      "link_telegram",
    ]);
  });

  it("withholds the tool from Telegram and from scheduled turns", async () => {
    const resolve = telegramLink.events["turn.started"];
    expect(resolve).toBeDefined();
    if (!resolve) return;

    expect(
      await resolve({}, dynamicContext("test", "channel:telegram"))
    ).toBeNull();
    expect(
      await resolve({}, dynamicContext("scheduled-worker", "channel:photon"))
    ).toBeNull();
    expect(
      await resolve({}, dynamicContext("scheduled-result", "channel:photon"))
    ).toBeNull();
  });
});

describe("link_telegram execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.botUsername = "open_instinct_bot";
  });

  it("returns a one-time deep link for the signed-in account", async () => {
    services.mint.mockResolvedValue("tok_abc123");
    services.read.mockResolvedValue(undefined);

    await expect(linkTelegram.execute({}, toolContext())).resolves.toEqual({
      connectedUsername: null,
      expiresInMinutes: 30,
      status: "ready",
      url: "https://t.me/open_instinct_bot?start=link_tok_abc123",
    });
    expect(services.mint).toHaveBeenCalledExactlyOnceWith(scope, "telegram");
  });

  it("reports the Telegram account already connected", async () => {
    services.mint.mockResolvedValue("tok_abc123");
    // SAFETY: The tool only reads the username from the stored identity row.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A full row would add columns this tool never reads.
    services.read.mockResolvedValue({ username: "ada" } as never);

    await expect(
      linkTelegram.execute({}, toolContext())
    ).resolves.toMatchObject({ connectedUsername: "ada" });
  });

  it("says Telegram is not configured when the bot username is unset", async () => {
    services.botUsername = undefined;

    await expect(
      linkTelegram.execute({}, toolContext())
    ).resolves.toMatchObject({ status: "not_configured" });
    expect(services.mint).not.toHaveBeenCalled();
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
          authenticator: "telegram-link-test",
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
