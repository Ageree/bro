import { readFileSync } from "node:fs";
import { timingSafeEqual } from "../convex/secret.ts";
import { WAKE_LINES } from "../convex/lib/memoryPolicy.ts";
import {
  buildSnapshot,
  challengeExpiry,
  CHALLENGE_TTL_MS,
  loginStartDecision,
  loginVerifyDecision,
  MAX_VERIFY_ATTEMPTS,
  memoriesForSnapshot,
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
  storedHandle,
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
assert(Array.isArray(snap.memories) && snap.memories.length === 0, "default memories empty");

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
assert(free.memories.length === 0, "unbound memories empty");

assert(storedHandle("bro-a1b2c3d4") === "bro-a1b2c3d4", "stored handle ok");
assert(storedHandle("  bro-a1b2c3d4  ") === "bro-a1b2c3d4", "stored handle trim");
assert(storedHandle(null) === null, "stored handle missing");
assert(storedHandle("Bro-a1b2c3d4") === null, "stored handle case");
assert(storedHandle("please-type-me") === null, "typed handle is not the path");

assert(memoriesForSnapshot(["n2", "n1"], WAKE_LINES).join(",") === "n1,n2", "memories oldest first newest last");
assert(memoriesForSnapshot([], WAKE_LINES).length === 0, "memories empty");
const newestFirst = Array.from({ length: WAKE_LINES + 5 }, (_, i) => `n${i}`);
const capped = memoriesForSnapshot(newestFirst, WAKE_LINES);
assert(capped.length === WAKE_LINES, "memories cap WAKE_LINES");
assert(capped[0] === `n${WAKE_LINES - 1}`, "cap keeps newest window, oldest of those first");
assert(capped[capped.length - 1] === "n0", "newest last");

const withMemos = buildSnapshot({
  handle: "bro-a1b2c3d4",
  phoneE164: "+79001112233",
  paid: false,
  msgsUsed: 0,
  msgsAllowance: 30,
  msgsDayKey: "2026-08-28",
  browserUsed: 0,
  browserAllowance: 5,
  browserMonthKey: "2026-08",
  payments: [],
  memories: ["old fact", "new fact"],
});
assert(withMemos.memories.join("|") === "old fact|new fact", "snapshot keeps memory order");

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
assert(authJs.includes("bro.handle"), "auth reads stored handle key");
assert(authJs.includes("login-handle-row"), "auth hides handle row");
assert(authJs.includes("storedHandle"), "auth sends stored handle");
assert(authJs.includes("Запросить доступ"), "missing handle points at request access");
assert(!authJs.includes('$("#login-handle").value'), "auth does not read typed handle");

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
assert(cabinet.includes('id="login-handle-row"'), "cabinet login handle row");
assert(cabinet.includes("handle-xl"), "cabinet handle is large");
assert(cabinet.includes("Написать Bro"), "cabinet write-bro cta");
assert(cabinet.includes('id="write-bro"'), "cabinet write-bro id");
assert(cabinet.includes("/access"), "write-bro reuses POST /access");
assert(cabinet.includes("smsLink"), "write-bro opens sms_link");
assert(
  cabinet.includes("bro-[a-z0-9]{8}"),
  "write-bro only opens a valid stored handle",
);
assert(cabinet.includes("Память"), "cabinet memory card");
assert(cabinet.includes("Забыть"), "cabinet forget button");
assert(cabinet.includes("/me/memories/forget"), "forget posts to cabinet route");

const vault = readFileSync(new URL("../vault.html", import.meta.url), "utf8");
assert(vault.includes('id="login-handle-row"'), "vault login handle row");
assert(landing.includes('id="login-handle-row"'), "landing login handle row");

const httpSrc = readFileSync(new URL("../convex/http.ts", import.meta.url), "utf8");
assert(httpSrc.includes("/me/memories/forget"), "http forget route");
assert(
  httpSrc.includes("forgetMemoriesForTenant"),
  "http forget uses cabinet session mutation",
);
assert(
  !httpSrc.includes("internal.memories.forget"),
  "http forget does not call secret memories.forget",
);

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
