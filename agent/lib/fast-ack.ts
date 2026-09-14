/**
 * Fast-ack lane: a tiny no-reasoning OpenRouter call that turns the human's
 * message into a 2-5 word status line («ищу на вб») and sends it as the
 * first bubble within a hard time budget — well before eve's queue hop,
 * workflow cold start, memory recall and model TTFT would produce one.
 *
 * The real agent turn runs in a DIFFERENT Vercel function (eve compiles it
 * into a queue-triggered workflow), so in-memory state made in the webhook
 * never reaches it — only the `attributes` object passed to
 * `from(...).send(content, { auth: { attributes } })` crosses that boundary.
 * So this lane must resolve BEFORE `from().send()` is called, with a hard
 * budget, and its result is stamped on those attributes (plain strings only
 * — wire v1 rejects `undefined`).
 */

import { isShortAck } from "./short-ack.ts";
import { isHelpAsk, isTelegramAsk } from "./onboard-policy.ts";
import { OPENROUTER_CHAT_URL } from "./openrouter-warm.ts";
import { withOpenRouterChatDefaults } from "./openrouter-chat.ts";
import { DEFAULT_OPENROUTER_MODEL } from "./model.ts";
import {
  isChatCodeMessage,
  isConfirmInject,
  isWaitInject,
} from "../../convex/lib/browserInjectPolicy.ts";

type EnvLike = Record<string, string | undefined>;

export const FAST_ACK_ATTR = "fastAck";

export function fastAckEnabled(env: EnvLike = process.env): boolean {
  const raw = env.BRO_FAST_ACK?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "off" || raw === "false") return false;
  if (raw === "1" || raw === "on" || raw === "true") return true;
  return true;
}

export function fastAckBudgetMs(env: EnvLike = process.env): number {
  const raw = env.BRO_FAST_ACK_BUDGET_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 700;
}

export function fastAckModel(env: EnvLike = process.env): string {
  return (
    env.BRO_FAST_ACK_MODEL?.trim() ||
    env.BRO_MODEL?.trim() ||
    DEFAULT_OPENROUTER_MODEL
  );
}

/** Compact Russian-first steer for the tiny ack model. Keep this <= 900 chars. */
export const FAST_ACK_SYSTEM = `Ты — Bro, персональный помощник, пишешь человеку как друг в чат. Тебе дают последнее сообщение человека. Если выполнить его нужно делом (поискать, купить, забронировать, проверить почту/календарь/заказ, поставить напоминание, открыть сайт, посмотреть фото) — ответь ОДНОЙ строкой из 2-5 слов на языке человека: с маленькой буквы, без точки на конце, без вступлений и без имени, в стиле «ищу на вб» / «смотрю почту» / «открываю озон» / «ставлю напоминание» / «проверяю заказ». Если это просто разговор, приветствие, спасибо, ответ на вопрос Bro, да/нет, или на это можно ответить сразу без инструментов — выведи ровно NONE. Никогда не выводи что-то ещё.
Примеры:
купи кроссовки на вб → ищу на вб
проверь почту → смотрю почту
спасибо бро → NONE
ок → NONE
открой озон и найди чехол → открываю озон
как дела? → NONE`;

/** False for empty text, short acks, event/wakeup/button placeholders, and long pastes. */
export function shouldFastAck(text: string): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return false;
  let judged = trimmed;
  const voice = /^\[voice\]\s*/i.exec(judged);
  if (voice) {
    judged = judged.slice(voice[0].length).trim();
  } else if (judged.startsWith("[")) {
    return false;
  }
  if (!judged) return false;
  if (isShortAck(judged)) return false;
  // Canned replies (welcome/help, the Telegram invite) never reach the agent.
  if (isHelpAsk(judged) || isTelegramAsk(judged)) return false;
  // The fast-ack lane has no idea whether a Cloud session is even open, so it
  // must defer entirely on anything that looks like an OTP code, a wait, or a
  // push/3DS confirmation — the real turn decides, not a tiny guessing model
  // (F_extra).
  if (isChatCodeMessage(judged) || isWaitInject(judged) || isConfirmInject(judged)) {
    return false;
  }
  if (trimmed.length > 600) return false;
  return true;
}

/** Text the tiny model sees: trimmed, capped — the same text the gate judged. */
export function fastAckPrompt(text: string): string {
  return (text ?? "").trim().slice(0, 600);
}

function stripSurroundingQuotes(s: string): string {
  const pairs: [string, string][] = [
    ["«", "»"],
    ['"', '"'],
    ["'", "'"],
    ["‘", "’"],
    ["“", "”"],
  ];
  let out = s;
  for (const [l, r] of pairs) {
    if (out.startsWith(l) && out.endsWith(r) && out.length > l.length + r.length) {
      out = out.slice(l.length, out.length - r.length).trim();
    }
  }
  return out;
}

/** Cleans the tiny model's raw output; null when it is unusable or means NONE. */
export function sanitizeFastAck(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.split("\n")[0]?.trim() ?? "";
  if (!s) return null;
  s = stripSurroundingQuotes(s);
  s = s.replace(/\.$/, "").trim();
  if (!s) return null;
  if (s.toLowerCase() === "none") return null;
  if (/\bnone\b/i.test(s)) return null;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return null;
  if (s.length > 48) return null;
  if (/https?:\/\/|www\.\S+/i.test(s)) return null;
  // \b is ASCII-only in JS regex — Cyrillic needs an explicit non-letter lookahead.
  if (/^(бро|bro)(?!\p{L})/iu.test(s)) return null;
  // Field labels («Статус: …», «статус:») and number dumps (phones, prices) are
  // never a status beat.
  if (/:/.test(s)) return null;
  if ((s.match(/\d/g) ?? []).length >= 5) return null;
  return s;
}

