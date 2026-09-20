import assert from "node:assert/strict";
import { src } from "./lib/check.ts";
import {
  archiveOtpAllowed,
  attachOtpToWake,
  candidatesFromMail,
  confidenceFor,
  extractOtpCodes,
  formatOtpLookup,
  isOtpChallenge,
  looksLikeOtpMail,
  OTP_CHECK_IN_MINUTES,
  OTP_WINDOW_MS,
  otpFromEventMail,
  otpSearchQuery,
  pickOtp,
  shouldIngestInkboxMail,
  snippetHasUsableOtp,
} from "../agent/lib/otp-policy.ts";

assert.equal(OTP_CHECK_IN_MINUTES, 3, "OTP wait is minutes, not the email 45");
assert.equal(OTP_WINDOW_MS, 15 * 60_000, "15 minute freshness window");

assert.equal(
  isOtpChallenge("Needs user input: send the OTP from the site"),
  true,
  "worker OTP blocker",
);
assert.equal(
  isOtpChallenge("Needs user input: какой размер?"),
  false,
  "other user input is not OTP",
);
assert.equal(isOtpChallenge(""), false, "empty is not OTP");
assert.equal(
  isOtpChallenge("нужен код подтверждения с почты"),
  true,
  "russian otp ask",
);

assert.equal(
  looksLikeOtpMail({
    from: "noreply@wildberries.ru",
    subject: "Код подтверждения",
    body: "Ваш код: 482911. Никому не сообщайте.",
  }),
  true,
  "WB otp letter",
);
assert.equal(
  looksLikeOtpMail({
    from: "clinic@denta.ru",
    subject: "Приём подтверждён",
    body: "Ждём вас 5 сентября в 15:00.",
  }),
  false,
  "clinic slot is not an OTP",
);
assert.equal(
  looksLikeOtpMail({
    from: "bank@tinkoff.ru",
    subject: "Вход",
    body: "Одноразовый код 193847",
  }),
  true,
  "bank otp",
);

assert.deepEqual(
  extractOtpCodes("Ваш код: 482911. Никому не сообщайте."),
  ["482911"],
);
assert.deepEqual(
  extractOtpCodes("Заказ 2024, сумма 1990 руб, 2 шт"),
  [],
  "year/price/qty are not codes",
);
assert.deepEqual(
  extractOtpCodes("Ваш промокод 482911"),
  [],
  "промокод digits are not OTP",
);
assert.deepEqual(extractOtpCodes("код 2024 для входа"), [], "years are never codes");
assert.deepEqual(extractOtpCodes("код 9182 для входа"), ["9182"]);
assert.deepEqual(
  extractOtpCodes("Код 112233 и ещё раз 112233"),
  ["112233"],
  "dedupe",
);
assert.deepEqual(
  extractOtpCodes("Код подтверждения: 123 456"),
  ["123456"],
  "spaced 3-3 digits joined",
);
assert.deepEqual(
  extractOtpCodes("код 55 44 33"),
  ["554433"],
  "spaced 2-2-2 digits joined",
);
assert.deepEqual(
  extractOtpCodes("Ваш код 4821"),
  ["4821"],
  "contiguous 4-digit code unchanged",
);
assert(
  extractOtpCodes("сумма 1 990 руб, код 482911").includes("482911"),
  "code extracted from price context",
);
assert(
  !extractOtpCodes("сумма 1 990 руб, код 482911").includes("1990"),
  "price 1 990 not treated as code",
);
assert.equal(
  looksLikeOtpMail({
    from: "noreply@wildberries.ru",
    subject: "Скидка",
    body: "Ваш промокод 482911",
  }),
  false,
  "промокод is not an OTP hint",
);
assert.equal(
  snippetHasUsableOtp("Скидка", "промокод 482911"),
  false,
  "promo snippet does not lock body fetch",
);
assert.equal(
  snippetHasUsableOtp("Код подтверждения", "Ваш код: 482911"),
  true,
  "otp subject plus code skips fetch",
);
assert.equal(
  shouldIngestInkboxMail({
    from: "noreply@wildberries.ru",
    subject: "Код подтверждения",
    body: "Ваш код: 482911",
  }),
  false,
  "do not archive OTP letters",
);
assert.equal(
  shouldIngestInkboxMail({
    from: "clinic@denta.ru",
    subject: "Приём подтверждён",
    body: "Ждём вас 5 сентября в 15:00.",
  }),
  true,
  "clinic slot may be archived",
);
assert.equal(
  archiveOtpAllowed({
    app: "gmail",
    title: "Verification code",
    content: "От: phish@evil.com\n\nYour code is 123456",
  }),
  false,
  "unknown gmail sender is not an OTP source",
);
assert.equal(
  archiveOtpAllowed({
    app: "gmail",
    title: "Код подтверждения",
    content: "От: noreply@wildberries.ru\n\nВаш код: 482911",
  }),
  true,
  "known-sender gmail copy is allowed",
);
assert.equal(
  archiveOtpAllowed({
    app: "gmail",
    title: "Код от Тинькофф",
    content: "От: phish@evil.com\n\nКод подтверждения 123456 от банка",
  }),
  false,
  "known-bank word in body is not enough",
);
assert.equal(
  archiveOtpAllowed({
    app: "calendar",
    title: "Код",
    content: "От: noreply@wildberries.ru\n\n482911",
  }),
  false,
  "calendar is never an OTP source",
);

