import { z } from "zod";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import { cafCodec, cafOpusToOgg } from "./caf-opus";
import { audioByteCap, baseMediaType, sniffMediaType } from "./media-type";

/**
 * Speech to text through OpenRouter's audio endpoint. Bake-off 2026-09-03 on
 * Russian assistant notes (digits, times, brands): Qwen3-ASR-Flash 0.011
 * number-normalised WER at about 1.5 s per clip, GPT-4o Transcribe 0.033 as
 * the quality fallback. Both take m4a and ogg.
 */
const transcriptionsUrl = "https://openrouter.ai/api/v1/audio/transcriptions";
const requestTimeoutMs = 20_000;
/**
 * The whole chain, primary and fallback together, must finish inside this
 * budget: the messenger's webhook handler is waiting on it and would
 * otherwise sit through two full request timeouts.
 */
export const transcriptionBudgetMs = 25_000;
/** A fallback attempt with less time than this left is not worth starting. */
export const fallbackMinimumMs = 5_000;

/** One inbound audio clip together with what the messenger said about it. */
export interface InboundAudio {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly mediaType?: string;
}

export type TranscriptionResult =
  | {
      readonly kind: "transcript";
      readonly model: string;
      readonly text: string;
    }
  | { readonly kind: "failed"; readonly reason: string };

