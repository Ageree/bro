/** Fails if OTP policy asks in chat before mail, or extracts junk as a code. */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
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
assert.deepEqual(extractOtpCodes("код 2024 для входа"), [], "years are never codes");
assert.deepEqual(extractOtpCodes("код 9182 для входа"), ["9182"]);
assert.deepEqual(
  extractOtpCodes("Код 112233 и ещё раз 112233"),
  ["112233"],
  "dedupe",
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

const instructions = readFileSync(
  new URL("../agent/instructions.md", import.meta.url),
  "utf8",
);
assert(instructions.includes("otp_lookup") || instructions.includes("`otp`"), "root knows otp");
assert(
  /сначала/i.test(instructions) && /треде/i.test(instructions),
  "inbox before thread",
);
assert(
  !/Если `worker` вернул `Needs user input:` — спроси код в треде/.test(instructions),
  "old ask-first OTP line is gone",
);

const skill = readFileSync(
  new URL("../agent/skills/otp/SKILL.md", import.meta.url),
  "utf8",
);
assert(skill.includes("otp_lookup"), "skill names the tool");
assert(skill.includes("не цитируй") || skill.includes("цифры не цитируй"), "no quote");

const broMail = readFileSync(
  new URL("../agent/tools/bro_mail.ts", import.meta.url),
  "utf8",
);
assert(broMail.includes('"inbox"'), "bro_mail lists inbox");
assert(broMail.includes("groupPersonalBlock"), "inbox stays 1:1");

const otpTool = readFileSync(
  new URL("../agent/tools/otp_lookup.ts", import.meta.url),
  "utf8",
);
assert(otpTool.includes("findFreshOtp"), "lookup is deterministic");
assert(otpTool.includes("groupPersonalBlock"), "lookup stays 1:1");

const otpAgent = readFileSync(
  new URL("../agent/subagents/otp/agent.ts", import.meta.url),
  "utf8",
);
assert(otpAgent.includes("outputSchema"), "otp returns structured result");
assert(otpAgent.includes("isGroupTurn"), "otp hidden in groups");

const otpInstr = readFileSync(
  new URL("../agent/subagents/otp/instructions.md", import.meta.url),
  "utf8",
);
assert(otpInstr.includes("Don't touch memory tools"), "otp is a subagent");
assert(otpInstr.includes("lookup"), "otp calls lookup first");

const worker = readFileSync(
  new URL("../agent/subagents/worker/instructions.md", import.meta.url),
  "utf8",
);
assert(worker.includes("mailbox") || worker.includes("archive"), "worker knows coordinator checks mail");

const inbound = readFileSync(
  new URL("../agent/lib/mail-inbound.ts", import.meta.url),
  "utf8",
);
assert(inbound.includes("ingestInkboxArchive"), "inbound copies Bro mail into archive");

const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
assert(pkg.includes("otp:check"), "npm script");

console.log("otp-check ok");
