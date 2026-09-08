import { readFileSync } from "node:fs";
import { timingSafeEqual } from "../convex/secret.ts";
import { WAKE_LINES } from "../convex/lib/memoryPolicy.ts";
import {
  BROWSER_JOB_DONE,
  BROWSER_JOB_FAILED,
  BROWSER_JOB_IDLE,
  BROWSER_JOB_RUNNING,
  BROWSER_JOB_SECURE,
  browserJobForSnapshot,
} from "../convex/lib/browserJobPolicy.ts";
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

function snapshotValidatorHas(src: string, field: string): boolean {
  const block = src.match(/const snapshotValidator = v\.object\(\{[\s\S]*?\n\}\);/);
  return block ? new RegExp(`\\b${field}\\b`).test(block[0]) : false;
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
assert(snap.tz === undefined, "default tz omitted");
assert(
  snap.browserJob.status === "" && snap.browserJob.label === BROWSER_JOB_IDLE,
  "default browser job idle",
);
assert(snap.computer.state === "none", "default computer none");
assert(snap.chatgpt.status === "none", "default chatgpt none");
assert(!("boxId" in snap.computer), "snapshot never leaks boxId");
assert(!("userCode" in snap.chatgpt), "snapshot never leaks userCode");

const withGear = buildSnapshot({
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
  computer: { state: "ready", lastActiveAt: now },
  chatgpt: { status: "connected", email: "a@b.c", planType: "plus" },
});
assert(withGear.computer.state === "ready", "snapshot keeps computer state");
assert(withGear.computer.lastActiveAt === now, "snapshot keeps lastActiveAt");
assert(withGear.chatgpt.status === "connected", "snapshot keeps chatgpt status");
assert(withGear.chatgpt.email === "a@b.c", "snapshot keeps chatgpt email");
assert(withGear.chatgpt.planType === "plus", "snapshot keeps chatgpt plan");

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

const withTz = buildSnapshot({
  handle: "bro-a1b2c3d4",
  paid: false,
  msgsUsed: 0,
  msgsAllowance: 30,
  msgsDayKey: "2026-08-28",
  browserUsed: 0,
  browserAllowance: 5,
  browserMonthKey: "2026-08",
  payments: [],
  tz: "Asia/Yekaterinburg",
  browserJob: browserJobForSnapshot({
    browserStatus: "running",
    browserTask: "скотч на ozon",
    browserStartedAt: now,
  }),
});
assert(withTz.tz === "Asia/Yekaterinburg", "snapshot keeps tz");
assert(withTz.browserJob.label === BROWSER_JOB_RUNNING, "snapshot keeps browser job");
assert(withTz.browserJob.task === "скотч на ozon", "snapshot keeps browser task");
assert(withTz.browserJob.startedAt === now, "snapshot keeps browser startedAt");

assert(browserJobForSnapshot({}).label === BROWSER_JOB_IDLE, "job empty idle");
assert(browserJobForSnapshot({ browserStatus: "" }).label === BROWSER_JOB_IDLE, "job blank idle");
assert(
  browserJobForSnapshot({ browserStatus: "missing" }).label === BROWSER_JOB_IDLE,
  "job missing idle",
);
assert(
  browserJobForSnapshot({ browserStatus: "empty" }).label === BROWSER_JOB_IDLE,
  "job empty-status idle",
);
assert(
  browserJobForSnapshot({
    browserStatus: "missing",
    browserLiveUrl: "https://live.example/view",
    browserTask: "old",
  }).label === BROWSER_JOB_IDLE,
  "idle wins leftover liveUrl",
);
for (const st of ["running", "started", "pending", "Running"]) {
  const job = browserJobForSnapshot({
    browserStatus: st,
    browserTask: "оформить заказ",
    browserStartedAt: now,
  });
  assert(job.label === BROWSER_JOB_RUNNING, `job ${st} running copy`);
  assert(job.status === st.trim(), `job ${st} keeps status`);
  assert(job.task === "оформить заказ", `job ${st} task`);
  assert(job.liveUrl === undefined, `job ${st} no liveUrl when none stored`);
}
const queued = browserJobForSnapshot({ browserStatus: "queued" });
assert(queued.label === BROWSER_JOB_RUNNING, "queued is in-flight copy");

const done = browserJobForSnapshot({
  browserStatus: "completed",
  browserTask: "готово",
  browserLiveUrl: "https://live.example/old",
  browserStartedAt: now,
});
assert(done.label === BROWSER_JOB_DONE, "completed copy");
assert(done.liveUrl === undefined, "completed hides leftover liveUrl");
assert(done.task === "готово" && done.startedAt === now, "completed keeps task");

for (const st of ["failed", "error", "cancelled", "canceled", "stopped"]) {
  assert(
    browserJobForSnapshot({ browserStatus: st }).label === BROWSER_JOB_FAILED,
    `job ${st} failed copy`,
  );
}

const threeDs = browserJobForSnapshot({
  browserStatus: "needs_3ds",
  browserTask: "оплата",
});
assert(threeDs.label === BROWSER_JOB_SECURE, "needs_3ds copy");
assert(threeDs.liveUrl === undefined, "3ds without url has no link");

const liveRunning = browserJobForSnapshot({
  browserStatus: "running",
  browserLiveUrl: "https://live.example/session",
  browserTask: "купить кроссовки",
  browserStartedAt: now,
});
assert(liveRunning.label === BROWSER_JOB_RUNNING, "live viewer is not 3ds");
assert(liveRunning.liveUrl === "https://live.example/session", "running keeps liveUrl");
assert(liveRunning.task === "купить кроссовки", "running keeps task");

assert(
  browserJobForSnapshot({
    browserStatus: "Needs 3-D Secure",
    browserLiveUrl: "https://live.example/bank",
  }).label === BROWSER_JOB_SECURE,
  "3-D Secure status copy",
);
assert(
  browserJobForSnapshot({
    browserStatus: "pending",
    browserLiveUrl: "  https://live.example/pad  ",
  }).liveUrl === "https://live.example/pad",
  "liveUrl trimmed",
);

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
assert(cabinet.includes('id="now"'), "cabinet now card");
assert(cabinet.includes("<h2>Сейчас</h2>"), "cabinet now title");
assert(cabinet.includes("browserJob"), "cabinet reads snapshot browserJob");
assert(cabinet.includes("Открыть"), "cabinet liveUrl open");
assert(cabinet.includes('id="computer"'), "cabinet computer card");
assert(cabinet.includes("<h2>Компьютер</h2>"), "cabinet computer title");
assert(cabinet.includes('id="computer-wake"'), "cabinet wake");
assert(cabinet.includes("Разбудить"), "cabinet wake copy");
assert(cabinet.includes('id="computer-stop"'), "cabinet stop");
assert(cabinet.includes("Выключить"), "cabinet stop copy");
assert(cabinet.includes('id="computer-wipe"'), "cabinet wipe");
assert(cabinet.includes("Стереть диск"), "cabinet wipe copy");
assert(cabinet.includes("/me/computer"), "computer posts to cabinet route");
assert(cabinet.includes('JSON.stringify({ action: action })'), "computer body is { action }");
assert(cabinet.includes('id="chatgpt"'), "cabinet chatgpt card");
assert(cabinet.includes("<h2>ChatGPT</h2>"), "cabinet chatgpt title");
assert(cabinet.includes('id="chatgpt-connect"'), "cabinet chatgpt connect");
assert(cabinet.includes("Подключить"), "cabinet chatgpt connect copy");
assert(cabinet.includes('id="chatgpt-disconnect"'), "cabinet chatgpt disconnect");
assert(cabinet.includes("Отключить"), "cabinet chatgpt disconnect copy");
assert(cabinet.includes("/me/chatgpt/start"), "chatgpt start route");
assert(cabinet.includes("/me/chatgpt/disconnect"), "chatgpt disconnect route");
assert(cabinet.includes("userCode"), "chatgpt start shows userCode only after start");
assert(!cabinet.includes("me.chatgpt.userCode"), "snapshot userCode is not rendered");
assert(!cabinet.includes("me.computer.boxId"), "snapshot boxId is not rendered");
assert(cabinet.includes('id="tz"'), "cabinet tz card");
assert(cabinet.includes("<h2>Часовой пояс</h2>"), "cabinet tz title");
assert(cabinet.includes('id="tz-select"'), "cabinet tz select");
assert(cabinet.includes("/me/tz"), "tz posts to cabinet route");
assert(cabinet.includes('JSON.stringify({ tz: tz })'), "tz body is { tz }");
assert(
  cabinet.includes('Authorization: "Bearer " + t'),
  "tz uses bearer session",
);
assert(!cabinet.includes("setTimezone"), "tz does not call secret mutation");
assert(!cabinet.includes("INKBOX_SECRET"), "tz does not send a secret");
for (const z of [
  "Europe/Moscow",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Kamchatka",
  "UTC",
]) {
  assert(cabinet.includes(`"${z}"`), `cabinet lists ${z}`);
}

const cabinetSrc = readFileSync(new URL("../convex/cabinet.ts", import.meta.url), "utf8");
assert(cabinetSrc.includes("tz: v.optional(v.string())"), "snapshot validator has tz");
assert(cabinetSrc.includes("browserJob:"), "snapshot validator has browserJob");
assert(cabinetSrc.includes("browserJobForSnapshot"), "snapshotForTenant maps browser job");
assert(cabinetSrc.includes("computer:"), "snapshot validator has computer");
assert(cabinetSrc.includes("chatgpt:"), "snapshot validator has chatgpt");
assert(!snapshotValidatorHas(cabinetSrc, "boxId"), "cabinet snapshot does not expose boxId");
assert(!snapshotValidatorHas(cabinetSrc, "userCode"), "cabinet snapshot does not expose userCode");
assert(!cabinetSrc.includes("setTimezone"), "cabinet.ts does not add /me/tz mutation");

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
assert(httpSrc.includes("/me/chatgpt/start"), "http chatgpt start");
assert(httpSrc.includes("/me/chatgpt/disconnect"), "http chatgpt disconnect");
assert(httpSrc.includes("/me/computer"), "http computer route");
assert(httpSrc.includes("/internal/computer"), "http computer proxies eve");
assert(!httpSrc.includes("BOX_API_KEY"), "http does not send BOX_API_KEY");

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
