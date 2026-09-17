// Pure-logic assertions for the per-errand instruction composer
// (agent/lib/errand-brief.ts + agent/lib/errand-context.ts) and for the
// scaffold it feeds (agent/lib/browseruse.ts scaffoldTask).
//
// No network, no Convex, no OpenRouter: the composer's transport is exercised
// with an injected `fetchImpl` and an injected env, and the context loader
// with injected deps — the same way scripts/fast-ack-check.ts and
// scripts/vault-check.ts do it.
//
// What this file is really guarding is the audit finding it was written for:
// a 39-character errand used to travel inside 1,458 characters of fixed
// boilerplate (2.6% of the prompt was the human's business), and the scaffold
// ordered the run to ABORT on any fact only the human could know while Bro
// sat on those facts in the vault. The char-count block at the bottom pins
// the first half of that down; the known-facts block pins the second.

import {
  ERRAND_BRIEF_BUDGET_MS,
  ERRAND_BRIEF_MAX_CHARS,
  ERRAND_BRIEF_MAX_LINES,
  ERRAND_BRIEF_SYSTEM,
  KNOWN_FACTS_GAP,
  MISSING_FACTS_LINE,
  composeErrandBrief,
  errandBriefBudgetMs,
  errandBriefConfigured,
  errandBriefEnabled,
  errandBriefKey,
  errandBriefModel,
  errandBriefPrompt,
  factLines,
  hasErrandFacts,
  knownFactsBlock,
  sanitizeErrandBrief,
  staticBriefLine,
  type ErrandFacts,
  ERRAND_BRIEF_BUDGET_CEILING_MS,
} from "../agent/lib/errand-brief.ts";
import { formatLocalNow, loadErrandFacts } from "../agent/lib/errand-context.ts";
import { DEFAULT_OPENROUTER_MODEL } from "../agent/lib/model.ts";
import { isScaffolded, scaffoldTask } from "../agent/lib/browseruse.ts";
import { expandPayHosts } from "../agent/lib/browser-pay.ts";
import { parseCloudOutcome } from "../convex/lib/browserOutcomePolicy.ts";
import { assert, eq, makeFetch, src, srcJson } from "./lib/check.ts";

// ---------------------------------------------------------------------------
// env knobs — house style: optional key, explicit off switch, sane defaults
// ---------------------------------------------------------------------------

assert(errandBriefEnabled({}) === true, "unset BRO_ERRAND_BRIEF defaults to on");
assert(errandBriefEnabled({ BRO_ERRAND_BRIEF: "off" }) === false, "off disables");
assert(errandBriefEnabled({ BRO_ERRAND_BRIEF: "0" }) === false, "0 disables");
assert(errandBriefEnabled({ BRO_ERRAND_BRIEF: "false" }) === false, "false disables");
assert(errandBriefEnabled({ BRO_ERRAND_BRIEF: "on" }) === true, "on leaves it on");

eq(errandBriefBudgetMs({}), ERRAND_BRIEF_BUDGET_MS, "default budget");
eq(errandBriefBudgetMs({ BRO_ERRAND_BRIEF_BUDGET_MS: "400" }), 400, "explicit budget");
eq(errandBriefBudgetMs({ BRO_ERRAND_BRIEF_BUDGET_MS: "x" }), ERRAND_BRIEF_BUDGET_MS, "garbage budget");
eq(errandBriefBudgetMs({ BRO_ERRAND_BRIEF_BUDGET_MS: "0" }), ERRAND_BRIEF_BUDGET_MS, "zero budget");
eq(errandBriefBudgetMs({ BRO_ERRAND_BRIEF_BUDGET_MS: "-9" }), ERRAND_BRIEF_BUDGET_MS, "negative budget");

eq(errandBriefModel({}), DEFAULT_OPENROUTER_MODEL, "no overrides → default model");
eq(errandBriefModel({ BRO_MODEL: "some/model" }), "some/model", "BRO_MODEL is used");
eq(
  errandBriefModel({ BRO_ERRAND_BRIEF_MODEL: "tiny/model", BRO_MODEL: "some/model" }),
  "tiny/model",
  "BRO_ERRAND_BRIEF_MODEL wins",
);

