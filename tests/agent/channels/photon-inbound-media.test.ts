import type { PhotonIMessageChannelConfig } from "eve/channels/photon";
import { Message, type Attachment } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as EnvModule from "@shared/environment";
import { syntheticCafOpus } from "@tests/helpers/synthetic-caf";
// oxlint-disable-next-line import/no-unassigned-import -- Loads the production module so the mocked channel factory can capture its configuration.
import "@agent/channels/photon";

const capture = vi.hoisted(() => ({
  // SAFETY: The mocked channel factory replaces this value during module loading.
  config: undefined as PhotonIMessageChannelConfig | undefined,
  ensureUser:
    vi.fn<() => Promise<{ created: boolean; userId: string } | undefined>>(),
  // The channel reads the key at message time, so a test flips it in place.
  // SAFETY: The mock factory fills this object with the real environment before any test runs.
  env: {} as Record<string, string | undefined>,
  messageQuotaGate: vi.fn<
    () => Promise<{
      allowed: boolean;
      paywallText: string | undefined;
    }>
  >(),
  markRead: vi.fn<(threadId: string, messageId: string) => Promise<void>>(),
  post: vi.fn<InboundContext["thread"]["post"]>(),
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  Object.assign(capture.env, original.env, {
    IMESSAGE_PROJECT_ID: "photon-test-project",
    IMESSAGE_PROJECT_SECRET: "photon-test-secret",
    IMESSAGE_WEBHOOK_SECRET: "photon-test-webhook-secret",
    OPENROUTER_API_KEY: "openrouter-test-key",
  });
  return { ...original, env: capture.env };
});
vi.mock(import("eve/channels/photon"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    photonIMessageChannel(config: PhotonIMessageChannelConfig) {
      capture.config = config;
      return original.photonIMessageChannel(config);
    },
  };
});
vi.mock("@db/services/auth/phone-user", () => ({
  ensureVerifiedPhoneUser: capture.ensureUser,
}));
vi.mock("@agent/lib/billing/quota", () => ({
  messageQuotaGate: capture.messageQuotaGate,
}));

const onMessage = capture.config?.onMessage;
if (!onMessage) {
  throw new Error("The Photon channel must route inbound messages.");
}

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

function reader(bytes: Uint8Array) {
  return vi.fn<() => Promise<Buffer>>(async () => Buffer.from(bytes));
}

const postedText = z.object({ raw: z.string() });

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
]);

