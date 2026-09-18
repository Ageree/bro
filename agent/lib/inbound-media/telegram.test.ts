import type { TelegramMessage } from "eve/channels/telegram";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { syntheticCafOpus } from "@tests/helpers/synthetic-caf";
import { voiceRetryText, voiceUnsupportedText } from "./turn-content";

const botToken = "123456:telegram-test-bot-token";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  OPENROUTER_API_KEY: "openrouter-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  TELEGRAM_BOT_TOKEN: botToken,
};

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();
const infoSpy = vi.spyOn(console, "info");

const jpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1,
]);
const ogg = new Uint8Array([
  0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const pdf = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3,
]);

/** Serves the Bot API: `getFile` resolves every id to a path, the file endpoint serves `files`. */
function serveTelegram(
  files: Readonly<
    Record<
      string,
      { readonly bytes: Uint8Array; readonly contentType?: string }
    >
  >,
  transcription?: () => Response
) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `https://api.telegram.org/bot${botToken}/getFile`) {
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: "files/next" } })
      );
    }
    if (url.startsWith(`https://api.telegram.org/file/bot${botToken}/`)) {
      const file = files[url.slice(url.lastIndexOf("/") + 1)];
      if (!file) return new Response("not found", { status: 404 });
      const headers = new Headers();
      if (file.contentType) headers.set("content-type", file.contentType);
      return new Response(new Uint8Array(file.bytes), { headers });
    }
    if (url === "https://openrouter.ai/api/v1/audio/transcriptions") {
      return transcription?.() ?? new Response("{}", { status: 500 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function telegramMessage(raw: TelegramMessage["raw"], text = "", caption = "") {
  const message: TelegramMessage = {
    attachments: [],
    caption,
    chat: { id: "4242", type: "private" },
    from: { id: "9001", isBot: false },
    messageId: "77",
    raw,
    text,
  };
  return message;
}

/** The JSON body of the one transcription request, if any was made. */
function transcriptionBody() {
  const call = fetchMock.mock.calls.find(([url]) =>
    String(url).includes("openrouter.ai")
  );
  return z.string().parse(call?.[1]?.body);
}

async function loadTelegramMedia() {
  return import("@agent/lib/inbound-media/telegram");
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  infoSpy.mockReset().mockImplementation(() => undefined);
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

describe("Telegram photo size selection", () => {
  it("takes the largest rendition under the inline cap, else the smallest", async () => {
    const { choosePhotoSize } = await loadTelegramMedia();
    const cap = 3 * 1024 * 1024;

    expect(
      choosePhotoSize([
        { file_id: "s", file_size: 1_000, height: 90, width: 90 },
        { file_id: "m", file_size: 50_000, height: 320, width: 320 },
        { file_id: "l", file_size: cap + 1, height: 1280, width: 1280 },
      ])?.file_id
    ).toBe("m");
    expect(
      choosePhotoSize([
        { file_id: "l", file_size: cap + 5 },
        { file_id: "xl", file_size: cap + 9 },
      ])?.file_id
    ).toBe("l");
    expect(choosePhotoSize([])).toBeUndefined();
  });
});

describe("Telegram media turn", () => {
  it("leaves a text message to eve", async () => {
    const { telegramMediaTurn } = await loadTelegramMedia();

    await expect(
      telegramMediaTurn(telegramMessage({ message_id: 77, text: "hi" }, "hi"))
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads the photo and trusts the bytes over the served content type", async () => {
    serveTelegram({
      next: { bytes: jpeg, contentType: "application/octet-stream" },
    });
    const { telegramMediaTurn } = await loadTelegramMedia();

    const turn = await telegramMediaTurn(
      telegramMessage({
        photo: [
          { file_id: "small", file_size: 900, height: 90, width: 90 },
          { file_id: "large", file_size: 40_000, height: 800, width: 800 },
        ],
      })
    );

    expect(turn?.notice).toBeUndefined();
    expect(turn?.message).toEqual([
      { text: "[фото]", type: "text" },
      {
        data: jpeg,
        filename: "photo.jpg",
        mediaType: "image/jpeg",
        type: "file",
      },
    ]);
    const getFile = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/getFile")
    );
    expect(getFile?.[1]?.body).toBe(JSON.stringify({ file_id: "large" }));
    expect(infoSpy).toHaveBeenCalledExactlyOnceWith(
      "[inbound-media] telegram photo",
      {
        bytes: jpeg.byteLength,
        mediaType: "image/jpeg",
        status: "ok",
      }
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(botToken);
  });

  it("keeps the caption and reports a photo that could not be downloaded", async () => {
    serveTelegram({});
    const { telegramMediaTurn } = await loadTelegramMedia();

    const turn = await telegramMediaTurn(
      telegramMessage(
        { caption: "смотри", photo: [{ file_id: "p", file_size: 10 }] },
        "",
        "смотри"
      )
    );

    expect(turn?.message).toBe(
      "смотри\n[файл: photo.jpg (image/jpeg), не удалось скачать]"
    );
  });

  it("turns a PDF document into a file part and describes other documents", async () => {
    serveTelegram({ next: { bytes: pdf, contentType: "application/pdf" } });
    const { telegramMediaTurn } = await loadTelegramMedia();

    const scan = await telegramMediaTurn(
      telegramMessage({
        document: {
          file_id: "d",
          file_name: "scan.pdf",
          file_size: 12,
          mime_type: "application/pdf",
        },
      })
    );
    expect(scan?.message).toEqual([
      { text: "[документ]", type: "text" },
      {
        data: pdf,
        filename: "scan.pdf",
        mediaType: "application/pdf",
        type: "file",
      },
    ]);

    const archive = await telegramMediaTurn(
      telegramMessage({
        document: {
          file_id: "z",
          file_name: "a.zip",
          file_size: 12,
          mime_type: "application/zip",
        },
      })
    );
    expect(archive?.message).toBe("[файл: a.zip (application/zip)]");
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/getFile"))
    ).toHaveLength(1);
  });

  it("transcribes a voice note into the turn text", async () => {
    serveTelegram(
      { next: { bytes: ogg, contentType: "audio/ogg" } },
      () => new Response(JSON.stringify({ text: "купи хлеб" }))
    );
    const { telegramMediaTurn } = await loadTelegramMedia();

    const turn = await telegramMediaTurn(
      telegramMessage({
        voice: {
          duration: 2,
          file_id: "v",
          file_size: 14,
          mime_type: "audio/ogg",
        },
      })
    );

    expect(turn).toEqual({
      message: "[голосовое] купи хлеб",
      notice: undefined,
    });
    expect(transcriptionBody()).toContain('"format":"ogg"');
  });

  it("asks for a retry when the voice note could not be transcribed", async () => {
    serveTelegram(
      { next: { bytes: ogg } },
      () => new Response(JSON.stringify({ error: "nope" }), { status: 401 })
    );
    const { telegramMediaTurn } = await loadTelegramMedia();

    await expect(
      telegramMediaTurn(
        telegramMessage({ voice: { file_id: "v", file_size: 14 } })
      )
    ).resolves.toEqual({ message: undefined, notice: voiceRetryText });
  });

  it("says voice is unsupported without the OpenRouter key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    serveTelegram({});
    const { telegramMediaTurn } = await loadTelegramMedia();

    await expect(
      telegramMediaTurn(
        telegramMessage({ audio: { file_id: "a", file_name: "song.mp3" } })
      )
    ).resolves.toEqual({ message: undefined, notice: voiceUnsupportedText });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transcribes a video note as an m4a clip", async () => {
    serveTelegram(
      { next: { bytes: new Uint8Array(16), contentType: "video/mp4" } },
      () => new Response(JSON.stringify({ text: "видео" }))
    );
    const { telegramMediaTurn } = await loadTelegramMedia();

    const turn = await telegramMediaTurn(
      telegramMessage({ video_note: { file_id: "n", file_size: 16 } })
    );

    expect(turn?.message).toBe("[голосовое] видео");
    expect(transcriptionBody()).toContain('"format":"m4a"');
  });

  it("remuxes a CAF audio file before transcription", async () => {
    serveTelegram(
      { next: { bytes: syntheticCafOpus() } },
      () => new Response(JSON.stringify({ text: "кафе" }))
    );
    const { telegramMediaTurn } = await loadTelegramMedia();

    const turn = await telegramMediaTurn(
      telegramMessage({ audio: { file_id: "c", file_name: "note.caf" } })
    );

    expect(turn?.message).toBe("[голосовое] кафе");
    expect(transcriptionBody()).toContain('"format":"ogg"');
  });
});
