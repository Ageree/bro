import {
  cardBrand,
  cardLinkUrl,
  cardPlain,
  cvcOk,
  decryptCard,
  digitsOnly,
  encryptCard,
  expiryOk,
  linkFresh,
  luhnOk,
  makeCardToken,
  modelPayloadHasPan,
  parseCardInput,
  splitCardPlain,
} from "../convex/lib/cardPolicy.ts";
import { redactBrowserError } from "../agent/lib/browseruse.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(digitsOnly("2200 1234 5678 9012") === "2200123456789012", "digits");
assert(luhnOk("2201382000000013"), "mir luhn");
assert(cardBrand("2201382000000013") === "mir", "mir brand from luhn pan");
assert(luhnOk("4111111111111111"), "4111 luhn");
assert(!luhnOk("4111111111111112"), "bad luhn");
assert(cardBrand("2200123456789012") === "mir", "mir bin");
assert(cardBrand("4111111111111111") === "visa", "visa");
assert(cardBrand("5555555555554444") === "mc", "mc");
assert(expiryOk(12, 2027, new Date("2026-08-27")), "future");
assert(!expiryOk(1, 2020, new Date("2026-08-27")), "past");
assert(cvcOk("123") && cvcOk("1234") && !cvcOk("12"), "cvc");
const parsed = parseCardInput({
  pan: "4111 1111 1111 1111",
  expMonth: 12,
  expYear: 27,
  cvc: "123",
});
assert(parsed.ok && parsed.last4 === "1111" && parsed.brand === "visa", "parse");
assert(!parseCardInput({ pan: "4111", expMonth: 12, expYear: 27, cvc: "123" }).ok, "short pan");

const tok = makeCardToken(new Uint8Array(24).fill(7));
assert(/^[0-9a-f]{48}$/.test(tok), "token hex");
assert(linkFresh(Date.now() + 60_000, false, Date.now()), "fresh");
assert(!linkFresh(Date.now() - 1, false, Date.now()), "expired");
assert(!linkFresh(Date.now() + 60_000, true, Date.now()), "used");
assert(
  cardLinkUrl("https://example.com", "ab") === "https://example.com/card.html?t=ab",
  "url",
);

const key = "11".repeat(32);
const blob = await encryptCard(cardPlain("4111111111111111", "123"), key);
const back = splitCardPlain(await decryptCard(blob, key));
assert(back.pan === "4111111111111111" && back.cvc === "123", "roundtrip");
assert(
  !modelPayloadHasPan({ last4: "1111", status: "active" }, "4111111111111111"),
  "meta safe",
);
assert(
  modelPayloadHasPan({ hint: "use 4111111111111111" }, "4111111111111111"),
  "leak",
);

const pan = "4111111111111111";
const cvc = "123";
const buInject = `buy tape on ozon\n\nPAYMENT CARD (fill on checkout, do not speak these digits, do not solve 3DS):\nPAN=${pan} EXP=12/2027 CVC=${cvc}\nIf a 3DS/Mir Accept form asks for an SMS code, wait; the human will send the code in iMessage and a later browser_task will type it.`;
const browserPayload = {
  status: "completed",
  runId: "run_1",
  sessionId: "sess_1",
  liveUrl: "https://live.example/view",
  result: "order paid",
  hint: "Send these results to the human now. Do not start another search.",
  started: true,
  alreadyNotified: true,
  card: "1111",
};
assert(!modelPayloadHasPan(browserPayload, pan), "browser payload last4 only");
assert(
  !JSON.stringify(browserPayload).includes(cvc) &&
    !JSON.stringify(browserPayload).includes("PAN="),
  "browser payload no cvc/inject",
);
assert(
  modelPayloadHasPan({ ...browserPayload, result: buInject }, pan),
  "browser payload illegal if pan injected into json",
);

const buErr = `browser-use 400 /runs: {"task":"${buInject}"}`;
assert(modelPayloadHasPan({ error: buErr }, pan), "raw bu error leaks pan");
const redacted = redactBrowserError(buErr);
assert(!modelPayloadHasPan({ error: redacted }, pan), "redacted bu error no pan");
assert(!redacted.includes(cvc), "redacted bu error no cvc");
assert(redacted.includes("PAN=REDACTED") && redacted.includes("CVC=REDACTED"), "redact tokens");
console.log("card-policy-check ok");
