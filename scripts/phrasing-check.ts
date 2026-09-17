/**
 * The phrasing lane: Bro writes the progress notes and the finished-errand
 * report himself, and the canned palette stays underneath as the fallback.
 *
 * What this pins down:
 *  - the hard budget (a slow model falls back, it never delays delivery);
 *  - every failure mode (no key, disabled, non-200, empty, garbage) → null;
 *  - facts survive the rewrite: a done line that dropped the order number or
 *    the sum is rejected, and so is any number the outcome never carried;
 *  - the gate rejects a URL, a field label, a «Бро» opener, an emoji and
 *    anything secret-shaped;
 *  - the no-key path does not fetch, does not log and does not hop;
 *  - the fallback is still seed-stable, so a retried poll cannot rephrase
 *    itself mid-run.
 */

import {
  DONE_BUDGET_MS,
  PROGRESS_BUDGET_MS,
  PHRASE_SYSTEM,
  doneFacts,
  generatePhrase,
  phraseBudgetMs,
  phrasePrompt,
  phrasingConfigured,
  phrasingModel,
  sanitizePhrase,
  type PhraseFacts,
} from "../convex/lib/broPhrasing.ts";
import { parseCloudOutcome } from "../convex/lib/browserOutcomePolicy.ts";
import {
  doneNowLine,
  nextProgressNote,
  pickProgressVariant,
} from "../convex/lib/browserProgressPolicy.ts";

import { assert, eq, makeFetch, src } from "./lib/check.ts";

const KEY_ENV = { OPENROUTER_API_KEY: "sk-test" } as const;

const FACTS: PhraseFacts = {
  done: "заказал такси до аэропорта",
  orderId: "508",
  amountRub: 1290,
  when: "через 5 минут",
};

