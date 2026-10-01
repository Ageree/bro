import { z } from "zod";
import { modelEndpoint } from "@agent/lib/model/endpoint";
import {
  failureStatus,
  reportedErrorSchema,
} from "@agent/lib/model/routerai/errors";
import { cafCodec, cafOpusToOgg } from "./caf-opus";
import { audioByteCap, baseMediaType, sniffMediaType } from "./media-type";

/**
 * Speech to text through the direct model provider's
 * `/audio/transcriptions`. OpenRouter takes the clip as JSON `input_audio`;
 * RouterAI takes the OpenAI multipart form (`file`, `model`, `language`) and
 * answered every speech model of its catalogue that way (probes of 01.10).
 * Bake-off 2026-09-03 on Russian assistant notes (digits, times, brands):
 * Qwen3-ASR-Flash 0.011 number-normalised WER at about 1.5 s per clip,
 * GPT-4o Transcribe 0.033 as the quality fallback. Both take m4a and ogg.
 */
const transcriptionsPath = "/audio/transcriptions";
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

/** The media type a multipart `file` part declares for each format. */
const mediaTypeByFormat: ReadonlyMap<string, string> = new Map([
  ["aac", "audio/aac"],
  ["flac", "audio/flac"],
  ["m4a", "audio/mp4"],
  ["mp3", "audio/mpeg"],
  ["ogg", "audio/ogg"],
  ["wav", "audio/wav"],
  ["webm", "audio/webm"],
]);

/**
 * The clip's format as the provider names it (OpenRouter's
 * `input_audio.format`, the file extension of RouterAI's upload), from the
 * bytes first and the declared type or file name second. A declared audio
 * type with no known container is sent as m4a, the most common phone
 * recording.
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

// A rejected clip comes back as the OpenAI-style `{ error: { message } }`, as
// `{ error: "text" }`, or, from RouterAI, as `{ error: "<the upstream's JSON
// answer as text>" }` whose `code` is the real status, often under HTTP 200.
const transcriptionResponseSchema = z.object({
  error: reportedErrorSchema.nullish(),
  id: z.string().optional(),
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
      /** Looks the cost up in `/generation` when the answer carries none. */
      readonly generationId: string | undefined;
      readonly seconds: number | undefined;
      readonly text: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      /** The HTTP failure status the error's own code names, if any. */
      readonly status?: number | undefined;
    };

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
    const status = failureStatus(json.error.code);
    return {
      kind: "error",
      message:
        message !== undefined && message.length > 0 ? message : "stt error",
      status,
    };
  }
  if (json.text === undefined) {
    return { kind: "error", message: "missing transcript" };
  }
  const text = json.text.replaceAll(invisibleCharacters, "").trim();
  if (text.length === 0) return { kind: "error", message: "empty transcript" };
  return {
    cost: json.usage?.cost,
    generationId: json.id,
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

/** Voice notes are transcribed only by a direct provider, not the Gateway. */
export function transcriptionAvailable() {
  return modelEndpoint() !== undefined;
}

type Endpoint = NonNullable<ReturnType<typeof modelEndpoint>>;

function transcriptionLanguage(endpoint: Endpoint) {
  const language = endpoint.sttLanguage;
  return language.toLowerCase() === "auto" ? undefined : language;
}

/** The body OpenRouter's transcription endpoint receives for one clip. */
interface OpenRouterTranscriptionRequest {
  input_audio: { data: string; format: string };
  language?: string;
  model: string;
  temperature: number;
}

/** The clip in the body this provider's transcription endpoint takes. */
function transcriptionBody(
  endpoint: Endpoint,
  model: string,
  audio: PreparedAudio
) {
  const language = transcriptionLanguage(endpoint);
  if (endpoint.provider === "routerai") {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from(audio.bytes)], {
        type: mediaTypeByFormat.get(audio.format) ?? "application/octet-stream",
      }),
      `voice.${audio.format}`
    );
    form.append("model", model);
    if (language) form.append("language", language);
    form.append("temperature", "0");
    // fetch writes the multipart content type with its boundary itself.
    return { body: form, contentType: undefined };
  }
  const body: OpenRouterTranscriptionRequest = {
    input_audio: {
      data: Buffer.from(audio.bytes).toString("base64"),
      format: audio.format,
    },
    model,
    temperature: 0,
  };
  if (language) body.language = language;
  return {
    body: JSON.stringify(body),
    contentType: "application/json",
  };
}

type TranscriptionAttempt =
  | (Extract<ParsedTranscription, { kind: "text" }> & { readonly ok: true })
  | { readonly ok: false; readonly error: string; readonly status?: number };

async function transcribeOnce(
  endpoint: Endpoint,
  model: string,
  audio: PreparedAudio,
  timeoutMs: number
): Promise<TranscriptionAttempt> {
  const { body, contentType } = transcriptionBody(endpoint, model, audio);
  const headers = new Headers(endpoint.headers);
  headers.set("authorization", `Bearer ${endpoint.apiKey}`);
  if (contentType) headers.set("content-type", contentType);
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${endpoint.baseURL}${transcriptionsPath}`, {
      body,
      headers,
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
    // An error under HTTP 200 is a failure still: its own code is the
    // status, and one without a code reads as an upstream failure.
    const status = response.ok ? (parsed.status ?? 502) : response.status;
    return { error: parsed.message, ok: false, status };
  }
  if (!response.ok) {
    return {
      error: `http ${String(response.status)}`,
      ok: false,
      status: response.status,
    };
  }
  return { ...parsed, ok: true };
}

interface PreparedAudio {
  readonly bytes: Uint8Array;
  readonly format: string;
}

/** Bytes and format as the provider takes them; CAF Opus is remuxed to Ogg. */
function prepareAudio(
  audio: InboundAudio
):
  | (PreparedAudio & { readonly kind: "audio" })
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
  const endpoint = modelEndpoint();
  if (endpoint === undefined) {
    return { kind: "failed", reason: "no direct model provider" };
  }
  if (audio.bytes.byteLength > audioByteCap) {
    return { kind: "failed", reason: "oversize" };
  }
  const prepared = prepareAudio(audio);
  if (prepared.kind === "failed") return prepared;

  const startedAt = Date.now();
  const deadline = startedAt + transcriptionBudgetMs;
  const primary = endpoint.sttModel;
  const fallback = endpoint.sttFallbackModel;
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
      endpoint,
      model,
      prepared,
      Math.max(1, Math.min(requestTimeoutMs, remainingMs))
    );
    if (attempt.ok) {
      console.info("[inbound-media] voice transcribed", {
        chars: attempt.text.length,
        cost: attempt.cost,
        // RouterAI bills in roubles, OpenRouter in dollars.
        costCurrency: endpoint.costCurrency,
        generationId: attempt.generationId,
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
    backend: endpoint.provider,
    model: lastModel,
    reason: lastReason,
  });
  return { kind: "failed", reason: lastReason };
}
