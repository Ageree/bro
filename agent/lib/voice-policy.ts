/** OpenRouter STT policy: format map, env, retry, user-facing copy. No I/O. */

/** Bake-off 2026-09-03 on Russian assistant notes (digits, times, brands):
 *  Qwen3-ASR-Flash 0.011 number-normalized WER, ~1.5 s, $0.001/30 s;
 *  GPT-4o Transcribe 0.033 as the quality fallback. Both take m4a and ogg. */
export const DEFAULT_STT_MODEL = "qwen/qwen3-asr-flash-2026-02-10";
export const DEFAULT_STT_FALLBACK_MODEL = "openai/gpt-4o-transcribe";
export const DEFAULT_STT_TIMEOUT_MS = 20_000;
export const DEFAULT_STT_MAX_BYTES = 25 * 1024 * 1024;

/** Sent when every voice note fails STT and the message has no other text. */
export const VOICE_FAILED_REPLY =
  "Не расслышал голосовое 🙈 Напиши текстом, пожалуйста — или запиши ещё раз.";

export type SttFormat = {
  format: string;
  remux?: "caf";
  guessed?: true;
};

export type SttConfig = {
  model: string;
  fallbackModel: string;
  language: string | undefined;
  timeoutMs: number;
  maxBytes: number;
};

const MIME_FORMAT: Record<string, SttFormat> = {
  "audio/mp4": { format: "m4a" },
  "audio/x-m4a": { format: "m4a" },
  "audio/m4a": { format: "m4a" },
  "audio/mpeg": { format: "mp3" },
  "audio/mp3": { format: "mp3" },
  "audio/wav": { format: "wav" },
  "audio/x-wav": { format: "wav" },
  "audio/wave": { format: "wav" },
  "audio/ogg": { format: "ogg" },
  "audio/opus": { format: "ogg" },
  "audio/webm": { format: "webm" },
  "audio/aac": { format: "aac" },
  "audio/flac": { format: "flac" },
  "audio/x-caf": { format: "ogg", remux: "caf" },
  "audio/caf": { format: "ogg", remux: "caf" },
};

const EXT_FORMAT: Record<string, SttFormat> = {
  ".m4a": { format: "m4a" },
  ".mp4": { format: "m4a" },
  ".mp3": { format: "mp3" },
  ".wav": { format: "wav" },
  ".ogg": { format: "ogg" },
  ".opus": { format: "ogg" },
  ".webm": { format: "webm" },
  ".aac": { format: "aac" },
  ".flac": { format: "flac" },
  ".caf": { format: "ogg", remux: "caf" },
};

function mimeType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

function extFromUrl(url: string | null | undefined): string {
  if (!url) return "";
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    const q = url.indexOf("?");
    path = q >= 0 ? url.slice(0, q) : url;
  }
  const base = path.toLowerCase();
  const slash = base.lastIndexOf("/");
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot < slash) return "";
  return base.slice(dot);
}

export function sttFormatFor(opts: {
  contentType?: string | null;
  url?: string | null;
}): SttFormat | null {
  const mime = mimeType(opts.contentType);
  if (mime && !mime.startsWith("audio/")) return null;
  const mapped = MIME_FORMAT[mime];
  if (mapped) return { ...mapped };
  const ext = EXT_FORMAT[extFromUrl(opts.url)];
  if (ext) return { ...ext };
  if (mime.startsWith("audio/")) return { format: "m4a", guessed: true };
  return null;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function sttConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): SttConfig {
  const model = env.BRO_STT_MODEL?.trim() || DEFAULT_STT_MODEL;
  const fallbackModel =
    env.BRO_STT_FALLBACK_MODEL?.trim() || DEFAULT_STT_FALLBACK_MODEL;
  const rawLang = env.BRO_STT_LANGUAGE;
  const trimmed = rawLang === undefined ? "ru" : rawLang.trim();
  const language =
    !trimmed || trimmed.toLowerCase() === "auto" ? undefined : trimmed;
  return {
    model,
    fallbackModel,
    language,
    timeoutMs: positiveInt(env.BRO_STT_TIMEOUT_MS, DEFAULT_STT_TIMEOUT_MS),
    maxBytes: positiveInt(env.BRO_STT_MAX_BYTES, DEFAULT_STT_MAX_BYTES),
  };
}

export function parseSttResponse(
  json: unknown,
): { text: string; cost?: number; seconds?: number } | { error: string } {
  if (json === null || typeof json !== "object") {
    return { error: "invalid stt response" };
  }
  const obj = json as Record<string, unknown>;
  if (obj.error != null) {
    if (typeof obj.error === "string" && obj.error.trim()) {
      return { error: obj.error };
    }
    if (typeof obj.error === "object") {
      const err = obj.error as Record<string, unknown>;
      const msg = err.message;
      if (typeof msg === "string" && msg.trim()) return { error: msg };
    }
    return { error: "stt error" };
  }
  if (typeof obj.text !== "string") return { error: "missing transcript" };
  const text = obj.text.trim();
  if (!text) return { error: "empty transcript" };
  const usage =
    obj.usage !== null && typeof obj.usage === "object"
      ? (obj.usage as Record<string, unknown>)
      : undefined;
  const cost = typeof usage?.cost === "number" ? usage.cost : undefined;
  const seconds = typeof usage?.seconds === "number" ? usage.seconds : undefined;
  const out: { text: string; cost?: number; seconds?: number } = { text };
  if (cost !== undefined) out.cost = cost;
  if (seconds !== undefined) out.seconds = seconds;
  return out;
}

export function voiceTranscriptLine(text: string): string {
  return `[voice] ${text.trim()}`;
}

export function shouldRetryWithFallback(
  status: number | undefined,
  errorMessage: string,
): boolean {
  if (status === 401 || status === 402) return false;
  if (status === 429 || status === 408) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  // OpenRouter wraps upstream rejects as a bare "Provider returned 400".
  if (status === 400) return true;
  if (status !== undefined && status >= 400 && status < 500) {
    const m = errorMessage.toLowerCase();
    return /unsupported|format|model|codec/.test(m);
  }
  if (status === undefined) return true;
  return false;
}