const formatByMediaType: ReadonlyMap<string, string> = new Map([
  ["audio/aac", "aac"],
  ["audio/caf", "caf"],
  ["audio/flac", "flac"],
  ["audio/m4a", "m4a"],
  ["audio/mp3", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/ogg", "ogg"],
  ["audio/opus", "ogg"],
  ["audio/wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/webm", "webm"],
  ["audio/x-caf", "caf"],
  ["audio/x-m4a", "m4a"],
  ["audio/x-wav", "wav"],
]);

const formatByExtension: ReadonlyMap<string, string> = new Map([
  [".aac", "aac"],
  [".caf", "caf"],
  [".flac", "flac"],
  [".m4a", "m4a"],
  [".mp3", "mp3"],
  [".mp4", "m4a"],
  [".oga", "ogg"],
  [".ogg", "ogg"],
  [".opus", "ogg"],
  [".wav", "wav"],
  [".webm", "webm"],
]);

function extensionOf(filename: string | undefined) {
  const dot = filename?.lastIndexOf(".") ?? -1;
  return dot >= 0 && filename ? filename.slice(dot).toLowerCase() : undefined;
}

/**
 * The `input_audio.format` OpenRouter expects, from the bytes first and the
 * declared type or file name second. A declared audio type with no known
 * container is sent as m4a, the most common phone recording.
 */
export function transcriptionFormat(audio: InboundAudio) {
  const sniffed = sniffMediaType(audio.bytes);
  const declared = baseMediaType(audio.mediaType);
  const byBytes = sniffed ? formatByMediaType.get(sniffed) : undefined;
  if (byBytes) return byBytes;
  const byDeclared = declared ? formatByMediaType.get(declared) : undefined;
  if (byDeclared) return byDeclared;
  const extension = extensionOf(audio.filename);
  const byExtension = extension ? formatByExtension.get(extension) : undefined;
  if (byExtension) return byExtension;
  return declared?.startsWith("audio/") === true ? "m4a" : undefined;
}

// OpenRouter answers a rejected clip either with `{ error: "..." }` or with
// the OpenAI-style `{ error: { message } }` object.
const transcriptionErrorSchema = z.union([
  z.string().transform((message) => ({ message })),
  z.object({ message: z.string().optional() }),
]);

const transcriptionResponseSchema = z.object({
  error: transcriptionErrorSchema.nullish(),
  text: z.string().optional(),
  usage: z
    .object({ cost: z.number().optional(), seconds: z.number().optional() })
    .optional(),
});

const invisibleCharacters = /[\u200B-\u200D\uFEFF]/gu;

type ParsedTranscription =
  | {
      readonly kind: "text";
      readonly cost: number | undefined;
      readonly seconds: number | undefined;
      readonly text: string;
    }
  | { readonly kind: "error"; readonly message: string };

/** Reads one transcription response body; an unparseable body is an error. */
export function parseTranscriptionResponse(body: string): ParsedTranscription {
  let json: z.infer<typeof transcriptionResponseSchema>;
  try {
    json = transcriptionResponseSchema.parse(JSON.parse(body));
  } catch {
    return { kind: "error", message: "invalid stt response" };
  }
  if (json.error !== undefined && json.error !== null) {
    const message = json.error.message?.trim();
    return {
      kind: "error",
      message:
        message !== undefined && message.length > 0 ? message : "stt error",
    };
  }
  if (json.text === undefined) {
    return { kind: "error", message: "missing transcript" };
  }
  const text = json.text.replaceAll(invisibleCharacters, "").trim();
  if (text.length === 0) return { kind: "error", message: "empty transcript" };
  return {
    cost: json.usage?.cost,
    kind: "text",
    seconds: json.usage?.seconds,
    text,
  };
}

/**
 * Whether the fallback model gets the clip after the primary failed. Auth and
 * billing failures would fail again; throttling, upstream errors, and a
 * provider that rejects the container are worth one more try.
 */
export function shouldRetryWithFallback(
  status: number | undefined,
  message: string
) {
  if (status === undefined) return true;
  if (status === 401 || status === 402) return false;
  if (status === 429 || status === 408) return true;
  if (status >= 500 && status < 600) return true;
  // OpenRouter wraps upstream rejects as a bare "Provider returned 400".
  if (status === 400) return true;
  if (status >= 400 && status < 500) {
    return /unsupported|format|model|codec/u.test(message.toLowerCase());
  }
  return false;
}

/** Voice notes can be transcribed only when the OpenRouter key is set. */
export function transcriptionAvailable() {
  return env.OPENROUTER_API_KEY !== undefined;
}

function transcriptionLanguage() {
  const language = env.OPENROUTER_STT_LANGUAGE;
  return language.toLowerCase() === "auto" ? undefined : language;
}

/** The body OpenRouter's transcription endpoint receives for one clip. */
interface TranscriptionRequest {
  input_audio: { data: string; format: string };
  language?: string;
  model: string;
  temperature: number;
}

type TranscriptionAttempt =
  | {
      readonly ok: true;
      readonly cost?: number;
      readonly seconds?: number;
      readonly text: string;
    }
  | { readonly ok: false; readonly error: string; readonly status?: number };

async function transcribeOnce(
  apiKey: string,
  model: string,
  data: string,
  format: string,
  timeoutMs: number
): Promise<TranscriptionAttempt> {
  const body: TranscriptionRequest = {
    input_audio: { data, format },
    model,
    temperature: 0,
  };
  const language = transcriptionLanguage();
  if (language) body.language = language;
  let response: Response;
  let text: string;
  try {
    response = await fetch(transcriptionsUrl, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": applicationOrigin(),
        "X-Title": "OpenInstinct",
      },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The timeout signal also aborts the body stream, so a stalled body
    // fails here like a stalled request.
    text = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message || error.name : "";
    return { error: message || "fetch failed", ok: false };
  }
  const parsed = parseTranscriptionResponse(text);
  if (parsed.kind === "error") {
    return { error: parsed.message, ok: false, status: response.status };
  }
  if (!response.ok) {
    return {
      error: `http ${String(response.status)}`,
      ok: false,
      status: response.status,
    };
  }
  return {
    cost: parsed.cost,
    ok: true,
    seconds: parsed.seconds,
    text: parsed.text,
  };
}

/** Bytes and format as OpenRouter takes them; CAF Opus is remuxed to Ogg. */
function prepareAudio(audio: InboundAudio):
  | {
      readonly kind: "audio";
      readonly bytes: Uint8Array;
      readonly format: string;
    }
  | { readonly kind: "failed"; readonly reason: string } {
  const format = transcriptionFormat(audio);
  if (format === undefined) return { kind: "failed", reason: "not audio" };
  if (format !== "caf") return { bytes: audio.bytes, format, kind: "audio" };
  if (cafCodec(audio.bytes) !== "opus") {
    return { kind: "failed", reason: "unsupported_caf_codec" };
  }
  try {
    return { bytes: cafOpusToOgg(audio.bytes), format: "ogg", kind: "audio" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "caf remux failed";
    return { kind: "failed", reason };
  }
}

/**
 * Transcribes one clip, trying the fallback model once when the primary
 * model's failure looks transient or container-specific and enough of the
 * {@link transcriptionBudgetMs} is left for it.
 */
export async function transcribeAudio(
  audio: InboundAudio
): Promise<TranscriptionResult> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (apiKey === undefined) {
    return { kind: "failed", reason: "missing OPENROUTER_API_KEY" };
  }
  if (audio.bytes.byteLength > audioByteCap) {
    return { kind: "failed", reason: "oversize" };
  }
  const prepared = prepareAudio(audio);
  if (prepared.kind === "failed") return prepared;

  const startedAt = Date.now();
  const deadline = startedAt + transcriptionBudgetMs;
  const data = Buffer.from(prepared.bytes).toString("base64");
  const primary = env.OPENROUTER_STT_MODEL;
  const fallback = env.OPENROUTER_STT_FALLBACK_MODEL;
  const models = fallback === primary ? [primary] : [primary, fallback];

  let lastReason = "stt failed";
  let lastModel = primary;
  for (const [index, model] of models.entries()) {
    const remainingMs = deadline - Date.now();
    if (index > 0 && remainingMs < fallbackMinimumMs) {
      lastReason = `${lastReason}; fallback skipped, budget exhausted`;
      break;
    }
    lastModel = model;
    // oxlint-disable-next-line eslint/no-await-in-loop -- The fallback model runs only after the primary answered.
    const attempt = await transcribeOnce(
      apiKey,
      model,
      data,
      prepared.format,
      Math.max(1, Math.min(requestTimeoutMs, remainingMs))
    );
    if (attempt.ok) {
      console.info("[inbound-media] voice transcribed", {
        chars: attempt.text.length,
        cost: attempt.cost,
        model,
        ms: Date.now() - startedAt,
        seconds: attempt.seconds,
      });
      return { kind: "transcript", model, text: attempt.text };
    }
    lastReason = attempt.error;
    const retry =
      index === 0 &&
      models.length > 1 &&
      shouldRetryWithFallback(attempt.status, attempt.error);
    if (!retry) break;
  }
  console.warn("[inbound-media] voice transcription failed", {
    model: lastModel,
    reason: lastReason,
  });
  return { kind: "failed", reason: lastReason };
}
