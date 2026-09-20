import {
  doneLineHint,
  humanLineForNeed,
  needsHuman,
  parseCloudOutcome,
  type CloudNeed,
} from "../convex/lib/browserOutcomePolicy.ts";
import {
  doneNowLine,
  doneOpeners,
  lateResultLine,
} from "../convex/lib/browserProgressPolicy.ts";

import { assert, src } from "./lib/check.ts";

// --- parseCloudOutcome: labelled block wins ---

const labelled = parseCloudOutcome(`СДЕЛАНО: Заказал такси до аэропорта
ЗАКАЗ: 55081234
СУММА: 890 ₽
КОГДА: через 7 минут
ВАРИАНТЫ: нет
НУЖНО: none
ДЕТАЛИ: нет`);
assert(labelled.labelled === true, "labelled block detected");
assert(labelled.done === "Заказал такси до аэропорта", "СДЕЛАНО parsed");
assert(labelled.orderId === "55081234", "ЗАКАЗ parsed");
assert(labelled.amountRub === 890, "СУММА parsed as rub");
assert(labelled.when === "через 7 минут", "КОГДА parsed");
assert(labelled.options === undefined, "ВАРИАНТЫ нет → no options");
assert(labelled.needs === "none", "НУЖНО none");
assert(labelled.detail === undefined, "ДЕТАЛИ нет → no detail");

// --- NEEDS: as an alias of НУЖНО: ---

const aliased = parseCloudOutcome("СДЕЛАНО: нет\nNEEDS: sms_code\nДЕТАЛИ: код пришёл на +7...93");
assert(aliased.labelled === true, "NEEDS: alias still counts as labelled");
assert(aliased.needs === "sms_code", "NEEDS: sms_code parsed");
assert(aliased.detail?.includes("код пришёл"), "ДЕТАЛИ parsed alongside NEEDS:");
assert(aliased.done === undefined, "нет → empty done");

// --- «нет»/«none»/«-» all mean empty ---

for (const empty of ["нет", "none", "NONE", "-", "—", "Нет"]) {
  const o = parseCloudOutcome(`СДЕЛАНО: ${empty}\nЗАКАЗ: ${empty}\nСУММА: ${empty}\nКОГДА: ${empty}\nВАРИАНТЫ: ${empty}\nНУЖНО: none`);
  assert(o.done === undefined, `"${empty}" done is empty`);
  assert(o.orderId === undefined, `"${empty}" orderId is empty`);
  assert(o.amountRub === undefined, `"${empty}" amount is empty`);
  assert(o.when === undefined, `"${empty}" when is empty`);
  assert(o.options === undefined, `"${empty}" options is empty`);
}

// --- ВАРИАНТЫ: up to 5, split on ";" or newline ---

const withOptions = parseCloudOutcome(
  "СДЕЛАНО: нет\nВАРИАНТЫ: Nike Air — 5990 ₽; Nike Zoom — 6400 ₽; Nike React — 5200 ₽\nНУЖНО: none",
);
assert(withOptions.options?.length === 3, "three options parsed");
assert(withOptions.options?.[0]?.startsWith("Nike Air"), "first option text");

const manyOptions = parseCloudOutcome(
  `ВАРИАНТЫ: a — 1 ₽; b — 2 ₽; c — 3 ₽; d — 4 ₽; e — 5 ₽; f — 6 ₽\nНУЖНО: none`,
);
assert(manyOptions.options?.length === 5, "options capped at 5");

// --- a chat model's own formatting of the block still parses -------------
//
// The errand now asks for these seven lines in one sentence instead of four
// lines of formatting instructions, and the shorter the ask, the more the run
// answers in its own style: a markdown list, or bolded labels. Neither used
// to match `grabLabel`, and a missed НУЖНО is not a missing field — it drops
// the whole result to the free-text heuristic, which is what drives the
// inject decision and the «нужно X» line the human reads.

