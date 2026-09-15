import { assert, eq, src } from "./lib/check.ts";
import { isDryRunErrand, scaffoldTask } from "../agent/lib/browseruse.ts";
import {
  CHAT_CODE_ACK,
  CHAT_CONFIRM_ACK,
  CHAT_INJECT_ACK,
  CHAT_WAIT_ACK,
  INJECT_MARK,
  NO_LIVE_RUN_TEXT,
  cloudInjectAttribute,
  cloudInjectInstruction,
  cloudInjectKindFromAttrs,
  cloudInjectTextFromAttrs,
  cloudSessionLooksLive,
  decideCloudInject,
  extractChatCode,
  injectAckText,
  injectCandidate,
  injectFollowTask,
  injectQueueInterrupt,
  injectQueueText,
  isChatCodeMessage,
  isConfirmInject,
  isWaitInject,
  looksLikeCorrectionText,
  looksLikePasswordDump,
  looksLikeSteer,
  steerCandidate,
  pageWaitsForCode,
  resultWaitsForCode,
} from "../convex/lib/browserInjectPolicy.ts";
import { scoreOtpInput } from "../agent/lib/browser-cdp.ts";

const taxiTask = `[bro-errand] Задача: вызови такси домой.`;
const loginTask = `[bro-login]
Первым действием открой именно https://taxi.yandex.ru/`;
const now = Date.parse("2026-09-14T21:20:00.000Z");
const liveRun = {
  status: "running",
  sessionId: "sess-1",
  runId: "run-1",
  storedTask: taxiTask,
  startedAt: now - 60_000,
  now,
};

assert(extractChatCode("482911") === "482911", "bare 6-digit code");
assert(extractChatCode("код 123 456") === "123456", "spaced code");
assert(extractChatCode("вот код: 918273") === "918273", "wrapped code");
assert(extractChatCode("+79217818876") === null, "phone is not a code");
assert(extractChatCode("2024") === null, "year is not a code");

// F5 — two digit runs: prefer the one next to a код/otp/sms keyword and
// reject the one next to an order/price word, instead of silently dropping
// the whole message.
assert(
  extractChatCode("код 482913, заказ 55081234") === "482913",
  "keyword-adjacent code wins over an order number",
);
assert(extractChatCode("1500") === "1500", "a bare short number still extracts (gated elsewhere)");
assert(extractChatCode("1500 руб") === null, "a price is not a code");
assert(extractChatCode("89161234567") === null, "an 11-digit phone number is not a code");

// Fast path (restored): dash/space/dot-separated bare or keyword-prefixed
// codes still extract — only a message with surviving letters/punctuation
// (a price, an order line) falls through to the clause-window logic.
assert(extractChatCode("482-913") === "482913", "dash-separated bare code");
assert(extractChatCode("48 29 13") === "482913", "2+2+2 space-separated bare code");
assert(extractChatCode("код: 482-913") === "482913", "keyword-prefixed dash-separated code");
assert(isChatCodeMessage("482911"), "bare digits are a chat code");
assert(isChatCodeMessage("код 482 911"), "код + digits");
assert(!isChatCodeMessage("купи скотч"), "errand is not a code");
assert(!isChatCodeMessage("привет"), "hello is not a code");
assert(!isChatCodeMessage("Ленина 12"), "address is not a code");

assert(isWaitInject("подожди"), "подожди");
assert(isWaitInject("Подожди секунду."), "wait with punct");
assert(isWaitInject("стой"), "стой");
assert(!isWaitInject("подожди, закажи такси"), "wait+new job is not wait-only");
assert(!isWaitInject("как дела"), "small talk is not wait");

assert(looksLikeCorrectionText("не туда, на Невский 10"), "address correction");
assert(looksLikeCorrectionText("другой ПВЗ"), "pvz correction");
assert(looksLikeCorrectionText("размер 42"), "size correction");
assert(looksLikeCorrectionText("домой"), "домой");
assert(!looksLikeCorrectionText("привет"), "hello is not correction");
assert(!looksLikeCorrectionText("купи скотч на ozon"), "new shop is not correction");
assert(
  looksLikeCorrectionText("закажи на другой адрес, Ленина 5"),
  "same-family address tweak",
);