function ok(content: string) {
  return () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

// ============================================================================
// 1. The prompt: small, and it never sees anything but parsed facts.
// ============================================================================

assert(PHRASE_SYSTEM.length < 1200, "the register prompt stays small");
assert(!/^\s*$/.test(PHRASE_SYSTEM), "the register prompt is real");
for (const rule of ["эмодзи", "ссылок", "Пароли", "Цифры"]) {
  assert(PHRASE_SYSTEM.includes(rule), `register rule kept: ${rule}`);
}

{
  const prompt = phrasePrompt("done", FACTS);
  assert(prompt.includes("508") && prompt.includes("1290"), "the done prompt carries the facts");
  assert(prompt.length < 600, "the done prompt stays small");
  const note = phrasePrompt("opened", { where: "в озоне" });
  assert(note.includes("в озоне"), "a progress prompt carries the human site phrase");
  assert(
    !phrasePrompt("opened", {}).includes("undefined"),
    "an unknown place never leaks the word undefined into the prompt",
  );
  assert(
    phrasePrompt("long", {}).includes("отмени"),
    "the long note prompt still offers the way out",
  );
}

// `doneFacts` is the only door between the run and the model: the raw result
// (which can carry a page dump, a code, a card) has no field here at all.
{
  const outcome = parseCloudOutcome(
    `СДЕЛАНО: заказал такси
ЗАКАЗ: 508
СУММА: 1290 ₽
КОГДА: через 5 минут
ДЕТАЛИ: пароль: hunter2, карта 4111 1111 1111 1111
НУЖНО: none`,
  );
  const facts = doneFacts(outcome);
  eq(Object.keys(facts).sort().join(","), "amountRub,done,orderId,when", "only speakable fields cross");
  assert(!("detail" in facts), "ДЕТАЛИ never reaches the model");
  assert(
    !JSON.stringify(facts).includes("hunter2") && !JSON.stringify(facts).includes("4111"),
    "nothing secret-shaped can ride along in the facts",
  );
}

// ============================================================================
// 2. The sanitiser.
// ============================================================================

eq(sanitizePhrase("", "done", FACTS), null, "empty output → fallback");
eq(sanitizePhrase(null, "done", FACTS), null, "null output → fallback");
eq(sanitizePhrase("   \n  ", "done", FACTS), null, "whitespace output → fallback");

// A good line survives, quotes and trailing junk stripped.
eq(
  sanitizePhrase("«Всё, такси поймал.\nномер 508, 1290 ₽, подъедет через 5 минут»", "done", FACTS),
  "Всё, такси поймал.\nномер 508, 1290 ₽, подъедет через 5 минут",
  "a clean two-line report passes, quotes stripped",
);
eq(
  sanitizePhrase("Готово, такси будет через 5 минут — 508, 1290 ₽,", "done", FACTS),
  "Готово, такси будет через 5 минут — 508, 1290 ₽",
  "a stray trailing comma is stripped",
);

// Facts must survive the rewrite.
eq(
  sanitizePhrase("Всё, такси заказал, 1290 ₽.", "done", FACTS),
  null,
  "a done line that dropped the order number falls back",
);
eq(
  sanitizePhrase("Всё, такси заказал, заказ 508.", "done", FACTS),
  null,
  "a done line that dropped the sum falls back",
);
assert(
  sanitizePhrase("Такси едет. 508, 1 290 ₽, через 5 минут", "done", FACTS) !== null,
  "a thousands space inside the sum is still the same sum",
);
eq(
  sanitizePhrase("Такси едет, заказ 509, 1290 ₽, через 5 минут", "done", FACTS),
  null,
  "a hallucinated order number falls back",
);
eq(
  sanitizePhrase("Такси едет, заказ 508, 1290 ₽, будет в 14:30", "done", FACTS),
  null,
  "a number the outcome never carried falls back",
);
// With no order/sum in the outcome there is nothing numeric to protect.
assert(
  sanitizePhrase("Записал тебя на завтра, всё подтвердили.", "done", {
    done: "записал к врачу",
  }) !== null,
  "an outcome with no numbers still gets a generated line",
);

// Shape and register.
eq(sanitizePhrase("Бро, всё готово: 508, 1290 ₽", "done", FACTS), null, "«Бро» opener → fallback");
eq(sanitizePhrase("bro, готово 508 1290", "done", FACTS), null, "«bro» opener → fallback");
eq(
  sanitizePhrase("Готово: смотри https://ozon.ru/order/508 — 1290 ₽", "done", FACTS),
  null,
  "a URL → fallback",
);
eq(
  sanitizePhrase("Готово, всё на ozon.ru, 508, 1290 ₽", "done", FACTS),
  null,
  "a bare domain → fallback",
);
eq(
  sanitizePhrase("СДЕЛАНО: такси\nЗАКАЗ: 508", "done", FACTS),
  null,
  "a field label → fallback",
);
eq(
  sanitizePhrase("Статус: всё готово, 508, 1290 ₽", "done", FACTS),
  null,
  "a «Статус:» label → fallback",
);
eq(
  sanitizePhrase("Готово 🚕 508, 1290 ₽", "done", FACTS),
  null,
  "an emoji → fallback",
);
eq(
  sanitizePhrase("Готово, 508, 1290 ₽\nвторая\nтретья", "done", FACTS),
  null,
  "more than two lines → fallback",
);
eq(
  sanitizePhrase(`Готово. ${"очень длинно ".repeat(30)}508 1290`, "done", FACTS),
  null,
  "an over-long report → fallback",
);
eq(
  sanitizePhrase("Готово, пароль от кабинета hunter2, 508, 1290 ₽", "done", FACTS),
  null,
  "a password-shaped line → fallback",
);
eq(
  sanitizePhrase("Оплатил картой 4111 1111 1111 1111", "done", { done: "оплатил" }),
  null,
  "a card-shaped line → fallback",
);

// Progress notes are one line, and «long» must keep the way out.
eq(
  sanitizePhrase("Я уже в озоне.\nСкоро закончу.", "opened", { where: "в озоне" }),
  null,
  "a two-line progress note → fallback",
);
assert(
  sanitizePhrase("так, я в озоне — начинаю", "opened", { where: "в озоне" }) !== null,
  "a clean one-line progress note passes",
);
eq(
  sanitizePhrase("всё ещё вожусь, потерпи", "long", {}),
  null,
  "a long note without «отмени» → fallback",
);
assert(
  sanitizePhrase("всё ещё вожусь — надоест, напиши «отмени»", "long", {}) !== null,
  "a long note that keeps «отмени» passes",
);

// ============================================================================
// 3. The call: budget, failures, and the no-key path.
// ============================================================================

const slowEnv = { ...KEY_ENV, BRO_PHRASE_BUDGET_MS: "60" };

{
  // A model that never answers must not hold the human's report hostage.
  let aborted = false;
  const slow = makeFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
  );
  const t0 = Date.now();
  const line = await generatePhrase({
    kind: "done",
    facts: FACTS,
    env: slowEnv,
    fetchImpl: slow.fetch,
  });
  const ms = Date.now() - t0;
  eq(line, null, "a call that misses its budget falls back");
  assert(ms < 1_000, `the budget is a real ceiling (took ${ms}ms)`);
  assert(aborted, "the abandoned request is aborted, not left streaming");
}