const bulleted = parseCloudOutcome(`- СДЕЛАНО: Заказал такси
- ЗАКАЗ: 55081234
- СУММА: 890 ₽
- НУЖНО: none`);
assert(bulleted.labelled === true, "a bulleted block is still the labelled block");
assert(bulleted.done === "Заказал такси", "bulleted СДЕЛАНО parsed");
assert(bulleted.orderId === "55081234", "bulleted ЗАКАЗ parsed");
assert(bulleted.amountRub === 890, "bulleted СУММА parsed");
assert(bulleted.needs === "none", "bulleted НУЖНО parsed");

const bolded = parseCloudOutcome(`**СДЕЛАНО:** Заказал такси
**ЗАКАЗ:** 55081234
**НУЖНО:** sms_code
**ДЕТАЛИ:** нужен код из SMS`);
assert(bolded.labelled === true, "a bolded block is still the labelled block");
assert(bolded.done === "Заказал такси", "bold markers never become part of СДЕЛАНО");
assert(bolded.orderId === "55081234", "bold markers never become part of ЗАКАЗ");
assert(bolded.needs === "sms_code", "a bolded НУЖНО still resolves to its enum value");
assert(bolded.detail === "нужен код из SMS", "bolded ДЕТАЛИ parsed");

const boldValue = parseCloudOutcome("**СДЕЛАНО**: **готово**\n**НУЖНО**: **none**");
assert(boldValue.done === "готово", "bold around the value is stripped too");
assert(boldValue.needs === "none", "a bolded need value still matches the enum");

// The tolerance is decoration only: a sentence that merely mentions the word
// must not be read as a label.
assert(
  parseCloudOutcome("в итоге НУЖНО: ничего").labelled === false,
  "a label mid-sentence is not a labelled block",
);

// --- unknown НУЖНО value falls back to heuristic, never invents a need ---

const garbageNeed = parseCloudOutcome("СДЕЛАНО: готово\nНУЖНО: bla-bla");
assert(garbageNeed.needs === "none", "unrecognized need value falls back to heuristic (none here)");

// --- no label at all → labelled:false, heuristic guess over free text ---

assert(parseCloudOutcome(null).labelled === false, "null result is unlabelled");
assert(parseCloudOutcome(null).needs === "none", "null result needs none");
assert(parseCloudOutcome("").labelled === false, "empty result is unlabelled");

const heuristics: [string, CloudNeed][] = [
  ["нужен код из смс: остановился", "sms_code"],
  ["жду код с почты, письмо ещё не пришло", "email_code"],
  ["нужно подтвердить в приложении банка (push)", "push"],
  ["банк требует 3-D Secure, остановился", "3ds"],
  ["сайт требует капчу captcha, не могу продолжить", "captcha"],
  ["форма требует пароль, введите его", "password"],
  ["нужен адрес доставки, не хватает деталей", "address"],
];
for (const [text, want] of heuristics) {
  const o = parseCloudOutcome(text);
  assert(o.labelled === false, `"${text}" has no НУЖНО label`);
  assert(o.needs === want, `"${text}" heuristic guesses ${want}, got ${o.needs}`);
}
assert(parseCloudOutcome("нашёл кроссовки за 5990 ₽").needs === "none", "plain success text needs none");

// --- a channel word alone (no ask context) is never a need — a successful
// order can say "код заказа" or "по адресу" without asking for anything ---

assert(
  parseCloudOutcome(
    "Заказ оформлен, доставка по адресу Ленина 5, код заказа 12345",
  ).needs === "none",
  "успешный заказ с «код»/«адрес» в тексте не читается как незакрытая просьба",
);
assert(
  parseCloudOutcome("Сайт требует код из SMS, остановился").needs === "sms_code",
  "ask-context + sms word → sms_code",
);
assert(
  parseCloudOutcome("Нужно подтвердить вход в приложении").needs === "push",
  "ask-context + приложение word → push",
);

// --- needsHuman ---

