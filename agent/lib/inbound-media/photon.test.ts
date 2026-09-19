import { Message, type Attachment } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { syntheticCafOpus } from "@tests/helpers/synthetic-caf";
import { voiceRetryText, voiceUnsupportedText } from "./turn-content";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  OPENROUTER_API_KEY: "openrouter-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

function reader(bytes: Uint8Array) {
  return vi.fn<() => Promise<Buffer>>(async () => Buffer.from(bytes));
}

/** The JSON body of the transcription request at `index`. */
function transcriptionBody(index: number) {
  return z.string().parse(fetchMock.mock.calls[index]?.[1]?.body);
}

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
]);
const pngBase64 = Buffer.from(png).toString("base64");

/** One spectrum content node as the Photon adapter leaves it on `message.raw`. */
interface RawNode {
  readonly content?: RawNode;
  readonly items?: readonly { readonly content: RawNode }[];
  readonly mimeType?: string;
  readonly name?: string;
  readonly read?: () => Promise<Buffer>;
  readonly text?: string;
  readonly type: string;
}

function photonMessage(
  attachments: readonly Attachment[],
  raw: RawNode | undefined,
  text = ""
) {
  return new Message({
    attachments: [...attachments],
    author: {
      fullName: "+15550100011",
      isBot: false,
      isMe: false,
      userId: "+15550100011",
      userName: "+15550100011",
    },
    formatted: { children: [], type: "root" },
    id: "message-1",
    metadata: { dateSent: new Date("2026-09-03T00:00:00.000Z"), edited: false },
    raw: raw ? { content: raw, id: "message-1" } : {},
    text,
    threadId: "imessage:iMessage;-;+15550100011",
  });
}

