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
vi.mock("@db/services/artifacts", () => ({
  async readReadyArtifact(
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
const handleMessageCompleted =
  telegramChannelCapture.config?.events?.["message.completed"];
const handleTurnFailed = telegramChannelCapture.config?.events?.["turn.failed"];
if (!handleActionResult || !handleMessageCompleted || !handleTurnFailed) {
  throw new Error(
    "The Telegram channel must configure action result delivery."
  );
}

type ActionHandlerParameters = Parameters<typeof handleActionResult>;
type MessageHandlerParameters = Parameters<typeof handleMessageCompleted>;
type TurnFailedEvent = Parameters<typeof handleTurnFailed>[0];

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

  it("delivers assistant text the model wrote instead of calling send_message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { context, request } = handlerContext();

    await handleMessageCompleted(
      assistantMessage("**Готово.** Заказ оформлен."),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "<b>Готово.</b> Заказ оформлен.",
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[telegram] assistant text delivered as fallback",
      { sessionId: "session-1" }
    );
    warn.mockRestore();
  });

  it("ignores the delivery marker the instructions ask for", async () => {
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: "Готово." }),
      context,
      sessionContext()
    );
    request.mockClear();
    await handleMessageCompleted(
      assistantMessage("DELIVERY_COMPLETE"),
      context,
      sessionContext()
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("does not repeat a reply send_message already delivered", async () => {
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: "Готово." }),
      context,
      sessionContext()
    );
    request.mockClear();
    await handleMessageCompleted(
      assistantMessage("Готово, заказ оформлен."),
      context,
      sessionContext()
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("does not follow a reaction with the text written after it", async () => {
    const { context, request } = handlerContext();

    await handleActionResult(
      reactToMessageResult({ operation: "add", type: "thumbs_up" }),
      context,
      sessionContext()
    );
    request.mockClear();
    await handleMessageCompleted(
      assistantMessage("Поставил лайк."),
      context,
      sessionContext()
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("still rescues plain text in a later turn after a delivered one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: "Готово." }),
      context,
      sessionContext()
    );
    request.mockClear();
    await handleMessageCompleted(
      { ...assistantMessage("Не могу это сделать."), turnId: "turn-2" },
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("drops the delivery marker from rescued plain text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { context, request } = handlerContext();

    await handleMessageCompleted(
      assistantMessage("Не могу это сделать.\nDELIVERY_COMPLETE"),
      context,
      sessionContext()
    );

    expect(JSON.stringify(request.mock.calls)).not.toContain(
      "DELIVERY_COMPLETE"
    );
    expect(request).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("leaves text that only introduces a tool call undelivered", async () => {
    const { context, request } = handlerContext();

    await handleMessageCompleted(
      assistantMessage("Сейчас посмотрю.", "tool-calls"),
      context,
      sessionContext()
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a scheduled report suppressed instead of delivering its text", async () => {
    const { context, request } = handlerContext();

    await handleMessageCompleted(
      assistantMessage("Внутренний отчёт."),
      context,
      sessionContext("scheduled-result")
    );

    expect(request).not.toHaveBeenCalled();
    expect(scheduleDeliveryCapture.finalize).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
      "suppressed"
    );
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

  it("uploads a URL attachment as a real photo", async () => {
    const network = stubNetwork();
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [
          {
            kind: "image",
            mimeType: "image/png",
            url: "https://media.example/result.jpg",
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
      text: "Here it is.",
    });
    // The words do not wait on a download that may take the whole timeout.
    expect(request.mock.invocationCallOrder[0]).toBeLessThan(
      network.mock.invocationCallOrder[0] ?? 0
    );
    const [upload] = botApiCalls(network);
    expect(upload?.method).toBe("sendPhoto");
    expect(upload?.form.get("chat_id")).toBe("4242");
    const photo = upload?.form.get("photo");
    expect(photo).toBeInstanceOf(File);
    expect(photo instanceof File ? photo.name : "").toBe("result.jpg");
    expect(photo instanceof File ? photo.type : "").toBe("image/jpeg");
    await expect(
      photo instanceof File ? photo.bytes() : undefined
    ).resolves.toEqual(jpegBytes);
  });

  it("sends two image attachments as one album", async () => {
    const network = stubNetwork();
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [
          { kind: "image", url: "https://media.example/first.jpg" },
          { kind: "image", url: "https://media.example/second.jpg" },
        ],
        kind: "message",
        text: "Two good ones.",
      }),
      context,
      sessionContext()
    );

    const calls = botApiCalls(network);
    expect(calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(calls[0]?.form.get("media")).toBe(
      JSON.stringify([
        { media: "attach://file0", type: "photo" },
        { media: "attach://file1", type: "photo" },
      ])
    );
    expect(calls[0]?.form.get("file0")).toBeInstanceOf(File);
    expect(calls[0]?.form.get("file1")).toBeInstanceOf(File);
  });

  it("sends each photo on its own when Telegram rejects the album", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const network = stubNetwork({
      telegram: (method) =>
        telegramError(method === "sendMediaGroup" ? 400 : 200),
    });
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [
          { kind: "image", url: "https://media.example/first.jpg" },
          { kind: "image", url: "https://media.example/second.jpg" },
        ],
        kind: "message",
        text: "Two good ones.",
      }),
      context,
      sessionContext()
    );

    const calls = botApiCalls(network);
    expect(calls.map((call) => call.method)).toEqual([
      "sendMediaGroup",
      "sendPhoto",
      "sendPhoto",
    ]);
    expect(
      calls.slice(1).map((call) => uploadedFile(call.form, "photo")?.name)
    ).toEqual(["first.jpg", "second.jpg"]);
    warn.mockRestore();
  });

  it("links an album Telegram could not serve instead of retrying it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const network = stubNetwork({
      telegram: (method) =>
        telegramError(method === "sendMediaGroup" ? 500 : 200),
    });
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [
          { kind: "image", url: "https://media.example/first.jpg" },
          { kind: "image", url: "https://media.example/second.jpg" },
        ],
        kind: "message",
        text: "Two good ones.",
      }),
      context,
      sessionContext()
    );

    expect(botApiCalls(network).map((call) => call.method)).toEqual([
      "sendMediaGroup",
    ]);
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      text: "https://media.example/first.jpg\nhttps://media.example/second.jpg",
    });
    warn.mockRestore();
  });

  it("retries a photo Telegram refused as a document", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const network = stubNetwork({
      telegram: (method) =>
        telegramError(
          method === "sendPhoto" ? 400 : 200,
          "PHOTO_INVALID_DIMENSIONS"
        ),
    });
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [{ kind: "image", url: "https://media.example/wide.jpg" }],
        kind: "message",
        text: "Here it is.",
      }),
      context,
      sessionContext()
    );

    const calls = botApiCalls(network);
    expect(calls.map((call) => call.method)).toEqual([
      "sendPhoto",
      "sendDocument",
    ]);
    expect(calls[1]?.form.get("document")).toBeInstanceOf(File);
    warn.mockRestore();
  });

  it("never re-uploads a photo Telegram only throttled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const network = stubNetwork({
      telegram: () => telegramError(429, "Too Many Requests"),
    });
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [{ kind: "image", url: "https://media.example/wide.jpg" }],
        kind: "message",
        text: "Here it is.",
      }),
      context,
      sessionContext()
    );

    expect(botApiCalls(network).map((call) => call.method)).toEqual([
      "sendPhoto",
    ]);
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      text: "https://media.example/wide.jpg",
    });
    warn.mockRestore();
  });

  it("links a photo neither upload could deliver", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const network = stubNetwork({ telegram: () => telegramError(400) });
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [{ kind: "image", url: "https://media.example/wide.jpg" }],
        kind: "message",
        text: "Here it is.",
      }),
      context,
      sessionContext()
    );

    expect(botApiCalls(network).map((call) => call.method)).toEqual([
      "sendPhoto",
      "sendDocument",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      text: "https://media.example/wide.jpg",
    });
    warn.mockRestore();
  });

  it("uploads a picture and a document of one message separately", async () => {
    const network = stubNetwork({
      download: (url) =>
        url.endsWith(".pdf")
          ? new Response(new Uint8Array(pdfBytes), {
              headers: { "content-type": "application/pdf" },
            })
          : new Response(new Uint8Array(jpegBytes), {
              headers: { "content-type": "image/jpeg" },
            }),
    });
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [
          { kind: "image", url: "https://media.example/photo.jpg" },
          { kind: "file", url: "https://media.example/brief.pdf" },
        ],
        kind: "message",
        text: "Both of them.",
      }),
      context,
      sessionContext()
    );

    expect(botApiCalls(network).map((call) => call.method)).toEqual([
      "sendPhoto",
      "sendDocument",
    ]);
  });

  it("uploads a document attachment with sendDocument", async () => {
    const network = stubNetwork({
      download: () =>
        new Response(new Uint8Array(pdfBytes), {
          headers: { "content-type": "application/pdf" },
        }),
    });
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [{ kind: "file", url: "https://media.example/brief.pdf" }],
        kind: "message",
        text: "The brief.",
      }),
      context,
      sessionContext()
    );

    const [upload] = botApiCalls(network);
    expect(upload?.method).toBe("sendDocument");
    const document = upload?.form.get("document");
    expect(document instanceof File ? document.name : "").toBe("brief.pdf");
  });

  it("delivers an attachment it could not download as a link", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const network = stubNetwork({
      download: () => new Response("", { status: 404 }),
    });
    const { context, request } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        attachments: [
          { kind: "image", url: "https://media.example/result.png" },
        ],
        kind: "message",
        text: "Here it is.",
      }),
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ text: "Here it is." });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      text: "https://media.example/result.png",
    });
    expect(botApiCalls(network)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[telegram] attachment delivery failed", {
      reasons: ["http 404"],
      sessionId: "session-1",
    });
    warn.mockRestore();
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

  it("sends two image artifacts of one reply as one album", async () => {
    const firstArtifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    const secondArtifactId = "206c3a7e-c0b8-4317-9e34-552cff646673";
    telegramChannelCapture.readImage.mockImplementation(
      async (_scope, artifactId) => ({
        // The stored hash belongs to these bytes, so both artifacts share them.
        bytes: new Uint8Array([1, 2, 3]),
        filename: artifactId === firstArtifactId ? "first.png" : "second.png",
        id: artifactId,
        mediaType: "image/png",
      })
    );
    const network = stubNetwork();
    const { context } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: [
          "Two good options.",
          `![First](/artifacts/${firstArtifactId})`,
          `![Second](/artifacts/${secondArtifactId})`,
        ].join("\n"),
      }),
      context,
      sessionContext()
    );

    const calls = botApiCalls(network);
    expect(calls.map((call) => call.method)).toEqual(["sendMediaGroup"]);
    expect(
      ["file0", "file1"].map(
        (field) => uploadedFile(calls[0]?.form, field)?.name
      )
    ).toEqual(["first.png", "second.png"]);
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
      text: "Here it is.\n\nНе получилось приложить файл.",
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

  it("tells the person Bro is resting when the model provider fails", async () => {
    const { context, request } = handlerContext();

    await handleTurnFailed(modelCallFailure(), context, sessionContext());

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "я прилёг, скоро вернусь",
    });
  });

  it("answers someone writing in English in English", async () => {
    const { context, request } = handlerContext();

    await handleTurnFailed(
      modelCallFailure(),
      context,
      englishSessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "taking a quick nap, back soon",
    });
  });

  // An overflowing context or a rejected request also fails as
  // MODEL_CALL_FAILED, and «back soon» would not be true there.
  it("keeps the apology for a model call the provider rejected", async () => {
    const { context, request } = handlerContext();

    await handleTurnFailed(
      { ...modelCallFailure(), details: { statusCode: 400 } },
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "Что-то сломалось, пока я разбирался с твоей просьбой. Попробуй ещё раз.",
    });
  });

  it("keeps the generic apology for other turn failures", async () => {
    const { context, request } = handlerContext();

    await handleTurnFailed(
      { ...modelCallFailure(), code: "TOOL_FAILED", message: "boom" },
      context,
      sessionContext()
    );

    expect(request).toHaveBeenCalledExactlyOnceWith("sendMessage", {
      chat_id: "4242",
      parse_mode: "HTML",
      text: "Что-то сломалось, пока я разбирался с твоей просьбой. Попробуй ещё раз.",
    });
  });

  it("leaves a failed scheduled report to its retry", async () => {
    const { context, request } = handlerContext();

    await handleTurnFailed(
      modelCallFailure(),
      context,
      sessionContext("scheduled-result")
    );

    expect(request).not.toHaveBeenCalled();
    expect(scheduleDeliveryCapture.release).toHaveBeenCalledOnce();
  });
});