assert(needsHuman("none") === false, "none is not human-needed");
for (const need of ["sms_code", "email_code", "push", "3ds", "captcha", "password", "address", "payment", "info"] as const) {
  assert(needsHuman(need) === true, `${need} needs a human`);
}
assert(needsHuman(undefined) === false, "undefined need is not human-needed");
assert(needsHuman("garbage") === false, "unknown string is not human-needed");

// --- humanLineForNeed: fluent Russian, never a password, never English ---

const ENGLISH_WORD = /\b(click|open|enter|confirm|the|and|your)\b/i;
const ALL_NEEDS: CloudNeed[] = [
  "sms_code",
  "email_code",
  "push",
  "3ds",
  "captcha",
  "password",
  "address",
  "payment",
  "info",
];
for (const need of ALL_NEEDS) {
  const line = humanLineForNeed(need, {
    site: "wildberries.ru",
    liveUrl: "https://live.example/view",
    detail: "нет размера 42",
  });
  assert(line.length > 0, `${need} produces a line`);
  assert(!/\bCVV\b/i.test(line), `${need} line never mentions CVV`);
  assert(!/\b\d[\d ]{12,18}\d\b/.test(line), `${need} line never contains a card-length digit run`);
  assert(!ENGLISH_WORD.test(line), `${need} line stays in Russian: "${line}"`);
  assert(!line.toLowerCase().includes("cloud"), `${need} line never says Cloud: "${line}"`);
}
assert(humanLineForNeed("none") === "", "none has no human line");

assert(
  humanLineForNeed("sms_code") === "Нужен код из SMS — пришли его сюда, введу сам.",
  "sms_code exact line",
);
assert(
  humanLineForNeed("email_code") === "Код ушёл на почту, сейчас гляну.",
  "email_code exact line",
);
assert(
  humanLineForNeed("push").includes("готово"),
  "push line asks for a written «готово»",
);
assert(
  humanLineForNeed("3ds", { liveUrl: "https://live.example/view" }).includes(
    "https://live.example/view",
  ),
  "3ds line carries the live-view link",
);
assert(
  !humanLineForNeed("password").includes("https://"),
  "password with no liveUrl has no link",
);
assert(
  humanLineForNeed("password", { liveUrl: "https://live.example/view" }).includes(
    "https://live.example/view",
  ),
  "password with a liveUrl links to it",
);
assert(
  humanLineForNeed("password", { site: "ozon.ru" }).includes("ozon.ru"),
  "password with no link names the site instead",
);
assert(
  humanLineForNeed("address", { detail: "какой подъезд?" }).includes("какой подъезд?"),
  "address line uses the detail when present",
);
assert(
  humanLineForNeed("address").length > 0,
  "address line has a generic fallback without detail",
);

// --- doneLineHint: 1-2 line «готово»-draft ---

assert(doneLineHint({ needs: "none", labelled: true }) === "Готово.", "bare done line");
const doneWithFacts = doneLineHint({
  done: "Заказал такси",
  orderId: "55081234",
  amountRub: 890,
  when: "через 7 минут",
  needs: "none",
  labelled: true,
});
assert(doneWithFacts.startsWith("Готово: Заказал такси."), "done line opens with СДЕЛАНО");
assert(doneWithFacts.includes("заказ №55081234"), "done line includes order number");
assert(doneWithFacts.includes("890 ₽"), "done line includes amount");
assert(doneWithFacts.includes("через 7 минут"), "done line includes when");
assert(doneWithFacts.split("\n").length <= 3, "done line stays short");
const doneWithOptions = doneLineHint({
  needs: "none",
  labelled: true,
  options: ["Nike Air — 5990 ₽", "Nike Zoom — 6400 ₽"],
});
assert(doneWithOptions.includes("Nike Air"), "done line surfaces options when present");

// --- doneNowLine: the report pollRun sends itself, with no model turn ---
//
// Same guard rails as lateResultLine (below it in the same module) but
// without the «кстати, прошлое поручение» framing: this one is the report,
// delivered while the person is still waiting for it.

