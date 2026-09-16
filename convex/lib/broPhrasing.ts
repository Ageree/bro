/**
 * The phrasing lane for the two messages that reach the human with no model
 * turn behind them: the finished-errand report (browserFollow.deliverDoneNow)
 * and the in-flight progress notes (browserFollow.pollRun).
 *
 * Both used to pick a canned Russian sentence out of a seeded palette in
 * browserProgressPolicy.ts. Rotating four frozen strings is not Bro talking,
 * it is Bro reading from a card — but the reason those paths exist (report a
 * finished run straight from the poll, ~11s instead of ~55s) is worth
 * keeping. So: one tiny, hard-bounded OpenRouter call phrases the line, and
 * the canned palette stays underneath as the fallback, and only as the
 * fallback.
 *
 * Same discipline as the fast-ack lane (agent/lib/fast-ack.ts):
 *  - a HARD time budget with an abort — a slow model never delays delivery;
 *  - null on timeout / error / empty / anything that fails sanitising;
 *  - never throws, so the caller's `?? canned` is always reachable;
 *  - OPENROUTER_API_KEY is OPTIONAL: with no key the lane is skipped whole,
 *    silently, and the deployment behaves exactly as it did before.
 *
 * The only thing the model is ever shown is the already-parsed, already
 * label-scrubbed `CloudOutcome` fields (plus the human site phrase) — never
 * the raw Cloud run result, never a vault payload, never a page dump.
 */

import type { CloudOutcome } from "./browserOutcomePolicy.ts";
import { scrubSecrets } from "./secretScrub.ts";

type EnvLike = Record<string, string | undefined>;

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Cheap + fast; same default family the agent and the fast-ack lane use. */
export const DEFAULT_PHRASE_MODEL = "deepseek/deepseek-v4.1-flash";

/**
 * The done report is the errand's single most visible message and the human
 * is already waiting on it — against the ~44s the instant path saves, 1.2s is
 * noise. A progress note is unprompted filler nobody is blocked on, so it
 * gets the tighter budget; measured round trips run ~460-1500ms, which means
 * the slower half of notes simply goes out in the canned wording. That is the
 * intended trade: a note is never worth holding a poll open for.
 */
export const DONE_BUDGET_MS = 1_200;
export const PROGRESS_BUDGET_MS = 1_000;

export type PhraseKind = "done" | "opened" | "slow" | "long";

/** Everything the phrasing call is ever allowed to see. Parsed fields only. */
export type PhraseFacts = {
  done?: string;
  orderId?: string;
  amountRub?: number;
  when?: string;
  options?: string[];
  /** Human site phrase («в озоне»), progress notes only. */
  where?: string;
};

/** The parsed outcome, narrowed to the fields a report may speak. Nothing
 *  else from the run (least of all `result`) may reach the model. */
export function doneFacts(outcome: CloudOutcome): PhraseFacts {
  return {
    ...(outcome.done ? { done: outcome.done } : {}),
    ...(outcome.orderId ? { orderId: outcome.orderId } : {}),
    ...(outcome.amountRub !== undefined ? { amountRub: outcome.amountRub } : {}),
    ...(outcome.when ? { when: outcome.when } : {}),
    ...(outcome.options && outcome.options.length > 0
      ? { options: outcome.options.slice(0, 5) }
      : {}),
  };
}

/** `BRO_PHRASING=0|off|false` turns the lane off; anything else leaves it on. */
export function phrasingEnabled(env: EnvLike = process.env): boolean {
  const raw = env.BRO_PHRASING?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "off" || raw === "false");
}

/**
 * Every whitespace character is stripped, not just the ends: a key pasted
 * into a hosted environment often carries a newline in the MIDDLE (this is
 * the same pathology scripts/deploy.sh trims for the Convex/Vercel CLIs),
 * and `fetch` rejects such a header outright — which would turn a configured
 * deployment into a permanently-falling-back one, silently.
 */
