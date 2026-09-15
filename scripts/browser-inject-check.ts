import { assert, src } from "./lib/check.ts";
import { isDryRunErrand, scaffoldTask } from "../agent/lib/browseruse.ts";
import {
  CHAT_CODE_ACK,
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
  isWaitInject,
  looksLikeCorrectionText,
  looksLikePasswordDump,
  looksLikeSteer,
  steerCandidate,
  pageWaitsForCode,
  resultWaitsForCode,
} from "../convex/lib/browserInjectPolicy.ts";

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

assert(injectAckText("code") === CHAT_CODE_ACK, "code ack");
assert(injectAckText("wait") === CHAT_WAIT_ACK, "wait ack");
assert(injectAckText("correction") === CHAT_INJECT_ACK, "correction ack");
assert(CHAT_CODE_ACK === "ввожу код", "first bubble for a chat code");
assert(NO_LIVE_RUN_TEXT.includes("нет открытой сессии"), "no-live copy");
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

// The real Yandex push case injects because the passport page is a code page.
assert(
  decideCloudInject("482911", {
    ...liveRun,
    status: "completed",
    pageUrl: "https://passport.yandex.ru/auth/challenge",
    browserListed: true,
  }).kind === "code",
  "code injects on the passport challenge page",
);
// A bare number on a non-code page is NOT force-typed as a login OTP, even with
// a live browser listed (a listed browser alone is not OTP evidence).
assert(
  decideCloudInject("код от домофона 4521", {
    ...liveRun,
    pageUrl: "https://taxi.yandex.ru/",
    browserListed: true,
  }).kind !== "code",
  "a random number on a non-code page is not a login OTP",
);

// The stored task is persisted RAW (unmarked) — steer and correction must fire
// for real errands, not only marked login-wait tasks.
const rawTaxi = {
  status: "running",
  sessionId: "s",
  runId: "r",
  storedTask: "вызови такси домой",
  startedAt: now - 60_000,
  now,
};
assert(
  decideCloudInject("сделай эконом", rawTaxi).kind === "steer",
  "steer fires for a raw (unmarked) errand task",
);
assert(
  decideCloudInject("не туда, вези на Невский 10", rawTaxi).kind === "correction",
  "correction fires for a raw (unmarked) errand task",
);

// Passwords without a special char must never be injected (security).
assert(looksLikePasswordDump("Hunter2024"), "no-special-char password is a dump");
assert(looksLikePasswordDump("Password1"), "Password1 is a dump");
assert(!steerCandidate("Hunter2024"), "a password is never a steer candidate");
assert(
  decideCloudInject("Hunter2024", { ...rawTaxi, storedTask: loginTask }).kind === null,
  "a password is never injected, even during login-wait",
);

// Steer is opt-in: chatter, emoji, skepticism and questions never steer.
assert(!steerCandidate("👌"), "an emoji is not a steer");
assert(!steerCandidate("🤔🎉"), "emoji are not a steer");
assert(!steerCandidate("а это точно безопасно?"), "a question is not a steer");
assert(!steerCandidate("ты уверен?"), "skeptical question is not a steer");
assert(!steerCandidate("норм"), "a bare ack without a cue is not a steer");
assert(steerCandidate("выбери что подешевле"), "an instruction with a cue is a steer");
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
  tool.includes("injectKind && (tenant.browserSessionId"),
  "a stamped inject turn never spawns a fresh browser errand",
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

const jobs = src("agent/instructions/jobs.ts");
assert(jobs.includes("cloudInjectKindFromAttrs"), "turn.started reads the inject stamp");
assert(jobs.includes("cloudInjectInstruction"), "turn.started steers a live inject");
assert(jobs.includes("getTenant"), "steer checks the live Cloud session");
assert(!jobs.includes('role: "user"'), "inject steer stays system-scoped");

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
