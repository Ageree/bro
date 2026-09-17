import {
  alreadySpoken,
  CALENDAR_LEAD_MAX_MS,
  ERRAND_STALL_MS,
  humanActive,
  inQuietHours,
  instinctAllowed,
  INSTINCT_HUMAN_ACTIVE_MS,
  INSTINCT_MAX_PER_DAY,
  INSTINCT_MIN_GAP_MS,
  INSTINCT_QUIET_HOURS,
  INSTINCT_SCAN_MINUTES,
  INSTINCT_SPOKEN_TTL_MS,
  instinctWakePrompt,
  pruneSpoken,
  rankCandidates,
  selectCandidates,
  shouldSpeak,
  type InstinctCandidate,
} from "../convex/lib/instinctPolicy.ts";

import { assert, eq } from "./lib/check.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------- quiet hours

// Wrapping window: quiet from 23:00 through 07:59 local.
for (const hour of [23, 0, 3, 7]) {
  assert(inQuietHours(hour), `${hour}h is quiet`);
}
for (const hour of [8, 12, 19, 22]) {
  assert(!inQuietHours(hour), `${hour}h is not quiet`);
}
// A non-wrapping window still works (nothing ships with one, but the helper
// must not silently invert it).
assert(inQuietHours(14, { fromHour: 13, toHour: 15 }), "plain window inside");
assert(!inQuietHours(15, { fromHour: 13, toHour: 15 }), "plain window end is open");
eq(INSTINCT_QUIET_HOURS.fromHour, 23, "quiet from");
eq(INSTINCT_QUIET_HOURS.toHour, 8, "quiet to");

// The whole point of holding a tz: one UTC instant, two people, two answers.
// 2026-09-17T22:00Z is 01:00 in Moscow (UTC+3) and 08:00 in Vladivostok (+10).
const nightInMoscow = Date.parse("2026-09-17T22:00:00.000Z");
const quiet = instinctAllowed({
  sentToday: 0,
  now: nightInMoscow,
  tz: "Europe/Moscow",
  humanActiveRecently: false,
});
eq(quiet.allowed, false, "Moscow 01:00 blocked");
eq(quiet.reason, "quiet_hours", "Moscow 01:00 reason");

const morningInVladivostok = instinctAllowed({
  sentToday: 0,
  now: nightInMoscow,
  tz: "Asia/Vladivostok",
  humanActiveRecently: false,
});
eq(morningInVladivostok.allowed, true, "Vladivostok 08:00 allowed");
eq(morningInVladivostok.reason, "ok", "Vladivostok 08:00 reason");

// Garbage tz must not crash the scan — it falls back to Europe/Moscow.
eq(
  instinctAllowed({
    sentToday: 0,
    now: nightInMoscow,
    tz: "Not/AZone",
    humanActiveRecently: false,
  }).reason,
  "quiet_hours",
  "bad tz falls back to Moscow",
);

// ------------------------------------------------------------------- budget

const noon = Date.parse("2026-09-17T09:00:00.000Z"); // 12:00 Europe/Moscow
const base = { now: noon, tz: "Europe/Moscow", humanActiveRecently: false };

eq(instinctAllowed({ ...base, sentToday: 0 }).allowed, true, "fresh day allowed");
eq(
  instinctAllowed({ ...base, sentToday: INSTINCT_MAX_PER_DAY - 1 }).allowed,
  true,
  "last slot allowed",
);
const capped = instinctAllowed({ ...base, sentToday: INSTINCT_MAX_PER_DAY });
eq(capped.allowed, false, "daily cap blocks");
eq(capped.reason, "daily_cap", "daily cap reason");
eq(INSTINCT_MAX_PER_DAY, 3, "budget is three a day");

const tooSoon = instinctAllowed({
  ...base,
  sentToday: 1,
  lastSentAt: noon - INSTINCT_MIN_GAP_MS + MINUTE,
});
eq(tooSoon.allowed, false, "min gap blocks");
eq(tooSoon.reason, "min_gap", "min gap reason");
eq(
  instinctAllowed({
    ...base,
    sentToday: 1,
    lastSentAt: noon - INSTINCT_MIN_GAP_MS - MINUTE,
  }).allowed,
  true,
  "past the gap allowed",
);
// The gap must be wide enough that two initiatives cannot land in one sitting,
// and narrow enough that a busy day still fits the daily budget.
assert(INSTINCT_MIN_GAP_MS >= 60 * MINUTE, "gap at least an hour");
assert(INSTINCT_MIN_GAP_MS * (INSTINCT_MAX_PER_DAY - 1) <= 12 * HOUR, "gap fits a day");