export function phrasingKey(env: EnvLike = process.env): string | undefined {
  return env.OPENROUTER_API_KEY?.replace(/\s+/gu, "") || undefined;
}

/**
 * True when this deployment can phrase at all. Callers check it BEFORE the
 * `ctx.runAction` hop, so a deployment that never sets the key does not even
 * pay a function call — it runs exactly the code it ran before this shipped.
 */
export function phrasingConfigured(env: EnvLike = process.env): boolean {
  return phrasingEnabled(env) && phrasingKey(env) !== undefined;
}

export function phrasingModel(env: EnvLike = process.env): string {
  return (
    env.BRO_PHRASE_MODEL?.trim() ||
    env.BRO_FAST_ACK_MODEL?.trim() ||
    env.BRO_MODEL?.trim() ||
    DEFAULT_PHRASE_MODEL
  );
}

function positiveInt(raw: string | undefined): number | undefined {
  const n = raw?.trim() ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function phraseBudgetMs(kind: PhraseKind, env: EnvLike = process.env): number {
  return kind === "done"
    ? (positiveInt(env.BRO_PHRASE_BUDGET_MS) ?? DONE_BUDGET_MS)
    : (positiveInt(env.BRO_PHRASE_PROGRESS_BUDGET_MS) ?? PROGRESS_BUDGET_MS);
}

/**
 * The register, once. Deliberately short: the rules a tiny model actually
 * follows are the ones it can hold, and a long menu of example lines is
 * something it copies verbatim — which is the canned palette again, only
 * slower. No examples at all, on purpose.
 */
export const PHRASE_SYSTEM = `Ты — Бро: пишешь человеку в личный чат как друг, по-русски, живым голосом.
Тебе дают факты о поручении, которое ты для него делал. Скажи это своими словами — так, как сказал бы вслух в эту секунду, каждый раз по-новому.
Коротко. Без вступлений, без обращения по имени, без эмодзи, без ссылок, без англицизмов, без ярлыков вида «Статус:» или «Заказ:». Не пересказывай задание, которое он тебе давал.
Ничего не придумывай сверх фактов. Цифры (номер заказа, сумму) перенеси точно как дано, других чисел не выдумывай.
Пароли, коды из смс и номера карт не пиши никогда.
В ответе — только сама реплика, без кавычек и пояснений.`;

const BEAT_PROMPT: Readonly<Record<Exclude<PhraseKind, "done">, string>> = {
  opened:
    "Ты только что открыл сайт и берёшься за дело. Одна строка: ты на месте и начал.",
  slow: "Дело идёт дольше обычного, ты всё ещё в процессе. Одна строка: ещё вожусь, напишу, как закончу.",
  long: "Дело тянется совсем долго. Одна строка: ты ещё в процессе, и если надоело — пусть напишет «отмени», ты остановишься. Слово «отмени» оставь дословно.",
};

/** The user message: the parsed facts, plus what this beat is. Small. */
export function phrasePrompt(kind: PhraseKind, facts: PhraseFacts): string {
  if (kind !== "done") {
    const where = facts.where?.trim();
    return [
      BEAT_PROMPT[kind],
      where ? `Ты сейчас ${where} — можешь назвать это место так же, этими словами.` : "Где именно ты сейчас — не говори, это неизвестно.",
    ].join("\n");
  }
  const lines: string[] = ["Поручение выполнено. Факты:"];
  if (facts.done) lines.push(`что сделал — ${facts.done}`);
  if (facts.orderId) lines.push(`номер заказа — ${facts.orderId}`);
  if (facts.amountRub !== undefined) lines.push(`сумма — ${facts.amountRub} ₽`);
  if (facts.when) lines.push(`когда — ${facts.when}`);
  if (facts.options && facts.options.length > 0) {
    lines.push(`варианты — ${facts.options.join("; ")}`);
  }
  lines.push(
    "Сообщи, что готово. Максимум две строки: первая — живая фраза о том, что сделал; вторая (если есть номер заказа, сумма или срок) — эти факты коротко, через запятую.",
  );
  return lines.join("\n");
}

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["«", "»"],
  ['"', '"'],
  ["'", "'"],
  ["‘", "’"],
  ["“", "”"],
];