const jpegBytes = new Uint8Array(16);
jpegBytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
const pdfBytes = new Uint8Array(16);
pdfBytes.set([...Buffer.from("%PDF-1.7")], 0);

function modelCallFailure(): TurnFailedEvent {
  return {
    code: "MODEL_CALL_FAILED",
    details: { statusCode: 402 },
    message: 'OpenRouter 402: "This request requires more credits"',
    sequence: 2,
    turnId: "turn-1",
  };
}

function englishSessionContext() {
  const session = sessionContext();
  const caller = session.session.auth.current;
  return {
    ...session,
    session: {
      ...session.session,
      auth: {
        ...session.session.auth,
        current: {
          ...caller,
          attributes: { ...caller.attributes, replyLanguage: "en" },
        },
      },
    },
  };
}

function telegramError(status: number, description?: string) {
  return new Response(
    JSON.stringify(description ? { description, ok: false } : {}),
    { status }
  );
}

function uploadedFile(form: FormData | undefined, field: string) {
  const value = form?.get(field);
  return value instanceof File ? value : undefined;
}

/** The absolute URL one fetch call targeted, however it was addressed. */
function requestUrl(input: RequestInfo | URL) {
  return new Request(input).url;
}

/**
 * Routes one fetch mock between the attachment downloads and the Bot API,
 * which the channel reaches directly because eve's handle only speaks JSON.
 */
function stubNetwork(
  routes: {
    readonly download?: (url: string) => Response;
    readonly telegram?: (method: string) => Response;
  } = {}
) {
  const network = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      const method = url.split("/").at(-1) ?? "";
      if (url.startsWith("https://api.telegram.org")) {
        return routes.telegram?.(method) ?? new Response("{}", { status: 200 });
      }
      return (
        routes.download?.(url) ??
        new Response(new Uint8Array(jpegBytes), {
          headers: { "content-type": "image/jpeg" },
        })
      );
    });
  vi.stubGlobal("fetch", network);
  return network;
}

function botApiCalls(network: ReturnType<typeof stubNetwork>) {
  return network.mock.calls.flatMap(([input, init]) => {
    const url = requestUrl(input);
    if (!url.startsWith("https://api.telegram.org")) return [];
    const form = init?.body;
    if (!(form instanceof FormData)) return [];
    return [{ form, method: url.split("/").at(-1) ?? "" }];
  });
}

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

function assistantMessage(
  message: string,
  finishReason: MessageHandlerParameters[0]["finishReason"] = "stop"
): MessageHandlerParameters[0] {
  return { finishReason, message, sequence: 1, stepIndex: 1, turnId: "turn-1" };
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