// A key pasted into a hosted env often carries a newline in the MIDDLE; fetch
// rejects such a header outright, which would silently make a configured
// deployment fall back forever.
eq(errandBriefKey({ OPENROUTER_API_KEY: " sk-a\nb " }), "sk-ab", "key whitespace stripped");
eq(errandBriefKey({ OPENROUTER_API_KEY: "   " }), undefined, "blank key is no key");
eq(errandBriefKey({}), undefined, "missing key is no key");
assert(!errandBriefConfigured({}), "no key → not configured");
assert(errandBriefConfigured({ OPENROUTER_API_KEY: "sk-x" }), "key → configured");
assert(
  !errandBriefConfigured({ OPENROUTER_API_KEY: "sk-x", BRO_ERRAND_BRIEF: "off" }),
  "off beats a present key",
);

// ---------------------------------------------------------------------------
// the fallback path: no key, lane off, and a budget miss all land on null
// ---------------------------------------------------------------------------

const SAMPLE_TASK = "купи кроссовки 42 размера на wildberries";

{
  const noKey = makeFetch(() => {
    throw new Error("the lane must not reach the network without a key");
  });
  const brief = await composeErrandBrief(
    { task: SAMPLE_TASK },
    { env: {}, fetchImpl: noKey.fetch },
  );
  eq(brief, null, "no OPENROUTER_API_KEY → null, no request");
  eq(noKey.calls.length, 0, "no key means no fetch at all");
}
{
  const off = makeFetch(() => {
    throw new Error("the lane must not reach the network when disabled");
  });
  const brief = await composeErrandBrief(
    { task: SAMPLE_TASK },
    { env: { OPENROUTER_API_KEY: "sk-x", BRO_ERRAND_BRIEF: "off" }, fetchImpl: off.fetch },
  );
  eq(brief, null, "lane off → null, no request");
  eq(off.calls.length, 0, "disabled means no fetch at all");
}
{
  // A model that never answers must cost exactly the budget and then be gone.
  const hang = makeFetch(() => new Promise<Response>(() => {}));
  const started = Date.now();
  const brief = await composeErrandBrief(
    { task: SAMPLE_TASK },
    {
      env: { OPENROUTER_API_KEY: "sk-x", BRO_ERRAND_BRIEF_BUDGET_MS: "40" },
      fetchImpl: hang.fetch,
    },
  );
  eq(brief, null, "budget miss → null");
  assert(Date.now() - started < 1_500, "budget miss returns promptly, not eventually");
}
{
  // Nothing the transport can do may throw out of this lane.
  for (const [label, impl] of [
    ["sync throw", makeFetch(() => { throw new Error("boom"); }).fetch],
    ["http 500", makeFetch(() => new Response("nope", { status: 500 })).fetch],
    ["not json", makeFetch(() => new Response("<html>", { status: 200 })).fetch],
    ["no choices", makeFetch(() => Response.json({})).fetch],
  ] as const) {
    const brief = await composeErrandBrief(
      { task: SAMPLE_TASK },
      { env: { OPENROUTER_API_KEY: "sk-x" }, fetchImpl: impl },
    );
    eq(brief, null, `${label} → null, never a throw`);
  }
}
{
  const ok = makeFetch(() =>
    Response.json({
      choices: [
        {
          message: {
            content:
              "Заказ на wildberries.ru оформлен: кроссовки 42 размера, на экране виден номер заказа.\nПолучатель Иван Петров, +7 916 123-45-67.",
          },
        },
      ],
    }),
  );
  const brief = await composeErrandBrief(
    { task: SAMPLE_TASK },
    { env: { OPENROUTER_API_KEY: "sk-x" }, fetchImpl: ok.fetch },
  );
  assert(brief !== null, "a usable answer comes back");
  assert(brief!.includes("номер заказа"), "the composed brief is what came back");
  const body = JSON.parse(ok.calls[0]!.body!) as {
    model: string;
    messages: { role: string; content: string }[];
    reasoning: Record<string, unknown>;
  };
  eq(body.messages[0]!.content, ERRAND_BRIEF_SYSTEM, "system prompt is sent as-is");
  assert(body.messages[1]!.content.includes(SAMPLE_TASK), "the errand is in the prompt");
  eq(body.reasoning.enabled, false, "no thinking phase — this is a bounded lane");
}

// The static fallback is byte-for-byte the goal line the scaffold always had,
// so a deployment with no key sends exactly what it sent before this shipped.
eq(staticBriefLine("  вызови такси  "), "вызови такси", "static line is the trimmed task");

// ---------------------------------------------------------------------------
// sanitizing: a brief may never hand the run a SECOND output contract
// ---------------------------------------------------------------------------