function stripSurroundingQuotes(s: string): string {
  let out = s;
  for (const [l, r] of QUOTE_PAIRS) {
    if (out.startsWith(l) && out.endsWith(r) && out.length > l.length + r.length) {
      out = out.slice(l.length, out.length - r.length).trim();
    }
  }
  return out;
}

/** "1 290" and "1 290" (nbsp) are the same number as "1290" — fold the
 *  thousands separators away before any digit is compared or judged. */
function foldDigits(s: string): string {
  let out = s.replace(/[\u00a0\u202f\u2009]/gu, " ");
  let prev = "";
  while (prev !== out) {
    prev = out;
    // Only a group of exactly three digits is a thousands separator. Folding
    // every space between digits would glue «заказ 508 на 1290 ₽» into one
    // seven-digit number and lose both facts.
    out = out.replace(/(\d)[ ](\d{3})(?!\d)/gu, "$1$2");
  }
  return out;
}

function digitRuns(s: string): string[] {
  return foldDigits(s).match(/\d+/gu) ?? [];
}

/** Letters+digits only, lowercased — «№ WB-508» and «wb508» compare equal. */
function alnumKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function factText(facts: PhraseFacts): string {
  return [
    facts.done ?? "",
    facts.orderId ?? "",
    facts.amountRub !== undefined ? String(facts.amountRub) : "",
    facts.when ?? "",
    ...(facts.options ?? []),
    facts.where ?? "",
    // Newline-joined on purpose: a space between two facts must never read as
    // a thousands separator when the runs are folded out below.
  ].join("\n");
}

/** Scaffold labels and report headers — a generated line is a sentence, not
 *  a form. «Готово: …» is fine (not a label); «СДЕЛАНО: …» is not. */
const FIELD_LABEL_RE =
  /(?:^|\n)\s*(?:сделано|заказ|сумма|когда|варианты|нужно|детали|статус|итог|результат|status|needs|order|total|done|amount)\s*:/iu;

// A bare domain counts as a URL too — a note never reads an address out loud.
// The trailing lookahead is unicode-aware on purpose: `\b` is ASCII-only in
// JS regex and would miss «озон.рф».
const URL_RE = /https?:\/\/|www\.\S|[\p{L}\d-]+\.(?:ru|com|org|net|io|рф)(?![\p{L}\d])/iu;

const SECRET_WORD_RE = /парол|cvv|cvc|пин-?код|секретн/iu;

/** Per-kind ceilings. The done report is two short bubbles' worth; a
 *  progress note is one line of filler and must stay one line of filler. */
const MAX_LINES: Readonly<Record<PhraseKind, number>> = {
  done: 2,
  opened: 1,
  slow: 1,
  long: 1,
};
const MAX_CHARS: Readonly<Record<PhraseKind, number>> = {
  done: 220,
  opened: 120,
  slow: 140,
  long: 140,
};

/**
 * The sanity gate. Returns the cleaned line, or null — and null always means
 * "send the canned line instead", never "send nothing".
 *
 * It is not a style filter: it is the set of things that must not reach the
 * human unread by a person. A URL, a form label, a «Бро, …» opener, an emoji,
 * a secret-shaped substring, a number the outcome never carried, or a report
 * that dropped the order number or the sum all fail here.
 */