assert(looksLikePasswordDump("Hunter2!secret"), "mixed secret is a password dump");
assert(!looksLikePasswordDump("482911"), "otp is not a password dump");

assert(
  pageWaitsForCode("https://passport.yandex.ru/pwl-yandex/auth/code"),
  "yandex code page",
);
assert(
  pageWaitsForCode("https://id.yandex.ru/auth"),
  "yandex id auth page",
);
assert(
  pageWaitsForCode("https://www.ozon.ru/otp/sms"),
  "ozon otp path",
);
assert(
  !pageWaitsForCode("https://taxi.yandex.ru/order"),
  "taxi form is not a code page",
);

assert(
  resultWaitsForCode("Needs user input: код из SMS", taxiTask),
  "result asked for SMS",
);
assert(!resultWaitsForCode("нашёл 3 варианта", taxiTask), "plain result is not otp");

assert(
  decideCloudInject("482911", {
    ...liveRun,
    pageUrl: "https://passport.yandex.ru/pwl-yandex/auth/code",
  }).kind === "code",
  "code on passport injects",
);
assert(
  decideCloudInject("код 123 456", {
    ...liveRun,
    storedTask: loginTask,
  }).kind === "code",
  "code during login wait injects",
);
assert(
  decideCloudInject("482911", {
    ...liveRun,
    status: "completed",
    pageUrl: "https://passport.yandex.ru/pwl-yandex/auth/code",
    browserListed: true,
  }).kind === "code",
  "completed run still on code page injects",
);
assert(
  decideCloudInject("482911", {
    ...liveRun,
    pageUrl: "https://taxi.yandex.ru/order",
    result: "форма заказа",
  }).kind === null,
  "bare code on taxi form is not relevant",
);
assert(
  decideCloudInject("482911", {}).kind === "code",
  "code without a session still flagged so Bro can say no live run",
);
assert(
  decideCloudInject("подожди", liveRun).kind === "wait",
  "подожди while running injects",
);
assert(
  decideCloudInject("не туда, Ленина 12", liveRun).kind === "correction",
  "address correction injects",
);
assert(
  decideCloudInject("как дела", liveRun).kind === null,
  "unrelated chat is not injected",
);
assert(
  decideCloudInject("спасибо", liveRun).kind === null,
  "thanks is not injected",
);
assert(
  decideCloudInject("купи скотч на ozon", liveRun).kind === null,
  "new errand is not injected into the taxi run",
);
assert(
  decideCloudInject("Hunter2!secret", {
    ...liveRun,
    storedTask: loginTask,
    pageUrl: "https://passport.yandex.ru/auth",
  }).kind === null,
  "site password dump is never injected",
);
assert(
  decideCloudInject("подожди", {
    status: "completed",
    sessionId: "sess-1",
    runId: "run-1",
    storedTask: taxiTask,
    startedAt: now - 60_000,
    now,
  }).kind === null,
  "подожди after the run ended is not injected unless the browser is still listed",
);
assert(
  decideCloudInject("размер 42", {
    ...liveRun,
    storedTask: "[bro-errand] кроссовки на wb",
  }).kind === "correction",
  "size correction on a shop errand",
);
assert(
  decideCloudInject("домой", {
    ...liveRun,
    storedTask: "[bro-errand] кроссовки на wb",
  }).kind === null,
  "домой is not a shop correction",
);
assert(
  decideCloudInject("домой", liveRun).kind === "correction",
  "домой on a taxi errand",
);
assert(
  decideCloudInject("Ленина 12", {
    ...liveRun,
    storedTask: loginTask,
    pageUrl: "https://passport.yandex.ru/auth",
  }).kind === null,
  "address is not injected into a login-wait tab",
);

