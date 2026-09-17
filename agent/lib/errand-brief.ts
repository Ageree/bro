/**
 * The per-errand brief: the instruction the Cloud browser agent actually
 * reads, composed fresh for THIS errand instead of being one frozen block.
 *
 * WHY this exists. An audit of what `scaffoldTask` sent to Browser Use found
 * a 39-character errand wrapped in 1,458 characters of fixed boilerplate —
 * 2.6% of the prompt was the human's business, and none of it was the
 * human's own wording (the coordinator model retyped the errand into the
 * `task` argument, and only that retyping travelled). Worse, the scaffold
 * carried a standing order to ABORT on any fact only the human could know —
 * address, name, phone, size, time — while Bro was sitting on exactly those
 * facts in the vault and in curated memory and never passed a single one of
 * them along. Runs came back with «НУЖНО: address» for an address Bro knew.
 *
 * So this module does two things, in that order of importance:
 *
 *  1. `knownFactsBlock()` — pure, no model, no network. It turns the facts
 *     Bro already holds (vault `address`/`contact` payload fields, curated
 *     memories, the tenant's timezone and the CURRENT LOCAL DATE, the
 *     display name) into a block the run can type from. This is the fix that
 *     matters: «на воскресенье» is unactionable until the run knows today is
 *     Thursday the 17th.
 *  2. `composeErrandBrief()` — a small-model lane, modelled on
 *     `agent/lib/fast-ack.ts` and `convex/lib/broPhrasing.ts`, that writes
 *     ONE short outcome-focused brief: what "done" looks like for this
 *     errand, plus the concrete facts needed to get there. Same discipline
 *     as those two lanes: the API key is OPTIONAL, the budget is hard, the
 *     lane never throws, and on a miss the caller falls back to the static
 *     `ЦЕЛЬ: <task>` line the scaffold always used.
 *
 * What the brief must NOT contain: generic browsing advice. «Закрывай
 * баннеры», «работай быстро», «не застревай» are things a capable browser
 * agent already does, and every character of them used to be spent on every
 * run. The system prompt says so explicitly, and `sanitizeErrandBrief`
 * enforces the parts that are checkable (no second output contract, no
 * secrets, a hard line and character cap).
 *
 * Secrets never travel this way. Passwords and card numbers stay on the
 * `secretBindings` path (`agent/lib/browser-pay.ts`) where the Cloud server
 * types them without either model seeing them; the facts here are the
 * human's own address/name/phone/email, which the human would otherwise be
 * asked to retype. Everything this module emits goes through `scrubSecrets`
 * anyway, as a last-resort net over free-text memories.
 */

import { scrubSecrets } from "../../convex/lib/secretScrub.ts";
import { DEFAULT_OPENROUTER_MODEL } from "./model.ts";
import { withOpenRouterChatDefaults } from "./openrouter-chat.ts";
import { OPENROUTER_CHAT_URL } from "./openrouter-warm.ts";

type EnvLike = Record<string, string | undefined>;

/** Postal address as the vault stores it (`addressPayloadSchema`), minus nothing —
 *  every field here is the human's own, non-secret, and typed into checkout forms. */
export type ErrandAddress = {
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
};

/**
 * Everything non-secret Bro knows that a browser errand might need. Every
 * field is optional: a tenant with an empty vault and no memories produces
 * an empty `ErrandFacts`, and the scaffold then behaves exactly as it did
 * before this shipped.
 */
export type ErrandFacts = {
  /** `tenants.displayName` — how the human is addressed, not a recipient name. */
  displayName?: string;
  /** Vault `contact.fullName`, or the address recipient. */
  contactName?: string;
  /** Vault `contact.phone`. The tenant's own phone is an account id, not a
   *  delivery phone, so it is NOT substituted here. */
  phone?: string;
  email?: string;
  address?: ErrandAddress;
  /** Curated memories (`memories.wakeContext`), already short lines. */
  memories?: readonly string[];
  /** IANA zone, already resolved through `resolveTenantTz`. */
  tz?: string;
  /** Current local date and time in `tz`, pre-formatted in Russian. */
  nowLocal?: string;
};

