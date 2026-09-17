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
  cloudStartInFlight,
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
  PENDING_STEER_TTL_MS,
  START_CLAIM_MS,
  startClaimIsLive,
  carriesSecretValue,
  looksLikeCredentialLine,
} from "../convex/lib/browserInjectPolicy.ts";
import { looksLikeCardNumber, scrubSecrets } from "../convex/lib/secretScrub.ts";
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
// S2 — a steer is ADDITIVE and must not cancel the run it is adding to.
assert(!injectQueueInterrupt("steer"), "steer is appended, never preempting (S2)");
assert(
  injectQueueText({ kind: "steer", humanText: "сделай эконом" }).includes("сделай эконом"),
  "steer queue carries the instruction",
);
assert(
  injectQueueText({ kind: "steer", humanText: "сделай эконом" }).startsWith("Дополнение"),
  "steer queue text says Дополнение, not Инструкция",
);
assert(
  injectQueueText({ kind: "correction", humanText: "Ленина 12" }).startsWith("Инструкция"),
  "correction queue text says Инструкция (#101)",
);
assert(
  injectQueueText({ kind: "correction", humanText: "Ленина 12" }).includes(
    "Пароли, карты и коды из этого текста не вводи",
  ),
  "correction queue carries #101's safety sentence",
);
assert(
  injectQueueText({ kind: "steer", humanText: "сделай эконом" }).includes(
    "Пароли, карты и коды из этого текста не вводи",
  ),
  "steer queue carries the same safety sentence as correction",
);

// Rule 2/9 — confirm decides before steer: a bare «готово»/«подтвердил» is a
// confirmation, never a general steer, even though STATUS_Q also matches
// «готово» and «сделал».
assert(
  decideCloudInject("готово", liveRun).kind === "confirm",
  "bare готово is a confirm, not a steer",
);
assert(!steerCandidate("подтвердил"), "a confirm phrase is never a steer candidate");

// ---------------------------------------------------------------------------
// Cue-less parameter follow-ups — the «на воскресенье» incident.
//
// The human asked to book a restaurant, the Cloud session started, and one
// second later they typed «на воскресенье». The old gate made steering OPT-IN
// on an imperative verb (`STEER_SIGNAL`), and none of these lines has a verb,
// so every one of them was classified as "not for the session" and dropped
// while the session sat there live. A2/F3 documents this bug class for
// corrections; this is one kind further out — the plain parameters of an
// errand: the day, the party size, the time, the area, the table.
// ---------------------------------------------------------------------------
const bookingRun = {
  status: "running",
  sessionId: "sess-book",
  runId: "run-book",
  storedTask: "забронируй столик на ужин",
  startedAt: now - 1_000,
  now,
};
for (const line of [
  "на воскресенье",
  "на двоих",
  "на 4 человек",
  "на 19:00",
  "в центре",
  "у окна",
]) {
  assert(steerCandidate(line), `«${line}» is a steer candidate (no verb needed)`);
  assert(
    decideCloudInject(line, bookingRun).kind === "steer",
    `«${line}» reaches the live booking session`,
  );
  assert(
    cloudInjectAttribute(line).cloudInject === "steer",
    `«${line}» is stamped as a steer, so it gets an ack bubble and an instruction`,
  );
  assert(
    cloudInjectAttribute(line).cloudInjectText === line,
    `«${line}» is stamped with the raw human line`,
  );
  const queued = injectQueueText({ kind: "steer", humanText: line });
  assert(queued.includes(line), `«${line}» survives into the queued message`);
  assert(
    queued.includes("Пароли, карты и коды из этого текста не вводи"),
    `«${line}» keeps the safety tail`,
  );
}
assert(
  cloudInjectKindFromAttrs({ origin: "human", cloudInject: "steer" }) === "steer",
  "a stamped steer is read back off the turn (ack bubble + jobs.ts instruction)",
);
assert(
  cloudInjectKindFromAttrs({ origin: "wakeup", cloudInject: "steer" }) === null,
  "a wakeup never steals the steer stamp",
);
assert(injectAckText("steer") === CHAT_INJECT_ACK, "steer acks with «ввожу»");
assert(CHAT_INJECT_ACK === "ввожу", "steer ack stays in Bro's register");
{
  const live = cloudInjectInstruction("steer", true);
  assert(live?.includes("ввожу"), "a live steer asks for the «ввожу» bubble first");
  assert(live?.includes("browser_task"), "a live steer calls browser_task with the exact line");
  assert(
    live?.includes("Do not start a new search"),
    "a live steer never opens a second errand",
  );
  assert(
    cloudInjectInstruction("steer", false) === null,
    "a steer with no live session is ordinary chat, not an instruction",
  );
}