// F3 — push/bank-app confirmations are recognized and resume a parked run.
assert(isConfirmInject("подтвердил"), "подтвердил is a confirm");
assert(isConfirmInject("готово"), "готово is a confirm");
assert(isConfirmInject("подтвердил вход"), "confirm with tail");
assert(isConfirmInject("готово, оплатил"), "confirm with comma tail");
assert(isConfirmInject("вошел"), "вошел is a confirm");
assert(isConfirmInject("оплатил"), "оплатил is a confirm");
assert(!isConfirmInject("готово к выходу?"), "a question is never a confirm");
assert(!isConfirmInject("купи скотч на ozon"), "a fresh errand is not a confirm");
assert(!isConfirmInject("привет"), "hello is not a confirm");
assert(injectCandidate("подтвердил"), "confirm is an inject candidate (F3)");
assert(injectCandidate("готово"), "готово is an inject candidate (F3)");
assert(
  decideCloudInject("подтвердил", liveRun).kind === "confirm",
  "confirm during a running errand injects",
);
assert(
  decideCloudInject("готово к выходу?", liveRun).kind === null,
  "false-positive question is never injected",
);
assert(
  decideCloudInject("подтвердил", {
    status: "completed",
    sessionId: "sess-1",
    runId: "run-1",
    need: "push",
    now,
  }).kind === "confirm",
  "confirm resumes a terminal run parked on a push (need=push)",
);
assert(
  decideCloudInject("подтвердил", {
    status: "completed",
    runId: "run-1",
    now,
  }).kind === null,
  "confirm without a live session and without a recorded need is not injected",
);
assert(injectAckText("confirm") === CHAT_CONFIRM_ACK, "confirm ack");
assert(CHAT_CONFIRM_ACK === "проверяю", "confirm first bubble text");
assert(cloudInjectAttribute("подтвердил").cloudInject === "confirm", "stamp confirm");
assert(
  cloudInjectKindFromAttrs({ origin: "human", cloudInject: "confirm" }) === "confirm",
  "human confirm stamp is read",
);
const confirmSteer = cloudInjectInstruction("confirm", true);
assert(confirmSteer?.includes("проверяю"), "confirm steer asks for проверяю first");
assert(confirmSteer?.includes("browser_task"), "confirm steer calls browser_task");
assert(
  injectQueueText({ kind: "confirm", humanText: "подтвердил" }).includes(
    "Проверь, продвинулся ли экран",
  ),
  "confirm queue text asks to check screen progress",
);
assert(
  injectQueueText({ kind: "confirm", humanText: "подтвердил" }).includes(
    "Ничего не вводи повторно",
  ),
  "confirm queue text forbids re-entering anything",
);
assert(!injectQueueInterrupt("confirm"), "confirm is appended, not interrupted");

assert(
  cloudSessionLooksLive({
    status: "running",
    sessionId: "s",
    runId: "r",
  }),
  "running is live",
);
assert(
  cloudSessionLooksLive({
    status: "completed",
    sessionId: "s",
    runId: "r",
    browserListed: true,
  }),
  "listed browser is live after complete",
);
assert(
  !cloudSessionLooksLive({
    status: "completed",
    runId: "r",
    startedAt: now - 2 * 60 * 60_000,
    now,
  }),
  "stale completed run without session is not live",
);

// F1 — a probed-absent browser outranks the elapsed-time fallback: the run
// only just finished (well inside the 20-min window), but the browser was
// actually checked and is gone, so it must not read as live.
assert(
  !cloudSessionLooksLive({
    status: "completed",
    sessionId: "s",
    runId: "r",
    browserListed: false,
    browserProbed: true,
    pageUrl: "https://taxi.yandex.ru/order",
    startedAt: now - 60_000,
    now,
  }),
  "probed-absent browser within the timeout window is not live (F1)",
);
// Same shape but never probed (network error, not "confirmed absent") — the
// elapsed-time fallback still applies.
assert(
  cloudSessionLooksLive({
    status: "completed",
    sessionId: "s",
    runId: "r",
    browserListed: false,
    startedAt: now - 60_000,
    now,
  }),
  "un-probed absence still falls back to the elapsed-time guess",
);
// A tenant recorded as waiting for a human input is live regardless of
// status — the session is parked, not gone.
assert(
  cloudSessionLooksLive({
    status: "completed",
    sessionId: "s",
    runId: "r",
    browserListed: false,
    browserProbed: true,
    need: "push",
    startedAt: now - 2 * 60 * 60_000,
    now,
  }),
  "need=push keeps the session live however stale (F1/Idea 1)",
);