eq(sanitizeErrandBrief(null), null, "null in, null out");
eq(sanitizeErrandBrief("   "), null, "blank is unusable");
eq(sanitizeErrandBrief("NONE"), null, "NONE means the model had nothing");
eq(
  sanitizeErrandBrief("```\nЗаказ оформлен\n```"),
  "Заказ оформлен",
  "a code fence is stripped",
);
eq(sanitizeErrandBrief("«Заказ оформлен»"), "Заказ оформлен", "quotes are stripped");
eq(
  sanitizeErrandBrief("- Заказ оформлен\n- Указан адрес"),
  "Заказ оформлен\nУказан адрес",
  "bullets are stripped",
);
eq(
  sanitizeErrandBrief("Заказ оформлен\nНУЖНО: none\nСДЕЛАНО: заказал"),
  "Заказ оформлен",
  "contract labels are dropped — the run gets exactly one output contract",
);
eq(sanitizeErrandBrief("НУЖНО: none"), null, "a brief that is only a contract is unusable");
eq(
  sanitizeErrandBrief("а\n".repeat(ERRAND_BRIEF_MAX_LINES + 2)),
  null,
  "too many lines → unusable, fall back to the static line",
);
eq(
  sanitizeErrandBrief("я".repeat(ERRAND_BRIEF_MAX_CHARS + 10)),
  null,
  "too long → unusable; a 'brief' that size is a second scaffold",
);
// scrubSecrets is the last-resort net over free text that reached the brief.
{
  const scrubbed = sanitizeErrandBrief("Плати картой 4111 1111 1111 1111, пароль: hunter2");
  assert(scrubbed !== null, "the line is otherwise usable");
  assert(!scrubbed!.includes("4111"), "a card number never survives into the brief");
  assert(!scrubbed!.includes("hunter2"), "a password never survives into the brief");
}

// ---------------------------------------------------------------------------
// the known-facts block — the fix that matters most
// ---------------------------------------------------------------------------

const FACTS: ErrandFacts = {
  displayName: "Иван",
  contactName: "Иван Петров",
  phone: "+7 916 123-45-67",
  email: "ivan@example.com",
  address: {
    recipientName: "Иван Петров",
    line1: "ул. Ленина, д. 5, кв. 12",
    city: "Москва",
    postalCode: "101000",
    countryCode: "RU",
  },
  tz: "Europe/Moscow",
  nowLocal: "четверг, 17 сентября 2026 г., 14:32",
};

assert(!hasErrandFacts(undefined), "no facts object → nothing known");
assert(!hasErrandFacts({}), "empty facts object → nothing known");
assert(hasErrandFacts(FACTS), "a filled vault is something to pass along");
eq(knownFactsBlock(undefined), "", "no facts → no block at all");

{
  const block = knownFactsBlock(FACTS);
  for (const needle of [
    "Иван Петров",
    "+7 916 123-45-67",
    "ivan@example.com",
    "ул. Ленина, д. 5, кв. 12",
    "Москва",
    "101000",
    "четверг, 17 сентября 2026",
    "Europe/Moscow",
  ]) {
    assert(block.includes(needle), `the known-facts block carries «${needle}»`);
  }
  // The inverted restriction: the facts come first and НУЖНО is the fallback
  // for what is genuinely missing, not a standing order to abort.
  assert(block.includes(KNOWN_FACTS_GAP), "the gap sentence closes the block");
  assert(block.includes("не выдумывай"), "inventing a fact is still forbidden");
  assert(block.includes("остановись"), "and stopping is still the alternative");
  // The `НУЖНО: address|info` menu left this sentence with the rewrite: the
  // output contract at the foot of every errand lists all ten values, and
  // reciting two of them here bought characters on every single run. The
  // facts themselves — the thing this block exists for — all stayed.
  assert(!block.includes("НУЖНО:"), "the outcome taxonomy is not repeated inside the facts");
  // One line, not a heading plus a dash per field: the list shape was ours,
  // the facts are the human's, and only the shape was worth deleting.
  assert(block.split("\n").length === 1, "the known facts travel as one line");
  assert(!block.includes("ИЗВЕСТНО"), "the form-field heading is gone");
  assert(
    !block.includes("Что знает только человек"),
    "the old abort-on-any-personal-fact order is gone",
  );
  // `RU` is the default for every stored address; a foreign code is the thing
  // that actually has to travel.
  assert(!block.includes(" RU"), "the default country code is not noise in the block");
  const abroad = knownFactsBlock({
    address: { recipientName: "Ivan", line1: "5 Main St", city: "Riga", countryCode: "LV" },
  });
  assert(abroad.includes("LV"), "a non-RU country code does travel");
}
{
  // The «помню: …» lines went with the Convex memo store. They were the only
  // free-text field here, and their replacement — semantic search over a
  // person's chat — is not a list of vetted facts to paste into a browser
  // instruction. The brief runs on the vault alone now, and must not grow a
  // memory feed back by accident.
  assert(
    !knownFactsBlock(FACTS).includes("помню"),
    "no memory lines in the known-facts block",
  );
  assert(
    !src("agent/lib/errand-context.ts").includes("wakeLines"),
    "the errand context no longer reads the memo store",
  );
}
{
  // Every fact line still goes through scrubSecrets. The vault payloads are
  // parsed, not sanitised, so a human who typed a card number into the
  // recipient field must not have it travel to the browser.
  const leaky = knownFactsBlock({
    address: {
      recipientName: "карта 4111 1111 1111 1111",
      line1: "пароль: hunter2",
      city: "Москва",
      countryCode: "RU",
    },
  });
  assert(!leaky.includes("4111"), "a card number never reaches the facts block");
  assert(!leaky.includes("hunter2"), "a password never reaches the facts block");
}
{
  // The prompt the composer sees carries the same facts and the human's own
  // words — and never a secret alias value.
  const prompt = errandBriefPrompt({
    task: SAMPLE_TASK,
    humanText: "слушай, закажи мне кроссы 42го на вб",
    facts: FACTS,
    pay: true,
    login: true,
  });
  assert(prompt.includes("слушай, закажи мне кроссы"), "the human's own wording is shown");
  assert(prompt.includes("ул. Ленина"), "the address is shown");
  assert(prompt.includes("четверг, 17 сентября 2026"), "today's date is shown");
  assert(!prompt.includes("card_number"), "no alias names leak into the composer prompt");
  assert(!prompt.includes("site_password"), "no login alias leaks into the composer prompt");
  const empty = errandBriefPrompt({ task: SAMPLE_TASK });
  assert(empty.includes("ничего не известно"), "an empty vault says so plainly");
}