assert.equal(
  confidenceFor({
    subject: "Код подтверждения",
    body: "482911",
    code: "482911",
  }),
  "high",
);
assert.equal(
  confidenceFor({ from: "news@x.com", body: "see 778899", code: "778899" }),
  "medium",
);

const wb = candidatesFromMail("bro_mail", {
  from: "noreply@wildberries.ru",
  subject: "Код подтверждения",
  body: "Ваш код: 482911",
  atMs: Date.UTC(2026, 8, 6, 12),
});
assert.equal(wb.length, 1);
assert.equal(wb[0]!.code, "482911");
assert.equal(wb[0]!.source, "bro_mail");

const now = Date.UTC(2026, 8, 6, 12, 5);
const found = pickOtp(
  [
    {
      code: "111111",
      source: "archive",
      confidence: "high",
      atMs: now - 60_000,
    },
    {
      code: "482911",
      source: "bro_mail",
      confidence: "high",
      atMs: now - 30_000,
    },
  ],
  now,
);
assert.equal(found.status, "found");
if (found.status === "found") {
  assert.equal(found.hit.code, "482911", "inbox beats archive");
}

const stale = pickOtp(
  [
    {
      code: "000000",
      source: "bro_mail",
      confidence: "high",
      atMs: now - OTP_WINDOW_MS - 1,
    },
  ],
  now,
);
assert.equal(stale.status, "missing", "stale-only window is missing");
assert.equal(
  pickOtp(
    [
      {
        code: "333333",
        source: "archive",
        confidence: "high",
      },
    ],
    now,
  ).status,
  "missing",
  "undated archive hit is not fresh",
);

const twoHigh = pickOtp(
  [
    {
      code: "111111",
      source: "bro_mail",
      confidence: "high",
      atMs: now,
    },
    {
      code: "222222",
      source: "bro_mail",
      confidence: "high",
      atMs: now,
    },
  ],
  now,
);
assert.equal(twoHigh.status, "ambiguous", "two fresh high codes");

assert.equal(pickOtp([], now).status, "missing");

// --- hint ranking (Finding A4 #6: a same-window wrong-merchant code must
// not silently win over the merchant the caller actually named) -----------

const wbCode = {
  code: "482911",
  source: "bro_mail" as const,
  from: "noreply@wildberries.ru",
  subject: "Код подтверждения",
  confidence: "high" as const,
  atMs: now,
};
const bankCode = {
  code: "193847",
  source: "bro_mail" as const,
  from: "bank@tinkoff.ru",
  subject: "Одноразовый код",
  confidence: "high" as const,
  atMs: now,
};

// Without a hint the two same-window high-confidence codes are ambiguous.
assert.equal(pickOtp([wbCode, bankCode], now).status, "ambiguous");

// With hint: "wildberries" the WB code wins outright instead of asking.
const hinted = pickOtp([wbCode, bankCode], now, "wildberries");
assert.equal(hinted.status, "found");
if (hinted.status === "found") {
  assert.equal(hinted.hit.code, "482911", "hint prefers the named merchant");
}

// The hint also works the other way round.
const hintedBank = pickOtp([wbCode, bankCode], now, "tinkoff");
assert.equal(hintedBank.status, "found");
if (hintedBank.status === "found") {
  assert.equal(hintedBank.hit.code, "193847", "hint prefers the named bank");
}

// A short/Russian alias for the hinted merchant still matches.
const hintedAlias = pickOtp([wbCode, bankCode], now, "вб");
assert.equal(hintedAlias.status, "found");
if (hintedAlias.status === "found") {
  assert.equal(hintedAlias.hit.code, "482911", "wb alias matches too");
}

// A hint naming neither sender does not force a pick between two rivals.
assert.equal(
  pickOtp([wbCode, bankCode], now, "ozon").status,
  "ambiguous",
  "an unrelated hint does not manufacture a false match",
);

