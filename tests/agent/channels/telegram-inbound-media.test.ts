import type {
  TelegramChannelConfig,
  TelegramContext,
  TelegramMessage,
} from "eve/channels/telegram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@shared/environment";
import type {
  findChannelIdentity,
  redeemChannelLinkToken,
} from "@db/services/channel-identities";
import { syntheticCafOpus } from "@tests/helpers/synthetic-caf";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/telegram";

const botToken = "123456:telegram-test-bot-token";

const capture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as TelegramChannelConfig | undefined,
  // The channel reads the key at message time, so a test flips it in place.
  // SAFETY: The mock factory fills this object with the real environment before any test runs.
  env: {} as Record<string, string | undefined>,
  findIdentity: vi.fn<typeof findChannelIdentity>(),
  messageQuotaGate: vi.fn<
    () => Promise<{
      allowed: boolean;
      paywallText: string | undefined;
    }>
  >(),
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  Object.assign(capture.env, original.env, {
    OPENROUTER_API_KEY: "openrouter-test-key",
    TELEGRAM_BOT_TOKEN: "123456:telegram-test-bot-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "telegram-test-webhook-secret",
  });
  return { ...original, env: capture.env };
});
vi.mock(import("eve/channels/telegram"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    telegramChannel(config?: TelegramChannelConfig) {
      capture.config = config;
      return original.telegramChannel(config);
    },
  };
});
vi.mock("@db/services/channel-identities", () => ({
  findChannelIdentity: capture.findIdentity,
  redeemChannelLinkToken: vi.fn<typeof redeemChannelLinkToken>(),
}));
vi.mock("@agent/lib/billing/quota", () => ({
  messageQuotaGate: capture.messageQuotaGate,
}));

const onMessage = capture.config?.onMessage;
if (!onMessage) {
  throw new Error("The Telegram channel must route inbound messages.");
}

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

const jpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1,
]);

function serveTelegram(file: Uint8Array, transcription?: () => Response) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/getFile")) {
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: "files/one" } })
      );
    }
    if (url.startsWith(`https://api.telegram.org/file/bot${botToken}/`)) {
      return new Response(new Uint8Array(file), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (url === "https://openrouter.ai/api/v1/audio/transcriptions") {
      return transcription?.() ?? new Response("{}", { status: 500 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

describe("Telegram inbound media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    capture.env.OPENROUTER_API_KEY = "openrouter-test-key";
    capture.findIdentity.mockResolvedValue(channelIdentity());
    capture.messageQuotaGate.mockResolvedValue({
      allowed: true,
      paywallText: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves a text message to eve's default turn", async () => {
    const { context } = inboundContext();

    const result = await onMessage(context, telegramMessage({ text: "hi" }));

    expect(result?.auth?.principalId).toBe("better-auth:user-1");
    expect(result).not.toHaveProperty("message");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the model the photo bytes with the sniffed media type", async () => {
    serveTelegram(jpeg);
    const { context, sent } = inboundContext();

    const result = await onMessage(
      context,
      telegramMessage({
        raw: {
          photo: [
            { file_id: "small", file_size: 900 },
            { file_id: "large", file_size: 40_000 },
          ],
        },
      })
    );

    expect(sent).not.toHaveBeenCalled();
    expect(result?.auth?.principalId).toBe("better-auth:user-1");
    expect(result?.message).toEqual([
      { text: "[фото]", type: "text" },
      {
        data: jpeg,
        filename: "photo.jpg",
        mediaType: "image/jpeg",
        type: "file",
      },
    ]);
  });

  it("puts the transcript of a voice note into the turn text", async () => {
    serveTelegram(
      syntheticCafOpus(),
      () => new Response(JSON.stringify({ text: "купи хлеб" }))
    );
    const { context, sent } = inboundContext();

    const result = await onMessage(
      context,
      telegramMessage({ raw: { voice: { file_id: "v", file_size: 80 } } })
    );

    expect(sent).not.toHaveBeenCalled();
    expect(result?.message).toBe("[голосовое] купи хлеб");
  });

  it("asks for a retry and skips the turn when the voice note is unusable", async () => {
    serveTelegram(
      syntheticCafOpus(),
      () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        })
    );
    const { context, sent } = inboundContext();

    await expect(
      onMessage(
        context,
        telegramMessage({ raw: { voice: { file_id: "v", file_size: 80 } } })
      )
    ).resolves.toBeNull();

    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]?.[0]).toContain("Не расслышал голосовое");
  });

  it("says voice is unsupported when the deployment has no OpenRouter key", async () => {
    capture.env.OPENROUTER_API_KEY = undefined;
    const { context, sent } = inboundContext();

    await expect(
      onMessage(
        context,
        telegramMessage({ raw: { voice: { file_id: "v", file_size: 80 } } })
      )
    ).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]?.[0]).toContain("не поддерживаются");
  });

  it("still runs the turn for a captioned photo when voice is unsupported", async () => {
    capture.env.OPENROUTER_API_KEY = undefined;
    serveTelegram(jpeg);
    const { context, sent } = inboundContext();

    const result = await onMessage(
      context,
      telegramMessage({
        caption: "и это",
        raw: {
          photo: [{ file_id: "p", file_size: 900 }],
          voice: { file_id: "v", file_size: 80 },
        },
      })
    );

    expect(sent).toHaveBeenCalledOnce();
    expect(result?.message).toEqual([
      { text: "и это", type: "text" },
      expect.objectContaining({ mediaType: "image/jpeg", type: "file" }),
    ]);
  });

  it("does not resolve media for a sender that is not linked", async () => {
    capture.findIdentity.mockResolvedValue(undefined);
    const { context } = inboundContext("777");

    await expect(
      onMessage(
        context,
        telegramMessage({
          chatId: "777",
          raw: { photo: [{ file_id: "p", file_size: 900 }] },
        })
      )
    ).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function inboundContext(chatId = "4242") {
  const sent = vi.fn<(text: string) => Promise<{ id: string }>>();
  sent.mockResolvedValue({ id: "sent-1" });
  const context: TelegramContext = {
    telegram: telegramHandle({
      chatId,
      sendMessage: sent,
    }),
  };
  return { context, sent };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This adapter deliberately accepts a focused structural fixture.
function telegramHandle(value: unknown): TelegramContext["telegram"] {
  // SAFETY: The inbound policy only reads the chat id and sends one message.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Telegram handle mock would add unrelated Bot API methods.
  return value as TelegramContext["telegram"];
}

function channelIdentity() {
  return {
    channel: "telegram" as const,
    chatId: "4242",
    externalUserId: "9001",
    linkedAt: new Date("2026-09-01T00:00:00.000Z"),
    userId: "user-1",
    username: "ada",
    workspaceId: "personal:workspace",
  };
}

function telegramMessage(options: {
  readonly caption?: string;
  readonly chatId?: string;
  readonly raw?: TelegramMessage["raw"];
  readonly text?: string;
}): TelegramMessage {
  return {
    attachments: [],
    caption: options.caption ?? "",
    chat: {
      id: options.chatId ?? "4242",
      type: "private",
    },
    from: {
      id: "9001",
      isBot: false,
      username: "ada",
    },
    messageId: "77",
    raw: options.raw ?? {},
    text: options.text ?? "",
  };
}