// F4 — a bare short number with no session/context signal must not be
// accepted as a code just because *some* Cloud errand exists.
assert(
  decideCloudInject("1500", {
    ...liveRun,
    pageUrl: undefined,
    result: undefined,
  }).kind === null,
  "contextless bare number is not a code (F4)",
);
assert(
  decideCloudInject("1500", {
    ...liveRun,
    pageUrl: undefined,
    result: undefined,
    need: "sms_code",
  }).kind === "code",
  "same bare number IS a code once the tenant is recorded as waiting for one",
);
// With a код/otp/sms keyword the old isBroCloudTask fallback still applies —
// only bare, keyword-less digits got tightened.
assert(
  decideCloudInject("код 482911", {
    ...liveRun,
    pageUrl: undefined,
    result: undefined,
  }).kind === "code",
  "a code WITH a keyword still injects via the errand fallback (unchanged)",
);
// need=sms_code is authoritative even when the CDP-probed pageUrl is the
// site's own page (an SMS modal on taxi.yandex.ru, not a passport URL) — the
// need check must not be shadowed by the pageUrl-known-non-code rejection.
assert(
  decideCloudInject("482913", {
    ...liveRun,
    pageUrl: "https://taxi.yandex.ru/",
    result: undefined,
    need: "sms_code",
  }).kind === "code",
  "need=sms_code overrides a non-code pageUrl",
);

// General steer: any relevant follow-up to a live Cloud session (not just
// code/wait/correction) is docked into it; chatter and status questions are not.
assert(
  decideCloudInject("сделай эконом", liveRun).kind === "steer",
  "extra instruction steers the live errand",
);
assert(
  decideCloudInject("поменяй время подачи на 18:30", liveRun).kind === "steer" ||
    decideCloudInject("поменяй время подачи на 18:30", liveRun).kind === "correction",
  "a time tweak reaches the live errand",
);
{
  const k = decideCloudInject("добавь комментарий водителю: перезвоню", liveRun).kind;
  assert(k === "steer" || k === "correction", "a driver note reaches the live errand");
}
assert(decideCloudInject("спасибо", liveRun).kind === null, "thanks never steers");
assert(decideCloudInject("ну что там?", liveRun).kind === null, "status question never steers");
assert(decideCloudInject("ты тут?", liveRun).kind === null, "presence ping never steers");
assert(
  decideCloudInject("купи скотч на ozon", liveRun).kind === null,
  "a new unrelated errand never steers the taxi run",
);
assert(
  decideCloudInject("сделай эконом", {}).kind === null,
  "steer needs a live session on record",
);
assert(steerCandidate("сделай эконом"), "instruction is a steer candidate");
assert(!steerCandidate("спасибо"), "thanks is not a steer candidate");
assert(!steerCandidate("ну что там?"), "status question is not a steer candidate");
assert(!steerCandidate("482911"), "a bare code is not a steer candidate");
assert(!steerCandidate("купи телефон на ozon"), "a fresh errand is not a steer candidate");
assert(looksLikeSteer("сделай эконом", taxiTask), "steer fires with a cloud task on record");
assert(!looksLikeSteer("сделай эконом", undefined), "steer needs a cloud task on record");
assert(injectCandidate("сделай подешевле"), "an instruction is an inject candidate");
assert(!injectCandidate("спасибо"), "thanks is not an inject candidate");
assert(!injectCandidate("ну что там?"), "status question is not an inject candidate");
assert(injectAckText("steer") === CHAT_INJECT_ACK, "steer ack is «ввожу»");
assert(injectQueueInterrupt("steer"), "steer preempts the active run");
assert(
  injectQueueText({ kind: "steer", humanText: "сделай эконом" }).includes("сделай эконом"),
  "steer queue carries the instruction",
);
assert(
  injectQueueText({ kind: "steer", humanText: "сделай эконом" }).startsWith("Дополнение"),
  "steer queue text says Дополнение, not Уточнение",
);
assert(
  injectQueueText({ kind: "correction", humanText: "Ленина 12" }).startsWith("Уточнение"),
  "correction queue text still says Уточнение",
);

