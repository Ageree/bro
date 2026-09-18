import type {
  TelegramChannelConfig,
  TelegramContext,
} from "eve/channels/telegram";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Blob from "@vercel/blob";
import type * as EnvModule from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import type {
  findChannelIdentity,
  redeemChannelLinkToken,
} from "@db/services/channel-identities";
import type {
  finalizeScheduledReport,
  releaseScheduledReport,
} from "@db/services/scheduled-agent-jobs";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/telegram";

interface ArtifactImage {
  bytes: Uint8Array;
  filename: string;
  id: string;
  mediaType: string;
}

const telegramChannelCapture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as TelegramChannelConfig | undefined,
  images: new Map<string, ArtifactImage>(),
  readImage: vi.fn<
    (
      scope: AccessScope,
      id: string,
      options: {
        readonly rootSessionId: string;
        readonly signal?: AbortSignal;
      }
    ) => Promise<ArtifactImage | undefined>
  >(),
}));
const scheduleDeliveryCapture = vi.hoisted(() => ({
  finalize: vi.fn<typeof finalizeScheduledReport>(),
  release: vi.fn<typeof releaseScheduledReport>(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  finalizeScheduledReport: scheduleDeliveryCapture.finalize,
  releaseScheduledReport: scheduleDeliveryCapture.release,
}));
vi.mock("@db/services/channel-identities", () => ({
  findChannelIdentity: vi.fn<typeof findChannelIdentity>(),
  redeemChannelLinkToken: vi.fn<typeof redeemChannelLinkToken>(),
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
      telegramChannelCapture.config = config;
      return original.telegramChannel(config);
    },
  };
});
vi.mock("@db/services/browser-images", () => ({
  async readReadyBrowserImageArtifact(
    scope: AccessScope,
    id: string,
    options: { readonly rootSessionId: string; readonly signal?: AbortSignal }
  ) {
    const image = await telegramChannelCapture.readImage(scope, id, options);
    if (!image) return undefined;
    telegramChannelCapture.images.set(id, image);
    return {
      byteSize: image.bytes.byteLength,
      contentHash:
        "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      filename: image.filename,
      id,
      mediaType: image.mediaType,
      storagePathname: id,
    };
  },
}));
vi.mock("@vercel/blob", async (importOriginal) => {
  const blob = await importOriginal<typeof Blob>();
  return {
    ...blob,
    async get(pathname: string) {
      const image = telegramChannelCapture.images.get(pathname);
      if (!image) return null;
      return {
        blob: { contentType: image.mediaType, size: image.bytes.byteLength },
        statusCode: 200,
        stream: new Response(Buffer.from(image.bytes)).body,
      };
    },
  };
});

const handleActionResult =
  telegramChannelCapture.config?.events?.["action.result"];
if (!handleActionResult) {
  throw new Error(
    "The Telegram channel must configure action result delivery."
  );
}

type ActionHandlerParameters = Parameters<typeof handleActionResult>;

