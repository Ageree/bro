import { readFileSync } from "node:fs";
import { timingSafeEqual } from "../convex/secret.ts";
import {
  buildSnapshot,
  challengeExpiry,
  CHALLENGE_TTL_MS,
  loginCodeText,
  loginLinkFor,
  loginStartDecision,
  loginVerifyDecision,
  MAX_VERIFY_ATTEMPTS,
  newLoginCode,
  newSessionToken,
  parseLoginIdentifier,
  paymentApplyDecision,
  paymentsOwnedBy,
  phoneLast4,
  sessionExpiry,
  sessionLive,
  SESSION_TTL_MS,
  sha256hex,
  START_COOLDOWN_MS,
} from "../convex/lib/cabinetPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const now = Date.parse("2026-08-28T12:00:00.000Z");
const bound = {
  phoneE164: "+79001112233",
  inkboxConversationId: "conv-1",
  inkboxHandle: "bro-a1b2c3d4",
  inkboxIdentityId: "id-1",
};

assert(loginStartDecision({ tenant: null, now }) === "unknown", "no tenant");
assert(
  loginStartDecision({ tenant: { inkboxHandle: "bro-a1b2c3d4" }, now }) ===
    "unbound",
  "handle only",
);
assert(
  loginStartDecision({
    tenant: { ...bound, inkboxConversationId: undefined },
    now,
  }) === "unbound",
  "no conversation",
);
assert(loginStartDecision({ tenant: bound, now }) === "ok", "bound ok");
assert(
  loginStartDecision({
    tenant: bound,
    now,
    lastChallengeAt: now - 1_000,
  }) === "cooldown",
  "fresh challenge",
);
assert(
  loginStartDecision({
    tenant: bound,
    now,
    lastChallengeAt: now - START_COOLDOWN_MS,
  }) === "ok",
  "cooldown elapsed",
);

assert(
  loginVerifyDecision({
    now,
    expiresAt: now - 1,
    attempts: 0,
    codeMatch: true,
  }).kind === "expired",
  "expired wins over match",
);
assert(
  loginVerifyDecision({
    now,
    expiresAt: now + 1,
    attempts: MAX_VERIFY_ATTEMPTS,
    codeMatch: true,
  }).kind === "locked",
  "locked wins over match",
);
const wrong = loginVerifyDecision({
  now,
  expiresAt: now + 1,
  attempts: 0,
  codeMatch: false,
});
assert(wrong.kind === "wrong" && wrong.attemptsLeft === 4, "wrong countdown");
assert(
  loginVerifyDecision({
    now,
    expiresAt: now + 1,
    attempts: 0,
    codeMatch: true,
  }).kind === "ok",
  "match",
);

assert(sessionLive(now + 1, now), "live");
assert(!sessionLive(now, now), "exact expiry is dead");
assert(sessionExpiry(now) === now + SESSION_TTL_MS, "session ttl");
assert(challengeExpiry(now) === now + CHALLENGE_TTL_MS, "challenge ttl");

assert(phoneLast4("+79001112233") === "2233", "last4");
assert(phoneLast4("123") === undefined, "short phone");

const snap = buildSnapshot({
  handle: "bro-a1b2c3d4",
  phoneE164: "+79001112233",
  paid: true,
  paidUntil: now + 1000,
  msgsUsed: 3,
  msgsAllowance: 500,
  msgsDayKey: "2026-08-28",
  browserUsed: 1,
  browserAllowance: 60,
  browserMonthKey: "2026-08",
  payments: [{ createdAt: now, amountRub: 2000, status: "succeeded" }],
});
assert(snap.plan === "paid", "paid plan");
assert(snap.phoneBound && snap.phoneLast4 === "2233", "phone mask");
assert(snap.paidUntil === now + 1000, "paidUntil shown");
assert(snap.payments.length === 1, "own payments");
assert(snap.browserProfileStatus === "missing", "default profile missing");
assert(snap.browserCookieDomains.length === 0, "default no domains");

const free = buildSnapshot({
  handle: "bro-a1b2c3d4",
  paid: false,
  msgsUsed: 0,
  msgsAllowance: 30,
  msgsDayKey: "2026-08-28",
  browserUsed: 0,
  browserAllowance: 5,
  browserMonthKey: "2026-08",
  payments: [],
});
assert(free.plan === "free" && free.paidUntil === undefined, "free hides until");
assert(!free.phoneBound && free.phoneLast4 === undefined, "unbound phone");

const a = "ten_a";
const mixed = paymentsOwnedBy(a, [
  { tenantId: a, n: 1 },
  { tenantId: "ten_b", n: 2 },
  { tenantId: a, n: 3 },
]);
assert(
  mixed.length === 2 && mixed.every((r) => r.tenantId === a),
  "payments strip foreign rows",
);

assert(paymentApplyDecision(false) === "apply", "first webhook");
assert(paymentApplyDecision(true) === "skip", "retry webhook");