// Rule 2/9 — confirm decides before steer: a bare «готово»/«подтвердил» is a
// confirmation, never a general steer, even though STATUS_Q also matches
// «готово» and «сделал».
assert(
  decideCloudInject("готово", liveRun).kind === "confirm",
  "bare готово is a confirm, not a steer",
);
assert(!steerCandidate("подтвердил"), "a confirm phrase is never a steer candidate");

// Rule 3 — codeRelevantToSession: browserListed makes a bare keyword-less
// code relevant (#100), but only once a session is actually on record/live.
assert(
  decideCloudInject("1500", {
    ...liveRun,
    pageUrl: undefined,
    result: undefined,
    browserListed: true,
  }).kind === "code",
  "bare 1500 is a code once the live browser is held (browserListed, #100)",
);
assert(
  decideCloudInject("1500", {
    ...liveRun,
    browserListed: false,
    need: undefined,
    pageUrl: undefined,
    result: undefined,
  }).kind === null,
  "bare 1500 with no browserListed/need/pageUrl signal is still not a code (ours)",
);

assert(injectAckText("code") === CHAT_CODE_ACK, "code ack");
assert(injectAckText("wait") === CHAT_WAIT_ACK, "wait ack");
assert(injectAckText("correction") === CHAT_INJECT_ACK, "correction ack");
assert(CHAT_CODE_ACK === "ввожу код", "first bubble for a chat code");
assert(NO_LIVE_RUN_TEXT.includes("нет открытой страницы"), "no-live copy");
assert(NO_LIVE_RUN_TEXT.includes("зайду заново"), "no-live copy offers to retry (F11)");
assert(!NO_LIVE_RUN_TEXT.includes("пароль"), "no-live copy does not ask for a password");

assert(cloudInjectAttribute("482911").cloudInject === "code", "stamp code");
assert(cloudInjectAttribute("подожди").cloudInject === "wait", "stamp wait");
assert(cloudInjectAttribute("Ленина 12").cloudInject === "correction", "stamp address");
assert(Object.keys(cloudInjectAttribute("привет")).length === 0, "hello is not stamped");
assert(Object.keys(cloudInjectAttribute("купи скотч")).length === 0, "new job is not stamped");

// The raw human line is stamped so the tool can inject it even if the model
// re-issues the whole errand instead of passing the bare code.
assert(cloudInjectAttribute("482911").cloudInjectText === "482911", "stamp carries the code");
assert(
  cloudInjectAttribute("не туда, Ленина 12").cloudInjectText === "не туда, Ленина 12",
  "stamp carries the correction line",
);
assert(
  cloudInjectTextFromAttrs({ origin: "human", cloudInject: "code", cloudInjectText: "482911" }) ===
    "482911",
  "human stamped text is read",
);
assert(
  cloudInjectTextFromAttrs({ origin: "wakeup", cloudInjectText: "482911" }) === undefined,
  "wakeup stamp text is ignored",
);
assert(cloudInjectTextFromAttrs(undefined) === undefined, "no attrs → no text");

// A live browser held for the errand makes a bare code relevant even when the
// tab URL is not a recognizable code page (the real Yandex push case).
assert(
  decideCloudInject("482911", {
    ...liveRun,
    status: "completed",
    pageUrl: "https://taxi.yandex.ru/",
    browserListed: true,
  }).kind === "code",
  "code injects when a live browser is held, whatever the page url",
);
assert(
  cloudInjectKindFromAttrs({ origin: "human", cloudInject: "code" }) === "code",
  "human stamp is read",
);
assert(
  cloudInjectKindFromAttrs({ origin: "wakeup", cloudInject: "code" }) === null,
  "wakeup does not steal the stamp",
);

const liveCodeSteer = cloudInjectInstruction("code", true);
assert(liveCodeSteer?.includes("ввожу код"), "steer asks for ввожу код");
assert(liveCodeSteer?.includes("browser_task"), "steer calls browser_task");
assert(liveCodeSteer?.includes("password") || liveCodeSteer?.includes("пароль"), "steer forbids password");
const noLiveSteer = cloudInjectInstruction("code", false);
assert(noLiveSteer?.includes("no live"), "no-live steer");
assert(cloudInjectInstruction("wait", false) === null, "wait without live is normal chat");
assert(cloudInjectInstruction("correction", false) === null, "correction without live is normal chat");