const CLEAN_DONE = `СДЕЛАНО: Заказал такси до аэропорта
ЗАКАЗ: 55081234
СУММА: 890 ₽
КОГДА: через 7 минут
НУЖНО: none`;

const nowLine = doneNowLine("completed", CLEAN_DONE);
assert(nowLine !== undefined, "a clean labelled done is reportable without the model");
assert(
  nowLine === doneLineHint(parseCloudOutcome(CLEAN_DONE)),
  "un-seeded, the instant line is still the canned done draft",
);
assert(
  !nowLine!.includes("Кстати"),
  "the instant report is not framed as a late afterthought",
);
assert(
  lateResultLine("completed", CLEAN_DONE)!.endsWith(nowLine!),
  "late and instant reports share one body, only the framing differs",
);

// --- the opener varies, the facts do not -------------------------------
//
// This line is the most visible message of the whole errand and no model
// turn phrases it any more, so a single frozen «Готово: …» would be the
// machine register the voice work exists to remove. The seed is the runId:
// one run keeps one wording across retries, different runs differ.

const FACTS = "заказ №55081234, 890 ₽, через 7 минут.";
const seeded = ["run_a", "run_b", "run_c", "run_d", "run_e", "run_f", "run_g", "run_h"].map(
  (seed) => doneNowLine("completed", CLEAN_DONE, seed)!,
);
assert(
  seeded.every((line) => line !== undefined && line.includes(FACTS)),
  "every wording still carries the order number, the sum and the when",
);
assert(
  new Set(seeded).size > 1,
  "the opener actually varies across runs — a frozen line is the bug",
);
assert(
  doneNowLine("completed", CLEAN_DONE, "run_a") ===
    doneNowLine("completed", CLEAN_DONE, "run_a"),
  "the same run always reads the same — a retried poll must not rephrase",
);
const openers = doneOpeners("Заказал такси до аэропорта");
assert(openers.length >= 4, "the done palette is a palette, not a pair");
assert(new Set(openers).size === openers.length, "no duplicated wording in the palette");
assert(
  openers.every((o) => o.length <= 120 && !/Сделал:/.test(o)),
  "openers stay short, and none doubles the verb with a past-tense СДЕЛАНО",
);
assert(
  seeded.every((line) => openers.some((o) => line.startsWith(o))),
  "every seeded line opens with one of the palette's wordings",
);
assert(
  doneOpeners(undefined).every((o) => o.length > 0 && !o.includes("undefined")),
  "a done with no phrase still renders a clean opener",
);

// Everything the model still has to think about must NOT be short-circuited.
assert(
  doneNowLine("running", CLEAN_DONE) === undefined,
  "a live run is never reported as finished",
);
assert(
  doneNowLine("failed", CLEAN_DONE) === undefined,
  "failed needs the model to phrase it, not a canned готово",
);
assert(
  doneNowLine("cancelled", CLEAN_DONE) === undefined,
  "cancelled is never a готово",
);
assert(
  doneNowLine("stalled", CLEAN_DONE) === undefined,
  "our own give-up sentinel is never a готово",
);
assert(
  doneNowLine("completed", "СДЕЛАНО: оплатил\nНУЖНО: sms_code") === undefined,
  "a run parked on the human goes to the model, which knows how to ask",
);
assert(
  doneNowLine("completed", "всё готово, такси приедет через 7 минут") === undefined,
  "unlabelled free text is not trustworthy enough to send unread",
);
assert(
  doneNowLine("completed", "НУЖНО: none\nДЕТАЛИ: нет") === undefined,
  "a labelled block with no СДЕЛАНО has nothing to report",
);
assert(doneNowLine("completed", undefined) === undefined, "no result → nothing to send");

// --- wiring: package.json carries the new check without dropping B3's line ---

const pkg = src("package.json");
assert(pkg.includes("\"outcome:check\""), "package.json outcome:check");
assert(pkg.includes("browser-outcome-check.ts"), "outcome:check runs this script");

console.log("browser-outcome-check ok");