// No regressions: the opt-out gate still names its exclusions.
assert(!steerCandidate("спасибо"), "thanks is still not a steer");
assert(!steerCandidate("как дела"), "smalltalk without a «?» is still not a steer");
assert(!steerCandidate("ну что там"), "a status question without a «?» is not a steer");
assert(!steerCandidate("а это точно безопасно?"), "a question to Bro is still not a steer");
assert(!steerCandidate("Hunter2024"), "a password dump is still never a steer");
assert(!steerCandidate("🙂"), "an emoji reaction is still not a steer");
assert(!steerCandidate("bro7788"), "a lone letter+digit token is still not a steer");
assert(!steerCandidate("купи скотч на ozon"), "a fresh unrelated errand is still not a steer");
assert(!steerCandidate("x".repeat(401)), "the 400-char cap still holds");
for (const line of ["спасибо", "как дела", "купи скотч на ozon", "Hunter2024", "🙂"]) {
  assert(
    decideCloudInject(line, bookingRun).kind === null,
    `«${line}» still never docks into the live session`,
  );
  assert(
    Object.keys(cloudInjectAttribute(line)).length === 0,
    `«${line}» is still not stamped`,
  );
}
// The dead regex is gone, not just unused (the name survives only in the
// comment that explains what it used to cost).
assert(
  !src("convex/lib/browserInjectPolicy.ts").includes("const STEER_SIGNAL"),
  "the opt-in STEER_SIGNAL regex is deleted, not left dead in the file",
);

// ---------------------------------------------------------------------------
// S1 — a credential typed in chat must never reach the vendor.
//
// Reproduced on the real modules: «пароль от вб: зайка2024» came back as
// `kind=steer` and was POSTed verbatim to Browser Use Cloud. The queued
// message's «Пароли, карты и коды из этого текста не вводи» tail is a prompt,
// not a guard — by the time the vendor's agent reads it the value has already
// left the tenancy. `looksLikePasswordDump` could not catch any of these: it
// bails on the first space, so it only ever saw a lone token.
//
// The values below are throwaway fixtures, not anybody's password.
// ---------------------------------------------------------------------------
const CREDENTIAL_LINES = [
  "пароль от вб: зайка2024",
  "мой пароль: qwerty123",
  "логин vasya пароль Hunter2024",
  "пароль от озона Hunter2024",
  "пароль-hunter2ochen",
  "пин 1234",
  "cvv 123",
  "seed фраза: table horse battery staple",
  "карта заканчивается на 4242",
  "мой инн 771234567890",
];
for (const line of CREDENTIAL_LINES) {
  assert(carriesSecretValue(line), `«${line}» carries a secret value (S1)`);
  assert(!steerCandidate(line), `«${line}» never steers (S1)`);
  assert(!looksLikeCorrectionText(line), `«${line}» never rides the correction path (S1)`);
  assert(
    decideCloudInject(line, bookingRun).kind === null,
    `«${line}» is never any kind of inject (S1)`,
  );
  assert(
    Object.keys(cloudInjectAttribute(line)).length === 0,
    `«${line}» is not stamped, so no turn can queue it (S1)`,
  );
}
// «мой инн 771234567890» and «пароль от вб: зайка2024» both match STREET_LINE
// («инн 771…» = "word + number"), which is why the veto had to cover the
// correction path and not just `steerCandidate`.
assert(
  !looksLikeCorrectionText("мой инн 771234567890"),
  "an ИНН is not an address correction (S1)",
);
// The stamp is the one place the raw line is copied onto the turn, so it is
// vetoed there too: «готово, пароль …» is head-anchored «готово» and would
// otherwise stamp as a confirm and be replayed verbatim by a later turn.
assert(
  Object.keys(cloudInjectAttribute("готово, пароль qwerty123")).length === 0,
  "a confirm-shaped line carrying a password is never stamped (S1)",
);
assert(cloudInjectAttribute("готово").cloudInject === "confirm", "…a plain confirm still is");

