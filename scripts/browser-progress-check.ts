import {
  humanSitePhrase,
  LATE_RESULT_RETRY_DELAYS_MS,
  lateResultLine,
  lateRetryDelayMs,
  nextProgressNote,
  pickProgressVariant,
  progressNoteVariants,
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

const opened = note({ pageUrl: "https://taxi.yandex.ru/order", seed: "run-1" });
assert(opened?.key === "opened", "opened fires on a real host");
// A person says where he is in human words, never reads a domain out loud…
assert(opened!.text.includes("в яндекс такси"), "opened names the place the way a person would");
assert(!/taxi\.yandex\.ru|\.ru\b/.test(opened!.text), "opened never prints a hostname");
// …and never echoes back the errand the human just typed.
assert(!opened!.text.includes("закажи такси домой"), "opened never repeats the errand text");

eq(
  note({ pageUrl: "https://taxi.yandex.ru/order", sent: ["opened"] }),
  undefined,
  "opened never fires twice",
);

// A host we cannot name in human words: the note still fires, and simply
// says nothing about where he is rather than printing the domain.
const openedUnknown = note({ pageUrl: "https://shop-xyz.example/cart", seed: "run-1" });
assert(openedUnknown?.key === "opened", "opened still fires for an unmappable host");
assert(
  !openedUnknown!.text.includes("shop-xyz") && !openedUnknown!.text.includes("example"),
  "an unmappable host is dropped, never printed raw",
);
assert(openedUnknown!.text.trim().length > 0, "the no-site variant is still a real sentence");

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
const withSite = note({ pageUrl: "https://www.ozon.ru/cart", site: "ozon.ru", seed: "run-1" });
assert(withSite?.key === "opened", "opened fires once pageUrl is an actual real host");
assert(withSite!.text.includes("в озоне"), "opened names the place from pageUrl, in human words");
assert(!withSite!.text.includes("ozon.ru"), "opened does not print the domain");

// --- the thresholds themselves: a sign of life inside a minute and a half ---
//
// The complaint these serve is "слегка много времени проходит": a run that
// never lands a page host (no "opened") used to leave four silent minutes
// after «делаю». Both notes must stay early, ordered, and distinct.

assert(PROGRESS_SLOW_MS <= 90_000, "the first «ещё вожусь» lands within ~90s, not minutes later");
assert(PROGRESS_SLOW_MS >= 60_000, "…but not so early it fires while the browser is still booting");
assert(PROGRESS_LONG_MS > PROGRESS_SLOW_MS, "long comes strictly after slow");
assert(PROGRESS_LONG_MS <= 5 * 60_000, "the «скажи отмени» note lands a few minutes in");
eq(
  note({ now: T0 + 60_000, sent: ["opened"] }),
  undefined,
  "nothing extra fires in the first minute — «делаю» has only just been said",
);
assert(
  note({ now: T0 + 90_000, sent: ["opened"] })?.key === "slow",
  "by 90s a silent run has said something",
);

// --- slow: only after the threshold, only once ---

eq(note({ now: T0 + PROGRESS_SLOW_MS - 1 }), undefined, "no slow note before the threshold");
const slow = note({ now: T0 + PROGRESS_SLOW_MS, sent: ["opened"], seed: "run-1" });
assert(slow?.key === "slow", "slow fires once the threshold passes");
assert(!slow!.text.includes("закажи такси домой"), "slow never repeats the errand text");
assert(/напиш/i.test(slow!.text), "slow still promises to write when it is done");
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
  seed: "run-1",
});
assert(slowWithHost!.text.includes("в яндекс такси"), "slow names the place when it is known");
assert(!slowWithHost!.text.includes("taxi.yandex.ru"), "slow does not print the domain either");

// --- long: only after its own threshold, once, mentions cancelling ---

eq(
  note({ now: T0 + PROGRESS_LONG_MS - 1, sent: ["opened", "slow"] }),
  undefined,
  "no long note before its threshold",
);
const long = note({ now: T0 + PROGRESS_LONG_MS, sent: ["opened", "slow"], seed: "run-1" });
assert(long?.key === "long", "long fires once its threshold passes");
assert(long?.text.includes("отмени"), "long note tells the human how to cancel");
assert(!long!.text.includes("закажи такси домой"), "long never repeats the errand text");
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
assert(
  !openedFromUrlTask!.text.includes("example.com"),
  "a note never carries a host from the errand text either",
);

