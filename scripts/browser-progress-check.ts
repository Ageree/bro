import {
  LATE_RESULT_RETRY_DELAYS_MS,
  lateResultLine,
  lateRetryDelayMs,
  nextProgressNote,
  PROGRESS_LONG_MS,
  PROGRESS_SLOW_MS,
  realPageHost,
  shortenTask,
  type ProgressKey,
} from "../convex/lib/browserProgressPolicy.ts";

import { assert, eq, src } from "./lib/check.ts";

const T0 = 1_700_000_000_000;

function note(overrides: Partial<Parameters<typeof nextProgressNote>[0]>) {
  return nextProgressNote({
    status: "running",
    startedAt: T0,
    now: T0,
    task: "закажи такси домой",
    loginWait: false,
    sent: [],
    ...overrides,
  });
}

// --- opened: fires once on the first real page host ---

const opened = note({ pageUrl: "https://taxi.yandex.ru/order" });
assert(opened?.key === "opened", "opened fires on a real host");
assert(opened?.text.startsWith("Открыл taxi.yandex.ru,"), "opened names the host w/o www.");
assert(opened?.text.includes("закажи такси домой"), "opened includes the task");

eq(
  note({ pageUrl: "https://taxi.yandex.ru/order", sent: ["opened"] }),
  undefined,
  "opened never fires twice",
);

// --- opened: not about:blank, not a live-view/preview host ---

eq(note({ pageUrl: "about:blank" }), undefined, "no opened note for about:blank");
eq(
  note({ pageUrl: "https://live.browser-use.com/session/abc" }),
  undefined,
  "no opened note for a live-view host",
);
eq(
  note({ pageUrl: "https://cloud.browser-use.com/x" }),
  undefined,
  "no opened note for any *.browser-use.com host",
);
eq(note({ pageUrl: undefined }), undefined, "no opened note with no page url at all");

// --- login-wait tasks get no progress notes at all (they get the login link
// instead, and every later note text is about the human, not the site) ---

eq(
  note({ pageUrl: "https://taxi.yandex.ru/order", loginWait: true }),
  undefined,
  "login-wait tasks skip the opened note",
);
eq(
  note({ now: T0 + PROGRESS_SLOW_MS, loginWait: true }),
  undefined,
  "login-wait tasks skip the slow note too",
);
eq(
  note({ now: T0 + PROGRESS_LONG_MS, loginWait: true }),
  undefined,
  "login-wait tasks skip the long note too",
);

// --- defense in depth: any bro-internal scaffold marker in `task` (not just
// [bro-login], which the caller is expected to gate via loginWait) means
// this isn't a human errand — never shortened into a note ---

eq(
  note({
    pageUrl: "https://taxi.yandex.ru/order",
    task: "[bro-vault-login]\nПервым действием открой https://taxi.yandex.ru/ и войди.",
  }),
  undefined,
  "a [bro-vault-login]-marked scaffold never produces a note, even with loginWait: false",
);
eq(
  note({ now: T0 + PROGRESS_LONG_MS, task: "[bro-errand] internal scaffold text" }),
  undefined,
  "any [marker]-prefixed task is treated as non-human text, not just bro-login",
);

// --- opened needs evidence: a known start URL (`site`) alone is not proof a
// page actually loaded — only a real pageUrl fires "opened" ---

eq(
  note({ pageUrl: undefined, site: "ozon.ru" }),
  undefined,
  "site alone (no pageUrl) never fires opened — that's not evidence a page loaded",
);
eq(
  note({ pageUrl: "about:blank", site: "ozon.ru" }),
  undefined,
  "site + about:blank pageUrl never fires opened either",
);
const withSite = note({ pageUrl: "https://www.ozon.ru/cart", site: "ozon.ru" });
assert(withSite?.key === "opened", "opened fires once pageUrl is an actual real host");
assert(withSite?.text.startsWith("Открыл ozon.ru,"), "opened names the host from pageUrl");

// --- slow: only after the threshold, only once ---

eq(note({ now: T0 + PROGRESS_SLOW_MS - 1 }), undefined, "no slow note before the threshold");
const slow = note({ now: T0 + PROGRESS_SLOW_MS, sent: ["opened"] });
assert(slow?.key === "slow", "slow fires once the threshold passes");
assert(slow?.text.includes("закажи такси домой"), "slow includes the task");
assert(!slow?.text.includes("http"), "slow note carries no URL");
eq(
  note({ now: T0 + PROGRESS_SLOW_MS, sent: ["opened", "slow"] }),
  undefined,
  "slow never fires twice",
);
const slowWithHost = note({
  now: T0 + PROGRESS_SLOW_MS,
  sent: ["opened"],
  site: "taxi.yandex.ru",
});
assert(slowWithHost?.text.includes("Сайт taxi.yandex.ru небыстрый"), "slow mentions the host when known");

// --- long: only after its own threshold, once, mentions cancelling ---

eq(
  note({ now: T0 + PROGRESS_LONG_MS - 1, sent: ["opened", "slow"] }),
  undefined,
  "no long note before its threshold",
);
const long = note({ now: T0 + PROGRESS_LONG_MS, sent: ["opened", "slow"] });
assert(long?.key === "long", "long fires once its threshold passes");
assert(long?.text.includes("отмени"), "long note tells the human how to cancel");
eq(
  note({ now: T0 + PROGRESS_LONG_MS, sent: ["opened", "slow", "long"] }),
  undefined,
  "long never fires twice",
);

// --- priority: opened wins over slow/long when several would apply at once ---

const late = note({
  now: T0 + PROGRESS_LONG_MS,
  pageUrl: "https://taxi.yandex.ru/order",
  sent: [],
});
eq(late?.key, "opened", "opened still takes priority even past the long threshold");

