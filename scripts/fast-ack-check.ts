import { existsSync } from "node:fs";

import {
  FAST_ACK_ATTR,
  FAST_ACK_SYSTEM,
  fastAckAttribute,
  fastAckBudgetMs,
  fastAckEnabled,
  fastAckInstruction,
  fastAckModel,
  fastAckOf,
  fastAckPrompt,
  peelFastAck,
  sanitizeFastAck,
  settleFastAck,
  shouldFastAck,
  startFastAck,
} from "../agent/lib/fast-ack.ts";
import { DEFAULT_OPENROUTER_MODEL } from "../agent/lib/model.ts";

import { assert, eq, src, withEnv } from "./lib/check.ts";

// --- env parsing ---
assert(fastAckEnabled({}) === true, "unset BRO_FAST_ACK defaults to enabled");
assert(fastAckEnabled({ BRO_FAST_ACK: "1" }) === true, "1 enables");
assert(fastAckEnabled({ BRO_FAST_ACK: "on" }) === true, "on enables");
assert(fastAckEnabled({ BRO_FAST_ACK: "0" }) === false, "0 disables");
assert(fastAckEnabled({ BRO_FAST_ACK: "off" }) === false, "off disables");
assert(fastAckEnabled({ BRO_FAST_ACK: "false" }) === false, "false disables");

assert(fastAckBudgetMs({}) === 700, "default budget is 700ms");
assert(fastAckBudgetMs({ BRO_FAST_ACK_BUDGET_MS: "500" }) === 500, "explicit budget is used");
assert(fastAckBudgetMs({ BRO_FAST_ACK_BUDGET_MS: "abc" }) === 700, "garbage budget falls back");
assert(fastAckBudgetMs({ BRO_FAST_ACK_BUDGET_MS: "-5" }) === 700, "negative budget falls back");
assert(fastAckBudgetMs({ BRO_FAST_ACK_BUDGET_MS: "0" }) === 700, "zero budget falls back");

withEnv({ BRO_FAST_ACK_MODEL: undefined, BRO_MODEL: undefined }, () => {
  assert(
    fastAckModel() === DEFAULT_OPENROUTER_MODEL,
    "no overrides falls back to the default OpenRouter model",
  );
});
withEnv({ BRO_FAST_ACK_MODEL: undefined, BRO_MODEL: "some/model" }, () => {
  assert(fastAckModel() === "some/model", "BRO_MODEL is used when BRO_FAST_ACK_MODEL is unset");
});
withEnv({ BRO_FAST_ACK_MODEL: "tiny/model", BRO_MODEL: "some/model" }, () => {
  assert(fastAckModel() === "tiny/model", "BRO_FAST_ACK_MODEL wins over BRO_MODEL");
});

// --- shouldFastAck ---
assert(shouldFastAck("купи кроссовки на вб"), "an errand triggers the fast-ack lane");
assert(!shouldFastAck("ок"), "a short ack does not");
assert(!shouldFastAck("спасибо бро"), "thanks does not");
assert(!shouldFastAck("[event:mail] новое письмо"), "event placeholder does not");
assert(!shouldFastAck("[background wakeup] напоминание"), "wakeup placeholder does not");
assert(shouldFastAck("[voice] запиши к врачу"), "a voice transcript still triggers");
assert(!shouldFastAck("а".repeat(700)), "a long paste does not");
assert(!shouldFastAck(""), "empty text does not");
assert(!shouldFastAck("   "), "whitespace-only text does not");

// F_extra — the fast-ack lane cannot know whether a Cloud session is open, so
// it must defer entirely on anything that looks like a code, a wait, or a
// push/3DS confirmation.
assert(!shouldFastAck("482913"), "a bare OTP code gets no fast ack");
assert(!shouldFastAck("подтвердил"), "a push confirmation gets no fast ack");
assert(!shouldFastAck("подожди"), "a wait-inject line gets no fast ack");

// --- sanitizeFastAck ---
eq(sanitizeFastAck("ищу на вб."), "ищу на вб", "trailing period is stripped");
eq(sanitizeFastAck("«смотрю почту»"), "смотрю почту", "surrounding quotes are stripped");
eq(sanitizeFastAck("NONE"), null, "NONE means nothing to send");
eq(sanitizeFastAck("none"), null, "none is case-insensitive");
eq(
  sanitizeFastAck("Конечно! Сейчас найду кроссовки на WB и пришлю варианты"),
  null,
  "a full sentence is rejected (too many words/chars)",
);
eq(sanitizeFastAck("Бро. ищу"), null, "a line starting with «Бро» is rejected");
eq(sanitizeFastAck("смотрю почту\nещё какой-то текст"), "смотрю почту", "multi-line takes the first line");
eq(sanitizeFastAck("ищу тут: http://example.com"), null, "a URL is rejected");
eq(sanitizeFastAck(null), null, "null raw input");
eq(sanitizeFastAck(undefined), null, "undefined raw input");
eq(sanitizeFastAck(""), null, "empty raw input");
eq(sanitizeFastAck("   "), null, "whitespace-only raw input");
eq(sanitizeFastAck("статус: ищу"), null, "a colon field label is rejected");
eq(
  sanitizeFastAck("ищу нашёл проверяю ставлю открываю прочее лишнее"),
  null,
  "more than 6 words is rejected",
);

