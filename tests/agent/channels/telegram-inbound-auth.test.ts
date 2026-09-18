import {
  resolveTelegramBotToken,
  resolveTelegramWebhookSecretToken,
  type TelegramChannelConfig,
  type TelegramContext,
  type TelegramMessage,
} from "eve/channels/telegram";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@shared/environment";
import type {
  findChannelIdentity,
  redeemChannelLinkToken,
} from "@db/services/channel-identities";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/telegram";

const capture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as TelegramChannelConfig | undefined,
  findIdentity: vi.fn<typeof findChannelIdentity>(),
  messageQuotaGate: vi.fn<
    () => Promise<{
      allowed: boolean;
      paywallText: string | undefined;
    }>
  >(),
  redeemToken: vi.fn<typeof redeemChannelLinkToken>(),
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      TELEGRAM_BOT_TOKEN: "telegram-test-bot-token",
      TELEGRAM_BOT_USERNAME: "open_instinct_bot",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "telegram-test-webhook-secret",
    },
  };
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
  redeemChannelLinkToken: capture.redeemToken,
}));
vi.mock("@agent/lib/billing/quota", () => ({
  messageQuotaGate: capture.messageQuotaGate,
}));

const onMessage = capture.config?.onMessage;
if (!onMessage) {
  throw new Error("The Telegram channel must route inbound messages.");
}

describe("Telegram channel configuration", () => {
  it("serves the default webhook route with the configured verification", async () => {
    expect(capture.config?.route).toBeUndefined();
    expect(capture.config?.botUsername).toBe("open_instinct_bot");
    await expect(
      resolveTelegramWebhookSecretToken(
        capture.config?.credentials?.webhookSecretToken
      )
    ).resolves.toBe("telegram-test-webhook-secret");
    await expect(
      resolveTelegramBotToken(capture.config?.credentials?.botToken)
    ).resolves.toBe("telegram-test-bot-token");
  });

  it("accepts inbound images and PDFs up to ten megabytes", () => {
    expect(capture.config?.uploadPolicy).toEqual({
      allowedMediaTypes: ["image/*", "application/pdf"],
      maxBytes: 10 * 1024 * 1024,
    });
  });
});

describe("Telegram inbound authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    capture.messageQuotaGate.mockResolvedValue({
      allowed: true,
      paywallText: undefined,
    });
  });

  it("ignores group chats without replying", async () => {
    const { context, sent } = inboundContext();

    await expect(
      onMessage(context, telegramMessage({ chatType: "supergroup" }))
    ).resolves.toBeNull();
    expect(sent).not.toHaveBeenCalled();
    expect(capture.findIdentity).not.toHaveBeenCalled();
  });

  it("ignores another bot's messages", async () => {
    const { context, sent } = inboundContext();

    await expect(
      onMessage(context, telegramMessage({ isBot: true }))
    ).resolves.toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });

  it("runs a linked Telegram user as their own Better Auth account", async () => {
    capture.findIdentity.mockResolvedValue(channelIdentity());
    const { context } = inboundContext();

    const result = await onMessage(context, telegramMessage());

    expect(capture.findIdentity).toHaveBeenCalledExactlyOnceWith(
      "telegram",
      "9001"
    );
    expect(result?.auth?.principalId).toBe("better-auth:user-1");
    expect(result?.auth?.attributes).toMatchObject({
      conversationChannel: "telegram",
      conversationId: "4242::",
      telegramChatId: "4242",
      telegramMessageId: "77",
      telegramUserId: "9001",
    });
    expect(result?.auth?.attributes.workspaceId).toMatch(
      /^personal:[0-9a-f]{32}$/
    );
  });

  it("answers an over-limit message with one paywall message a day", async () => {
    capture.findIdentity.mockResolvedValue(channelIdentity());
    capture.messageQuotaGate.mockResolvedValueOnce({
      allowed: false,
      paywallText: "Лимит на сегодня исчерпан",
    });
    const { context, sent } = inboundContext();

    await expect(onMessage(context, telegramMessage())).resolves.toBeNull();
    expect(sent).toHaveBeenCalledExactlyOnceWith("Лимит на сегодня исчерпан");

    // The rest of the day is turned away without saying so again.
    capture.messageQuotaGate.mockResolvedValueOnce({
      allowed: false,
      paywallText: undefined,
    });
    await expect(onMessage(context, telegramMessage())).resolves.toBeNull();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("explains linking once per chat per hour to an unlinked user", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-18T10:00:00.000Z") });
    capture.findIdentity.mockResolvedValue(undefined);
    const { context, sent } = inboundContext("5150");

    await expect(
      onMessage(context, telegramMessage({ chatId: "5150" }))
    ).resolves.toBeNull();
    await expect(
      onMessage(context, telegramMessage({ chatId: "5150" }))
    ).resolves.toBeNull();

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[0]).toContain("Привязать Telegram");

    vi.setSystemTime(new Date("2026-09-18T11:00:01.000Z"));
    await expect(
      onMessage(context, telegramMessage({ chatId: "5150" }))
    ).resolves.toBeNull();

    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("redeems a start payload and confirms the link", async () => {
    capture.redeemToken.mockResolvedValue("linked");
    const { context, sent } = inboundContext();

    await expect(
      onMessage(context, telegramMessage({ text: "/start link_abc-123_XYZ" }))
    ).resolves.toBeNull();

    expect(capture.redeemToken).toHaveBeenCalledExactlyOnceWith(
      "telegram",
      "abc-123_XYZ",
      { chatId: "4242", externalUserId: "9001", username: "ada" }
    );
    expect(sent).toHaveBeenCalledExactlyOnceWith(
      "Готово, телеграм привязан. Пиши мне прямо здесь."
    );
    expect(capture.findIdentity).not.toHaveBeenCalled();
  });

  it("accepts the bot-qualified start command", async () => {
    capture.redeemToken.mockResolvedValue("linked");
    const { context } = inboundContext();

    await onMessage(
      context,
      telegramMessage({ text: "/start@open_instinct_bot link_abc" })
    );

    expect(capture.redeemToken).toHaveBeenCalledWith(
      "telegram",
      "abc",
      expect.objectContaining({ externalUserId: "9001" })
    );
  });

  it.each([
    ["expired", "протухла"],
    ["unknown", "уже воспользовались"],
    ["already_linked_other_user", "другому кабинету"],
    ["already_linked_other_account", "другой телеграм"],
  ] as const)("reports the %s outcome", async (outcome, reason) => {
    capture.redeemToken.mockResolvedValue(outcome);
    const { context, sent } = inboundContext();

    await expect(
      onMessage(context, telegramMessage({ text: "/start link_abc" }))
    ).resolves.toBeNull();

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[0]).toContain(reason);
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

function telegramMessage(options?: {
  readonly chatId?: string;
  readonly chatType?: TelegramMessage["chat"]["type"];
  readonly isBot?: boolean;
  readonly text?: string;
}): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: {
      id: options?.chatId ?? "4242",
      type: options?.chatType ?? "private",
    },
    from: {
      id: "9001",
      isBot: options?.isBot ?? false,
      username: "ada",
    },
    messageId: "77",
    raw: {},
    text: options?.text ?? "list my vault items",
  };
}
