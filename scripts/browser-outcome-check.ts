import {
  doneLineHint,
  humanLineForNeed,
  needsHuman,
  parseCloudOutcome,
  type CloudNeed,
} from "../convex/lib/browserOutcomePolicy.ts";
import {
  doneNowLine,
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
  "the instant line is exactly the canned done draft — no second wording to drift",
);
assert(
  !nowLine!.includes("Кстати"),
  "the instant report is not framed as a late afterthought",
);
assert(
  lateResultLine("completed", CLEAN_DONE)!.endsWith(nowLine!),
  "late and instant reports share one body, only the framing differs",
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
