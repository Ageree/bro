import {
  cafCodec,
  cafOpusToOgg,
  isCaf,
} from "./caf-opus.ts";
import {
  parseSttResponse,
  shouldRetryWithFallback,
  sttConfig,
  sttFormatFor,
} from "./voice-policy.ts";

const STT_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const REFERER = "https://bro-agent.vercel.app";

export type TranscribeVoiceNote = {
  url: string;
  contentType?: string | null;
  size?: number | null;
};

export type TranscribeDeps = {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: () => number;
};

export type TranscribeOk = {
  ok: true;
  text: string;
  model: string;
  cost?: number;
  seconds?: number;
  ms: number;
};

export type TranscribeErr = {
  ok: false;
  reason: string;
  ms: number;
};

export type TranscribeResult = TranscribeOk | TranscribeErr;

function sniffAudio(bytes: Uint8Array): "caf" | "m4a" | "ogg" | "wav" | "mp3" | null {
  if (bytes.length >= 4) {
    const mag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    if (mag === "caff") return "caf";
    if (mag === "OggS") return "ogg";
    if (mag === "RIFF") return "wav";
    if (mag.startsWith("ID3")) return "mp3";
    if (bytes[0] === 0xff && bytes[1] === 0xfb) return "mp3";
  }
  if (bytes.length >= 8) {
    const ftyp = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
    if (ftyp === "ftyp") return "m4a";
  }
  return null;
}

export async function readLimited(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array | { error: string }> {
  const lenRaw = res.headers.get("content-length");
  if (lenRaw) {
    const len = Number(lenRaw);
    if (Number.isFinite(len) && len > maxBytes) return { error: "oversize" };
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return { error: "oversize" };
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { error: "oversize" };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

type SttOnce =
  | { ok: true; text: string; cost?: number; seconds?: number }
  | { ok: false; status?: number; error: string };

async function sttOnce(opts: {
  fetch: typeof fetch;
  key: string;
  model: string;
  data: string;
  format: string;
  language: string | undefined;
  timeoutMs: number;
}): Promise<SttOnce> {
  const body: Record<string, unknown> = {
    model: opts.model,
    input_audio: { data: opts.data, format: opts.format },
    temperature: 0,
  };
  if (opts.language) body.language = opts.language;
  let res: Response;
  try {
    res = await opts.fetch(STT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": REFERER,
        "X-Title": "Bro",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, status: res.status, error: `http ${res.status}` };
  }
  const parsed = parseSttResponse(json);
  if ("error" in parsed) {
    return { ok: false, status: res.status, error: parsed.error };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: `http ${res.status}` };
  }
  return { ok: true, text: parsed.text, cost: parsed.cost, seconds: parsed.seconds };
}

export async function transcribeVoiceNote(
  note: TranscribeVoiceNote,
  deps: TranscribeDeps = {},
): Promise<TranscribeResult> {
  const doFetch = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const ms = () => Math.max(0, now() - t0);
  const cfg = sttConfig(env);
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) return { ok: false, reason: "missing OPENROUTER_API_KEY", ms: ms() };
  if (typeof note.size === "number" && note.size > cfg.maxBytes) {
    return { ok: false, reason: "oversize", ms: ms() };
  }

  let downloaded: Uint8Array;
  try {
    const res = await doFetch(note.url, {
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, reason: `download ${res.status}`, ms: ms() };
    }
    const body = await readLimited(res, cfg.maxBytes);
    if ("error" in body) return { ok: false, reason: body.error, ms: ms() };
    downloaded = body;
  } catch (err) {
    return { ok: false, reason: errMessage(err), ms: ms() };
  }

  const sniffed = sniffAudio(downloaded);
  let format: string;
  let audio = downloaded;
  if (sniffed === "caf" || isCaf(downloaded)) {
    const codec = cafCodec(downloaded);
    if (codec !== "opus") {
      return { ok: false, reason: "unsupported_caf_codec", ms: ms() };
    }
    try {
      audio = cafOpusToOgg(downloaded);
    } catch (err) {
      return { ok: false, reason: errMessage(err), ms: ms() };
    }
    format = "ogg";
  } else if (sniffed) {
    format = sniffed;
  } else {
    const mapped = sttFormatFor({
      contentType: note.contentType,
      url: note.url,
    });
    if (!mapped) return { ok: false, reason: "not audio", ms: ms() };
    if (mapped.remux === "caf") {
      return { ok: false, reason: "unsupported_caf_codec", ms: ms() };
    }
    format = mapped.format;
  }

  const data = Buffer.from(audio).toString("base64");
  const models = [cfg.model];
  if (cfg.fallbackModel && cfg.fallbackModel !== cfg.model) {
    models.push(cfg.fallbackModel);
  }

  let lastReason = "stt failed";
  let lastModel = models[0]!;
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    lastModel = model;
    const result = await sttOnce({
      fetch: doFetch,
      key,
      model,
      data,
      format,
      language: cfg.language,
      timeoutMs: cfg.timeoutMs,
    });
    if (result.ok) {
      const text = result.text.trim();
      console.log("voice transcribed", {
        model,
        ms: ms(),
        seconds: result.seconds,
        cost: result.cost,
        chars: text.length,
      });
      const ok: TranscribeOk = { ok: true, text, model, ms: ms() };
      if (result.cost !== undefined) ok.cost = result.cost;
      if (result.seconds !== undefined) ok.seconds = result.seconds;
      return ok;
    }
    lastReason = result.error;
    const retry =
      i === 0 &&
      models.length > 1 &&
      shouldRetryWithFallback(result.status, result.error);
    if (!retry) break;
  }

  console.error("voice transcription failed", {
    reason: lastReason,
    model: lastModel,
  });
  return { ok: false, reason: lastReason, ms: ms() };
}
