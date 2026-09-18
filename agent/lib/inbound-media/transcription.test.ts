import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  syntheticCafLpcm,
  syntheticCafOpus,
} from "@tests/helpers/synthetic-caf";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  OPENROUTER_API_KEY: "openrouter-test-key",
  OPENROUTER_STT_FALLBACK_MODEL: "fallback-stt",
  OPENROUTER_STT_MODEL: "primary-stt",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

/** The OpenRouter request this client is expected to send. */
const requestBodySchema = z.object({
  input_audio: z.object({ data: z.string(), format: z.string() }),
  language: z.string().optional(),
  model: z.string(),
  temperature: z.number(),
});

interface TranscriptionRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly method: string;
}

const fetchMock =
  vi.fn<(url: string, init: TranscriptionRequest) => Promise<Response>>();

function requestAt(index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error("The clip did not reach OpenRouter.");
  const [url, init] = call;
  return { body: requestBodySchema.parse(JSON.parse(init.body)), init, url };
}

function transcript(text: string) {
  return new Response(
    JSON.stringify({ text, usage: { cost: 0.001, seconds: 2 } })
  );
}

function failure(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

async function loadTranscription() {
  return import("@agent/lib/inbound-media/transcription");
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("transcription format", () => {
  it("maps declared audio types, file extensions and sniffed containers", async () => {
    const { transcriptionFormat } = await loadTranscription();
    const silent = new Uint8Array(16);

    expect(transcriptionFormat({ bytes: silent, mediaType: "audio/mp4" })).toBe(
      "m4a"
    );
    expect(
      transcriptionFormat({ bytes: silent, mediaType: "audio/x-m4a" })
    ).toBe("m4a");
    expect(
      transcriptionFormat({ bytes: silent, mediaType: "audio/mpeg" })
    ).toBe("mp3");
    expect(
      transcriptionFormat({ bytes: silent, mediaType: "audio/x-wav" })
    ).toBe("wav");
    expect(
      transcriptionFormat({ bytes: silent, mediaType: "audio/opus" })
    ).toBe("ogg");
    expect(
      transcriptionFormat({
        bytes: silent,
        mediaType: "audio/x-caf; codecs=opus",
      })
    ).toBe("caf");
    expect(transcriptionFormat({ bytes: silent, filename: "note.caf" })).toBe(
      "caf"
    );
    expect(
      transcriptionFormat({
        bytes: silent,
        filename: "v.M4A",
        mediaType: "application/octet-stream",
      })
    ).toBe("m4a");
    expect(transcriptionFormat({ bytes: silent, mediaType: "audio/amr" })).toBe(
      "m4a"
    );
    expect(
      transcriptionFormat({ bytes: silent, mediaType: "image/jpeg" })
    ).toBeUndefined();
    expect(transcriptionFormat({ bytes: silent })).toBeUndefined();
    expect(
      transcriptionFormat({ bytes: mp3, mediaType: "application/octet-stream" })
    ).toBe("mp3");
    expect(
      transcriptionFormat({
        bytes: syntheticCafOpus(),
        mediaType: "audio/mpeg",
      })
    ).toBe("caf");
  });
});

describe("transcription response parsing", () => {
  it("reads the transcript and usage", async () => {
    const { parseTranscriptionResponse } = await loadTranscription();

    expect(
      parseTranscriptionResponse(
        JSON.stringify({ text: "привет", usage: { cost: 0.01, seconds: 1.5 } })
      )
    ).toEqual({ cost: 0.01, kind: "text", seconds: 1.5, text: "привет" });
  });

  it.each([
    [JSON.stringify({ text: "  " }), "empty transcript"],
    [JSON.stringify({ text: "​​" }), "empty transcript"],
    [JSON.stringify({ foo: 1 }), "missing transcript"],
    ["null", "invalid stt response"],
    ["not json", "invalid stt response"],
    [JSON.stringify({ error: { code: 400, message: "nope" } }), "nope"],
    [JSON.stringify({ error: "boom" }), "boom"],
    [JSON.stringify({ error: { code: 500 } }), "stt error"],
  ])("rejects %s as %s", async (body, message) => {
    const { parseTranscriptionResponse } = await loadTranscription();

    expect(parseTranscriptionResponse(body)).toEqual({
      kind: "error",
      message,
    });
  });
});

describe("fallback policy", () => {
  it("retries transient, throttled, and container rejections but not auth or billing", async () => {
    const { shouldRetryWithFallback } = await loadTranscription();

    expect(shouldRetryWithFallback(500, "")).toBe(true);
    expect(shouldRetryWithFallback(503, "oops")).toBe(true);
    expect(shouldRetryWithFallback(429, "")).toBe(true);
    expect(shouldRetryWithFallback(408, "")).toBe(true);
    expect(shouldRetryWithFallback(undefined, "fetch failed")).toBe(true);
    expect(shouldRetryWithFallback(400, "Unsupported format")).toBe(true);
    expect(shouldRetryWithFallback(400, "Provider returned 400")).toBe(true);
    expect(shouldRetryWithFallback(415, "unsupported media")).toBe(true);
    expect(shouldRetryWithFallback(401, "")).toBe(false);
    expect(shouldRetryWithFallback(401, "unsupported format")).toBe(false);
    expect(shouldRetryWithFallback(402, "credits")).toBe(false);
    expect(shouldRetryWithFallback(404, "not found")).toBe(false);
    expect(shouldRetryWithFallback(403, "")).toBe(false);
  });
});

describe("transcribeAudio", () => {
  it("posts the clip as base64 with the language hint and the app headers", async () => {
    fetchMock.mockResolvedValueOnce(transcript("ок"));
    const { transcribeAudio } = await loadTranscription();

    const result = await transcribeAudio({
      bytes: mp3,
      mediaType: "audio/mpeg",
    });

    expect(result).toEqual({
      kind: "transcript",
      model: "primary-stt",
      text: "ок",
    });
    const request = requestAt(0);
    expect(request.url).toBe(
      "https://openrouter.ai/api/v1/audio/transcriptions"
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toEqual({
      authorization: "Bearer openrouter-test-key",
      "content-type": "application/json",
      "HTTP-Referer": "https://openinstinct.example",
      "X-Title": "OpenInstinct",
    });
    expect(request.body).toEqual({
      input_audio: { data: Buffer.from(mp3).toString("base64"), format: "mp3" },
      language: "ru",
      model: "primary-stt",
      temperature: 0,
    });
  });

  it("omits the language when it is set to auto", async () => {
    vi.stubEnv("OPENROUTER_STT_LANGUAGE", "auto");
    fetchMock.mockResolvedValueOnce(transcript("ok"));
    const { transcribeAudio } = await loadTranscription();

    await transcribeAudio({ bytes: mp3, mediaType: "audio/mpeg" });

    expect(requestAt(0).body.language).toBeUndefined();
  });

  it("hands the clip to the fallback model after an upstream failure", async () => {
    fetchMock
      .mockResolvedValueOnce(failure(500, "upstream"))
      .mockResolvedValueOnce(transcript("ок"));
    const { transcribeAudio } = await loadTranscription();

    const result = await transcribeAudio({
      bytes: mp3,
      mediaType: "audio/mpeg",
    });

    expect(result).toEqual({
      kind: "transcript",
      model: "fallback-stt",
      text: "ок",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAt(0).body.model).toBe("primary-stt");
    expect(requestAt(1).body.model).toBe("fallback-stt");
  });

  it("does not retry an unauthorized key", async () => {
    fetchMock.mockResolvedValueOnce(failure(401, "unauthorized"));
    const { transcribeAudio } = await loadTranscription();

    const result = await transcribeAudio({
      bytes: mp3,
      mediaType: "audio/mpeg",
    });

    expect(result).toEqual({ kind: "failed", reason: "unauthorized" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("skips the fallback when it is the same model", async () => {
    vi.stubEnv("OPENROUTER_STT_FALLBACK_MODEL", "primary-stt");
    fetchMock.mockResolvedValueOnce(failure(500, "upstream"));
    const { transcribeAudio } = await loadTranscription();

    const result = await transcribeAudio({
      bytes: mp3,
      mediaType: "audio/mpeg",
    });

    expect(result.kind).toBe("failed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("remuxes an iMessage CAF Opus note to Ogg before sending it", async () => {
    fetchMock.mockResolvedValueOnce(transcript("привет из кафе"));
    const { transcribeAudio } = await loadTranscription();

    const result = await transcribeAudio({
      bytes: syntheticCafOpus(),
      filename: "Audio Message.caf",
      mediaType: "audio/x-caf",
    });

    expect(result).toEqual({
      kind: "transcript",
      model: "primary-stt",
      text: "привет из кафе",
    });
    const sent = Buffer.from(requestAt(0).body.input_audio.data, "base64");
    expect(requestAt(0).body.input_audio.format).toBe("ogg");
    expect(sent.subarray(0, 4).toString()).toBe("OggS");
    expect(sent.toString("latin1")).toContain("OpusHead");
  });

  it("refuses a CAF note whose payload is not Opus without calling out", async () => {
    const { transcribeAudio } = await loadTranscription();

    const result = await transcribeAudio({
      bytes: syntheticCafLpcm(),
      mediaType: "audio/x-caf",
    });

    expect(result).toEqual({ kind: "failed", reason: "unsupported_caf_codec" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a clip that is not audio or is too large", async () => {
    const { transcribeAudio } = await loadTranscription();

    expect(
      await transcribeAudio({
        bytes: new Uint8Array(16),
        mediaType: "image/jpeg",
      })
    ).toEqual({ kind: "failed", reason: "not audio" });
    expect(
      await transcribeAudio({
        bytes: new Uint8Array(25 * 1024 * 1024 + 1),
        mediaType: "audio/mpeg",
      })
    ).toEqual({ kind: "failed", reason: "oversize" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the missing key instead of calling OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const { transcribeAudio, transcriptionAvailable } =
      await loadTranscription();

    expect(transcriptionAvailable()).toBe(false);
    expect(
      await transcribeAudio({ bytes: mp3, mediaType: "audio/mpeg" })
    ).toEqual({
      kind: "failed",
      reason: "missing OPENROUTER_API_KEY",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