// --- never fires after a terminal status, however long elapsed ---

for (const status of ["completed", "failed", "cancelled", "stalled"]) {
  eq(
    note({ status, now: T0 + PROGRESS_LONG_MS, pageUrl: "https://taxi.yandex.ru/order" }),
    undefined,
    `no note once status is terminal (${status})`,
  );
}

// --- only one note per call, ever ---

const both = note({ now: T0 + PROGRESS_LONG_MS, pageUrl: "https://taxi.yandex.ru/order", sent: [] });
assert(both !== undefined, "sanity: a note did fire");
const keys: ProgressKey[] = ["opened", "slow", "long"];
assert(keys.includes(both!.key), "the fired note is one of the three known keys");

// --- shortenTask: ~60 chars, cut at a word boundary, never mid-word for long text ---

eq(shortenTask("закажи такси домой"), "закажи такси домой", "short task is unchanged");
const longTask =
  "закажи такси от офиса на войковской до дома на юго-западной с детским креслом и оплатой картой";
const shortened = shortenTask(longTask);
assert(shortened.length <= 62, "shortened task stays near the 60-char budget");
assert(!shortened.endsWith(" "), "shortened task has no trailing space before the ellipsis");
assert(longTask.startsWith(shortened.replace(/…$/, "").trim()), "shortened task is a prefix of the original");

// --- shortenTask: a URL inside the errand itself is collapsed to its host,
// never leaked whole into a note (real Browser Use Cloud incident) ---

const taskWithUrl = "открой https://www.example.com/some/deep/path?x=1 и скажи заголовок";
const shortenedUrl = shortenTask(taskWithUrl);
assert(!shortenedUrl.includes("http"), "shortenTask leaves no http(s) scheme in the text");
assert(shortenedUrl.includes("example.com"), "shortenTask keeps the bare host");
assert(!shortenedUrl.includes("www."), "shortenTask strips www. from the embedded url too");
assert(!shortenedUrl.includes("/some/deep/path"), "shortenTask drops the path/query, not just the scheme");

const openedFromUrlTask = note({
  pageUrl: "https://example.com/",
  task: taskWithUrl,
});
assert(openedFromUrlTask?.key === "opened", "sanity: opened still fires for a task containing a url");
assert(!openedFromUrlTask?.text.includes("http"), "opened note text carries no URL even when the errand has one");

// --- realPageHost: filters blank/localhost/preview, strips www. ---

eq(realPageHost("https://www.ozon.ru/product/1"), "ozon.ru", "www. stripped");
eq(realPageHost("http://localhost:3000/"), undefined, "localhost excluded");
eq(realPageHost("about:blank"), undefined, "about:blank excluded");
eq(realPageHost("https://live.browser-use.com/x"), undefined, "browser-use preview host excluded");
eq(realPageHost("not a url"), undefined, "garbage input excluded");
eq(realPageHost(undefined), undefined, "undefined input excluded");

// --- lateResultLine: the abandoned-run decision (goal.md taxi incident) ---

const doneResult = `СДЕЛАНО: Такси заказано, водитель назначен
ЗАКАЗ: 12345
СУММА: 508 ₽
КОГДА: через ~2 мин
НУЖНО: none`;

const line = lateResultLine("completed", doneResult);
assert(line !== undefined, "finished + labelled + done → a line");
assert(line!.startsWith("Кстати, прошлое поручение всё же завершилось."), "late line opens with the caveat");
assert(line!.includes("508"), "late line carries the done facts (via doneLineHint)");

eq(lateResultLine("cancelled", doneResult), undefined, "cancelled run is never announced late");
eq(lateResultLine("failed", doneResult), undefined, "failed run is never announced late");
eq(lateResultLine("stalled", doneResult), undefined, "our own stalled sentinel is never announced late");
eq(lateResultLine("running", doneResult), undefined, "a still-active run is never announced late");

const needResult = `СДЕЛАНО: нет
НУЖНО: sms_code`;
eq(lateResultLine("completed", needResult), undefined, "a pending need on an abandoned run is moot");

eq(lateResultLine("completed", "the agent rambled with no labelled block"), undefined, "unlabelled result is never announced late");
eq(lateResultLine("completed", ""), undefined, "empty result is never announced late");
eq(lateResultLine("completed", undefined), undefined, "missing result is never announced late");

// --- lateRetryDelayMs: bounded re-check schedule for a still-active old run ---

eq(LATE_RESULT_RETRY_DELAYS_MS.length, 3, "three retries scheduled");
eq(LATE_RESULT_RETRY_DELAYS_MS[0], 20_000, "first retry after 20s");
eq(LATE_RESULT_RETRY_DELAYS_MS[1], 60_000, "second retry after 60s");
eq(LATE_RESULT_RETRY_DELAYS_MS[2], 120_000, "third retry after 120s");
eq(lateRetryDelayMs(0), 20_000, "attempt 0 → delay before attempt 1");
eq(lateRetryDelayMs(1), 60_000, "attempt 1 → delay before attempt 2");
eq(lateRetryDelayMs(2), 120_000, "attempt 2 → delay before attempt 3");
eq(lateRetryDelayMs(3), undefined, "schedule exhausted after 3 retries — give up");
eq(lateRetryDelayMs(99), undefined, "well past the schedule — give up");

// --- wiring: package.json carries the new check ---

const pkg = src("package.json");
assert(pkg.includes("\"progress:check\""), "package.json progress:check");
assert(pkg.includes("browser-progress-check.ts"), "progress:check runs this script");

console.log("browser-progress-check ok");