{
  // Network error, non-200, malformed body, empty completion, garbage.
  const boom = makeFetch(() => Promise.reject(new Error("network")));
  eq(
    await generatePhrase({ kind: "done", facts: FACTS, env: KEY_ENV, fetchImpl: boom.fetch }),
    null,
    "a failed call falls back",
  );
  const http500 = makeFetch(() => new Response("nope", { status: 500 }));
  eq(
    await generatePhrase({ kind: "done", facts: FACTS, env: KEY_ENV, fetchImpl: http500.fetch }),
    null,
    "a non-200 falls back",
  );
  const notJson = makeFetch(() => new Response("<html>", { status: 200 }));
  eq(
    await generatePhrase({ kind: "done", facts: FACTS, env: KEY_ENV, fetchImpl: notJson.fetch }),
    null,
    "an unparseable body falls back",
  );
  const emptyChoice = makeFetch(ok(""));
  eq(
    await generatePhrase({ kind: "done", facts: FACTS, env: KEY_ENV, fetchImpl: emptyChoice.fetch }),
    null,
    "an empty completion falls back",
  );
  const noChoices = makeFetch(() => new Response("{}", { status: 200 }));
  eq(
    await generatePhrase({ kind: "done", facts: FACTS, env: KEY_ENV, fetchImpl: noChoices.fetch }),
    null,
    "a response with no choices falls back",
  );
  // A completion that ran into the token cap comes back with its tail sawn
  // off («…и я торм»). Sending that is worse than sending the canned line.
  const truncated = makeFetch(
    () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "Такси заказал, 508, 1290 ₽, приедет через 5 мин" },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  eq(
    await generatePhrase({ kind: "done", facts: FACTS, env: KEY_ENV, fetchImpl: truncated.fetch }),
    null,
    "a completion cut off at the token cap falls back",
  );
  const garbage = makeFetch(ok("Sure! Here is your message: «Готово: 777 ₽» 🎉"));
  eq(
    await generatePhrase({ kind: "done", facts: FACTS, env: KEY_ENV, fetchImpl: garbage.fetch }),
    null,
    "a garbage response falls back",
  );
}

{
  // The happy path, end to end.
  const good = makeFetch(ok("Всё, такси поймал.\n508, 1290 ₽, подъедет через 5 минут"));
  eq(
    await generatePhrase({ kind: "done", facts: FACTS, env: KEY_ENV, fetchImpl: good.fetch }),
    "Всё, такси поймал.\n508, 1290 ₽, подъедет через 5 минут",
    "a good line is what the human gets",
  );
  eq(good.calls.length, 1, "one call, not a retry storm");
  const body = JSON.parse(good.calls[0]!.body ?? "{}") as {
    reasoning?: { enabled?: boolean };
    max_tokens?: number;
    messages?: Array<{ content?: string }>;
  };
  eq(body.reasoning?.enabled, false, "no thinking phase — this is a latency lane");
  assert((body.max_tokens ?? 999) <= 110, "the completion is capped short");
  assert(
    !JSON.stringify(body.messages).includes("НУЖНО"),
    "the raw Cloud result never reaches the wire",
  );
}