// The veto needs a VALUE. A label on its own is ordinary errand text and must
// still reach the open session — «забыл пароль, восстанови» asks the agent to
// run the recovery flow, «войди в мой аккаунт» asks it to sign in. Neither
// hands over anything, so vetoing them would cost the errand for nothing.
for (const line of [
  "забыл пароль, восстанови",
  "войди в мой аккаунт",
  "пароль не подошел",
  "пароль от ozon забыл",
  "логин через госуслуги",
]) {
  assert(!looksLikeCredentialLine(line), `«${line}» names a label but hands over no value`);
}
assert(steerCandidate("забыл пароль, восстанови"), "«забыл пароль, восстанови» still steers");
assert(steerCandidate("войди в мой аккаунт"), "«войди в мой аккаунт» still steers");
// Ordinary errand words that merely CONTAIN a credential label as a substring
// («пассажир», «секретарь», «пингвин») must not trip the veto.
assert(!carriesSecretValue("на 3 пассажира"), "«пассажир» is not «пасс»");
assert(!carriesSecretValue("запишись к секретарю на 10:00"), "«секретарь» is not «секрет»");
// An OTP is the whole reason injection exists and is never vetoed.
assert(!carriesSecretValue("код 482913"), "a one-time code is not a credential");
assert(decideCloudInject("код 482913", { ...liveRun, need: "sms_code" }).kind === "code", "the OTP path is untouched by the veto");

// Last-resort net: even a line that slips the veto cannot carry a raw secret
// out, because the queued/scaffolded text is scrubbed in-process.
{
  const queued = injectQueueText({ kind: "steer", humanText: "пароль от вб: зайка2024" });
  assert(!queued.includes("зайка2024"), "injectQueueText scrubs the raw secret (S1)");
  assert(queued.includes("[password]"), "the scrubbed value is marked, not silently dropped");
  const followed = injectFollowTask({
    kind: "correction",
    humanText: "мой пароль: qwerty123",
    originalTask: taxiTask,
  });
  assert(!followed.includes("qwerty123"), "injectFollowTask scrubs the raw secret (S1)");
}
// …and the scrub itself now sees the shape people actually type. The label no
// longer has to be followed IMMEDIATELY by the separator.
assert(
  scrubSecrets("пароль от озона: Hunter2024") === "пароль от озона: [password]",
  "a label with intervening words before the «:» is redacted (S1)",
);
assert(
  scrubSecrets("логин vasya пароль Hunter2024").endsWith("[password]"),
  "a label with no separator at all but a secret-shaped value is redacted (S1)",
);
assert(
  scrubSecrets("пароль не подошел") === "пароль не подошел",
  "prose with no value is still left alone",
);
assert(
  scrubSecrets("пароль не подошел, зайди на сайт: там кнопка") ===
    "пароль не подошел, зайди на сайт: там кнопка",
  "the gap stops at a comma, so a later clause's «:» is never reached",
);
// A 13-19 digit run is only a card when it checks out. A tracking number has
// the same shape, and scrubbing it would delete the errand's own subject —
// see the comment in agent/lib/browseruse.ts about «проверь заказ 46000…».
assert(looksLikeCardNumber("4111 1111 1111 1111"), "a Luhn-valid PAN is a card");
assert(looksLikeCardNumber("2200-1234-5678-9012"), "four-groups-of-four is a card however it checks out");
assert(!looksLikeCardNumber("46000123456789"), "a 14-digit tracking number is not a card");
assert(
  scrubSecrets("проверь заказ 46000123456789") === "проверь заказ 46000123456789",
  "a tracking number survives the scrub (S1)",
);
assert(
  scrubSecrets("оплатил картой 4111 1111 1111 1111") === "оплатил картой [card]",
  "a real card is still redacted",
);