// `factLines` order is the order a checkout form asks for them.
eq(
  factLines(FACTS)[0],
  "зовут: Иван",
  "the display name opens the block",
);
assert(
  factLines({ address: FACTS.address }).some((l) => l.startsWith("получатель:")),
  "with no contact item the address recipient is the recipient",
);

// ---------------------------------------------------------------------------
// the context loader — vault address/contact only, never a secret kind
// ---------------------------------------------------------------------------

{
  const reads: string[] = [];
  const facts = await loadErrandFacts(
    "+79161234567",
    {
      getTenant: async () => ({ displayName: "Иван", tz: "Asia/Yekaterinburg" }) as never,
      listVaultItems: async () =>
        [
          { handle: "h-addr", kind: "address", label: "Дом", account: "Москва", available: true },
          { handle: "h-con", kind: "contact", label: "Я", account: "Иван", available: true },
          { handle: "h-card", kind: "payment", label: "Карта", account: "•••• 1111", available: true },
          { handle: "h-log", kind: "login", label: "ozon", account: "i•••", available: true },
          { handle: "h-old", kind: "address", label: "Старый", account: "Тверь", available: false },
        ] as never,
      readVaultSecret: async (_phone: string, handle: string) => {
        reads.push(handle);
        if (handle === "h-addr") {
          return {
            kind: "address" as const,
            secret: JSON.stringify({
              kind: "address",
              version: 1,
              recipientName: "Иван Петров",
              line1: "ул. Ленина, д. 5",
              city: "Москва",
              postalCode: "101000",
              countryCode: "ru",
            }),
          };
        }
        return {
          kind: "contact" as const,
          secret: JSON.stringify({
            kind: "contact",
            version: 1,
            fullName: "Иван Петров",
            email: "ivan@example.com",
            phone: "+7 916 123-45-67",
          }),
        };
      },
    },
    { now: new Date("2026-09-17T09:32:00Z") },
  );
  // The filter IS the security boundary: a `payment` or `login` handle must
  // never be read at all on this path — those stay on secretBindings.
  assert(!reads.includes("h-card"), "a payment secret is never read for the brief");
  assert(!reads.includes("h-log"), "a login secret is never read for the brief");
  assert(!reads.includes("h-old"), "an unavailable item is skipped");
  eq(facts.displayName, "Иван", "display name loaded");
  eq(facts.contactName, "Иван Петров", "contact name loaded");
  eq(facts.phone, "+7 916 123-45-67", "contact phone loaded");
  eq(facts.email, "ivan@example.com", "contact email loaded");
  eq(facts.address?.city, "Москва", "address city loaded");
  eq(facts.address?.countryCode, "RU", "country code normalised by the payload schema");
  eq(facts.tz, "Asia/Yekaterinburg", "tenant tz wins");
  assert(facts.nowLocal!.includes("2026"), "the current local date is stamped");
}
{
  // Nothing here may fail an errand: every dependency throwing at once still
  // yields a usable (empty-ish) facts object with the default timezone.
  const boom = async () => {
    throw new Error("convex down");
  };
  const facts = await loadErrandFacts("+79161234567", {
    getTenant: boom as never,
    listVaultItems: boom as never,
    readVaultSecret: boom as never,
  });
  eq(facts.tz, "Europe/Moscow", "a dead Convex still leaves the default timezone");
  eq(facts.address, undefined, "and no invented address");
}