describe("Telegram message delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    telegramChannelCapture.images.clear();
    scheduleDeliveryCapture.finalize.mockResolvedValue(true);
    scheduleDeliveryCapture.release.mockResolvedValue(true);
  });

  it("replaces eve's default assistant text delivery", () => {
    expect(
      telegramChannelCapture.config?.events?.["message.completed"]
    ).toBeTypeOf("function");
  });

  it("sends send_message output as Telegram HTML", async () => {
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: "**Done.** Nothing < everything.",
      }),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "<b>Done.</b> Nothing &lt; everything.",
    });
  });

  it("splits a reply that exceeds the Telegram text cap", async () => {
    const { context, request } = handlerContext();
    const paragraph = "a".repeat(4_000);

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: `${paragraph}\n${"b".repeat(300)}`,
      }),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ text: paragraph });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      text: "b".repeat(300),
    });
  });

  it("posts a native link as its own message", async () => {
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "link", url: "https://example.com/renew" }),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "https://example.com/renew",
    });
  });

  it("delivers a URL attachment as a link", async () => {
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [
          {
            kind: "image",
            mimeType: "image/png",
            name: "result.png",
            url: "https://media.example/result.png",
          },
        ],
        kind: "message",
        text: "Here it is.",
      }),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "Here it is.\n\nhttps://media.example/result.png",
    });
  });

  it("uploads an image artifact with a multipart sendPhoto call", async () => {
    const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    telegramChannelCapture.readImage.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "product.png",
      id: artifactId,
      mediaType: "image/png",
    });
    const botApi = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", botApi);
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: `Here it is.\n\n![Product](/artifacts/${artifactId})`,
      }),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "Here it is.",
    });
    expect(botApi).toHaveBeenCalledTimes(1);
    const [url, init] = botApi.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.telegram.org/bottelegram-test-bot-token/sendPhoto"
    );
    expect(init?.method).toBe("POST");
    const form = init?.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form instanceof FormData ? form.get("chat_id") : null).toBe("4242");
    const photo = form instanceof FormData ? form.get("photo") : null;
    expect(photo).toBeInstanceOf(File);
    expect(photo instanceof File ? photo.name : "").toBe("product.png");
    expect(photo instanceof File ? photo.type : "").toBe("image/png");
  });

  it("explains an artifact it could not attach", async () => {
    const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    telegramChannelCapture.readImage.mockResolvedValue(undefined);
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: `Here it is.\n\n![Product](/artifacts/${artifactId})`,
      }),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "Here it is.\n\nI couldn't attach one image.",
    });
  });

  it("finalizes a scheduled result after send_message posts it", async () => {
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: "The price fell." }),
      context,
      sessionContext("scheduled-result")
    );

    expect(scheduleDeliveryCapture.finalize).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
      "delivered"
    );
  });

  it.each([
    ["thumbs_up", "👍"],
    ["thumbs_down", "👎"],
    ["heart", "❤️"],
    ["laugh", "😂"],
    ["exclamation", "‼️"],
    ["question", "❓"],
  ] as const)("sets the %s reaction", async (type, emoji) => {
    const { context, request } = handlerContext();

    await handleActionResult(
      reactToMessageResult({ operation: "add", type }),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("setMessageReaction", {
      chat_id: "4242",
      message_id: 77,
      reaction: [{ emoji, type: "emoji" }],
    });
  });

  it("clears a reaction with an empty reaction list", async () => {
    const { context, request } = handlerContext();

    await handleActionResult(
      reactToMessageResult({ operation: "remove", type: "heart" }),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("setMessageReaction", {
      chat_id: "4242",
      message_id: 77,
      reaction: [],
    });
  });
});

function sendMessageResult(
  output: ActionHandlerParameters[0]["result"] extends { output: infer Output }
    ? Output
    : never
): ActionHandlerParameters[0] {
  return {
    result: {
      callId: "call-send-message",
      kind: "tool-result",
      output,
      toolName: "send_message",
    },
    sequence: 0,
    status: "completed",
    stepIndex: 0,
    turnId: "turn-1",
  };
}

function reactToMessageResult(
  output: ActionHandlerParameters[0]["result"] extends { output: infer Output }
    ? Output
    : never
): ActionHandlerParameters[0] {
  return {
    result: {
      callId: "call-react-to-message",
      kind: "tool-result",
      output,
      toolName: "react_to_message",
    },
    sequence: 0,
    status: "completed",
    stepIndex: 0,
    turnId: "turn-1",
  };
}

function handlerContext() {
  const request = vi.fn<TelegramContext["telegram"]["request"]>();
  request.mockResolvedValue({ body: { ok: true }, ok: true, status: 200 });
  const context = handlerEventContext({
    state: { chatId: "4242" },
    telegram: { chatId: "4242", request },
  });

  return { context, request };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test adapter deliberately accepts a focused structural fixture.
function handlerEventContext(value: unknown): ActionHandlerParameters[1] {
  // SAFETY: Callers provide every Telegram context field exercised by these focused handlers.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Telegram event context would add unrelated continuation operations.
  return value as ActionHandlerParameters[1];
}

function sessionContext(authenticator = "test") {
  const attributes: Record<string, string | readonly string[]> =
    authenticator === "scheduled-result"
      ? {
          conversationChannel: "telegram",
          conversationId: "4242::",
          scheduleId: "00000000-0000-4000-8000-000000000003",
          scheduledReportLeaseToken: "00000000-0000-4000-8000-000000000004",
          scheduledReportSequence: "1",
          scheduledRunId: "00000000-0000-4000-8000-000000000002",
          scheduledRunSessionId: "scheduled-run-session",
          workspaceId: "workspace-1",
        }
      : {
          conversationChannel: "telegram",
          conversationId: "4242::",
          telegramMessageId: "77",
          workspaceId: "workspace-1",
        };
  return {
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes,
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
  } satisfies ActionHandlerParameters[2];
}