// A person who is writing right now does not need to be written to.
const busy = instinctAllowed({ ...base, sentToday: 0, humanActiveRecently: true });
eq(busy.allowed, false, "human in the chat blocks");
eq(busy.reason, "human_active", "human active reason");
assert(humanActive(noon - MINUTE, noon), "a minute ago is active");
assert(
  humanActive(noon - INSTINCT_HUMAN_ACTIVE_MS + MINUTE, noon),
  "inside the window is active",
);
assert(
  !humanActive(noon - INSTINCT_HUMAN_ACTIVE_MS - MINUTE, noon),
  "outside the window is not active",
);
assert(!humanActive(undefined, noon), "never wrote is not active");

// ---------------------------------------------------------------- shouldSpeak

const meeting: InstinctCandidate = {
  kind: "calendar_soon",
  summary: "встреча «Созвон с клиникой» в 13:40, ты её не подтверждал",
  at: noon + 40 * MINUTE,
  sourceId: "gcal_abc",
};
assert(shouldSpeak(meeting, noon), "meeting in 40 minutes speaks");
assert(
  !shouldSpeak({ ...meeting, at: noon + 5 * MINUTE }, noon),
  "meeting in 5 minutes is too late to help",
);
assert(
  !shouldSpeak({ ...meeting, at: noon + 6 * HOUR }, noon),
  "meeting tonight is not now",
);
assert(!shouldSpeak({ ...meeting, at: noon - MINUTE }, noon), "started already");
assert(!shouldSpeak({ ...meeting, at: undefined }, noon), "no start time, no message");
assert(
  CALENDAR_LEAD_MAX_MS - INSTINCT_SCAN_MINUTES * MINUTE > 0,
  "scan cadence fits inside the calendar window",
);

const newsletter: InstinctCandidate = {
  kind: "mail_actionable",
  summary: "письмо от Ozon: рассылка со скидками недели",
  sourceId: "gmail_spam1",
};
assert(!shouldSpeak(newsletter, noon), "newsletter stays silent");
assert(
  !shouldSpeak(
    {
      kind: "mail_actionable",
      summary: "no-reply@site.ru: подтверди подписку на новости",
      sourceId: "gmail_spam2",
    },
    noon,
  ),
  "noreply broadcast stays silent even with an action word",
);
assert(
  !shouldSpeak(
    { kind: "mail_actionable", summary: "письмо от коллеги про вчерашний созвон", sourceId: "gmail_chat" },
    noon,
  ),
  "a letter with nothing to do stays silent",
);
assert(
  shouldSpeak(
    {
      kind: "mail_actionable",
      summary: "клиника: нужно подтвердить запись на приём до завтра",
      sourceId: "gmail_real",
    },
    noon,
  ),
  "a letter that asks something speaks",
);

assert(
  shouldSpeak(
    {
      kind: "errand_stalled",
      summary: "поручение «записаться к стоматологу» висит без движения",
      at: noon - ERRAND_STALL_MS - MINUTE,
      sourceId: "job_1",
    },
    noon,
  ),
  "long-stalled errand speaks",
);
assert(
  !shouldSpeak(
    {
      kind: "errand_stalled",
      summary: "поручение «записаться к стоматологу» висит без движения",
      at: noon - 30 * MINUTE,
      sourceId: "job_1",
    },
    noon,
  ),
  "a half-hour-old errand belongs to the job nudge path, not here",
);

assert(
  shouldSpeak(
    { kind: "order_update", summary: "заказ на WB готов к выдаче", sourceId: "order_7" },
    noon,
  ),
  "order that moved speaks",
);
assert(
  !shouldSpeak(
    { kind: "order_update", summary: "заказ на WB оформлен", sourceId: "order_7" },
    noon,
  ),
  "an order that did not move says nothing new",
);
assert(
  !shouldSpeak({ ...meeting, summary: "  " }, noon),
  "empty summary never speaks",
);
assert(!shouldSpeak({ ...meeting, sourceId: "" }, noon), "no id, no dedupe, no message");

// ------------------------------------------------------------------- dedupe