const follow = injectFollowTask({
  kind: "code",
  humanText: "482911",
  originalTask: taxiTask,
  code: "482911",
});
assert(follow.startsWith(INJECT_MARK), "follow-up is marked");
assert(follow.includes("482911"), "follow-up carries the code");
assert(follow.includes("не пароль"), "follow-up says not a password");
assert(!follow.includes("нажми «Заказать»"), "code follow-up does not order a taxi");
assert(scaffoldTask(follow) === follow, "inject task is not re-wrapped");

// Queue message: concise follow-up dropped into the live session (POST
// /sessions/{id}/queue), not a fresh errand scaffold.
const codeQueue = injectQueueText({
  kind: "code",
  humanText: "482911",
  code: "482911",
});
assert(codeQueue.includes("482911"), "queue code carries the digits");
assert(!codeQueue.startsWith(INJECT_MARK), "queue text is not scaffold-marked");
assert(
  codeQueue.includes("не пароль") && !/пароль сайта(?!.*не проси)/.test(codeQueue),
  "queue code says not a password",
);
assert(
  injectQueueText({ kind: "code", humanText: "482911", code: "482911", alreadyTyped: true })
    .includes("уже введён"),
  "already-typed queue does not re-enter the code",
);
assert(
  !injectQueueText({ kind: "code", humanText: "482911", code: "482911", alreadyTyped: true })
    .includes("482911"),
  "already-typed queue never repeats the digits",
);
assert(
  injectQueueText({ kind: "wait", humanText: "подожди" }).includes("Оставайся"),
  "wait queue holds the screen",
);
assert(
  injectQueueText({ kind: "correction", humanText: "Ленина 12" }).includes("Ленина 12"),
  "correction queue carries the text",
);
assert(
  injectQueueText({ kind: "code", humanText: "1", code: "1", dryRun: true })
    .includes("ничего не заказывай"),
  "dry-run queue does not order",
);
assert(injectQueueInterrupt("wait"), "wait interrupts the active run");
assert(injectQueueInterrupt("correction"), "correction interrupts the active run");
assert(!injectQueueInterrupt("code"), "code is appended, not interrupted");
assert(
  injectFollowTask({
    kind: "wait",
    humanText: "подожди",
    originalTask: taxiTask,
  }).includes("Не подтверждай заказ"),
  "wait follow-up forbids Заказать",
);
assert(isDryRunErrand("покажи форму, не нажимай Заказать"), "dry-run still detected");
assert(injectCandidate("482911"), "code is a candidate");
assert(injectCandidate("подожди"), "wait is a candidate");
assert(injectCandidate("на Невский 10"), "address is a candidate");
assert(!injectCandidate("привет"), "hello is not a candidate");

const tool = src("agent/tools/browser_task.ts");
assert(tool.includes("maybeInjectChat"), "browser_task intercepts chat inject");
assert(tool.includes("cdpTypeIntoPage"), "codes go into the live tab over CDP");
assert(tool.includes("queueMessage"), "follow-up is queued into the live session");
assert(
  tool.includes("cloudInjectTextFromAttrs") && tool.includes("stampedInjectText"),
  "inject uses the raw stamped human line, not just the model's task arg",
);
assert(
  tool.includes('injectKind === "code" || injectKind === "confirm"') &&
    tool.includes("tenant.browserSessionId || tenant.browserRunId"),
  "a stamped code or confirm turn never spawns a fresh browser errand",
);
assert(tool.includes("NO_LIVE_RUN_TEXT"), "no-live run is spoken");
assert(tool.includes("ввожу код") || tool.includes("injectAckText"), "first bubble ack");
{
  const fn = tool.slice(
    tool.indexOf("async function maybeInjectChat"),
    tool.indexOf("function extraHosts"),
  );
  assert(fn.includes("maybeInjectChat"), "inject helper is bounded");
  assert(
    fn.includes("queueMessage(sessionId"),
    "follow-up queues into the live session, not a fresh run",
  );
  assert(
    !fn.includes("startRun("),
    "inject follow-up does not start a fresh browser run",
  );
  assert(
    !fn.includes("startPage"),
    "inject follow-up does not CDP-navigate away",
  );
  assert(
    fn.includes('decided.kind === "code"'),
    "CDP typing is for a code",
  );
}