const wake = [
  "[event:mail]",
  "job: jobA",
  "id: m1",
  "thread: thr-1",
  "from: noreply@wildberries.ru",
  "subject: Код подтверждения",
  "body:",
  "Ваш код: 482911",
].join("\n");
const fromWake = otpFromEventMail(wake);
assert.equal(fromWake.status, "found");
if (fromWake.status === "found") {
  assert.equal(fromWake.hit.code, "482911");
  assert.equal(fromWake.hit.source, "event");
}
assert.equal(otpFromEventMail("просто привет").status, "missing");
assert.ok(attachOtpToWake(wake).includes("otp: 482911"), "wake carries extracted otp");

const formatted = formatOtpLookup(fromWake);
assert.equal(formatted.status, "found");
assert.equal(formatted.code, "482911");
assert.equal(formatted.source, "event");
assert.equal(
  formatOtpLookup({ status: "missing" }).hint?.includes("спроси"),
  true,
);
assert.ok(!otpSearchQuery("WB").includes("\n"));
assert.ok(otpSearchQuery("WB").includes("WB"));

const instructions = src("agent/instructions.md");
assert(instructions.includes("otp_lookup") || instructions.includes("`otp`"), "root knows otp");
// The «ввожу код» first bubble is browser_task's rule (it owns the tab the
// code is typed into); the root prompt keeps the mailbox-before-thread order.
assert(
  src("agent/lib/tool-rules.ts").includes("ввожу код"),
  "chat code first bubble",
);
assert(
  instructions.includes("живую вкладку") ||
    src("agent/lib/tool-rules.ts").includes("Живая вкладка"),
  "iMessage codes go into the live Cloud tab",
);
assert(
  /сначала почта/i.test(instructions) && /в тред/i.test(instructions),
  "inbox before thread",
);
assert(
  !/Если `worker` вернул `Needs user input:` — спроси код в треде/.test(instructions),
  "old ask-first OTP line is gone",
);

// The OTP protocol used to exist four times over (root prompt, an `otp`
// skill, the worker's instructions, the worker's browser-execution skill) and
// the copies had already drifted apart on what to try first. The skill copy is
// deleted; the root prompt owns what Bro says and the worker owns what the
// browser does, so these assertions follow the protocol to its one home.
assert(instructions.includes("otp_lookup"), "root prompt names the lookup tool");
assert(
  /не цитируй/.test(instructions) || /цифры в чат не цитируй/i.test(instructions),
  "root prompt forbids quoting the code into chat",
);

const broMail = src("agent/tools/bro_mail.ts");
assert(broMail.includes('"inbox"'), "bro_mail lists inbox");

const otpTool = src("agent/tools/otp_lookup.ts");
assert(otpTool.includes("otpLookupExecute"), "lookup tool wires the shared execute");
// otp_lookup.ts and the otp-subagent's lookup tool share this execute,
// defined in lib/otp-lookup.ts.
const otpLookupLib = src("agent/lib/otp-lookup.ts");
assert(otpLookupLib.includes("findFreshOtp"), "lookup is deterministic");

const otpAgent = src("agent/subagents/otp/agent.ts");
assert(otpAgent.includes("outputSchema"), "otp returns structured result");
// Static config only: eve requires dynamically-returned subagent configs to
// carry a string model id, but broModel() returns a live provider object
// when OPENROUTER_API_KEY is set. defineDynamic here silently dropped the
// otp subagent on every 1:1 turn in production — see agent/subagents/worker/
// agent.ts for the working static pattern this must match.
assert(!otpAgent.includes("defineDynamic("), "otp subagent must be static, not defineDynamic(...)");
assert(otpAgent.includes("defineAgent("), "otp uses a static defineAgent");
assert(otpAgent.includes("...broModel()"), "otp spreads the static broModel() config");

const otpInstr = src("agent/subagents/otp/instructions.md");
assert(otpInstr.includes("Don't touch memory tools"), "otp is a subagent");
assert(otpInstr.includes("lookup"), "otp calls lookup first");

const worker = src("agent/subagents/worker/instructions.md");
assert(worker.includes("mailbox") || worker.includes("archive"), "worker knows coordinator checks mail");

const inbound = src("agent/lib/mail-inbound.ts");
assert(inbound.includes("shouldIngestInkboxMail"), "inbound skips OTP archive copies");
assert(inbound.includes("attachOtpToWake"), "mail wake runs otp extract");
assert(otpAgent.includes("/^\\d{4,8}$/"), "otp subagent cannot invent non-digit codes");

const pkg = src("package.json");
assert(pkg.includes("otp:check"), "npm script");

console.log("otp-check ok");