const spoken = [{ sourceId: "gcal_abc", at: noon - HOUR }];
assert(alreadySpoken("gcal_abc", spoken, noon), "same source already said");
assert(!alreadySpoken("gcal_other", spoken, noon), "another source is new");
assert(
  !alreadySpoken("gcal_abc", spoken, noon + INSTINCT_SPOKEN_TTL_MS, INSTINCT_SPOKEN_TTL_MS),
  "dedupe expires with the TTL",
);
assert(
  alreadySpoken("gcal_abc", spoken, noon, 2 * HOUR),
  "inside a custom TTL it is still said",
);
assert(!alreadySpoken("gcal_abc", spoken, noon, 30 * MINUTE), "past a custom TTL it is new");
assert(!alreadySpoken("", spoken, noon), "empty id is never a duplicate");

eq(pruneSpoken(spoken, noon).length, 1, "fresh record kept");
eq(pruneSpoken(spoken, noon + 2 * INSTINCT_SPOKEN_TTL_MS).length, 0, "stale record dropped");

// selectCandidates is the three rules together: rank, filter, dedupe.
const picked = selectCandidates([meeting, newsletter], spoken, noon);
eq(picked.length, 0, "already-said meeting plus newsletter leaves nothing");
const picked2 = selectCandidates([meeting, newsletter], [], noon);
eq(picked2.length, 1, "only the meeting survives");
eq(picked2[0]?.sourceId, "gcal_abc", "and it is the meeting");

// ------------------------------------------------------------------ ranking

const pool: InstinctCandidate[] = [
  { kind: "mail_actionable", summary: "нужно подтвердить запись", sourceId: "m1" },
  { kind: "errand_stalled", summary: "поручение висит", at: noon - 8 * HOUR, sourceId: "j1" },
  { kind: "order_update", summary: "заказ готов к выдаче", at: noon - 2 * HOUR, sourceId: "o1" },
  meeting,
  { kind: "calendar_soon", summary: "встреча позже", at: noon + 70 * MINUTE, sourceId: "gcal_z" },
];
const ranked = rankCandidates(pool, noon);
eq(
  ranked.map((c) => c.sourceId).join(","),
  "gcal_abc,gcal_z,o1,j1,m1",
  "time-bound kinds first, nearest first",
);
// Determinism: same input in any order must produce the same output.
const shuffled = rankCandidates([...pool].reverse(), noon);
eq(
  shuffled.map((c) => c.sourceId).join(","),
  ranked.map((c) => c.sourceId).join(","),
  "ranking is order-independent",
);
eq(
  rankCandidates(pool, noon).map((c) => c.sourceId).join(","),
  ranked.map((c) => c.sourceId).join(","),
  "ranking is stable across calls",
);
// Ties on kind and distance fall back to the source id, not to input order.
const tied = rankCandidates(
  [
    { kind: "order_update", summary: "b", at: noon, sourceId: "b" },
    { kind: "order_update", summary: "a", at: noon, sourceId: "a" },
  ],
  noon,
);
eq(tied.map((c) => c.sourceId).join(","), "a,b", "tiebreak by source id");
eq(rankCandidates([], noon).length, 0, "empty stays empty");

// ------------------------------------------------------------------- prompt

const prompt = instinctWakePrompt([
  meeting,
  { kind: "mail_actionable", summary: "клиника: нужно подтвердить запись", sourceId: "gmail_real" },
]);
assert(prompt.startsWith("[background wakeup]"), "same wakeup framing as job_check");
assert(prompt.includes("[SILENT]"), "prompt names the silent exit");
assert(
  /ответь ровно \[SILENT\]/.test(prompt),
  "prompt spells out the exact silent answer, like watcher/job wakeups do",
);
assert(
  /нормальный и ожидаемый исход/.test(prompt),
  "prompt says silence is expected, not a failure",
);
assert(/не выдумывай/.test(prompt), "prompt forbids inventing news");
assert(prompt.includes(meeting.summary), "candidate summary reaches the model");
assert(prompt.includes("не инструкции"), "copied app data is framed as data");
// Never paste an inbox: only the top few lines go in.
const many = instinctWakePrompt(
  Array.from({ length: 10 }, (_, i) => ({
    kind: "order_update" as const,
    summary: `заказ ${i} готов к выдаче`,
    sourceId: `o${i}`,
  })),
);
eq(many.split("\n").filter((l) => l.startsWith("- ")).length, 3, "prompt caps at three lines");

console.log("instinct-check ok");