export type ErrandBriefInput = {
  /** The errand as the coordinator model phrased it. */
  task: string;
  /** The human's ORIGINAL wording, when the caller has it. */
  humanText?: string;
  facts?: ErrandFacts;
  /** A vault card is bound to this run. */
  pay?: boolean;
  /** A vault login is bound to this run. */
  login?: boolean;
  /** This run resumes an already-open tab from a previous step. */
  continuation?: boolean;
  /** The page Bro opens over CDP before the run reads anything. */
  startPage?: string;
};

/** Longest brief we will ever paste into a task. Past this the "brief" is a
 *  second scaffold, which is the thing this module exists to delete. */
export const ERRAND_BRIEF_MAX_CHARS = 700;
export const ERRAND_BRIEF_MAX_LINES = 6;

/** Memories are free text a human dictated; cap both count and length so one
 *  rambling note cannot become the largest thing in the prompt. */
export const MEMORY_LINE_LIMIT = 6;
export const MEMORY_LINE_MAX_CHARS = 180;

/** Default budget. A Cloud run costs minutes, so ~1.5s of composition is
 *  free in wall-clock terms — but it is still hard-capped, because a hung
 *  OpenRouter call must never be the reason an errand does not start. */
export const ERRAND_BRIEF_BUDGET_MS = 1_500;

/** `BRO_ERRAND_BRIEF=0|off|false` turns the lane off; anything else leaves it on. */
export function errandBriefEnabled(env: EnvLike = process.env): boolean {
  const raw = env.BRO_ERRAND_BRIEF?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "off" || raw === "false");
}

/**
 * Every whitespace character is stripped, not just the ends: a key pasted
 * into a hosted environment can carry a newline in the MIDDLE, and `fetch`
 * rejects such a header outright — which would turn a configured deployment
 * into a permanently-falling-back one, silently. Same treatment the fast-ack
 * and phrasing lanes give their keys.
 */
export function errandBriefKey(env: EnvLike = process.env): string | undefined {
  return env.OPENROUTER_API_KEY?.replace(/\s+/gu, "") || undefined;
}

/** True when this deployment can compose at all — checked before any work. */
export function errandBriefConfigured(env: EnvLike = process.env): boolean {
  return errandBriefEnabled(env) && errandBriefKey(env) !== undefined;
}

export function errandBriefModel(env: EnvLike = process.env): string {
  return (
    env.BRO_ERRAND_BRIEF_MODEL?.trim() ||
    env.BRO_FAST_ACK_MODEL?.trim() ||
    env.BRO_MODEL?.trim() ||
    DEFAULT_OPENROUTER_MODEL
  );
}

export function errandBriefBudgetMs(env: EnvLike = process.env): number {
  const raw = env.BRO_ERRAND_BRIEF_BUDGET_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : ERRAND_BRIEF_BUDGET_MS;
}

/**
 * The register, once. Deliberately blunt about what NOT to write: the whole
 * point of composing per errand is that the ~980 characters of generic
 * browsing advice the old scaffold shipped every time are gone, and a small
 * model's first instinct is to write them back.
 */
export const ERRAND_BRIEF_SYSTEM = `Ты пишешь задание для браузерного агента, который прямо сейчас сядет и выполнит поручение человека на сайте.
Тебе дают слова человека и факты, которые про него уже известны.
Выведи задание по-русски, от 1 до 5 строк, обычным текстом без заголовков, нумерации и маркеров.
Первая строка — что значит «сделано» для ЭТОЙ задачи: конкретный результат, который должен быть на экране в конце.
Дальше — только те известные данные, которые нужны именно для этой задачи, в том виде, в каком их надо будет ввести. Относительные сроки («на воскресенье», «завтра») переведи в конкретную дату, считая от «сейчас».
Ничего не выдумывай: нет факта — не упоминай его.
Не пиши общих советов про браузер: баннеры, капчи, куки, скорость, «не застревай», «жми Tab» — агент это умеет сам.
Не пиши пароли, номера карт и коды. Не повторяй формат отчёта и слова НУЖНО, СДЕЛАНО, ЗАКАЗ, СУММА, ВАРИАНТЫ, ДЕТАЛИ.
В ответе — только текст задания, без кавычек и пояснений.`;

/** Labels the output contract owns. A brief that re-emits them would give the
 *  run two contracts and `browserOutcomePolicy` the wrong one to parse. */
const CONTRACT_LABELS = [
  "СДЕЛАНО",
  "ЗАКАЗ",
  "СУММА",
  "КОГДА",
  "ВАРИАНТЫ",
  "НУЖНО",
  "ДЕТАЛИ",
  "ЦЕЛЬ",
  "NEEDS",
] as const;

