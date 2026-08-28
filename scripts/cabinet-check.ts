import { readFileSync } from "node:fs";
import { timingSafeEqual } from "../convex/secret.ts";
import {
  buildSnapshot,
  challengeExpiry,
  CHALLENGE_TTL_MS,
  loginStartDecision,
  loginVerifyDecision,
  MAX_VERIFY_ATTEMPTS,
  newLoginCode,
  newSessionToken,
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

const authJs = readFileSync(new URL("../assets/auth.js", import.meta.url), "utf8");
assert(authJs.includes('#login-open'), "auth binds #login-open");
assert(authJs.includes('#login-modal'), "auth binds #login-modal");
assert(!/\$\("\.login-open"\)/.test(authJs), "auth does not use class login-open");

console.log("cabinet-check ok");