// --- fastAckAttribute / fastAckOf round trip ---
eq(Object.keys(fastAckAttribute(null)).length, 0, "null yields no attribute at all");
eq(
  JSON.stringify(fastAckAttribute("ищу на вб")),
  JSON.stringify({ [FAST_ACK_ATTR]: "ищу на вб" }),
  "text yields a plain-string attribute (wire v1 rejects undefined)",
);
eq(fastAckOf({}), null, "missing attribute reads as null");
eq(fastAckOf({ fastAck: "ищу на вб" }), "ищу на вб", "string attribute round-trips");
eq(
  fastAckOf({ fastAck: ["ищу на вб", "extra"] }),
  "ищу на вб",
  "array-valued attribute reads the first item",
);
eq(fastAckOf({ fastAck: "   " }), null, "whitespace-only attribute reads as null");
eq(fastAckOf(undefined), null, "missing attrs object reads as null");
eq(fastAckOf(null), null, "null attrs object reads as null");

assert(fastAckInstruction("ищу на вб").includes("ищу на вб"), "instruction quotes the sent line");
assert(
  fastAckInstruction("x").toLowerCase().includes("do not repeat"),
  "instruction steers the real turn against repeating the line",
);

// --- startFastAck / settleFastAck ---
{
  const fakeFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: " ищу на вб. " } }] }),
      { status: 200 },
    )) as typeof fetch;
  const handle = startFastAck("купи кроссовки на вб", {
    env: { OPENROUTER_API_KEY: "sk-test" },
    fetchImpl: fakeFetch,
  });
  assert(handle !== null, "a qualifying message with a key returns a handle");
  const result = await handle!.promise;
  eq(result, "ищу на вб", "the fake response is sanitized before it resolves");
}

{
  let capturedSignal: AbortSignal | undefined;
  const neverResolves: typeof fetch = ((_input: unknown, init?: RequestInit) => {
    capturedSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {
      // deliberately never settles
    });
  }) as typeof fetch;
  const handle = startFastAck("купи кроссовки на вб", {
    env: { OPENROUTER_API_KEY: "sk-test" },
    fetchImpl: neverResolves,
  });
  assert(handle !== null, "handle created before the budget check");
  const result = await settleFastAck(handle, { budgetMs: 30 });
  eq(result, null, "budget expiry resolves null rather than waiting forever");
  assert(capturedSignal?.aborted === true, "the abort signal fired once the budget expired");
}

{
  const rejecting: typeof fetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;
  const handle = startFastAck("купи кроссовки на вб", {
    env: { OPENROUTER_API_KEY: "sk-test" },
    fetchImpl: rejecting,
  });
  const result = await handle!.promise;
  eq(result, null, "a rejecting fetch resolves null and never throws");
}

eq(
  startFastAck("купи кроссовки на вб", {
    env: { OPENROUTER_API_KEY: "sk-test", BRO_FAST_ACK: "0" },
  }),
  null,
  "disabled env returns no handle at all",
);
eq(
  startFastAck("купи кроссовки на вб", { env: {} }),
  null,
  "missing OPENROUTER_API_KEY returns no handle",
);
eq(
  startFastAck("ок", { env: { OPENROUTER_API_KEY: "sk-test" } }),
  null,
  "a short ack returns no handle",
);

eq(await settleFastAck(null), null, "settling a null handle is a no-op");

{
  let resolveFn!: (v: string | null) => void;
  const promise = new Promise<string | null>((resolve) => {
    resolveFn = resolve;
  });
  const handle = { promise, abort: () => undefined, startedAt: 1_000 };
  const settlePromise = settleFastAck(handle, { budgetMs: 700, now: () => 1_050 });
  resolveFn("ищу на вб");
  const result = await settlePromise;
  eq(result, "ищу на вб", "a promise that wins inside the budget resolves with its value");
}

// --- source wiring ---
const imessage = src("agent/channels/imessage.ts");
const telegram = src("agent/channels/telegram.ts");
const jobs = src("agent/instructions/jobs.ts");
const delivery = src("agent/lib/turn-delivery-events.ts");
const fastAckSrc = src("agent/lib/fast-ack.ts");