const token = newSessionToken();
assert(/^[0-9a-f]{64}$/.test(token), "session token hex");
assert(newSessionToken() !== token, "session tokens differ");

const code = newLoginCode();
assert(/^\d{6}$/.test(code), "otp format");

const hex = await sha256hex("secret");
assert(hex.length === 64, "sha256 hex");
assert(hex === (await sha256hex("secret")), "sha256 stable");
assert(hex !== (await sha256hex("Secret")), "sha256 distinct");
assert(timingSafeEqual(hex, hex), "hash compare");

assert(
  parseLoginIdentifier("8 (900) 111-22-33")?.kind === "phone" &&
    (parseLoginIdentifier("8 (900) 111-22-33") as { phoneE164: string })
      .phoneE164 === "+79001112233",
  "ru 8-prefixed number",
);
assert(
  parseLoginIdentifier("+7 900 111 22 33")?.kind === "phone" &&
    (parseLoginIdentifier("+7 900 111 22 33") as { phoneE164: string })
      .phoneE164 === "+79001112233",
  "ru +7 spaced number",
);
assert(
  (parseLoginIdentifier("79001112233") as { phoneE164: string })
    .phoneE164 === "+79001112233",
  "ru bare 11-digit number",
);
assert(
  (parseLoginIdentifier("9001112233") as { phoneE164: string }).phoneE164 ===
    "+79001112233",
  "ru bare 10-digit mobile",
);
assert(
  (parseLoginIdentifier("+1 415 555 2671") as { phoneE164: string })
    .phoneE164 === "+14155552671",
  "non-ru plus number",
);
const parsedHandle = parseLoginIdentifier("BRO-A1B2C3D4");
assert(
  parsedHandle?.kind === "handle" &&
    (parsedHandle as { handle: string }).handle === "bro-a1b2c3d4",
  "handle is lowercased",
);
assert(parseLoginIdentifier("123") === null, "too short to be a phone");
assert(parseLoginIdentifier("abc") === null, "no digits at all");
assert(parseLoginIdentifier("bro-xyz") === null, "malformed handle");
assert(parseLoginIdentifier("") === null, "empty input");

assert(
  loginLinkFor(undefined, "bro-a1b2c3d4", "123456") === undefined,
  "no base means no link",
);
assert(
  loginLinkFor("", "bro-a1b2c3d4", "123456") === undefined,
  "empty base means no link",
);
assert(
  loginLinkFor("https://bro.example", "bro-a1b2c3d4", "123456") ===
    "https://bro.example/cabinet.html#login=bro-a1b2c3d4.123456",
  "link format",
);
assert(
  loginLinkFor("https://bro.example/", "bro-a1b2c3d4", "123456") ===
    "https://bro.example/cabinet.html#login=bro-a1b2c3d4.123456",
  "trailing slash stripped",
);

const textNoLink = loginCodeText("123456", undefined);
assert(
  textNoLink === "Код входа в кабинет bro: 123456" &&
    textNoLink.split("\n").length === 1,
  "code text without link is one line",
);
const textWithLink = loginCodeText(
  "123456",
  "https://bro.example/cabinet.html#login=bro-a1b2c3d4.123456",
);
assert(
  textWithLink.split("\n").length === 2 &&
    textWithLink.includes("123456") &&
    textWithLink.includes("https://bro.example/cabinet.html#login=bro-a1b2c3d4.123456"),
  "code text with link is two lines",
);

const authJs = readFileSync(new URL("../assets/auth.js", import.meta.url), "utf8");
assert(authJs.includes('#login-open'), "auth binds #login-open");
assert(authJs.includes('#login-modal'), "auth binds #login-modal");
assert(!/\$\("\.login-open"\)/.test(authJs), "auth does not use class login-open");

const landing = readFileSync(new URL("../index.html", import.meta.url), "utf8");
assert(landing.includes('id="login-send"'), "landing has login send");
assert(
  landing.includes('class="cta sheet-cta" id="login-send"'),
  "login send is a full-width one-line CTA",
);
assert(landing.includes("white-space: nowrap"), "login CTA stays on one line");
assert(
  landing.includes("Код придёт сообщением от Bro"),
  "login sheet says where the code arrives",
);
const cabinet = readFileSync(new URL("../cabinet.html", import.meta.url), "utf8");
assert(cabinet.includes('id="chrome"'), "cabinet chrome card");
assert(cabinet.includes("пришлёт ссылку в чат"), "cabinet login is a chat link");
assert(!cabinet.includes("profile.sh"), "cabinet has no terminal helper");
assert(!cabinet.includes('id="profile-save"'), "cabinet does not bind profile ids");

assert(landing.includes('id="request-access"'), "landing CTA has id");
assert(
  landing.includes('querySelector("#request-access")'),
  "landing CTA script does not grab modal .cta",
);
assert(
  !/var cta = document\.querySelector\("\.cta"\)/.test(landing),
  "landing does not query first .cta",
);

console.log("cabinet-check ok");