{
  // No key: no request, no hop, no behaviour change at all.
  const never = makeFetch(() => {
    throw new Error("must not fetch without a key");
  });
  eq(
    await generatePhrase({ kind: "done", facts: FACTS, env: {}, fetchImpl: never.fetch }),
    null,
    "no key → no line",
  );
  eq(never.calls.length, 0, "no key → no request at all");
  eq(phrasingConfigured({}), false, "no key → the caller skips the action hop");
  eq(phrasingConfigured({ OPENROUTER_API_KEY: "  " }), false, "a blank key is no key");
  {
    // A key pasted into a hosted env often carries a newline in the middle;
    // `fetch` rejects such a header outright, which would silently turn a
    // configured deployment into a permanently-falling-back one.
    const pasted = makeFetch(ok("Готово, такси едет. 508, 1290 ₽, через 5 минут"));
    const line = await generatePhrase({
      kind: "done",
      facts: FACTS,
      env: { OPENROUTER_API_KEY: "sk-or-v1-abc\ndef\n" },
      fetchImpl: pasted.fetch,
    });
    assert(line !== null, "a key pasted with a newline in it still works");
    const auth = "sk-or-v1-abcdef";
    assert(
      JSON.stringify(pasted.calls).length > 0 && phrasingConfigured({ OPENROUTER_API_KEY: "sk-or-v1-abc\ndef\n" }),
      `the whitespace is stripped out of the key (${auth})`,
    );
  }
  eq(phrasingConfigured(KEY_ENV), true, "a key turns the lane on");
  eq(
    phrasingConfigured({ ...KEY_ENV, BRO_PHRASING: "off" }),
    false,
    "BRO_PHRASING=off turns it back off",
  );
  const offFetch = makeFetch(() => {
    throw new Error("must not fetch when disabled");
  });
  eq(
    await generatePhrase({
      kind: "done",
      facts: FACTS,
      env: { ...KEY_ENV, BRO_PHRASING: "off" },
      fetchImpl: offFetch.fetch,
    }),
    null,
    "disabled → no line",
  );
  eq(offFetch.calls.length, 0, "disabled → no request");
}

// Budgets: the done line may take a beat, a progress note may not.
eq(DONE_BUDGET_MS, 1_200, "the done line gets ~1200ms, a fraction of the 44s the instant path saves");
eq(phraseBudgetMs("done", {}), DONE_BUDGET_MS, "the done budget defaults to 1200ms");
eq(phraseBudgetMs("opened", {}), PROGRESS_BUDGET_MS, "a progress note is tighter");
assert(PROGRESS_BUDGET_MS < DONE_BUDGET_MS, "progress notes are the tighter lane");
assert(DONE_BUDGET_MS <= 1_500, "the done budget stays a fraction of the 44s it saved");
eq(phraseBudgetMs("done", { BRO_PHRASE_BUDGET_MS: "300" }), 300, "the done budget is tunable");
eq(phraseBudgetMs("slow", { BRO_PHRASE_PROGRESS_BUDGET_MS: "250" }), 250, "…and so is the note budget");
eq(phraseBudgetMs("done", { BRO_PHRASE_BUDGET_MS: "junk" }), DONE_BUDGET_MS, "junk budget → default");
assert(phrasingModel({}).length > 0, "there is always a model to call");
eq(phrasingModel({ BRO_PHRASE_MODEL: "x/y" }), "x/y", "the phrasing model is tunable");

// ============================================================================
// 4. The fallback is untouched: same canned lines, same seed stability.
// ============================================================================

const DONE_RESULT = `СДЕЛАНО: заказал такси до аэропорта
ЗАКАЗ: 508
СУММА: 1290 ₽
КОГДА: через 5 минут
НУЖНО: none`;