function foldBeat(text: string): string {
  return text
    .normalize("NFC")
    .replace(/ё/gi, "е")
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function beatTokens(text: string): Set<string> {
  return new Set(foldBeat(text).split(" ").filter((w) => w.length >= 3));
}

/**
 * The real turn's model was told not to repeat the ack, but a weak model
 * still opens with «Ищу на ВБ.» or «Ищу кроссовки на ВБ». The generic bubble
 * dedupe is case-sensitive and needs 32 shared chars / 6 tokens, which a
 * 3-word beat never has. Returns: null when `text` is the ack restated (drop
 * it), the remainder when `text` starts with the ack (send only the rest),
 * or `text` unchanged.
 */
export function peelFastAck(ack: string, text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const ackFold = foldBeat(ack);
  if (!ackFold) return t;
  const firstLine = t.split("\n")[0]?.trim() ?? "";
  const lineFold = foldBeat(firstLine);
  if (lineFold === ackFold) {
    const rest = t.slice(firstLine.length).replace(/^[\s.!?…。！？,;:—–-]+/u, "").trim();
    return rest || null;
  }
  if (lineFold.startsWith(`${ackFold} `)) {
    // Walk the original line past the ack's words (case/punctuation-insensitive).
    const ackWords = ackFold.split(" ").length;
    const re = /\S+/gu;
    let end = 0;
    for (let i = 0; i < ackWords; i += 1) {
      const m = re.exec(firstLine);
      if (!m) return t;
      end = m.index + m[0].length;
    }
    const restLine = firstLine.slice(end).replace(/^[\s.!?…。！？,;:—–-]+/u, "").trim();
    const restBody = t.slice(firstLine.length).trim();
    const rest = [restLine, restBody].filter(Boolean).join("\n");
    return rest || null;
  }
  // Single short line with mostly the same content words → a restatement.
  if (!t.includes("\n") && lineFold.split(" ").length <= 8) {
    const a = beatTokens(ack);
    const b = beatTokens(firstLine);
    if (a.size > 0 && b.size > 0) {
      let shared = 0;
      for (const w of b) if (a.has(w)) shared += 1;
      const union = new Set([...a, ...b]).size;
      if (shared / union >= 0.5) return null;
    }
  }
  return t;
}

export function fastAckAttribute(text: string | null): Record<string, string> {
  return text ? { [FAST_ACK_ATTR]: text } : {};
}

export function fastAckOf(
  attrs: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  const raw = attrs?.[FAST_ACK_ATTR];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function fastAckInstruction(text: string): string {
  return `Before this turn started, Bro already sent the human this first line: «${text}». Treat it as the first line of your reply — do not repeat, rephrase, or write another looking/status line. Continue from it: call the tool now, or write the answer. If that line turns out to be wrong, just proceed correctly without apologising.`;
}

export type FastAckHandle = {
  promise: Promise<string | null>;
  abort: () => void;
  startedAt: number;
};

type ChatResponse = { choices?: Array<{ message?: { content?: unknown } }> };

export function startFastAck(
  text: string,
  opts?: {
    env?: EnvLike;
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
): FastAckHandle | null {
  const env = opts?.env ?? process.env;
  if (!fastAckEnabled(env)) return null;
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  if (!shouldFastAck(text)) return null;

  const now = opts?.now ?? Date.now;
  const startedAt = now();
  const budgetMs = fastAckBudgetMs(env);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(budgetMs + 300),
  ]);

  const body = withOpenRouterChatDefaults(
    {
      model: fastAckModel(env),
      stream: false,
      max_tokens: 24,
      temperature: 0.2,
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: FAST_ACK_SYSTEM },
        { role: "user", content: fastAckPrompt(text) },
      ],
    },
    env,
  );

  let request: Promise<Response>;
  try {
    request = fetchImpl(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // A synchronously throwing fetch must not take the webhook down.
    console.error("fast ack failed", err);
    return null;
  }
  const promise = request
    .then(async (res) => {
      if (!res.ok) {
        console.error("fast ack failed", new Error(`status ${res.status}`));
        return null;
      }
      let json: ChatResponse;
      try {
        json = (await res.json()) as ChatResponse;
      } catch (err) {
        console.error("fast ack failed", err);
        return null;
      }
      const raw = json.choices?.[0]?.message?.content;
      const result = sanitizeFastAck(typeof raw === "string" ? raw : null);
      console.log("fast ack", { ms: now() - startedAt, sent: Boolean(result) });
      return result;
    })
    .catch((err) => {
      if (!(err instanceof Error && err.name === "AbortError")) {
        console.error("fast ack failed", err);
      }
      return null;
    });

  return { promise, abort: () => controller.abort(), startedAt };
}

export async function settleFastAck(
  handle: FastAckHandle | null,
  opts?: { budgetMs?: number; now?: () => number },
): Promise<string | null> {
  if (!handle) return null;
  const now = opts?.now ?? Date.now;
  const budgetMs = opts?.budgetMs ?? fastAckBudgetMs();
  const remaining = Math.max(0, budgetMs - (now() - handle.startedAt));
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      handle.abort();
      resolve(null);
    }, remaining);
    // `handle.promise` never rejects (startFastAck swallows every error).
    void handle.promise.then((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    });
  });
}