// The timezone is load-bearing, not decoration: «на воскресенье» is not a
// date until the run knows what day it is, in the human's own zone.
{
  const at = new Date("2026-09-17T18:00:00Z");
  const msk = formatLocalNow("Europe/Moscow", at);
  const vvo = formatLocalNow("Asia/Vladivostok", at);
  assert(msk.includes("17 сентября"), "Moscow is still the 17th");
  assert(vvo.includes("18 сентября"), "Vladivostok is already the 18th");
  assert(msk.includes("четверг"), "the weekday is spelled out");
  assert(vvo.includes("пятница"), "and it is a different weekday across the country");
}

// ---------------------------------------------------------------------------
// the scaffold: marks, contract, secrets, and the char-count reduction
// ---------------------------------------------------------------------------

const BRIEF =
  "Заказ на wildberries.ru оформлен: кроссовки 42 размера, на экране виден номер заказа.\nДоставка на пункт выдачи, получатель Иван Петров, +7 916 123-45-67.";

assert(isScaffolded("[bro-errand]\nx"), "errand mark recognised");
assert(isScaffolded("[bro-login]\nx"), "login mark recognised");
assert(isScaffolded("[bro-vault-login]\nx"), "vault-login mark recognised");
assert(isScaffolded("[bro-inject]\nx"), "inject mark recognised");
assert(!isScaffolded("купи кроссовки"), "a raw errand is not scaffolded");