async function loadPhotonMedia() {
  return import("@agent/lib/inbound-media/photon");
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Photon media turn", () => {
  it("leaves a text-only message to eve", async () => {
    const { photonMediaTurn } = await loadPhotonMedia();

    await expect(
      photonMediaTurn(photonMessage([], { text: "hi", type: "text" }, "hi"))
    ).resolves.toBeUndefined();
  });

  it("reads a photo through the raw spectrum node and sniffs its type", async () => {
    const read = reader(png);
    const { photonMediaTurn } = await loadPhotonMedia();

    const turn = await photonMediaTurn(
      photonMessage(
        [
          {
            mimeType: "application/octet-stream",
            name: "IMG_0001",
            size: 14,
            type: "file",
          },
        ],
        {
          mimeType: "application/octet-stream",
          name: "IMG_0001",
          read,
          type: "attachment",
        },
        "что на фото?"
      )
    );

    expect(read).toHaveBeenCalledOnce();
    expect(turn?.message).toEqual([
      { text: "что на фото?", type: "text" },
      {
        data: pngBase64,
        filename: "IMG_0001",
        mediaType: "image/png",
        type: "file",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds attachments nested in a reply or a group, in order", async () => {
    const first = reader(png);
    const second = reader(syntheticCafOpus());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: "два" })));
    const { photonMediaTurn } = await loadPhotonMedia();

    const turn = await photonMediaTurn(
      photonMessage(
        [
          { mimeType: "image/png", name: "a.png", size: 14, type: "image" },
          {
            mimeType: "audio/x-caf",
            name: "Audio Message.caf",
            size: 80,
            type: "audio",
          },
        ],
        {
          items: [
            {
              content: {
                mimeType: "image/png",
                name: "a.png",
                read: first,
                type: "attachment",
              },
            },
            { content: { text: "x", type: "text" } },
            {
              content: {
                content: {
                  mimeType: "audio/x-caf",
                  name: "Audio Message.caf",
                  read: second,
                  type: "voice",
                },
                type: "reply",
              },
            },
          ],
          type: "group",
        }
      )
    );

    expect(turn?.message).toEqual([
      { text: "[голосовое] два", type: "text" },
      expect.objectContaining({ mediaType: "image/png", type: "file" }),
    ]);
  });

  it("keeps a node without bytes from shifting the next attachment's bytes", async () => {
    const second = reader(png);
    const { photonMediaTurn } = await loadPhotonMedia();

    const turn = await photonMediaTurn(
      photonMessage(
        [
          { mimeType: "image/png", name: "a.png", size: 14, type: "image" },
          { mimeType: "image/png", name: "b.png", size: 14, type: "image" },
        ],
        {
          items: [
            {
              content: {
                mimeType: "image/png",
                name: "a.png",
                type: "attachment",
              },
            },
            {
              content: {
                mimeType: "image/png",
                name: "b.png",
                read: second,
                type: "attachment",
              },
            },
          ],
          type: "group",
        }
      )
    );

    expect(second).toHaveBeenCalledOnce();
    expect(turn?.message).toEqual([
      { text: "[файл: a.png (image/png), не удалось получить]", type: "text" },
      expect.objectContaining({ filename: "b.png", mediaType: "image/png" }),
    ]);
  });

  it("refuses an attachment by its reported size before reading it", async () => {
    const read = reader(png);
    const { photonMediaTurn } = await loadPhotonMedia();

    const turn = await photonMediaTurn(
      photonMessage(
        [
          {
            mimeType: "image/png",
            name: "big.png",
            size: 3 * 1024 * 1024 + 1,
            type: "image",
          },
        ],
        { mimeType: "image/png", name: "big.png", read, type: "attachment" }
      )
    );

    expect(read).not.toHaveBeenCalled();
    expect(turn?.message).toBe("[файл: big.png (image/png), слишком большой]");
  });

  it("gives a bare .caf file the audio cap rather than the document cap", async () => {
    const read = reader(syntheticCafOpus());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "длинное" }))
    );
    const { photonMediaTurn } = await loadPhotonMedia();

    const turn = await photonMediaTurn(
      photonMessage(
        [{ name: "Audio Message.caf", size: 12 * 1024 * 1024, type: "file" }],
        { name: "Audio Message.caf", read, type: "attachment" }
      )
    );

    expect(read).toHaveBeenCalledOnce();
    expect(turn).toEqual({ message: "[голосовое] длинное", notice: undefined });
  });

  it("transcribes a CAF voice note as Ogg and asks for a retry when it fails", async () => {
    const read = reader(syntheticCafOpus());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "привет" }))
    );
    const { photonMediaTurn } = await loadPhotonMedia();
    const voice = () =>
      photonMessage(
        [
          {
            mimeType: "audio/x-caf",
            name: "Audio Message.caf",
            size: 80,
            type: "audio",
          },
        ],
        {
          mimeType: "audio/x-caf",
          name: "Audio Message.caf",
          read,
          type: "voice",
        }
      );

    await expect(photonMediaTurn(voice())).resolves.toEqual({
      message: "[голосовое] привет",
      notice: undefined,
    });
    expect(transcriptionBody(0)).toContain('"format":"ogg"');

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "no" }), { status: 401 })
    );
    await expect(photonMediaTurn(voice())).resolves.toEqual({
      message: undefined,
      notice: voiceRetryText,
    });
  });

  it("says voice is unsupported without the OpenRouter key and never reads the clip", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const read = reader(syntheticCafOpus());
    const { photonMediaTurn } = await loadPhotonMedia();

    await expect(
      photonMediaTurn(
        photonMessage([{ name: "Audio Message.caf", size: 80, type: "file" }], {
          name: "Audio Message.caf",
          read,
          type: "attachment",
        })
      )
    ).resolves.toEqual({ message: undefined, notice: voiceUnsupportedText });
    expect(read).not.toHaveBeenCalled();
  });

  it("downloads a public HTTPS attachment URL and refuses other schemes", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(png, { headers: { "content-type": "image/png" } })
    );
    const { photonMediaTurn } = await loadPhotonMedia();

    const downloaded = await photonMediaTurn(
      photonMessage(
        [
          {
            mimeType: "image/png",
            name: "a.png",
            type: "image",
            url: "https://cdn.example/a.png",
          },
        ],
        undefined
      )
    );
    expect(downloaded?.message).toEqual([
      { text: "[фото]", type: "text" },
      {
        data: pngBase64,
        filename: "a.png",
        mediaType: "image/png",
        type: "file",
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://cdn.example/a.png"
    );

    const refused = await photonMediaTurn(
      photonMessage(
        [
          {
            mimeType: "image/png",
            name: "a.png",
            type: "image",
            url: "http://cdn.example/a.png",
          },
        ],
        undefined
      )
    );
    expect(refused?.message).toBe(
      "[файл: a.png (image/png), не удалось получить]"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("prefers inline data and a fetcher over the raw reader", async () => {
    const fetchData = reader(png);
    const read = reader(png);
    const { photonMediaTurn } = await loadPhotonMedia();

    const turn = await photonMediaTurn(
      photonMessage(
        [{ fetchData, mimeType: "image/png", name: "a.png", type: "image" }],
        { mimeType: "image/png", name: "a.png", read, type: "attachment" }
      )
    );

    expect(turn?.message).toEqual([
      { text: "[фото]", type: "text" },
      expect.objectContaining({ mediaType: "image/png" }),
    ]);
    expect(fetchData).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("describes a file the model cannot open and one that is too large", async () => {
    const { photonMediaTurn } = await loadPhotonMedia();

    const archive = await photonMediaTurn(
      photonMessage(
        [
          {
            data: Buffer.from(new Uint8Array(20)),
            mimeType: "application/zip",
            name: "a.zip",
            type: "file",
          },
        ],
        undefined
      )
    );
    expect(archive?.message).toBe("[файл: a.zip (application/zip)]");

    const huge = await photonMediaTurn(
      photonMessage(
        [
          {
            data: Buffer.alloc(3 * 1024 * 1024 + 1),
            mimeType: "image/png",
            name: "big.png",
            type: "image",
          },
        ],
        undefined
      )
    );
    expect(huge?.message).toBe("[файл: big.png (image/png), слишком большой]");
  });
});
