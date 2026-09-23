import type { PhotonIMessageChannelConfig } from "eve/channels/photon";
import type { AdapterPostableMessage } from "chat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Blob from "@vercel/blob";
import type * as EnvModule from "@shared/environment";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import type { AccessScope } from "@shared/identity/access-scope";
import type {
  finalizeScheduledReport,
  releaseScheduledReport,
} from "@db/services/scheduled-agent-jobs";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/photon";

interface BrowserImage {
  bytes: Uint8Array;
  filename: string;
  id: string;
  mediaType: string;
}

const photonChannelCapture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as PhotonIMessageChannelConfig | undefined,
  images: new Map<string, BrowserImage>(),
  readImage: vi.fn<
    (
      scope: AccessScope,
      id: string,
      options: {
        readonly rootSessionId: string;
        readonly signal?: AbortSignal;
      }
    ) => Promise<BrowserImage | undefined>
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
vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      IMESSAGE_PROJECT_ID: "photon-test-project",
      IMESSAGE_PROJECT_SECRET: "photon-test-secret",
      IMESSAGE_WEBHOOK_SECRET: "photon-test-webhook-secret",
    },
  };
});
vi.mock(import("eve/channels/photon"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    photonIMessageChannel(config: PhotonIMessageChannelConfig) {
      photonChannelCapture.config = config;
      return original.photonIMessageChannel(config);
    },
  };
});
vi.mock("@db/services/artifacts", () => ({
  async readReadyArtifact(
    scope: AccessScope,
    id: string,
    options: { readonly rootSessionId: string; readonly signal?: AbortSignal }
  ) {
    const image = await photonChannelCapture.readImage(scope, id, options);
    if (!image) return undefined;
    photonChannelCapture.images.set(id, image);
    return {
      byteSize: image.bytes.byteLength,
      contentHash:
        image.bytes[0] === 1
          ? "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
          : "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
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
      const image = photonChannelCapture.images.get(pathname);
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
  photonChannelCapture.config?.events?.["action.result"];
const handleMessageCompleted =
  photonChannelCapture.config?.events?.["message.completed"];
const handleTurnFailed = photonChannelCapture.config?.events?.["turn.failed"];
if (!handleActionResult || !handleMessageCompleted || !handleTurnFailed) {
  throw new Error("The Photon channel must configure action result delivery.");
}

type ActionHandlerParameters = Parameters<typeof handleActionResult>;
type MessageHandlerParameters = Parameters<typeof handleMessageCompleted>;
type TurnFailedEvent = Parameters<typeof handleTurnFailed>[0];

describe("Photon message delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    scheduleDeliveryCapture.finalize.mockResolvedValue(true);
    scheduleDeliveryCapture.release.mockResolvedValue(true);
  });

  it("does not register automatic assistant text posting", () => {
    expect(
      photonChannelCapture.config?.events?.["message.completed"]
    ).toBeTypeOf("function");
  });

  it("posts assistant text the model wrote instead of calling send_message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { context, post } = handlerContext();

    await handleMessageCompleted(
      assistantMessage("Готово, заказ оформлен."),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "Готово, заказ оформлен.",
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[photon] assistant text delivered as fallback",
      { sessionId: "session-1" }
    );
    warn.mockRestore();
  });

  it("ignores the delivery marker the instructions ask for", async () => {
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: "Готово." }),
      context,
      sessionContext()
    );
    post.mockClear();
    await handleMessageCompleted(
      assistantMessage("DELIVERY_COMPLETE"),
      context,
      sessionContext()
    );

    expect(post).not.toHaveBeenCalled();
  });

  it("does not repeat a reply send_message already posted", async () => {
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: "Готово." }),
      context,
      sessionContext()
    );
    post.mockClear();
    await handleMessageCompleted(
      assistantMessage("Готово, заказ оформлен."),
      context,
      sessionContext()
    );

    expect(post).not.toHaveBeenCalled();
  });

  it("does not follow a reaction with the text written after it", async () => {
    const { context, post } = handlerContext();

    await handleActionResult(
      reactToMessageResult({ operation: "add", type: "thumbs_up" }),
      context,
      sessionContext()
    );
    post.mockClear();
    await handleMessageCompleted(
      assistantMessage("Поставил лайк."),
      context,
      sessionContext()
    );

    expect(post).not.toHaveBeenCalled();
  });

  it("still rescues plain text in a later turn after a posted one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: "Готово." }),
      context,
      sessionContext()
    );
    post.mockClear();
    await handleMessageCompleted(
      { ...assistantMessage("Не могу это сделать."), turnId: "turn-2" },
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("drops the delivery marker from rescued plain text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { context, post } = handlerContext();

    await handleMessageCompleted(
      assistantMessage("Не могу это сделать.\nDELIVERY_COMPLETE"),
      context,
      sessionContext()
    );

    expect(JSON.stringify(post.mock.calls)).not.toContain("DELIVERY_COMPLETE");
    expect(post).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("leaves text that only introduces a tool call unposted", async () => {
    const { context, post } = handlerContext();

    await handleMessageCompleted(
      assistantMessage("Сейчас посмотрю.", "tool-calls"),
      context,
      sessionContext()
    );

    expect(post).not.toHaveBeenCalled();
  });

  it("keeps a scheduled report suppressed instead of posting its text", async () => {
    const { context, post } = handlerContext();

    await handleMessageCompleted(
      assistantMessage("Внутренний отчёт."),
      context,
      sessionContext("scheduled-result")
    );

    expect(post).not.toHaveBeenCalled();
    expect(scheduleDeliveryCapture.finalize).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
      "suppressed"
    );
  });

  it("posts send_message output as raw iMessage text", async () => {
    const message = [
      "Still blocked. No order was submitted.",
      "The order remains unchanged:",
      "Spider-Man: Brand New Day",
      "$15.00 total",
    ].join("\n");
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: message }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({ raw: message });
  });

  it("delivers a requested reply as an ordinary message", async () => {
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        replyTo: { kind: "current" },
        text: "Yes, that one.",
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({ raw: "Yes, that one." });
  });

  it("posts a native link preview as a URL-only message", async () => {
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "link", url: "https://example.com/renew" }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "https://example.com/renew",
    });
  });

  it("finalizes a scheduled result after send_message posts it", async () => {
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({ kind: "message", text: "The price fell." }),
      context,
      sessionContext("scheduled-result")
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({ raw: "The price fell." });
    expect(scheduleDeliveryCapture.finalize).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
      "delivered"
    );
  });

  it.each([
    ["image", "image/jpeg", "photo.jpg"],
    ["video", "video/mp4", "clip.mp4"],
    ["audio", "audio/mpeg", "voice.mp3"],
    ["file", "application/pdf", "brief.pdf"],
  ] as const)(
    "uploads a %s attachment as a message file",
    async (kind, mimeType, name) => {
      stubDownloads(() => servedFile(mimeType));
      const { context, post } = handlerContext();
      const url = `https://media.example/${name}`;

      await handleActionResult(
        sendMessageResult({
          attachments: [{ kind, mimeType, name, url }],
          kind: "message",
        }),
        context,
        sessionContext()
      );

      expect(post).toHaveBeenCalledExactlyOnceWith({
        files: [{ data: Buffer.from(fileBytes), filename: name, mimeType }],
        raw: "",
      });
    }
  );

  it("uploads an attachment alongside the message text", async () => {
    stubDownloads(() => servedFile("image/jpeg"));
    const { context, post } = handlerContext();

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

    expect(post).toHaveBeenCalledExactlyOnceWith({
      files: [
        {
          data: Buffer.from(fileBytes),
          filename: "result.jpg",
          mimeType: "image/jpeg",
        },
      ],
      raw: "Here it is.",
    });
  });

  it("posts the links of attachments the upload dropped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubDownloads(() => servedFile("image/jpeg"));
    const { context, post } = handlerContext();
    post.mockRejectedValueOnce(new Error("attachment upload rejected"));

    await handleActionResult(
      sendMessageResult({
        attachments: [
          { kind: "image", url: "https://media.example/first.jpg" },
          { kind: "image", url: "https://media.example/second.jpg" },
        ],
        kind: "message",
        text: "Here they are.",
      }),
      context,
      sessionContext()
    );

    // The adapter posts the words before the files, so only the links repeat.
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[0]).toEqual({
      raw: "https://media.example/first.jpg\nhttps://media.example/second.jpg",
    });
    expect(warn).toHaveBeenCalledWith(
      "[photon] file upload failed",
      expect.objectContaining({ files: 2, sessionId: "session-1" })
    );
    warn.mockRestore();
  });

  it("keeps an attachment it could not download as a link", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubDownloads(() => new Response("", { status: 404 }));
    const { context, post } = handlerContext();

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

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "Here it is.\n\nhttps://media.example/result.png",
    });
    expect(warn).toHaveBeenCalledWith("[photon] attachment delivery failed", {
      reasons: ["http 404"],
      sessionId: "session-1",
    });
    warn.mockRestore();
  });

  it("uploads scoped artifact files with the message", async () => {
    const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    photonChannelCapture.readImage.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "product.png",
      id: artifactId,
      mediaType: "image/png",
    });
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: `Here it is.\n\n![Product](/artifacts/${artifactId})`,
      }),
      context,
      sessionContext()
    );

    expect(photonChannelCapture.readImage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workspaceId: "workspace-1",
      }),
      artifactId,
      { rootSessionId: "session-1", signal: undefined }
    );
    expect(post).toHaveBeenCalledExactlyOnceWith({
      files: [
        {
          data: Buffer.from([1, 2, 3]),
          filename: "product.png",
          mimeType: "image/png",
        },
      ],
      raw: "Here it is.",
    });
  });

  it("uploads scheduled artifacts from the scheduled-run session", async () => {
    const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    photonChannelCapture.readImage.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "scheduled-product.png",
      id: artifactId,
      mediaType: "image/png",
    });
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        replyTo: {
          id: "00000000-0000-4000-8000-000000000003",
          kind: "automation",
        },
        text: `Price changed.\n\n![Product](/artifacts/${artifactId})`,
      }),
      context,
      sessionContext("scheduled-result", "original-message")
    );

    expect(photonChannelCapture.readImage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workspaceId: "workspace-1",
      }),
      artifactId,
      { rootSessionId: "scheduled-run-session", signal: undefined }
    );
    expect(post).toHaveBeenCalledExactlyOnceWith({
      files: [expect.objectContaining({ filename: "scheduled-product.png" })],
      raw: "Price changed.",
    });
  });

  it("sends multiple artifact images as one native attachment gallery", async () => {
    const firstArtifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    const secondArtifactId = "206c3a7e-c0b8-4317-9e34-552cff646673";
    photonChannelCapture.readImage.mockImplementation(
      async (_scope, artifactId) => ({
        bytes: new Uint8Array(
          artifactId === firstArtifactId ? [1, 2, 3] : [4, 5, 6]
        ),
        filename: artifactId === firstArtifactId ? "first.png" : "second.png",
        id: artifactId,
        mediaType: "image/png",
      })
    );
    const { context, post } = handlerContext();

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

    expect(post).toHaveBeenCalledExactlyOnceWith({
      files: [
        {
          data: Buffer.from([1, 2, 3]),
          filename: "first.png",
          mimeType: "image/png",
        },
        {
          data: Buffer.from([4, 5, 6]),
          filename: "second.png",
          mimeType: "image/png",
        },
      ],
      raw: "Two good options.",
    });
  });

  it("explains an artifact that could not be attached", async () => {
    const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    photonChannelCapture.readImage.mockResolvedValue(undefined);
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: `Here it is.\n\n![Product](/artifacts/${artifactId})`,
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "Here it is.\n\nНе получилось приложить файл.",
    });
  });

  it("compiles Markdown into text an iMessage bubble can render", async () => {
    const { context, post } = handlerContext();

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: "## Итог\n- взял [чек](https://example.com/receipt)\n- списал `1290`",
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "Итог\n• взял чек\nhttps://example.com/receipt\n• списал 1290",
    });
  });

  it("posts one bubble per item of a long numbered list, in order", async () => {
    const { context, post } = handlerContext();
    const first = `1. ${"Первое письмо про сборку, которая упала на верификации ".repeat(2)}`;
    const second = `2. ${"Второе письмо про релиз, который ждёт подтверждения ".repeat(2)}`;

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: `Вот письма:\n${first}\n${second}`,
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toEqual({
      raw: `Вот письма:\n${first.trim()}`,
    });
    expect(post.mock.calls[1]?.[0]).toEqual({ raw: second.trim() });
  });

  it("posts a proactive message without a current inbound message", async () => {
    const { context, post } = handlerContext(null);

    await handleActionResult(
      sendMessageResult({
        kind: "message",
        text: "Your weekly summary is ready.",
      }),
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "Your weekly summary is ready.",
    });
  });

  it.each([
    "thumbs_up",
    "thumbs_down",
    "heart",
    "laugh",
    "exclamation",
    "question",
  ] as const)("adds the native %s Tapback", async (type) => {
    const { addReaction, context, post } = handlerContext();

    await handleActionResult(
      reactToMessageResult({ operation: "add", type }),
      context,
      sessionContext()
    );

    expect(addReaction).toHaveBeenCalledExactlyOnceWith(
      "imessage:dm:chat-1",
      "message-1",
      type
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("removes a native Tapback", async () => {
    const { context, post, removeReaction } = handlerContext();

    await handleActionResult(
      reactToMessageResult({ operation: "remove", type: "heart" }),
      context,
      sessionContext()
    );

    expect(removeReaction).toHaveBeenCalledExactlyOnceWith(
      "imessage:dm:chat-1",
      "message-1",
      "heart"
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("requires a native link preview to be its own send_message call", () => {
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "link",
        text: "Read this",
        url: "https://example.com/article",
      }).success
    ).toBe(false);
  });

  it("discriminates native links from message content", () => {
    expect(
      sendMessageOutputSchema.safeParse({
        attachments: [{ kind: "image", url: "https://example.com/image.png" }],
        kind: "message",
        text: "A caption",
      }).success
    ).toBe(true);
    expect(sendMessageOutputSchema.safeParse({ kind: "message" }).success).toBe(
      false
    );
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "message",
        text: "Read this",
        url: "https://example.com/article",
      }).success
    ).toBe(false);
    expect(
      sendMessageOutputSchema.safeParse({
        link: "https://example.com/article",
      }).success
    ).toBe(false);
  });

  it("refuses more attachments than a message can carry", () => {
    const attachments = Array.from({ length: 11 }, (_item, index) => ({
      kind: "image" as const,
      url: `https://media.example/photo-${String(index)}.jpg`,
    }));

    expect(
      sendMessageOutputSchema.safeParse({
        attachments: attachments.slice(0, 10),
        kind: "message",
      }).success
    ).toBe(true);
    expect(
      sendMessageOutputSchema.safeParse({ attachments, kind: "message" })
        .success
    ).toBe(false);
    expect(
      sendMessageOutputSchema.safeParse({ attachments: [], kind: "message" })
        .success
    ).toBe(false);
  });

  it("enforces the native link URL constraints", () => {
    const prefix = "https://example.com/";
    const maximumLengthLink = `${prefix}${"a".repeat(2048 - prefix.length)}`;

    expect(
      sendMessageOutputSchema.safeParse({
        kind: "link",
        url: maximumLengthLink,
      }).success
    ).toBe(true);
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "link",
        url: `${maximumLengthLink}a`,
      }).success
    ).toBe(false);
    expect(
      sendMessageOutputSchema.safeParse({
        kind: "link",
        url: "http://example.com/article",
      }).success
    ).toBe(false);
  });

  it("tells the person Bro is resting when the model provider fails", async () => {
    const { context, post } = handlerContext();

    await handleTurnFailed(modelCallFailure(), context, sessionContext());

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "я прилёг, скоро вернусь",
    });
  });

  it("answers someone writing in English in English", async () => {
    const { context, post } = handlerContext();

    await handleTurnFailed(
      modelCallFailure(),
      context,
      englishSessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "taking a quick nap, back soon",
    });
  });

  // Like Telegram, a failure that is not the provider's still gets a line
  // rather than silence, and «back soon» is kept for real outages.
  it("apologizes for other turn failures", async () => {
    const { context, post } = handlerContext();

    await handleTurnFailed(
      { ...modelCallFailure(), code: "TOOL_FAILED", message: "boom" },
      context,
      sessionContext()
    );

    expect(post).toHaveBeenCalledExactlyOnceWith({
      raw: "Что-то сломалось, пока я разбирался с твоей просьбой. Попробуй ещё раз.",
    });
  });

  it("leaves a failed scheduled report to its retry", async () => {
    const { context, post } = handlerContext();

    await handleTurnFailed(
      modelCallFailure(),
      context,
      sessionContext("scheduled-result")
    );

    expect(post).not.toHaveBeenCalled();
    expect(scheduleDeliveryCapture.release).toHaveBeenCalledOnce();
  });
});