// --- human site names: the map, the subdomain fallback, and the "say nothing
// rather than a domain" rule ---

eq(humanSitePhrase("taxi.yandex.ru"), "в яндекс такси", "taxi is named the way people name it");
eq(humanSitePhrase("www.ozon.ru"), "в озоне", "www. is ignored");
eq(humanSitePhrase("m.ozon.ru"), "в озоне", "an unknown subdomain falls back to its parent");
eq(humanSitePhrase("WILDBERRIES.RU"), "на вб", "case is ignored");
eq(humanSitePhrase("market.yandex.ru"), "на яндекс маркете", "market is not plain yandex");
eq(humanSitePhrase("yandex.ru"), "в яндексе", "plain yandex still has a name");
eq(humanSitePhrase("shop-xyz.example"), undefined, "an unmappable host has no human name");
eq(humanSitePhrase(""), undefined, "empty host");
eq(humanSitePhrase(undefined), undefined, "no host");
for (const host of ["taxi.yandex.ru", "ozon.ru", "wildberries.ru", "avito.ru"]) {
  const phrase = humanSitePhrase(host)!;
  assert(/^(?:в|во|на) /.test(phrase), `site name is ready to use in a sentence: ${phrase}`);
  assert(!/\.[a-z]{2,}/i.test(phrase), `site name is not a domain: ${phrase}`);
}

// --- the variant palettes: short, distinct, never templated ---

const SEEDS = ["run-1", "run-2", "run-3", "run-4", "run-5", "run-6", "run-7", "run-8"];

for (const key of ["opened", "slow", "long"] as ProgressKey[]) {
  for (const where of [undefined, "в озоне"]) {
    const variants = progressNoteVariants(key, where);
    assert(variants.length >= 3 && variants.length <= 5, `${key}: 3–5 variants`);
    assert(new Set(variants).size === variants.length, `${key}: variants are actually different`);
    for (const text of variants) {
      assert(text.trim().length > 0, `${key}: variant is non-empty`);
      assert(text.length <= 140, `${key}: variant stays short — ${text}`);
      assert(!text.includes("http"), `${key}: variant carries no URL`);
      assert(!/\$\{|undefined/.test(text), `${key}: variant is fully rendered — ${text}`);
      assert(!/\.[a-z]{2,}\b/i.test(text.replace(/\.$/, "")), `${key}: no domain in — ${text}`);
    }
  }
  // same seed → same wording (a retried poll never rephrases itself)
  eq(
    pickProgressVariant(key, "в озоне", "run-1"),
    pickProgressVariant(key, "в озоне", "run-1"),
    `${key}: one run keeps one wording`,
  );
  const picked = new Set(SEEDS.map((seed) => pickProgressVariant(key, "в озоне", seed)));
  assert(picked.size > 1, `${key}: different runs read differently`);
  for (const text of picked) {
    assert(
      progressNoteVariants(key, "в озоне").includes(text),
      `${key}: the pick always comes from the palette`,
    );
  }
}

// every "long" wording keeps the stop word, every "slow" one keeps the promise
for (const where of [undefined, "в озоне"]) {
  for (const text of progressNoteVariants("long", where)) {
    assert(text.includes("«отмени»"), `long variant offers the stop word: ${text}`);
  }
  for (const text of progressNoteVariants("slow", where)) {
    assert(/напиш/i.test(text), `slow variant promises to write back: ${text}`);
  }
}

// the note itself is seeded per run: stable for one run, varied across runs
const seededA = note({ pageUrl: "https://www.ozon.ru/cart", seed: "run-a" });
const seededAgain = note({ pageUrl: "https://www.ozon.ru/cart", seed: "run-a" });
eq(seededA?.text, seededAgain?.text, "same run → same note wording on every poll");
const seededTexts = new Set(
  SEEDS.map((seed) => note({ pageUrl: "https://www.ozon.ru/cart", seed })?.text),
);
assert(seededTexts.size > 1, "different runs get different note wording");
// no seed at all → still deterministic (startedAt), never random
eq(
  note({ pageUrl: "https://www.ozon.ru/cart" })?.text,
  note({ pageUrl: "https://www.ozon.ru/cart" })?.text,
  "a caller without a seed still gets a stable line, not a random one",
);

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