const CONTRACT_LINE = new RegExp(`^\\s*(?:${CONTRACT_LABELS.join("|")})\\s*:`, "iu");

/**
 * The line the scaffold falls back to when the composer is off, unkeyed,
 * over budget or unusable — byte-for-byte the goal line the scaffold has
 * always opened with, so a deployment without `OPENROUTER_API_KEY` sends
 * exactly what it sent before.
 */
export function staticBriefLine(task: string): string {
  return task.trim();
}

function shorten(raw: string, max: number): string {
  const s = raw.replace(/\s+/gu, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function addressOneLine(a: ErrandAddress): string {
  return [
    a.line1,
    a.line2,
    a.city,
    a.region,
    a.postalCode,
    // RU is the default for every stored address; naming it adds noise, a
    // foreign country code is exactly the thing a run must not guess.
    a.countryCode && a.countryCode !== "RU" ? a.countryCode : undefined,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

/** The fact lines, in the order a checkout form asks for them. */
export function factLines(facts?: ErrandFacts): string[] {
  if (!facts) return [];
  const lines: string[] = [];
  const recipient = facts.contactName?.trim() || facts.address?.recipientName?.trim();
  if (facts.displayName?.trim()) lines.push(`зовут: ${facts.displayName.trim()}`);
  if (recipient) lines.push(`получатель: ${recipient}`);
  if (facts.phone?.trim()) lines.push(`телефон: ${facts.phone.trim()}`);
  if (facts.email?.trim()) lines.push(`почта: ${facts.email.trim()}`);
  if (facts.address) {
    const address = addressOneLine(facts.address);
    if (address) lines.push(`адрес доставки: ${address}`);
  }
  // The current local date is the single most load-bearing fact here: «на
  // воскресенье» is not a date until the run knows what day it is, and the
  // Cloud agent's own clock is neither the human's zone nor reliable.
  if (facts.nowLocal?.trim()) {
    const tz = facts.tz?.trim();
    lines.push(`сейчас: ${facts.nowLocal.trim()}${tz ? ` (${tz})` : ""}`);
  }
  for (const memory of (facts.memories ?? []).slice(0, MEMORY_LINE_LIMIT)) {
    const line = shorten(memory ?? "", MEMORY_LINE_MAX_CHARS);
    if (line) lines.push(`помню: ${line}`);
  }
  return lines.map((line) => scrubSecrets(line));
}

export function hasErrandFacts(facts?: ErrandFacts): boolean {
  return factLines(facts).length > 0;
}

/**
 * The inverted restriction. The old scaffold said «что знает только человек
 * — не придумывай: закончи с НУЖНО: address или info», full stop, and so a
 * run aborted asking for a street Bro had on file. Now the facts come first
 * and `НУЖНО` is the fallback for what is genuinely missing — the ban on
 * INVENTING a fact is what survives, not the ban on knowing one.
 */
export const KNOWN_FACTS_GAP =
  "Чего нет ни здесь, ни в задаче — не выдумывай: закончи с НУЖНО: address или info и напиши в ДЕТАЛИ, чего не хватает.";

/** Same sentence for a tenant whose vault and memories really are empty. */
export const MISSING_FACTS_LINE =
  "Данных человека — адреса, имени, телефона, времени, размера — не нашлось: не выдумывай их, закончи с НУЖНО: address или info и напиши в ДЕТАЛИ, чего не хватает.";

/** The known-facts block, or "" when Bro knows nothing worth passing along. */
export function knownFactsBlock(facts?: ErrandFacts): string {
  const lines = factLines(facts);
  if (lines.length === 0) return "";
  return [
    "ИЗВЕСТНО (это данные самого человека — вводи их сам, не переспрашивай):",
    ...lines.map((line) => `- ${line}`),
    KNOWN_FACTS_GAP,
  ].join("\n");
}

/** The user message the composer sees: the errand, the human's own line, the facts. */
export function errandBriefPrompt(input: ErrandBriefInput): string {
  const lines: string[] = [];
  const human = input.humanText?.trim();
  const task = input.task.trim();
  lines.push(`Человек попросил: ${task}`);
  if (human && human !== task) lines.push(`Его собственные слова: «${human}»`);
  const facts = factLines(input.facts);
  if (facts.length > 0) {
    lines.push("Известно про человека:");
    for (const fact of facts) lines.push(`- ${fact}`);
  } else {
    lines.push("Про человека ничего не известно — данных для ввода нет.");
  }
  if (input.startPage) lines.push(`Сайт уже будет открыт: ${input.startPage}`);
  if (input.continuation) {
    lines.push("Страница уже открыта с предыдущего шага этого же поручения.");
  }
  if (input.pay) lines.push("Карта для оплаты подключена отдельно, её реквизиты не нужны.");
  if (input.login) lines.push("Логин и пароль подключены отдельно, их не называй.");
  return lines.join("\n");
}

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["«", "»"],
  ['"', '"'],
  ["'", "'"],
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

/**
 * Cleans the composer's raw output; null when it is unusable, which sends
 * the caller back to the static line. Drops anything that would give the run
 * a SECOND output contract, and scrubs secrets as a last-resort net.
 */
export function sanitizeErrandBrief(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  // Small models like to wrap prose in a fence when the prompt mentions a format.
  s = s.replace(/^```[a-z]*\n?/iu, "").replace(/\n?```$/u, "").trim();
  s = stripSurroundingQuotes(s);
  const lines = s
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/u, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !CONTRACT_LINE.test(line));
  if (lines.length === 0) return null;
  if (lines.length > ERRAND_BRIEF_MAX_LINES) return null;
  const out = scrubSecrets(lines.join("\n")).trim();
  if (!out) return null;
  if (out.length > ERRAND_BRIEF_MAX_CHARS) return null;
  if (out.toLowerCase() === "none") return null;
  return out;
}

type ChatResponse = { choices?: Array<{ message?: { content?: unknown } }> };

/**
 * One bounded OpenRouter call. Returns the brief, or null — never throws,
 * never rejects, and never takes longer than the budget. Every failure mode
 * (lane off, no key, non-200, malformed JSON, timeout, unusable text) lands
 * on the same `null`, and the caller's `?? staticBriefLine(task)` is always
 * reachable.
 */
export async function composeErrandBrief(
  input: ErrandBriefInput,
  opts?: { env?: EnvLike; fetchImpl?: typeof fetch; now?: () => number },
): Promise<string | null> {
  const env = opts?.env ?? process.env;
  if (!errandBriefEnabled(env)) return null;
  const apiKey = errandBriefKey(env);
  if (!apiKey) return null;
  if (!input.task.trim()) return null;

  const now = opts?.now ?? Date.now;
  const startedAt = now();
  const budgetMs = errandBriefBudgetMs(env);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  // The `+300` mirrors the fast-ack lane: the outer race below is the real
  // deadline, this only stops a socket from outliving the decision.
  const signal = AbortSignal.timeout(budgetMs + 300);

  const body = withOpenRouterChatDefaults(
    {
      model: errandBriefModel(env),
      stream: false,
      max_tokens: 220,
      // Low, not zero: this is an instruction, not a personality. The facts
      // must come back as given, so the model has little room to be creative.
      temperature: 0.3,
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: ERRAND_BRIEF_SYSTEM },
        { role: "user", content: errandBriefPrompt(input) },
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
    // A synchronously throwing fetch must not take the errand down with it.
    console.error("errand brief failed", err);
    return null;
  }

  const composed = request
    .then(async (res) => {
      if (!res.ok) {
        console.error("errand brief failed", new Error(`status ${res.status}`));
        return null;
      }
      let json: ChatResponse;
      try {
        json = (await res.json()) as ChatResponse;
      } catch (err) {
        console.error("errand brief failed", err);
        return null;
      }
      const raw = json.choices?.[0]?.message?.content;
      return sanitizeErrandBrief(typeof raw === "string" ? raw : null);
    })
    .catch((err: unknown) => {
      if (!(err instanceof Error && err.name === "AbortError")) {
        console.error("errand brief failed", err);
      }
      return null;
    });

  // The race, with the timer cleared afterwards: a pending timer keeps the
  // Node event loop alive, so a lane that answered in 200ms must not hold a
  // serverless invocation open for the rest of its budget.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  const brief = await Promise.race([composed, deadline]);
  if (timer) clearTimeout(timer);
  console.log("errand brief", { ms: now() - startedAt, composed: Boolean(brief) });
  return brief;
}