// ---------------------------------------------------------------------------
// S3 — the opt-out gate captures what parameterises the OPEN errand, not all
// chat. Before this, everything outside a closed smalltalk list went to the
// vendor; the lines below were all reproduced as `kind=steer`.
// ---------------------------------------------------------------------------
for (const line of [
  "ты вообще тупой",
  "мама звонила, просила перезвонить",
  "завтра встреча в 10 с юристом",
  "кстати я вчера был в кино",
  "а ещё почини кран",
  "интересно сколько это стоит",
  "как думаешь стоит брать",
  "ты вообще там что делаешь",
]) {
  assert(!steerCandidate(line), `«${line}» is not a parameter of the errand (S3)`);
  assert(
    decideCloudInject(line, bookingRun).kind === null,
    `«${line}» never docks into the live session (S3)`,
  );
  assert(
    Object.keys(cloudInjectAttribute(line)).length === 0,
    `«${line}» is not stamped (S3)`,
  );
}
// …and the whole reason opt-out exists still works, verbless and all.
for (const line of [
  "на воскресенье",
  "на двоих",
  "на 4 человек",
  "на 19:00",
  "в центре",
  "у окна",
  "и чтобы веранда была",
]) {
  assert(steerCandidate(line), `«${line}» still parameterises the errand (S3)`);
  assert(
    decideCloudInject(line, bookingRun).kind === "steer",
    `«${line}» still reaches the live booking session (S3)`,
  );
}
// A lead-in in front of a parameter does not make it chat.
assert(steerCandidate("лучше на воскресенье"), "«лучше на воскресенье» is still a parameter");
assert(steerCandidate("а в центре"), "«а в центре» is still a parameter");

// ---------------------------------------------------------------------------
// S11 — the greeting opener is STRIPPED and the remainder judged, instead of
// counting words. The old `<= 4` gate was wrong in both directions.
// ---------------------------------------------------------------------------
assert(
  steerCandidate("что там 4 человека"),
  "a party size behind a greeting is not dropped (S11, 4 words)",
);
assert(
  decideCloudInject("что там 4 человека", bookingRun).kind !== null,
  "…and it actually reaches the live session",
);
for (const line of [
  "ну что там вообще происходит у тебя",
  "что нового на работе у тебя сегодня",
]) {
  assert(!steerCandidate(line), `«${line}» is still just chat (S11, 7 words)`);
  assert(
    decideCloudInject(line, bookingRun).kind === null,
    `«${line}» never docks into the live session (S11)`,
  );
}
assert(!steerCandidate("ну что там"), "an opener with nothing after it is chatter");
assert(!steerCandidate("как дела"), "…same for «как дела»");
assert(
  !src("convex/lib/browserInjectPolicy.ts").includes("split(/\\s+/).length <= 4 && CHATTER_Q"),
  "the word-count proxy in front of CHATTER_Q is gone, not left dead (S11)",
);

// ---------------------------------------------------------------------------
// The start race: a follow-up that lands BEFORE the first errand persisted its
// ids must not open a second run, must not be charged a second time, and must
// not be dropped. `startClaimIsLive` is the single source of truth both the
// Convex claim mutation and the agent read.
// ---------------------------------------------------------------------------
assert(startClaimIsLive(now - 1_000, now), "a claim taken a second ago is live");
assert(!startClaimIsLive(0, now), "0 is no claim at all");
assert(!startClaimIsLive(undefined, now), "an absent claim is no claim");
assert(
  !startClaimIsLive(now - START_CLAIM_MS - 1, now),
  "a stale claim is taken over — a dead turn cannot wedge the tenant",
);
assert(
  cloudStartInFlight({ startingAt: now - 1_000, now }),
  "cloudStartInFlight reads the same claim",
);
assert(
  decideCloudInject("на воскресенье", { startingAt: now - 1_000, now }).kind === "steer",
  "a follow-up steers on a bare start claim — before any session id exists",
);
{
  // One tenant row, two turns, the exact timeline of the report.
  const row: {
    browserStartingAt?: number;
    browserStartingTask?: string;
    browserPendingSteer?: string;
    browserSessionId?: string;
  } = {};
  let runs = 0;
  let charges = 0;
  const claim = (task: string, at: number) => {
    if (startClaimIsLive(row.browserStartingAt, at, START_CLAIM_MS)) return false;
    row.browserStartingAt = at;
    row.browserStartingTask = task;
    return true;
  };

  // t0 — «хочу забронировать ресторан». The claim is taken BEFORE startRun,
  // so the row already says "starting" while the Cloud call is in flight.
  assert(claim("хочу забронировать ресторан", now), "the errand claims the start");
  charges += 1;
  runs += 1;

  // t0+1s — «на воскресенье». No runId, no sessionId on the row yet: this is
  // exactly the window that used to read as "no session → start".
  const at = now + 1_000;
  assert(
    decideCloudInject("на воскресенье", { startingAt: row.browserStartingAt, now: at })
      .kind === "steer",
    "the follow-up is recognised as a steer during the start",
  );
  assert(!claim("на воскресенье", at), "the follow-up never wins a second start claim");
  row.browserPendingSteer = "на воскресенье"; // holdBrowserSteer
  assert(runs === 1, "no second cloud run");
  assert(charges === 1, "no second charged job");

  // The start finally returns and persists its session; the held line drains.
  row.browserSessionId = "sess-book";
  row.browserStartingAt = 0;
  const drained = row.browserPendingSteer ?? "";
  row.browserPendingSteer = "";
  assert(drained === "на воскресенье", "the held detail is still there, not dropped");
  assert(
    injectQueueText({ kind: "steer", humanText: drained }).includes("на воскресенье"),
    "the held detail is queued into the session that now exists",
  );
  assert(row.browserPendingSteer === "", "draining clears the hold — queued once, not twice");

  // A genuinely new errand much later is not blocked by the spent claim.
  assert(
    claim("вызови такси", now + START_CLAIM_MS + 5_000),
    "a later errand still starts normally",
  );
}