/** Bytes with no signature of their own, so the served media type decides. */
const fileBytes = new Uint8Array(16);

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

function servedFile(mimeType: string) {
  return new Response(new Uint8Array(fileBytes), {
    headers: { "content-type": mimeType },
  });
}

/** Attachment bytes are downloaded before a post, which Photon never does. */
function stubDownloads(respond: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async () => respond())
  );
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

function handlerContext(currentMessageId: string | null = "message-1") {
  const post =
    vi.fn<(message: AdapterPostableMessage) => Promise<{ id: string }>>();
  post.mockResolvedValue({ id: "message-2" });
  const addReaction = vi
    .fn<(threadId: string, messageId: string, emoji: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const removeReaction = vi
    .fn<(threadId: string, messageId: string, emoji: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const context = handlerEventContext({
    bot: {
      getAdapter: () => ({
        addReaction,
        decodeThreadId: () => ({ chatGuid: "dm:chat-1" }),
        removeReaction,
      }),
    },
    state: {},
    streaming: false,
    streamingEditIntervalMs: 1000,
    thread: {
      id: "imessage:dm:chat-1",
      post,
      toJSON: () => ({
        _type: "chat:Thread",
        adapterName: "imessage",
        channelId: "imessage:dm:chat-1",
        currentMessage: currentMessageId ? { id: currentMessageId } : undefined,
        id: "imessage:dm:chat-1",
        isDM: true,
      }),
    },
  });

  return {
    addReaction,
    context,
    post,
    removeReaction,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test adapter deliberately accepts a focused structural fixture.
function handlerEventContext(value: unknown): ActionHandlerParameters[1] {
  // SAFETY: Callers provide every Photon context field exercised by these focused handlers.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Chat SDK bot mock would add 97 unrelated methods.
  return value as ActionHandlerParameters[1];
}

function sessionContext(
  authenticator = "test",
  replyAnchorMessageId?: string,
  currentMessageId: string | null = "message-1"
) {
  const attributes: Record<string, string | readonly string[]> =
    authenticator === "scheduled-result"
      ? {
          conversationChannel: "photon",
          conversationId: "imessage:dm:chat-1",
          scheduleId: "00000000-0000-4000-8000-000000000003",
          scheduledReportLeaseToken: "00000000-0000-4000-8000-000000000004",
          scheduledReportSequence: "1",
          scheduledRunId: "00000000-0000-4000-8000-000000000002",
          scheduledRunSessionId: "scheduled-run-session",
          workspaceId: "workspace-1",
        }
      : {
          conversationChannel: "photon",
          conversationId: "imessage:dm:chat-1",
          workspaceId: "workspace-1",
        };
  if (authenticator !== "scheduled-result" && currentMessageId) {
    attributes.photonMessageId = currentMessageId;
  }
  if (replyAnchorMessageId) {
    attributes.photonReplyAnchorMessageId = replyAnchorMessageId;
  }
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
