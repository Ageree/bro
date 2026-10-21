import {
  resolveTelegramBotToken,
  resolveTelegramWebhookSecretToken,
  type TelegramChannelConfig,
  type TelegramContext,
  type TelegramMessage,
} from "eve/channels/telegram";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@shared/environment";
import type { redeemChannelLinkToken } from "@db/services/channel-identities";
import type { approveTelegramLogin } from "@db/services/auth/telegram-login";
import type { ensureTelegramUser } from "@db/services/auth/telegram-user";
import type * as ScopeService from "@db/services/scope";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/telegram";

const capture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as TelegramChannelConfig | undefined,
  approveLogin: vi.fn<typeof approveTelegramLogin>(),
  ensureUser: vi.fn<typeof ensureTelegramUser>(),
  claimIntroduction: vi.fn<typeof ScopeService.claimWorkspaceIntroduction>(),
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
  redeemChannelLinkToken: capture.redeemToken,
}));
vi.mock("@db/services/auth/telegram-user", () => ({
  ensureTelegramUser: capture.ensureUser,
}));
vi.mock("@db/services/auth/telegram-login", () => ({
  approveTelegramLogin: capture.approveLogin,
  telegramLoginPayloadPrefix: "login_",
}));
vi.mock("@db/services/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof ScopeService>()),
  claimWorkspaceIntroduction: capture.claimIntroduction,
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

  it("accepts inbound images and PDFs up to twenty mebibytes", () => {
    expect(capture.config?.uploadPolicy).toEqual({
      allowedMediaTypes: ["image/*", "application/pdf"],
      maxBytes: 20 * 1024 * 1024,
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
    capture.claimIntroduction.mockResolvedValue(false);
    capture.ensureUser.mockResolvedValue({ created: false, userId: "user-1" });
  });

  it("ignores group chats without replying", async () => {
    const { context, sent } = inboundContext();

    await expect(
      onMessage(context, telegramMessage({ chatType: "supergroup" }))
    ).resolves.toBeNull();
    expect(sent).not.toHaveBeenCalled();
    expect(capture.ensureUser).not.toHaveBeenCalled();
  });

  it("ignores another bot's messages", async () => {
    const { context, sent } = inboundContext();

    await expect(
      onMessage(context, telegramMessage({ isBot: true }))
    ).resolves.toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });

  it("runs a Telegram user as their own Better Auth account", async () => {
    const { context } = inboundContext();

    const result = await onMessage(context, telegramMessage());

    expect(capture.ensureUser).toHaveBeenCalledExactlyOnceWith({
      chatId: "4242",
      name: "",
      telegramUserId: "9001",
      username: "ada",
    });
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
    expect(result?.context).toEqual([]);
  });

  // An account linked from the web cabinet may never have written to Bro,
  // so its first Telegram message is where the introduction happens.
  it("introduces Bro on the workspace's first message", async () => {
    capture.claimIntroduction.mockResolvedValue(true);
    const { context } = inboundContext();

    const result = await onMessage(context, telegramMessage());

    expect(capture.claimIntroduction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "better-auth:user-1" })
    );
    expect(result?.context?.join("\n")).toContain("`first-contact`");
  });

  it("answers an over-limit message with one paywall message a day", async () => {
    capture.messageQuotaGate.mockResolvedValueOnce({
      allowed: false,
      paywallText: "Лимит на сегодня исчерпан",
    });
    const { context, sent, typing } = inboundContext();

    await expect(onMessage(context, telegramMessage())).resolves.toBeNull();
    expect(sent).toHaveBeenCalledExactlyOnceWith("Лимит на сегодня исчерпан");
    // Nobody answers it, so Bro is never shown typing.
    expect(typing).not.toHaveBeenCalled();

    // The rest of the day is turned away without saying so again.
    capture.messageQuotaGate.mockResolvedValueOnce({
      allowed: false,
      paywallText: undefined,
    });
    await expect(onMessage(context, telegramMessage())).resolves.toBeNull();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  // Telegram is Bro's main channel: a stranger starts on their first
  // message instead of being sent to bind a cabinet they do not have.
  it("gives a stranger an account on their first message", async () => {
    capture.ensureUser.mockResolvedValue({ created: true, userId: "user-2" });
    const { context, sent } = inboundContext("5150");

    const result = await onMessage(
      context,
      telegramMessage({ chatId: "5150" })
    );

    expect(result?.auth?.principalId).toBe("better-auth:user-2");
    expect(sent).not.toHaveBeenCalled();
  });

  it("starts no turn when the account cannot be made", async () => {
    capture.ensureUser.mockResolvedValue(undefined);
    const { context, sent } = inboundContext();

    await expect(onMessage(context, telegramMessage())).resolves.toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });

  it("answers the website's sign-in link with a code and no turn", async () => {
    capture.approveLogin.mockResolvedValue({ code: "042917", kind: "code" });
    const { context, sent } = inboundContext();

    await expect(
      onMessage(context, telegramMessage({ text: "/start login_tok-1_A" }))
    ).resolves.toBeNull();

    expect(capture.approveLogin).toHaveBeenCalledExactlyOnceWith(
      "tok-1_A",
      "user-1"
    );
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[0]).toContain("042917");
    expect(sent.mock.calls[0]?.[0]).toContain("Никому его не сообщай");
  });

  it("sends a stale sign-in link back to the website", async () => {
    capture.approveLogin.mockResolvedValue({ kind: "expired" });
    const { context, sent } = inboundContext();

    await onMessage(context, telegramMessage({ text: "/start login_old" }));

    expect(sent.mock.calls[0]?.[0]).toContain("Войти через Telegram");
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
    expect(capture.ensureUser).not.toHaveBeenCalled();
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
    ["already_linked_other_user", "другому кабинету"],
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
  const typing = vi.fn<() => Promise<void>>();
  typing.mockResolvedValue(undefined);
  const context: TelegramContext = {
    telegram: telegramHandle({
      chatId,
      sendMessage: sent,
      startTyping: typing,
    }),
  };
  return { context, sent, typing };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This adapter deliberately accepts a focused structural fixture.
function telegramHandle(value: unknown): TelegramContext["telegram"] {
  // SAFETY: The inbound policy only reads the chat id and sends one message.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Telegram handle mock would add unrelated Bot API methods.
  return value as TelegramContext["telegram"];
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