export function sanitizePhrase(
  raw: string | null | undefined,
  kind: PhraseKind,
  facts: PhraseFacts,
): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  // Fenced blocks are a model formatting reflex, never something a friend types.
  s = s.replace(/^```[\w-]*\n?/u, "").replace(/```$/u, "").trim();
  // Quotes around the WHOLE answer come off first — a two-line report is
  // often wrapped once, not line by line.
  s = stripSurroundingQuotes(s);
  if (!s) return null;

  const lines = s
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => stripSurroundingQuotes(line.replace(/^[-–—*•]\s+/u, "")))
    .map((line) => line.replace(/[,;:\-–—]+$/u, "").trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_LINES[kind]) return null;

  const text = lines.join("\n");
  if (text.length > MAX_CHARS[kind]) return null;
  if (URL_RE.test(text)) return null;
  if (FIELD_LABEL_RE.test(`\n${text}`)) return null;
  if (/\p{Extended_Pictographic}/u.test(text)) return null;
  // \b is ASCII-only in JS regex — Cyrillic needs an explicit letter lookahead.
  if (/^(?:бро|bro)(?!\p{L})/iu.test(text)) return null;
  if (SECRET_WORD_RE.test(text)) return null;
  // Last-resort net: anything card/CVV/password-shaped means we do not send it.
  if (scrubSecrets(text) !== text) return null;

  // No number the outcome did not carry. A hallucinated order number or price
  // is worse than a boring line.
  const allowed = new Set(digitRuns(factText(facts)));
  for (const run of digitRuns(text)) {
    if (!allowed.has(run)) return null;
  }

  // …and the numbers it did carry have to survive the rewrite.
  const key = alnumKey(foldDigits(text));
  if (facts.orderId && !key.includes(alnumKey(facts.orderId))) return null;
  if (facts.amountRub !== undefined && !key.includes(String(facts.amountRub))) {
    return null;
  }
  // The «long» note's whole job is offering the human the way out.
  if (kind === "long" && !/отмен/iu.test(text)) return null;

  return text;
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
};

/**
 * One phrasing call, hard-bounded. Resolves to the sanitised line, or null —
 * on a missing key, a disabled lane, a timeout, a non-200, a parse failure,
 * an empty completion, or output the gate rejects. Never rejects, never
 * outlives its budget, and aborts the request on the way out so a slow host
 * is not left streaming into nothing.
 */
export async function generatePhrase(opts: {
  kind: PhraseKind;
  facts: PhraseFacts;
  env?: EnvLike;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<string | null> {
  const env = opts.env ?? process.env;
  // No key configured → this deployment simply does not have the lane. No
  // request, no log line, no behaviour change of any kind.
  if (!phrasingConfigured(env)) return null;

  const apiKey = phrasingKey(env)!;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const budgetMs = phraseBudgetMs(opts.kind, env);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();

  const body = {
    model: phrasingModel(env),
    stream: false,
    // Room to finish the thought. A completion cut off at the cap («…и я
    // торм») is rejected below rather than sent, so a cap that is too tight
    // does not produce a bad line — it produces the canned one, every time.
    max_tokens: opts.kind === "done" ? 110 : 64,
    // High enough that the wording really moves run to run — a low
    // temperature here would rebuild the canned palette by other means.
    temperature: 0.9,
    reasoning: { enabled: false },
    provider: { sort: "latency", preferred_max_latency: { p90: 2.5 } },
    messages: [
      { role: "system", content: PHRASE_SYSTEM },
      { role: "user", content: phrasePrompt(opts.kind, opts.facts) },
    ],
  };

  const call = (async (): Promise<string | null> => {
    try {
      const res = await fetchImpl(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error("phrasing failed", new Error(`status ${res.status}`));
        return null;
      }
      const json = (await res.json()) as ChatResponse;
      const choice = json.choices?.[0];
      // Ran into the token cap: whatever came back is a sentence with its
      // tail sawn off. Never send that.
      if (choice?.finish_reason === "length") return null;
      const raw = choice?.message?.content;
      return sanitizePhrase(typeof raw === "string" ? raw : null, opts.kind, opts.facts);
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        console.error("phrasing failed", err);
      }
      return null;
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, budgetMs);
  });

  const line = await Promise.race([call, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  // A call that lost the race is abandoned, not awaited: the human's line is
  // already on its way.
  if (line === null) controller.abort();
  console.log("phrasing", { kind: opts.kind, ms: now() - startedAt, sent: line !== null });
  return line;
}