{
  const task = scaffoldTask(SAMPLE_TASK, { facts: FACTS, brief: BRIEF, humanText: "закажи кроссы 42го на вб" });
  assert(task.startsWith("[bro-errand]"), "the mark survives");
  eq(scaffoldTask(task, { facts: FACTS, brief: BRIEF }), task, "still idempotent");
  assert(task.includes(BRIEF.split("\n")[0]!), "the composed brief is the goal");
  assert(
    task.includes("ДОСЛОВНО ОТ ЧЕЛОВЕКА: «закажи кроссы 42го на вб»"),
    "the human's literal wording reaches the run — it never used to",
  );
  assert(task.includes("ул. Ленина, д. 5, кв. 12"), "the known address reaches the run");
  assert(task.includes("четверг, 17 сентября 2026"), "today's date reaches the run");
  // The 476-char output contract is parsed by convex/lib/browserOutcomePolicy.
  for (const label of ["СДЕЛАНО:", "ЗАКАЗ:", "СУММА:", "КОГДА:", "ВАРИАНТЫ:", "НУЖНО:", "ДЕТАЛИ:"]) {
    assert(task.includes(label), `the output contract keeps ${label}`);
  }
  assert(task.includes("НУЖНО: none|"), "the НУЖНО menu survives verbatim");
  assert(
    task.includes("Пароль, номер карты и код в ответ не пиши."),
    "the safety line survives",
  );
  // The generic browsing advice the audit costed at ~980 chars is gone.
  for (const gone of ["Работай быстро", "Важен результат", "баннеры закрывай", "куки прошлой сессии", "iframe"]) {
    assert(!task.includes(gone), `generic advice «${gone}» is gone`);
  }
  // The second pass over the envelope: what a browser agent does not need to
  // be told is how to use a browser. Each of these was a full sentence on
  // every run, and not one of them is a fact about the errand.
  for (const gone of [
    "дождись страницы",
    "на языке сайта",
    "убедись, что на экране",
    "Сайт откроет Bro сам",
  ]) {
    assert(!task.includes(gone), `browser how-to «${gone}» is gone`);
  }
  // …while every one of these is a fact or a boundary, and stays.
  for (const kept of ["Решай сам", "входи или регистрируйся", "остановись"]) {
    assert(task.includes(kept), `the licence/boundary «${kept}» survives`);
  }
}
{
  // The goal opens the errand as a sentence, not as a form field. Anything
  // that reads the task back out (scripts/fake-browser-use.ts `humanErrand`,
  // and a human reading a log) takes the line after the mark, so it must
  // stay ONE line and stay first.
  const task = scaffoldTask(SAMPLE_TASK, { facts: FACTS });
  const [mark, goal] = task.split("\n");
  eq(mark, "[bro-errand]", "the mark is still the first line");
  eq(goal, SAMPLE_TASK, "the errand itself is the second line, unlabelled");
  assert(!task.includes("ЦЕЛЬ:"), "the ЦЕЛЬ form label is gone");
  // ДОСЛОВНО is not a restatement of the goal — it is the only line that
  // carries the human's own «43» and «до 12к» — so it stays, and stays
  // labelled, but only when it says something the goal does not.
  const quoted = scaffoldTask("купи кроссовки nike air max 43 на wildberries, до 12000", {
    humanText: "купи кроссовки nike air max 43 на вб, до 12к",
  });
  assert(
    quoted.includes("ДОСЛОВНО ОТ ЧЕЛОВЕКА: «купи кроссовки nike air max 43 на вб, до 12к»"),
    "the human's own wording still rides along verbatim",
  );
  eq(
    scaffoldTask(SAMPLE_TASK, { humanText: SAMPLE_TASK }).split("\n").length,
    scaffoldTask(SAMPLE_TASK).split("\n").length,
    "and never costs a line when it would only repeat the goal",
  );
}
{
  // The release blocker this pass was written around: `payScaffold`'s
  // `holder`/`account` are optional at every real call site, were typed as
  // required, and were interpolated unconditionally — so the errand told the
  // cloud agent «Держатель undefined — не секрет, печатай его текстом».
  // Nothing the scaffold assembles may ever print the word.
  const matrix: Array<[string, Parameters<typeof scaffoldTask>[1]]> = [
    ["bare", undefined],
    ["facts only", { facts: FACTS }],
    ["empty facts", { facts: {} }],
    ["brief + human", { brief: BRIEF, humanText: "закажи кроссы 42го на вб" }],
    ["continuation", { facts: FACTS, continuation: true }],
    ["start page", { facts: FACTS, startPage: "https://www.ozon.ru/" }],
    ["vault login", { facts: FACTS, login: true }],
    [
      "card without holder/account",
      { facts: FACTS, pay: { hosts: expandPayHosts(["ozon.ru"]), maxRub: 5000 } },
    ],
    [
      "card without hosts",
      { facts: FACTS, pay: { hosts: [], holder: "IVAN PETROV", account: "Visa" } },
    ],
    [
      "attach card, nothing but hosts",
      { facts: FACTS, pay: { hosts: expandPayHosts(["taxi.yandex.ru"]), attachCard: true } },
    ],
  ];
  for (const [label, opts] of matrix) {
    const task = opts ? scaffoldTask(SAMPLE_TASK, opts) : scaffoldTask(SAMPLE_TASK);
    assert(!task.includes("undefined"), `«undefined» never reaches the run (${label})`);
    assert(!task.includes("null"), `nor «null» (${label})`);
    assert(!/\n\s*\n\s*\n/u.test(task), `and an absent block leaves no blank gap (${label})`);
  }
}
{
  // With facts on file the run is handed them; НУЖНО is only the fallback.
  const known = scaffoldTask(SAMPLE_TASK, { facts: FACTS });
  assert(known.includes(KNOWN_FACTS_GAP), "facts present → the gap sentence");
  assert(!known.includes(MISSING_FACTS_LINE), "facts present → not the empty-vault line");
  // With nothing on file it falls back exactly where it used to.
  const unknown = scaffoldTask(SAMPLE_TASK);
  assert(unknown.includes(MISSING_FACTS_LINE), "empty vault → say so and ask");
  assert(
    unknown.includes("|address|"),
    "empty vault → address is still a reachable outcome, via the output contract",
  );
  assert(unknown.includes(SAMPLE_TASK), "the raw task still travels with no context at all");
}
{
  // Secrets stay on the secretBindings path. A paid, vault-login errand names
  // the aliases and never a value — and the facts block never adds one.
  const paid = scaffoldTask(SAMPLE_TASK, {
    facts: FACTS,
    brief: BRIEF,
    login: true,
    pay: {
      hosts: expandPayHosts(["wildberries.ru"]),
      holder: "IVAN PETROV",
      account: "Visa · •••• 1111",
      maxRub: 5000,
    },
  });
  for (const alias of [
    "site_login",
    "site_password",
    "card_number",
    "card_expiry",
    "card_exp_month",
    "card_exp_year",
    "card_exp_year_full",
    "card_cvc",
  ]) {
    assert(paid.includes(alias), `the secretBindings alias ${alias} survives`);
  }
  assert(paid.includes("и их поддоменах"), "the allowed-hosts sentence survives");
  assert(paid.includes("5000 ₽"), "the maxRub spend ceiling survives");
  assert(!/\b\d{13,19}\b/.test(paid.replace(/\D/g, " ")), "no card-shaped number anywhere");
  for (const secretish of ["hunter2", "4111", "CVV: 123"]) {
    assert(!paid.includes(secretish), `no ${secretish} in the task`);
  }
}
{
  // The scaffold's output contract still parses as the contract.
  const outcome = parseCloudOutcome("СДЕЛАНО: заказал\nЗАКАЗ: 12345\nНУЖНО: none");
  eq(outcome.needs, "none", "browserOutcomePolicy still reads the block the scaffold asks for");
  assert(outcome.labelled, "and still sees it as labelled");
}