describe("Photon inbound media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    capture.env.OPENROUTER_API_KEY = "openrouter-test-key";
    capture.ensureUser.mockResolvedValue({ created: false, userId: "user-1" });
    capture.messageQuotaGate.mockResolvedValue({
      allowed: true,
      paywallText: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves a text message to eve's default turn", async () => {
    const result = await onMessage(
      threadContext(),
      photonMessage({ text: "list my vault items" })
    );

    expect(result?.auth?.principalId).toBe("better-auth:user-1");
    expect(result).not.toHaveProperty("message");
  });

  it("reads a photo from the Photon message and keeps the first-contact context", async () => {
    capture.ensureUser.mockResolvedValue({ created: true, userId: "user-new" });
    const read = reader(png);

    const result = await onMessage(
      threadContext(),
      photonMessage({
        attachments: [
          { mimeType: "image/png", name: "IMG_1.png", size: 14, type: "image" },
        ],
        raw: {
          content: {
            mimeType: "image/png",
            name: "IMG_1.png",
            read,
            type: "attachment",
          },
        },
      })
    );

    expect(capture.post).not.toHaveBeenCalled();
    expect(result?.context?.join("\n")).toContain("`first-contact`");
    expect(result?.message).toEqual([
      { text: "[фото]", type: "text" },
      {
        data: Buffer.from(png),
        filename: "IMG_1.png",
        mediaType: "image/png",
        type: "file",
      },
    ]);
  });

  it("transcribes an iMessage voice note into the turn text", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ text: "привет" }))
    );
    const read = reader(syntheticCafOpus());

    const result = await onMessage(
      threadContext(),
      photonMessage({
        attachments: [
          {
            mimeType: "audio/x-caf",
            name: "Audio Message.caf",
            size: 80,
            type: "audio",
          },
        ],
        raw: {
          content: {
            mimeType: "audio/x-caf",
            name: "Audio Message.caf",
            read,
            type: "voice",
          },
        },
      })
    );

    expect(result?.message).toBe("[голосовое] привет");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://openrouter.ai/api/v1/audio/transcriptions"
    );
  });

  it("asks for a retry, marks the message read and skips the turn when the voice note is unusable", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    const read = reader(syntheticCafOpus());

    await expect(
      onMessage(
        threadContext(),
        photonMessage({
          attachments: [{ name: "Audio Message.caf", size: 80, type: "audio" }],
          raw: { content: { name: "Audio Message.caf", read, type: "voice" } },
        })
      )
    ).resolves.toBeNull();

    expect(capture.post).toHaveBeenCalledOnce();
    expect(postedText.parse(capture.post.mock.calls[0]?.[0]).raw).toContain(
      "Не расслышал голосовое"
    );
    expect(capture.markRead).toHaveBeenCalledExactlyOnceWith(
      "imessage:iMessage;-;+15550100011",
      "message-1"
    );
  });

  it("still opens the first-contact turn when the very first message is an unusable voice note", async () => {
    capture.ensureUser.mockResolvedValue({ created: true, userId: "user-new" });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    const read = reader(syntheticCafOpus());

    const result = await onMessage(
      threadContext(),
      photonMessage({
        attachments: [{ name: "Audio Message.caf", size: 80, type: "audio" }],
        raw: { content: { name: "Audio Message.caf", read, type: "voice" } },
      })
    );

    expect(capture.post).toHaveBeenCalledOnce();
    expect(result?.context?.join("\n")).toContain("`first-contact`");
    expect(result?.message).toBe("[голосовое не распозналось]");
    expect(capture.markRead).not.toHaveBeenCalled();
  });

  it("says voice is unsupported when the deployment has no OpenRouter key", async () => {
    capture.env.OPENROUTER_API_KEY = undefined;
    const read = reader(syntheticCafOpus());

    await expect(
      onMessage(
        threadContext(),
        photonMessage({
          attachments: [{ name: "Audio Message.caf", size: 80, type: "audio" }],
          raw: { content: { name: "Audio Message.caf", read, type: "voice" } },
        })
      )
    ).resolves.toBeNull();

    expect(read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postedText.parse(capture.post.mock.calls[0]?.[0]).raw).toContain(
      "не поддерживаются"
    );
  });
});

type InboundContext = Parameters<
  NonNullable<PhotonIMessageChannelConfig["onMessage"]>
>[0];

interface ThreadIdentity {
  readonly thread: Pick<InboundContext["thread"], "id" | "post"> & {
    /** The iMessage adapter's read receipt, the only adapter call the policy makes. */
    readonly adapter: { readonly markRead: typeof capture.markRead };
  };
}

function threadContext() {
  const identity: ThreadIdentity = {
    thread: {
      adapter: { markRead: capture.markRead },
      id: "imessage:iMessage;-;+15550100011",
      post: capture.post,
    },
  };
  return focusedInboundContext(identity);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test adapter deliberately accepts a focused structural fixture.
function focusedInboundContext(value: unknown): InboundContext {
  // SAFETY: The inbound policy reads only the thread id, `post` and the adapter's read receipt from this context.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Chat SDK thread mock would add unrelated methods.
  return value as InboundContext;
}

/** One spectrum content node as the Photon adapter leaves it on `message.raw`. */
interface RawNode {
  readonly mimeType?: string;
  readonly name?: string;
  readonly read?: () => Promise<Buffer>;
  readonly type: string;
}

function photonMessage(options: {
  readonly attachments?: readonly Attachment[];
  readonly raw?: { readonly content: RawNode };
  readonly text?: string;
}) {
  return new Message({
    attachments: [...(options.attachments ?? [])],
    author: {
      fullName: "+15550100011",
      isBot: false,
      isMe: false,
      userId: "+15550100011",
      userName: "+15550100011",
    },
    formatted: { children: [], type: "root" },
    id: "message-1",
    metadata: {
      dateSent: new Date("2026-09-03T00:00:00.000Z"),
      edited: false,
    },
    raw: options.raw ?? {},
    text: options.text ?? "",
    threadId: "imessage:iMessage;-;+15550100011",
  });
}