// Rule 1 (#101) — codeRelevantToSession no longer has a browserListed
// short-circuit: a listed browser alone is not OTP evidence, so a bare
// keyword-less number stays a non-code even when the browser is listed.
assert(
  decideCloudInject("1500", {
    ...liveRun,
    pageUrl: undefined,
    result: undefined,
    browserListed: true,
  }).kind === null,
  "bare 1500 is still not a code merely because the browser is listed (#101)",
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
// A bare code IS relevant once there is real evidence: need=sms_code (any
// page) or a passport/id code-page pageUrl.
assert(
  decideCloudInject("1500", {
    ...liveRun,
    pageUrl: undefined,
    result: undefined,
    need: "sms_code",
  }).kind === "code",
  "bare 1500 is a code once need=sms_code is recorded",
);
assert(
  decideCloudInject("1500", {
    ...liveRun,
    pageUrl: "https://passport.yandex.ru/pwl-yandex/auth/code",
    result: undefined,
  }).kind === "code",
  "bare 1500 is a code on a passport code-challenge pageUrl",
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
  /injectKind &&\s*injectKind !== "steer" &&\s*\(tenant\.browserSessionId/.test(tool),
  "a stamped HARD inject turn (code/wait/correction/confirm) never spawns a fresh browser errand",
);
// …and `steer` is deliberately excluded from that guard: steering is opt-out
// now, so almost every line is stamped `steer` and blocking on it would strand
// an ordinary new errand behind a long-dead session id.
assert(
  tool.includes('injectKind !== "steer"'),
  "a steer that found no live session falls through to a normal start",
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

// Liveness is decided BEFORE the text classifier gets a veto (b): the pure
// text predicate `injectCandidate` must not stand in front of maybeInjectChat
// any more — that ordering is what dropped «на воскресенье» before anyone
// looked at whether a Cloud session was live.
{
  const fn = tool.slice(
    tool.indexOf("async function maybeInjectChat"),
    tool.indexOf("function extraHosts"),
  );
  assert(!fn.includes("injectCandidate("), "the text pre-filter no longer vetoes before liveness");
  assert(
    fn.indexOf("cloudStartInFlight(") < fn.indexOf("decideCloudInject("),
    "liveness / start-in-flight is established before the inject decision",
  );
  assert(
    fn.includes("holdBrowserSteer(phone, incoming)"),
    "a follow-up that lands mid-start is held, never dropped",
  );
  assert(
    fn.includes("drainHeldSteer(phone, sessionId"),
    "held follow-ups are queued into the session once it exists",
  );
}
assert(
  !/^import[\s\S]*?injectCandidate/m.test(tool.slice(0, tool.indexOf("async function persist"))),
  "browser_task no longer imports the text pre-filter",
);

// The start race (d): the claim is taken before anything is charged or
// created, and a refused claim holds the line instead of opening a twin run.
assert(tool.includes("claimBrowserStart(phone, task, Date.now(), START_CLAIM_MS)"), "the start is claimed");
assert(
  tool.indexOf("claimBrowserStart(") < tool.indexOf("countBrowserJobStart("),
  "the claim is taken before the billing gate — a held follow-up is never charged",
);
assert(
  tool.indexOf("claimBrowserStart(") < tool.indexOf("startRun(task, undefined"),
  "the claim is taken before startRun round-trips",
);
assert(
  tool.includes("if (!claim.claimed)") &&
    tool.includes("holdBrowserSteer(phone, injectIncoming)"),
  "a refused claim parks the line instead of starting a second run",
);
// Pinned on the ARITY, not just the name. The release used to be
// `releaseBrowserStart(phone)`, which cleared whoever's claim happened to be
// on the row — that is how a `reset` turn stole a sibling's in-flight claim
// and started a second paid run. It is compare-and-clear now, so the stamp is
// the whole point of the call. Matching the bare name would also match the
// historical reference inside the WHY-comment that documents the old form,
// i.e. the assertion would pass with every real call site deleted.
assert(
  tool.includes("releaseBrowserStart(phone, startClaimAt)"),
  "a claim that will never produce a run is released by its owner, not left to expire",
);
assert(
  !/releaseBrowserStart\(phone\)\s*[;.)]/.test(tool),
  "and no ownerless release survives anywhere in the tool",
);
assert(
  tool.includes("tenant = (await getTenant(phone).catch(() => null)) ?? tenant;"),
  "the tenant row is re-read immediately before the start decision, not trusted from the turn's opening snapshot",
);
assert(
  tool.includes("drainHeldSteer(phone, opened.sessionId"),
  "a fresh start drains whatever was held while it was starting",
);
assert(
  /drainHeldSteer\(phone, opened\.sessionId, \{[^}]*interrupt: false/s.test(tool),
  "the drained detail is appended, never interrupting the run it belongs to",
);

// (f) The poll branch no longer throws the human's line away.
{
  const poll = tool.slice(
    tool.indexOf('if (action === "poll"'),
    tool.indexOf('if (action === "continue"'),
  );
  assert(
    poll.includes("queueSteer(tenant.browserSessionId, injectIncoming"),
    "a poll queues the human's own line into the live session",
  );
  assert(
    poll.includes("steerCandidate(injectIncoming)"),
    "a poll only queues what is actually meant for the errand",
  );
  assert(
    poll.includes('injected: "steer"'),
    "the poll payload says so when the line really landed",
  );
}
assert(
  tool.includes("Unless this payload has `injected`, nothing from their last line was added"),
  "the still-running hint never lets the model claim a detail was taken",
);

// The Convex side of the race: one claim per transaction, a claim that a new
// run clears, and a hold that expires instead of leaking into a later errand.
{
  const tenants = src("convex/tenants.ts");
  assert(
    tenants.includes("startClaimIsLive(at, args.now, args.staleMs)"),
    "the claim mutation and the agent read the same start-claim policy",
  );
  assert(
    tenants.includes("browserStartingAt: args.now"),
    "claiming stamps the start on the tenant row inside the transaction",
  );
  assert(
    /if \(isNewRun && args\.browserStartingAt === undefined\)/.test(tenants),
    "only a NEW run id clears the claim — a poll must not cancel a start in flight",
  );
  assert(
    tenants.includes('args.now - at > args.ttlMs ? "" : held'),
    "a held follow-up older than the TTL is dropped, never queued into a later errand",
  );
  assert(
    tenants.includes('browserPendingSteer: ""'),
    "draining clears the hold in the same transaction (queued once)",
  );
  assert(
    tenants.includes("if (held.includes(text)) return null"),
    "the same line held twice stays one line",
  );
}
assert(PENDING_STEER_TTL_MS <= START_CLAIM_MS * 10, "a held line expires on a human timescale");

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
// The rule, not the sentence: small talk and a new unrelated errand must not
// be typed into the tab an errand is waiting in.
assert(
  /Посторонний чат/.test(instructions) ||
    /несвязанное поручение туда не клади/.test(instructions),
  "unrelated chat is not injected",
);
assert(instructions.includes("не только Яндекс") || instructions.includes("любой сайт"), "not Yandex-only");
assert(
  /не проси пароль|Пароль в чат не проси|Do not ask for a password/.test(instructions),
  "no password ask",
);

const login = src("convex/lib/browserProfilePolicy.ts");
assert(login.includes("прислать в чат"), "login wait accepts a chat code");
assert(login.includes("Пароль в iMessage не проси"), "login wait never asks for a password");
assert(login.includes("Не вводи логин"), "Cloud still does not invent a login");

const pkg = src("package.json");
assert(pkg.includes("inject:check"), "npm script");

console.log("browser-inject-check ok");