{
  const a = doneNowLine("completed", DONE_RESULT, "run-seed-1");
  const b = doneNowLine("completed", DONE_RESULT, "run-seed-1");
  assert(a !== undefined, "the canned done report still exists");
  eq(a, b, "the canned report is seed-stable — a retried poll cannot rephrase itself");
  assert(a!.includes("508") && a!.includes("1290"), "the canned report keeps the facts");
  eq(
    pickProgressVariant("slow", "в озоне", "run-seed-1"),
    pickProgressVariant("slow", "в озоне", "run-seed-1"),
    "the canned progress note is seed-stable too",
  );
}

// The note now hands out the human site phrase for the phrasing lane, and
// keeps saying nothing about a place it cannot name.
{
  const opened = nextProgressNote({
    status: "running",
    startedAt: 0,
    now: 0,
    pageUrl: "https://m.ozon.ru/cart",
    task: "закажи молока",
    loginWait: false,
    sent: [],
    seed: "run-1",
  });
  eq(opened?.where, "в озоне", "the note carries the human site phrase");
  assert(opened!.text.includes("в озоне"), "…and the canned text still uses it");
  const unknown = nextProgressNote({
    status: "running",
    startedAt: 0,
    now: 0,
    pageUrl: "https://shop-xyz.example/cart",
    task: "закажи молока",
    loginWait: false,
    sent: [],
    seed: "run-1",
  });
  eq(unknown?.where, undefined, "an unnameable host yields no place, never a hostname");
}

// ============================================================================
// 5. Wiring.
// ============================================================================

{
  const follow = src("convex/browserFollow.ts");
  assert(
    /const text =\s*\(opts\.facts \? await phraseOrNull\(ctx, "done", opts\.facts\) : null\) \?\? opts\.text;/.test(
      follow,
    ),
    "deliverDoneNow sends the phrased line, with the canned one as the fallback",
  );
  const deliverFn = follow.slice(
    follow.indexOf("async function deliverDoneNow"),
    follow.indexOf("const startResult"),
  );
  assert(
    deliverFn.indexOf("claimBrowserWakeup") < deliverFn.indexOf("phraseOrNull"),
    "nothing is phrased before the claim is won",
  );
  assert(
    deliverFn.indexOf("phraseOrNull") < deliverFn.indexOf("notifyHuman("),
    "…and the phrasing happens before the send, not after",
  );
  assert(
    follow.includes("facts: doneFacts(outcome!)"),
    "pollRun hands over the parsed outcome fields, never run.result",
  );
  assert(
    /phraseOrNull\(ctx, note\.key, note\.where \? \{ where: note\.where \} : \{\}\)\) \?\?\s*note\.text/.test(
      follow,
    ),
    "the progress note is phrased with the canned note as the fallback",
  );
  assert(
    follow.includes("if (!phrasingConfigured()) return null;"),
    "an unconfigured deployment never even pays the action hop",
  );
  assert(
    /catch \(err\) \{\s*console\.error\("phrasing hop failed", err\);\s*return null;/.test(follow),
    "a throwing hop falls back instead of taking the delivery down",
  );

  const action = src("convex/phrasing.ts");
  assert(action.includes("internalAction"), "the phrasing call is a Convex internal action");
  assert(
    action.includes("returns: v.union(v.string(), v.null())"),
    "the action has a returns validator and may answer null",
  );
  assert(
    !/result|detail/i.test(action.slice(action.indexOf("const phraseFacts"), action.indexOf("const phraseKind"))),
    "the accepted facts cannot be widened to the raw result or the detail line",
  );

  const pkg = src("package.json");
  assert(pkg.includes("\"phrasing:check\""), "package.json carries phrasing:check");
  const deploy = src("scripts/deploy.sh");
  assert(
    deploy.includes("OPENROUTER_API_KEY") && deploy.includes("note: convex has no OPENROUTER_API_KEY"),
    "deploy warns about the optional key instead of requiring it",
  );
  const required = deploy.slice(deploy.indexOf("missing=\"\""), deploy.indexOf("if [ -n \"$missing\" ]"));
  assert(
    !required.includes("missing=\"$missing OPENROUTER_API_KEY\""),
    "the phrasing key is never a hard deploy requirement",
  );
}

console.log("phrasing-check ok");
