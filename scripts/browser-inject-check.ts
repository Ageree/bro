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
  cloudSessionLooksLive,
  decideCloudInject,
  extractChatCode,
  injectAckText,
  injectCandidate,
  injectFollowTask,
  isChatCodeMessage,
  isWaitInject,
  looksLikeCorrectionText,
  looksLikePasswordDump,
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
assert(tool.includes("injectFollowTask"), "Cloud follow-up on the same session");
assert(tool.includes("NO_LIVE_RUN_TEXT"), "no-live run is spoken");
assert(tool.includes("ввожу код") || tool.includes("injectAckText"), "first bubble ack");
{
  const fn = tool.slice(
    tool.indexOf("async function maybeInjectChat"),
    tool.indexOf("function extraHosts"),
  );
  assert(fn.includes("maybeInjectChat"), "inject helper is bounded");
  assert(
    fn.includes("startRun(followTask, sessionId"),
    "follow-up reuses the live session",
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