// ---------------------------------------------------------------------------
// the measured reduction. `boilerplate` is everything in the task that is not
// this errand's own content — not the brief, not the human's words, not the
// facts. Before this shipped a 39-char errand travelled inside 1,458 chars of
// it, i.e. 2.6% of the prompt was the human's business.
// ---------------------------------------------------------------------------

const BOILERPLATE_BEFORE = 1_458;

function userContentChars(task: string, opts: { brief?: string; facts?: ErrandFacts; human: string }): number {
  const own = [opts.brief ?? "", opts.human, ...factLines(opts.facts)].filter(Boolean);
  let total = 0;
  for (const piece of own) {
    assert(task.includes(piece), `expected «${piece.slice(0, 40)}…» in the task`);
    total += piece.length;
  }
  return total;
}

{
  const human = "закажи кроссы 42го на вб";
  const task = scaffoldTask(SAMPLE_TASK, { facts: FACTS, brief: BRIEF, humanText: human });
  const mine = userContentChars(task, { brief: BRIEF, facts: FACTS, human });
  const boilerplate = task.length - mine;
  const share = mine / task.length;
  console.log(
    `errand-brief: total=${task.length} user=${mine} boilerplate=${boilerplate} user-share=${(share * 100).toFixed(1)}%`,
  );
  assert(
    boilerplate < BOILERPLATE_BEFORE,
    `boilerplate is ${boilerplate}, was ${BOILERPLATE_BEFORE} — it must not creep back`,
  );
  // The threshold moved 25% → 20% when the memo feed left `FACTS`, and 20% →
  // 24% when the envelope was rewritten as a message rather than a form
  // (the heading-plus-dashes fact list, the browser how-to sentences and the
  // recited `НУЖНО` taxonomy all went). `boilerplate < BOILERPLATE_BEFORE`
  // just above is what actually guards against prose creeping back; this one
  // guards the ratio it produces, which is the number the product owner
  // reads: how much of what we send is the human's own business.
  assert(share > 0.24, `user content is ${(share * 100).toFixed(1)}% of the task, was 2.6%`);
  // The word that shipped a release blocker. `payScaffold` interpolated an
  // optional `holder`/`account` unconditionally, and the errand told the run
  // «Держатель undefined — печатай его текстом» — with the card bound, on a
  // live checkout. Every scaffold, every combination, never the word.
  assert(!task.includes("undefined"), "no «undefined» anywhere in the assembled task");
}
{
  // The envelope alone — no facts, no brief — is what shrank. Everything the
  // audit listed as class-(c) advice came out of it.
  const bare = scaffoldTask(SAMPLE_TASK);
  const boilerplate = bare.length - SAMPLE_TASK.length;
  console.log(`errand-brief: bare envelope=${boilerplate} chars (was ${BOILERPLATE_BEFORE})`);
  assert(
    boilerplate <= 900,
    `the bare envelope is ${boilerplate} chars — cut a sentence, do not raise this`,
  );
}
{
  // A task carrying the human's own facts is allowed to be BIGGER than the
  // old one: that growth is the human's business, not prose. The ceiling is
  // here so prose cannot hide behind it.
  const paid = scaffoldTask("купи на ozon.ru кофе Lavazza 1 кг, оплати картой", {
    facts: FACTS,
    brief: BRIEF,
    login: true,
    startPage: "https://www.ozon.ru/",
    pay: {
      hosts: expandPayHosts(["ozon.ru"]),
      holder: "IVAN PETROV",
      account: "Visa · •••• 1111",
      maxRub: 5000,
    },
  });
  assert(
    paid.length <= 2_000,
    `the fullest scaffold is ${paid.length} chars — cut a sentence, do not raise this`,
  );
  assert(!paid.includes("undefined"), "not even the fullest scaffold prints «undefined»");
}