const cdp = src("agent/lib/browser-cdp.ts");
assert(cdp.includes("cdpTypeIntoPage"), "cdp can type into the live tab");
assert(cdp.includes("password"), "cdp skips password fields");
assert(cdp.includes("заказать"), "cdp never clicks Заказать");
assert(cdp.includes("one-time-code"), "cdp prefers OTP inputs");
assert(
  !cdp.includes("ranked.length === 1"),
  "F6: no bare only-one-input escape hatch left in the injected JS",
);
assert(cdp.includes("iframe"), "F8: cdp documents that iframes (3DS) are invisible to top-frame evaluate");

// F6/F7 — scoreOtpInput is the extracted, directly-testable source of truth
// for the inline scoring string (kept in sync by a comment + these weights).
eq(scoreOtpInput({ autocomplete: "one-time-code" }, 6), 80, "one-time-code autocomplete scores highest");
eq(scoreOtpInput({ name: "otp-code" }, 6), 50, "an otp/code/pin/код name scores");
eq(scoreOtpInput({ active: true }, 6), 20, "the focused element scores");
eq(scoreOtpInput({ maxLength: 1 }, 6), 10, "a maxLength=1 box scores a little");
eq(scoreOtpInput({}, 6), 0, "a plain input with no signal scores 0");
eq(
  scoreOtpInput({ autocomplete: "one-time-code", name: "code", active: true, maxLength: 1 }, 1),
  80 + 50 + 20 + 10,
  "signals stack",
);
for (const weight of ["80", "50", "20", "10"]) {
  assert(cdp.includes(`n += ${weight}`), `inline score() JS still carries the ${weight} weight`);
}
assert(cdp.includes("partial"), "F7: a maxLength=1 box only gets the first char of a longer value");

const jobs = src("agent/instructions/jobs.ts");
assert(jobs.includes("cloudInjectKindFromAttrs"), "turn.started reads the inject stamp");
assert(jobs.includes("cloudInjectInstruction"), "turn.started steers a live inject");
assert(jobs.includes("getTenant"), "steer checks the live Cloud session");
assert(!jobs.includes('role: "user"'), "inject steer stays system-scoped");
assert(
  jobs.includes("browserNeed"),
  "jobs.ts passes the tenant's browserNeed into cloudSessionLooksLive",
);
assert(
  jobs.includes("{ browserNeed?: string }"),
  "browserNeed is read defensively — the schema field does not exist yet",
);

const imessage = src("agent/channels/imessage.ts");
assert(imessage.includes("cloudInjectAttribute(inbound.text)"), "iMessage stamps inject");
assert(
  imessage.includes("уже прислал одноразовый код"),
  "browser_poll wakeup must use a code already in chat",
);

const telegram = src("agent/channels/telegram.ts");
assert(telegram.includes("cloudInjectAttribute(opts.text"), "telegram stamps inject");

const instructions = src("agent/instructions.md");
assert(instructions.includes("ввожу код"), "root first bubble for a chat code");
assert(instructions.includes("Посторонний чат"), "unrelated chat is not injected");
assert(instructions.includes("не только Яндекс") || instructions.includes("любой сайт"), "not Yandex-only");
assert(instructions.includes("Пароль в чат не проси") || instructions.includes("Do not ask for a password"), "no password ask");

const login = src("convex/lib/browserProfilePolicy.ts");
assert(login.includes("прислать в чат"), "login wait accepts a chat code");
assert(login.includes("Пароль в iMessage не проси"), "login wait never asks for a password");
assert(login.includes("Не вводи логин"), "Cloud still does not invent a login");

const pkg = src("package.json");
assert(pkg.includes("inject:check"), "npm script");

console.log("browser-inject-check ok");