assert(imessage.includes("startFastAck("), "iMessage starts the fast-ack lane");
assert(imessage.includes("settleFastAck("), "iMessage settles the lane before from().send()");
assert(imessage.includes("fastAckAttribute("), "iMessage stamps the fast ack on attributes");
assert(telegram.includes("startFastAck("), "telegram starts the fast-ack lane");
assert(telegram.includes("settleFastAck("), "telegram settles the lane before from().send()");
assert(telegram.includes("fastAckAttribute("), "telegram stamps the fast ack on attributes");

assert(imessage.includes("from(inbound.spaceId).send("), "the Photon human turn is still sent");
eq(
  (imessage.match(/from\(inbound\.spaceId\)\.send\(/g) ?? []).length,
  1,
  "iMessage sends the human turn exactly once — the agent turn is never skipped",
);
eq(
  (telegram.match(/from\([^)]*\)\.send\(/g) ?? []).length,
  2,
  "telegram still sends on both the callback and message routes",
);

assert(jobs.includes("fastAckInstruction("), "turn.started steers the real turn off the fast ack");
assert(delivery.includes("alreadySentFor("), "delivery dedupes streamed text against the fast ack");

assert(
  !fastAckSrc.includes("bubblesFor"),
  "fast-ack.ts never reaches into the delivery module's in-memory maps",
);
assert(
  !/new Map/.test(fastAckSrc),
  "fast-ack.ts holds no cross-process in-memory state of its own",
);
assert(
  !existsSync(new URL("../agent/lib/instant-ack.ts", import.meta.url)),
  "no instant-ack.ts skip lane — the agent turn always runs",
);

assert(FAST_ACK_SYSTEM.length <= 900, "system prompt stays compact");
assert(FAST_ACK_SYSTEM.includes("NONE"), "system prompt defines the NONE escape hatch");

// --- review round: restatement peel, sanitize tightening, sync-throw guard ---
{
  const ack = "ищу на вб";
  eq(peelFastAck(ack, "Ищу на ВБ."), null, "case-different restatement is dropped");
  eq(peelFastAck(ack, "Ищу на вб 👀"), null, "emoji tail restatement is dropped");
  eq(peelFastAck(ack, "Ищу кроссовки на ВБ."), null, "same content words → restatement dropped");
  eq(peelFastAck(ack, "Ищу на ВБ, размер 42"), "размер 42", "ack prefix is peeled case-insensitively");
  eq(peelFastAck(ack, "Ищу на ВБ. Нашёл 3 варианта"), "Нашёл 3 варианта", "sentence after the ack survives");
  eq(peelFastAck(ack, "ищу на вб\n\nНашёл 3 варианта"), "Нашёл 3 варианта", "body after the ack line survives");
  eq(peelFastAck(ack, "открываю вб"), "открываю вб", "a different status beat is kept");
  eq(peelFastAck(ack, "смотрю почту"), "смотрю почту", "unrelated beat is kept");
  eq(peelFastAck(ack, "Нашёл: Nike Air 5990 ₽"), "Нашёл: Nike Air 5990 ₽", "real content is kept");
  eq(peelFastAck("", "Ищу на ВБ."), "Ищу на ВБ.", "empty ack peels nothing");

  eq(sanitizeFastAck("статус:"), null, "bare field label is rejected");
  eq(sanitizeFastAck("перезвони +7 999 123 45 67"), null, "phone-number dump is rejected");
  eq(sanitizeFastAck("смотрю почту и календарь сейчас же"), null, "six words is too long for a beat");
  eq(sanitizeFastAck("ищу"), "ищу", "a single-word beat is fine");

  assert(!shouldFastAck("привет"), "canned welcome ask gets no fast ack");
  assert(!shouldFastAck("телеграм"), "telegram invite ask gets no fast ack");
  assert(!shouldFastAck("help"), "help ask gets no fast ack");
  eq(fastAckPrompt("   купи хлеб   "), "купи хлеб", "prompt is the trimmed text");
  eq(fastAckPrompt(" ".repeat(700) + "купи хлеб").length, 9, "leading whitespace does not eat the message");

  withEnv({ OPENROUTER_API_KEY: "k", BRO_FAST_ACK: undefined }, () => {
    const handle = startFastAck("купи хлеб", {
      fetchImpl: (() => {
        throw new Error("sync boom");
      }) as unknown as typeof fetch,
    });
    assert(handle === null, "a synchronously throwing fetch yields null, never a throw");
  });

  const events = src("agent/lib/turn-delivery-events.ts");
  assert(events.includes("afterFastAck("), "delivery events peel the fast ack from the first model bubble");
  assert(events.includes("peelFastAck"), "delivery events use the case-insensitive peel");
}

console.log("fast-ack-check ok");