// ---------------------------------------------------------------------------
// wiring: startRun is the single choke point, and it must stay
// backward-compatible for the call sites that pass nothing
// ---------------------------------------------------------------------------

const browserUseSrc = src("agent/lib/browseruse.ts");
assert(
  browserUseSrc.includes("phone?: string"),
  "startRun opts take the tenant phone",
);
assert(
  browserUseSrc.includes("humanText?: string"),
  "startRun opts take the human's original wording",
);
assert(
  browserUseSrc.includes("await errandBriefing(task, opts)"),
  "startRun composes the brief on the way to POST /runs",
);
assert(
  browserUseSrc.includes("if (isScaffolded(task)) return {}"),
  "a login/inject task skips the context+brief work entirely",
);

const pkg = srcJson<{ scripts: Record<string, string> }>("package.json");
assert(
  pkg.scripts["errand-brief:check"]?.includes("errand-brief-check.ts"),
  "package.json wires errand-brief:check",
);
assert(
  src("scripts/check-all.ts").includes("endsWith(\":check\")"),
  "check-all enumerates every *:check script, so the new one is picked up",
);

// A budget is a latency knob, but `AbortSignal.timeout` throws a RangeError
// above 2^32-1 ms, and that call sits in front of the try/catch — so one extra
// digit in the env var did not degrade the brief, it failed EVERY browser
// errand. Clamp, do not trust.
{
  assert(
    errandBriefBudgetMs({ BRO_ERRAND_BRIEF_BUDGET_MS: "999999999999999999" }) ===
      ERRAND_BRIEF_BUDGET_CEILING_MS,
    "an absurd budget is clamped instead of reaching AbortSignal.timeout",
  );
  assert(
    errandBriefBudgetMs({ BRO_ERRAND_BRIEF_BUDGET_MS: "900" }) === 900,
    "a sane budget is honoured unchanged",
  );
  assert(
    errandBriefBudgetMs({ BRO_ERRAND_BRIEF_BUDGET_MS: "-5" }) ===
      errandBriefBudgetMs({}),
    "a negative budget falls back to the default",
  );
}

// The composer's output must never hand the run a SECOND output contract.
// `grabLabel` in browserOutcomePolicy matches with the `m` flag, whose `^`
// also fires after a lone \r, U+2028 and U+2029 — so splitting on /\r?\n/
// alone let «Итог\rНУЖНО: info» through, and the run came back labelled with
// a `needs` nobody asked for, driving browserNeed and the «нужно X» line.
{
  for (const sep of ["\r", "\u2028", "\u2029", "\u0085"]) {
    const out = sanitizeErrandBrief(`Итог${sep}НУЖНО: info`);
    assert(
      out === null || !/(^|[\r\n\u2028\u2029\u0085])\s*НУЖНО:/u.test(out),
      `a contract line hidden behind ${JSON.stringify(sep)} never survives sanitize`,
    );
  }
  assert(
    sanitizeErrandBrief("Столик на 2 подтверждён на экране.") !== null,
    "ordinary one-line briefs still pass",
  );
}

console.log("errand-brief-check ok");


// --- what looked like browsing advice and was not ---------------------------
/**
 * Two sentences were cut by the trim as "how to use a browser" and are back,
 * because nothing in this repository replaces them.
 *
 * «Дважды не заказывай и не плати» was removed on the reasoning that
 * double-charging is already held off by `browser_task`'s charge key and by
 * `orderRowFromRun`. Neither does that: the charge key meters Bro's own
 * monthly browser-job quota and never touches the card, and `orderRowFromRun`
 * only decides whether to record a row, upserting by `merchantOrderId` — a
 * real second order carries a different number and records as a second row.
 * «выдумывать пароль или номер карты нельзя» had no replacement at all.
 *
 * The test for cutting a sentence from this envelope is not whether it sounds
 * like advice. It is whether deleting it removes the only thing standing
 * between the run and the person's money.
 */
{
  const paid = scaffoldTask("купи кроссовки", {
    pay: { hosts: ["wildberries.ru"], maxRub: 5000 },
  });
  assert(
    paid.includes("Дважды не заказывай и не плати"),
    "a paid run is still told not to pay twice",
  );
  const plain = scaffoldTask("забронируй столик на двоих");
  assert(
    plain.includes("Дважды не заказывай"),
    "an unpaid run is still told not to order twice",
  );
  assert(
    plain.includes("выдумывать пароль или номер карты нельзя"),
    "the run is still forbidden from inventing a password or a card number",
  );
}

console.log("errand-brief-check: money guards present");
