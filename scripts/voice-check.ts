import { inboundIMessageTextWithVoice } from "../agent/lib/imessage-text.ts";
import { cafOpusToOgg, isCaf, cafCodec } from "../agent/lib/caf-opus.ts";
import { transcribeVoiceNote } from "../agent/lib/voice.ts";
import {
  DEFAULT_STT_FALLBACK_MODEL,
  DEFAULT_STT_MAX_BYTES,
  DEFAULT_STT_MODEL,
  DEFAULT_STT_TIMEOUT_MS,
  VOICE_FAILED_REPLY,
  parseSttResponse,
  shouldRetryWithFallback,
  sttConfig,
  sttFormatFor,
  voiceTranscriptLine,
} from "../agent/lib/voice-policy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq<T>(got: T, want: T, msg: string): void {
  if (got !== want) throw new Error(`${msg}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// --- sttFormatFor ---
eq(sttFormatFor({ contentType: "audio/mp4" })?.format, "m4a", "mp4");
eq(sttFormatFor({ contentType: "audio/x-m4a" })?.format, "m4a", "x-m4a");
eq(sttFormatFor({ contentType: "audio/m4a" })?.format, "m4a", "m4a mime");
eq(sttFormatFor({ url: "https://x/v.m4a?sig=1" })?.format, "m4a", "m4a ext");
eq(sttFormatFor({ contentType: "audio/mpeg" })?.format, "mp3", "mpeg");
eq(sttFormatFor({ contentType: "audio/mp3" })?.format, "mp3", "mp3");
eq(sttFormatFor({ contentType: "audio/wav" })?.format, "wav", "wav");
eq(sttFormatFor({ contentType: "audio/x-wav" })?.format, "wav", "x-wav");
eq(sttFormatFor({ contentType: "audio/wave" })?.format, "wav", "wave");
eq(sttFormatFor({ contentType: "audio/ogg" })?.format, "ogg", "ogg");
eq(sttFormatFor({ contentType: "audio/opus" })?.format, "ogg", "opus");
eq(sttFormatFor({ contentType: "audio/webm" })?.format, "webm", "webm");
eq(sttFormatFor({ contentType: "audio/aac" })?.format, "aac", "aac");
eq(sttFormatFor({ contentType: "audio/flac" })?.format, "flac", "flac");
const cafMime = sttFormatFor({ contentType: "audio/x-caf" });
eq(cafMime?.format, "ogg", "caf mime format");
eq(cafMime?.remux, "caf", "caf mime remux");
const cafMime2 = sttFormatFor({ contentType: "audio/caf" });
eq(cafMime2?.remux, "caf", "audio/caf remux");
const cafExt = sttFormatFor({ url: "https://cdn.example/note.caf?token=abc" });
eq(cafExt?.format, "ogg", "caf ext format");
eq(cafExt?.remux, "caf", "caf ext remux");
const guessed = sttFormatFor({ contentType: "audio/amr" });
eq(guessed?.format, "m4a", "unknown audio guessed m4a");
assert(guessed?.guessed === true, "guessed flag");
eq(sttFormatFor({ contentType: "audio/x-caf; codecs=opus" })?.remux, "caf", "caf charset");
assert(sttFormatFor({ contentType: "image/jpeg" }) === null, "image null");
assert(sttFormatFor({ contentType: "text/plain" }) === null, "text null");
assert(sttFormatFor({}) === null, "empty null");

// --- sttConfig ---
eq(DEFAULT_STT_MODEL, "openai/gpt-4o-transcribe", "default model const");
const d = sttConfig({});
eq(d.model, DEFAULT_STT_MODEL, "default model");
eq(d.fallbackModel, DEFAULT_STT_FALLBACK_MODEL, "default fallback");
eq(d.language, "ru", "default language ru");
eq(d.timeoutMs, DEFAULT_STT_TIMEOUT_MS, "default timeout");
eq(d.maxBytes, DEFAULT_STT_MAX_BYTES, "default max bytes");
eq(sttConfig({ BRO_STT_MODEL: " qwen/qwen3-asr-flash-2026-02-10 " }).model, "qwen/qwen3-asr-flash-2026-02-10", "model override");
eq(sttConfig({ BRO_STT_FALLBACK_MODEL: "deepgram/nova-3" }).fallbackModel, "deepgram/nova-3", "fallback override");
assert(sttConfig({ BRO_STT_LANGUAGE: "auto" }).language === undefined, "auto language");
assert(sttConfig({ BRO_STT_LANGUAGE: "" }).language === undefined, "empty language");
eq(sttConfig({ BRO_STT_LANGUAGE: "en" }).language, "en", "lang override");
eq(sttConfig({ BRO_STT_TIMEOUT_MS: "15000" }).timeoutMs, 15000, "timeout override");
eq(sttConfig({ BRO_STT_TIMEOUT_MS: "nope" }).timeoutMs, DEFAULT_STT_TIMEOUT_MS, "timeout garbage");
eq(sttConfig({ BRO_STT_MAX_BYTES: "1000" }).maxBytes, 1000, "max bytes override");

// --- parseSttResponse ---
const happy = parseSttResponse({
  text: "привет",
  usage: { cost: 0.01, seconds: 1.5 },
});
assert(!("error" in happy) && happy.text === "привет", "happy text");
assert(!("error" in happy) && happy.cost === 0.01, "happy cost");
assert(!("error" in happy) && happy.seconds === 1.5, "happy seconds");
function sttErr(json: unknown): string {
  const r = parseSttResponse(json);
  return "error" in r ? r.error : "";
}

eq(sttErr({ text: "  " }), "empty transcript", "whitespace empty");
eq(sttErr({ text: "" }), "empty transcript", "empty string");
eq(sttErr({ foo: 1 }), "missing transcript", "missing text");
eq(sttErr(null), "invalid stt response", "null json");
eq(sttErr({ error: { code: 400, message: "nope" } }), "nope", "error object");
eq(sttErr({ error: "boom" }), "boom", "error string");

eq(voiceTranscriptLine("  купи молоко  "), "[voice] купи молоко", "voice line");
assert(VOICE_FAILED_REPLY.includes("Не расслышал"), "failed reply russian");
assert(!/[A-Za-z]/.test(VOICE_FAILED_REPLY.replace("🙈", "")), "failed reply no english");

// --- shouldRetryWithFallback ---
assert(shouldRetryWithFallback(500, ""), "500");
assert(shouldRetryWithFallback(503, "oops"), "503");
assert(shouldRetryWithFallback(429, ""), "429");
assert(shouldRetryWithFallback(408, ""), "408");
assert(shouldRetryWithFallback(undefined, "fetch failed"), "network");
assert(shouldRetryWithFallback(undefined, "TimeoutError"), "timeout");
assert(shouldRetryWithFallback(400, "Unsupported format"), "400 format");
assert(shouldRetryWithFallback(400, "unknown model"), "400 model");
assert(!shouldRetryWithFallback(401, ""), "401");
assert(!shouldRetryWithFallback(401, "unsupported format"), "401 wins");
assert(!shouldRetryWithFallback(402, "credits"), "402");
assert(!shouldRetryWithFallback(400, "bad request"), "400 generic");
assert(!shouldRetryWithFallback(403, ""), "403");

// --- inboundIMessageTextWithVoice ---
let sttCalls = 0;
const okTranscribe = async () => {
  sttCalls++;
  return { ok: true as const, text: "купи хлеб" };
};
const failTranscribe = async () => {
  sttCalls++;
  return { ok: false as const, reason: "boom" };
};

sttCalls = 0;
const success = await inboundIMessageTextWithVoice(
  {
    content: null,
    media: [{ url: "https://m/v.m4a", content_type: "audio/mp4", size: 12 }],
  },
  okTranscribe,
);
eq(success.text, "[voice] купи хлеб", "inbound success");
assert(success.voice && !success.allVoiceFailed, "success flags");
eq(sttCalls, 1, "stt called once");

sttCalls = 0;
const failed = await inboundIMessageTextWithVoice(
  {
    content: null,
    media: [{ url: "https://m/v.m4a", content_type: "audio/mp4" }],
  },
  failTranscribe,
);
eq(failed.text, "[voice message] https://m/v.m4a", "failed keeps url line");
assert(failed.allVoiceFailed && failed.voice, "failed flags");
eq(sttCalls, 1, "fail stt once");

sttCalls = 0;
const mixed = await inboundIMessageTextWithVoice(
  {
    content: null,
    media: [
      { url: "https://m/v.m4a", content_type: "audio/mp4" },
      { url: "https://m/p.jpg", content_type: "image/jpeg" },
    ],
  },
  failTranscribe,
);
eq(
  mixed.text,
  "[voice message] https://m/v.m4a\nhttps://m/p.jpg",
  "mixed keeps voice url and photo",
);
assert(mixed.voice && !mixed.allVoiceFailed, "mixed not all-failed");
eq(sttCalls, 1, "mixed still transcribes");

sttCalls = 0;
const mixedOk = await inboundIMessageTextWithVoice(
  {
    content: null,
    media: [
      { url: "https://m/v.m4a", content_type: "audio/mp4" },
      { url: "https://m/p.jpg", content_type: "image/jpeg" },
    ],
  },
  okTranscribe,
);
eq(mixedOk.text, "[voice] купи хлеб\nhttps://m/p.jpg", "mixed success");

sttCalls = 0;
const withContent = await inboundIMessageTextWithVoice(
  {
    content: "уже транскрипт",
    media: [{ url: "https://m/v.m4a", content_type: "audio/mp4" }],
  },
  async () => {
    throw new Error("stt must not be called");
  },
);
eq(withContent.text, "[voice] уже транскрипт", "content skips stt");
eq(sttCalls, 0, "no stt when content");

const photoOnly = await inboundIMessageTextWithVoice(
  {
    content: "смотри",
    media: [{ url: "https://m/p.jpg", content_type: "image/jpeg" }],
  },
  async () => {
    throw new Error("stt must not be called");
  },
);
eq(photoOnly.text, "смотри\nhttps://m/p.jpg", "photo no stt");
assert(!photoOnly.voice, "photo not voice");

// --- synthetic CAF ---
function be32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}
function be64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(n), false);
  return b;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function four(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  return cat(four(type), be64(data.length), data);
}

const opusPkt = new Uint8Array([0xfc, 0xff, 0xfe]);
const desc = cat(
  (() => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, 48000, false);
    return b;
  })(),
  four("opus"),
  be32(0),
  be32(0),
  be32(960),
  be32(1),
  be32(0),
);
const pakt = cat(be64(1), be64(960), be32(312), be32(0), new Uint8Array([3]));
const data = cat(be32(0), opusPkt);
const cafHdr = cat(four("caff"), new Uint8Array([0, 1, 0, 0]));
const caf = cat(cafHdr, chunk("desc", desc), chunk("pakt", pakt), chunk("data", data));
assert(isCaf(caf), "synthetic is caf");
eq(cafCodec(caf), "opus", "synthetic codec");
const ogg = cafOpusToOgg(caf);
const oggStr = Buffer.from(ogg).toString("latin1");
assert(oggStr.startsWith("OggS"), "ogg magic");
assert(oggStr.includes("OpusHead"), "OpusHead");
assert(oggStr.includes("OpusTags"), "OpusTags");
const crc = new DataView(ogg.buffer, ogg.byteOffset, ogg.byteLength).getUint32(22, true);
assert(crc !== 0, "crc nonzero");
let pages = 0;
let audioPackets = 0;
for (let i = 0; i < ogg.length - 4; ) {
  if (
    ogg[i] === 0x4f &&
    ogg[i + 1] === 0x67 &&
    ogg[i + 2] === 0x67 &&
    ogg[i + 3] === 0x53
  ) {
    pages++;
    const segs = ogg[i + 26] ?? 0;
    if (pages > 2) audioPackets++;
    let body = 0;
    for (let s = 0; s < segs; s++) body += ogg[i + 27 + s] ?? 0;
    i += 27 + segs + body;
  } else i++;
}
eq(audioPackets, 1, "one audio packet");
assert(pages >= 3, "head+tags+audio pages");

const lpcmDesc = cat(
  (() => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, 48000, false);
    return b;
  })(),
  four("lpcm"),
  be32(0),
  be32(2),
  be32(1),
  be32(1),
  be32(16),
);
const lpcmCaf = cat(cafHdr, chunk("desc", lpcmDesc), chunk("data", cat(be32(0), new Uint8Array(4))));
eq(cafCodec(lpcmCaf), "lpcm", "lpcm codec");
let threw = false;
try {
  cafOpusToOgg(lpcmCaf);
} catch {
  threw = true;
}
assert(threw, "lpcm remux throws");

// --- transcribeVoiceNote with fake fetch ---
type Call = { url: string; body?: string };
function makeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    return handler(url, init);
  };
  return { fetch: fn as typeof fetch, calls };
}

{
  const audio = new Uint8Array([0x49, 0x44, 0x33, 0x00, 1, 2, 3]);
  let sttHits = 0;
  const { fetch: f, calls } = makeFetch((url) => {
    if (url.includes("media.example")) {
      return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
    }
    sttHits++;
    const body = calls[calls.length - 1]?.body ?? "";
    const parsed = JSON.parse(body) as { model: string };
    if (sttHits === 1) {
      eq(parsed.model, "primary-stt", "primary first");
      return new Response(JSON.stringify({ error: { message: "upstream" } }), { status: 500 });
    }
    eq(parsed.model, "fallback-stt", "fallback second");
    return new Response(JSON.stringify({ text: "ок", usage: { seconds: 1, cost: 0.001 } }));
  });
  const result = await transcribeVoiceNote(
    { url: "https://media.example/v.mp3", contentType: "audio/mpeg" },
    {
      fetch: f,
      env: {
        OPENROUTER_API_KEY: "test-key",
        BRO_STT_MODEL: "primary-stt",
        BRO_STT_FALLBACK_MODEL: "fallback-stt",
      },
    },
  );
  assert(result.ok, "500 then fallback ok");
  if (result.ok) {
    eq(result.text, "ок", "fallback text");
    eq(result.model, "fallback-stt", "used fallback");
  }
  eq(sttHits, 2, "two stt attempts");
}

{
  let sttHits = 0;
  const { fetch: f } = makeFetch((url) => {
    if (url.includes("media.example")) {
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x00]));
    }
    sttHits++;
    return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
      status: 401,
    });
  });
  const result = await transcribeVoiceNote(
    { url: "https://media.example/v.mp3", contentType: "audio/mpeg" },
    {
      fetch: f,
      env: {
        OPENROUTER_API_KEY: "test-key",
        BRO_STT_MODEL: "primary-stt",
        BRO_STT_FALLBACK_MODEL: "fallback-stt",
      },
    },
  );
  assert(!result.ok, "401 fails");
  eq(sttHits, 1, "401 no fallback");
}

{
  let fetches = 0;
  const { fetch: f } = makeFetch(() => {
    fetches++;
    return new Response("nope");
  });
  const result = await transcribeVoiceNote(
    { url: "https://media.example/v.mp3", contentType: "audio/mpeg", size: 26 * 1024 * 1024 },
    { fetch: f, env: { OPENROUTER_API_KEY: "test-key" } },
  );
  assert(!result.ok && result.reason === "oversize", "note size oversize");
  eq(fetches, 0, "oversize skips download");
}

{
  const { fetch: f } = makeFetch(() => {
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-length": String(26 * 1024 * 1024) },
    });
  });
  const result = await transcribeVoiceNote(
    { url: "https://media.example/v.mp3", contentType: "audio/mpeg" },
    { fetch: f, env: { OPENROUTER_API_KEY: "test-key" } },
  );
  assert(!result.ok && result.reason === "oversize", "content-length oversize");
}

{
  let sttFormat = "";
  const { fetch: f } = makeFetch((url, init) => {
    if (url.includes("media.example")) {
      return new Response(Buffer.from(caf), {
        headers: { "content-type": "audio/x-caf" },
      });
    }
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input_audio: { format: string; data: string };
    };
    sttFormat = body.input_audio.format;
    const raw = Buffer.from(body.input_audio.data, "base64");
    assert(Buffer.from(raw.subarray(0, 4)).toString() === "OggS", "sent ogg magic");
    assert(Buffer.from(raw).toString("latin1").includes("OpusHead"), "sent OpusHead");
    return new Response(JSON.stringify({ text: "привет из кафе" }));
  });
  const result = await transcribeVoiceNote(
    { url: "https://media.example/v.caf", contentType: "audio/x-caf" },
    { fetch: f, env: { OPENROUTER_API_KEY: "test-key" } },
  );
  assert(result.ok, "caf remux stt ok");
  if (result.ok) eq(result.text, "привет из кафе", "caf transcript");
  eq(sttFormat, "ogg", "caf sent as ogg");
}

{
  const result = await transcribeVoiceNote(
    { url: "https://media.example/v.mp3", contentType: "audio/mpeg" },
    { env: { OPENROUTER_API_KEY: "" } },
  );
  assert(!result.ok && result.reason === "missing OPENROUTER_API_KEY", "missing key");
}

console.log("voice-check ok");
