/**
 * Deterministic (no LLM) decisions for the two silence gaps around a Cloud
 * browser run: short Russian progress notes while it is still in flight
 * (nextProgressNote), and the one-off report for a run that finished after
 * the human stopped hearing about it (lateResultLine — see browserFollow.ts
 * lateResultNotify for why that can happen at all: startFollowThrough's
 * cancel_then_start replaces a workflow's next poll before it ever runs).
 *
 * `doneNowLine` is the same report one beat earlier: the poll that sees a
 * clean «готово» speaks it straight away, so the person does not wait out a
 * whole model turn for an outcome that is already fully parsed.
 *
 * Since the phrasing lane shipped (convex/lib/broPhrasing.ts) these palettes
 * are the FALLBACK, not the voice: browserFollow asks a tiny, hard-bounded
 * model call to write the line, and sends what is below whenever that call is
 * unconfigured, too slow, or comes back with something that fails the gate.
 * That is why the pick here stays seeded rather than random — a retried poll
 * that falls back must fall back to the same sentence it would have used the
 * first time, never a new one.
 */

import { isPreviewHost } from "./browserLivePolicy.ts";
import { isFollowTerminal, STALLED_STATUS } from "./browserFollowPolicy.ts";
import {
  doneLineHint,
  needsHuman,
  parseCloudOutcome,
  type CloudOutcome,
} from "./browserOutcomePolicy.ts";

export type ProgressKey = "opened" | "slow" | "long";

/**
 * Run still active this long with no "opened" note sent → "slow".
 *
 * 75s, not the old 4 minutes: "opened" needs a real page host to fire, and a
 * run that never lands one (a slow start, a redirect chain, a site that hangs)
 * used to leave the person with four silent minutes after «делаю». A minute
 * and a quarter is about how long a person waits before wondering whether
 * anything is happening at all.
 */
export const PROGRESS_SLOW_MS = 75_000;
/** Run still active this long → "long", once. Strictly after PROGRESS_SLOW_MS. */
export const PROGRESS_LONG_MS = 4 * 60_000;

const MAX_TASK_CHARS = 60;

const URL_RE = /https?:\/\/[^\s<>"')]+/giu;

/** Replace every URL in free text with just its host (no "www."), so an
 *  errand that itself names a link ("открой https://example.com и...") never
 *  leaks a full URL into a note — notes never include URLs. */
function stripUrls(text: string): string {
  return text.replace(URL_RE, (match) => {
    try {
      return new URL(match).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return match;
    }
  });
}

/** Free-text errand shortened to ~60 chars, cut at a word boundary, with any
 *  URL inside it collapsed to its host first. */
export function shortenTask(task: string): string {
  const text = stripUrls(task.trim()).replace(/\s+/gu, " ");
  if (text.length <= MAX_TASK_CHARS) return text;
  const cut = text.slice(0, MAX_TASK_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return `${head}…`;
}

/**
 * A real page host: not about:blank/localhost, not a Browser Use live-view
 * or preview host. `hydrate`'s `pageUrl` can be either the CDP tab's raw URL
 * (unfiltered) or an events-derived one, so this filters instead of trusting
 * the caller. Host is returned without a leading "www.".
 */
export function realPageHost(pageUrl: string | undefined): string | undefined {
  const raw = pageUrl?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return undefined;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!host || isPreviewHost(host)) return undefined;
    return host;
  } catch {
    return undefined;
  }
}

/**
 * Host → the way a person actually names that place in a sentence, ready to
 * drop in after a verb («Я уже в озоне»). Stored with the preposition and in
 * the right case, because Russian will not let us build it from the bare name.
 * Unknown host → undefined: the note then simply says nothing about where he
 * is, which is far better than reading a domain out loud.
 */
const SITE_PHRASES: ReadonlyMap<string, string> = new Map([
  ["wildberries.ru", "на вб"],
  ["wb.ru", "на вб"],
  ["ozon.ru", "в озоне"],
  ["taxi.yandex.ru", "в яндекс такси"],
  ["market.yandex.ru", "на яндекс маркете"],
  ["eda.yandex.ru", "в яндекс еде"],
  ["lavka.yandex.ru", "в яндекс лавке"],
  ["yandex.ru", "в яндексе"],
  ["avito.ru", "на авито"],
  ["aliexpress.ru", "на алиэкспрессе"],
  ["aliexpress.com", "на алиэкспрессе"],
  ["megamarket.ru", "в мегамаркете"],
  ["lamoda.ru", "в ламоде"],
  ["dns-shop.ru", "в днс"],
  ["mvideo.ru", "в мвидео"],
  ["citilink.ru", "в ситилинке"],
  ["samokat.ru", "в самокате"],
  ["vkusvill.ru", "во вкусвилле"],
  ["perekrestok.ru", "в перекрёстке"],
  ["sbermarket.ru", "в сбермаркете"],
  ["kuper.ru", "в купере"],
  ["dodopizza.ru", "в додо"],
  ["gosuslugi.ru", "на госуслугах"],
  ["tutu.ru", "на туту"],
  ["aviasales.ru", "на авиасейлс"],
  ["sportmaster.ru", "в спортмастере"],
  ["detmir.ru", "в детском мире"],
  ["eapteka.ru", "в аптеке"],
  ["apteka.ru", "в аптеке"],
  ["yclients.com", "в записи"],
  ["booking.com", "на букинге"],
]);

/**
 * «taxi.yandex.ru» → «в яндекс такси». Subdomains fall back to their parent
 * («m.ozon.ru» → «в озоне»); anything we cannot name in human words returns
 * undefined so the note drops the place entirely instead of printing a domain.
 */
export function humanSitePhrase(host: string | undefined): string | undefined {
  const raw = host?.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!raw) return undefined;
  const labels = raw.split(".").filter(Boolean);
  for (let i = 0; i < labels.length - 1; i++) {
    const phrase = SITE_PHRASES.get(labels.slice(i).join("."));
    if (phrase) return phrase;
  }
  return undefined;
}

/**
 * The note palettes. Every variant is written twice over: once for when we can
 * name the place like a person would, once for when we cannot — a note never
 * falls back to a raw hostname, and never reads the errand text back to the
 * human who just typed it.
 */
const PROGRESS_VARIANTS: Readonly<
  Record<ProgressKey, ReadonlyArray<(where: string | undefined) => string>>
> = {
  opened: [
    (w) => (w ? `Я уже ${w}, начинаю.` : "Я уже начал, сейчас всё сделаю."),
    (w) => (w ? `Всё, я ${w} — занимаюсь.` : "Всё, занимаюсь."),
    (w) => (w ? `Я ${w}, приступил. Напишу, как будет готово.` : "Приступил. Напишу, как будет готово."),
    (w) => (w ? `Так, я ${w}. Сейчас всё сделаю.` : "Так, я на месте. Сейчас всё сделаю."),
  ],
  slow: [
    (w) =>
      w
        ? `Ещё вожусь ${w}, тут всё небыстро. Напишу, как закончу.`
        : "Ещё вожусь, тут всё небыстро. Напишу, как закончу.",
    (w) =>
      w
        ? `Я ${w}, но идёт медленно. Как доделаю — сразу напишу.`
        : "Идёт медленно, но я в процессе. Как доделаю — сразу напишу.",
    (w) =>
      w
        ? `Всё ещё ${w}, сайт не торопится. Напишу, как будет готово.`
        : "Всё ещё занимаюсь, сайт не торопится. Напишу, как будет готово.",
    (w) =>
      w
        ? `Пока без результата: ${w} всё грузится долго. Напишу, как получится.`
        : "Пока без результата, всё грузится долго. Напишу, как получится.",
  ],
  long: [
    (w) =>
      w
        ? `Всё ещё вожусь ${w}. Если надоело — напиши «отмени», остановлюсь.`
        : "Всё ещё вожусь. Если надоело — напиши «отмени», остановлюсь.",
    () => "Дольше обычного выходит. Скажешь «отмени» — брошу.",
    (w) =>
      w
        ? `Я ${w}, пока не закончил. Если что, напиши «отмени» — остановлюсь.`
        : "Пока не закончил. Если что, напиши «отмени» — остановлюсь.",
    () => "Ещё в процессе. Надоест ждать — напиши «отмени».",
  ],
};

/** Every wording we can send for this key, in order. Exported for the guard. */
export function progressNoteVariants(
  key: ProgressKey,
  where?: string,
): string[] {
  return PROGRESS_VARIANTS[key].map((build) => build(where));
}

/** FNV-1a, so the pick is stable across processes and deploys (Math.random
 *  would make a retried poll flip wording mid-run). */
function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * One wording per (run, key): the same seed always picks the same line, so a
 * re-poll or a retried delivery never rephrases itself, while a different run
 * gets a different voice.
 */
export function pickProgressVariant(
  key: ProgressKey,
  where: string | undefined,
  seed: string,
): string {
  const variants = progressNoteVariants(key, where);
  return variants[hashSeed(`${seed}|${key}`) % variants.length]!;
}

/**
 * Which progress note (if any) to send on this poll. At most one per run per
 * key, checked in priority order, and never once the run has gone terminal —
 * the final done/need/failed/giveup wakeup owns that moment.
 *
 * `seed` should be the runId; it only picks the wording, and defaults to the
 * run's start time so an older caller still gets a stable (never random) line.
 */
export function nextProgressNote(opts: {
  status: string;
  startedAt: number;
  now: number;
  pageUrl?: string;
  task: string;
  site?: string;
  loginWait: boolean;
  sent: ProgressKey[];
  seed?: string;
}): { key: ProgressKey; text: string; where?: string } | undefined {
  if (isFollowTerminal(opts.status)) return undefined;
  // Login-wait runs already get the login-link push once the site's login
  // page loads, and every note afterwards is about the human, not the
  // site ("waiting on you" isn't "the site is slow") — skip all of them.
  if (opts.loginWait) return undefined;
  // Defense in depth: any bro-internal scaffold marker ([bro-login],
  // [bro-vault-login], [bro-errand], [bro-inject], ...) means `task` is not
  // a human errand at all — callers should already be gating this via
  // `loginWait`, but a marked scaffold must never reach a note.
  if (opts.task.trim().startsWith("[")) return undefined;

  const sent = new Set(opts.sent);
  const seed = opts.seed?.trim() || String(opts.startedAt);
  // "opened" needs actual evidence a page loaded — `site` (the errand's
  // known start URL) is not proof of that; it fires the instant a poll sees
  // one, which for a known-start errand is the very first ~10s poll whether
  // or not anything actually rendered.
  const openedHost = realPageHost(opts.pageUrl);
  // Once opened is unavailable as proof, later notes may still name the
  // known start host as a best-effort label.
  const host = openedHost ?? opts.site?.trim();

  if (openedHost && !sent.has("opened")) {
    const where = humanSitePhrase(openedHost);
    return {
      key: "opened",
      text: pickProgressVariant("opened", where, seed),
      // `where` is the same human phrase the canned line uses, handed out so
      // the phrasing lane (convex/lib/broPhrasing.ts) can name the place in
      // its own sentence. Undefined for a host we cannot name — the note then
      // says nothing about where he is, generated or canned.
      ...(where ? { where } : {}),
    };
  }

  const elapsed = opts.now - opts.startedAt;
  const laterWhere = humanSitePhrase(host);
  if (elapsed >= PROGRESS_SLOW_MS && !sent.has("slow")) {
    return {
      key: "slow",
      text: pickProgressVariant("slow", laterWhere, seed),
      ...(laterWhere ? { where: laterWhere } : {}),
    };
  }

  if (elapsed >= PROGRESS_LONG_MS && !sent.has("long")) {
    return {
      key: "long",
      text: pickProgressVariant("long", laterWhere, seed),
      ...(laterWhere ? { where: laterWhere } : {}),
    };
  }

  return undefined;
}

/** Real vendor terminal statuses that never carry a reportable outcome. */
const NON_REPORTABLE_TERMINAL: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  STALLED_STATUS,
]);

/**
 * The one shape of outcome Bro can report without a model turn: a real
 * terminal success carrying a labelled СДЕЛАНО and nothing left pending on
 * the human. Anything else (unlabelled free text, a НУЖНО, failed/cancelled/
 * stalled) still needs the model to phrase it, and returns undefined here.
 */
function reportableDone(
  status: string,
  result: string | null | undefined,
): CloudOutcome | undefined {
  const s = status.trim().toLowerCase();
  if (!isFollowTerminal(s) || NON_REPORTABLE_TERMINAL.has(s)) return undefined;
  const outcome = parseCloudOutcome(result, { status: s });
  if (!outcome.labelled || !outcome.done || needsHuman(outcome.needs)) return undefined;
  return outcome;
}

/**
 * A stale/abandoned run is worth one late message only when it actually
 * finished with a labelled, human-facing done and nothing left pending on
 * the human — a need on a run nobody is watching anymore is moot, and an
 * unlabelled or cancelled/failed result was never going to be reported.
 */
/**
 * How Bro opens a finished errand. `doneLineHint` says «Готово: …» and only
 * that, which was fine while a model turn did the talking — but the instant
 * report speaks for itself now, and one frozen opener on the single most
 * visible message of the whole errand is exactly the machine register the
 * voice work is trying to get rid of. Same pick-by-seed as the progress
 * notes: one run keeps one wording, different runs differ.
 */
// СДЕЛАНО comes back as a past-tense phrase («Заказал такси до аэропорта»),
// so an opener that takes it after a colon has to be one the phrase can
// follow. «Сделал: Заказал…» doubles the verb; making the phrase its own
// sentence after a short «Готово.» is what a person actually types.
const DONE_OPENERS: ReadonlyArray<(done: string | undefined) => string> = [
  (d) => (d ? `Готово: ${d}.` : "Готово."),
  (d) => (d ? `Всё, готово. ${d}.` : "Всё, готово."),
  (d) => (d ? `Готово. ${d}.` : "Готово."),
  (d) => (d ? `Порядок. ${d}.` : "Порядок."),
  (d) => (d ? `Готово — ${d}.` : "Готово."),
];

/** Every opener we can send, in order. Exported for the guard. */
export function doneOpeners(done?: string): string[] {
  return DONE_OPENERS.map((build) => build(done));
}

/**
 * The report body: a varied human opener, then the facts exactly as
 * `doneLineHint` lays them out — those stay factual, it is the opener that
 * was robotic. With no seed the first opener is used, which is
 * `doneLineHint`'s own wording, so an un-seeded caller is unchanged.
 */
function humanDoneBody(outcome: CloudOutcome, seed?: string): string {
  const openers = doneOpeners(outcome.done);
  const opener = seed
    ? openers[hashSeed(`${seed}|done`) % openers.length]!
    : openers[0]!;
  const rest = doneLineHint(outcome).split("\n").slice(1);
  return [opener, ...rest].join("\n");
}

export function lateResultLine(
  status: string,
  result: string | null | undefined,
  seed?: string,
): string | undefined {
  const outcome = reportableDone(status, result);
  if (!outcome) return undefined;
  return `Кстати, прошлое поручение всё же завершилось. ${humanDoneBody(outcome, seed)}`;
}

/**
 * The same outcome, reported while the human is still waiting for it: the
 * poll that notices a clean, fully-resolved «готово» sends this line itself
 * instead of waking a model turn (queue hop + cold start + TTFT) to say the
 * same thing in prettier words. Same guard rails as lateResultLine, minus
 * its «кстати, прошлое поручение» framing — this one is not late, it is the
 * report. Everything the model still has to think about (need/failed/giveup,
 * an unlabelled result, a queued next errand) returns undefined and takes
 * the normal wakeup path.
 */
export function doneNowLine(
  status: string,
  result: string | null | undefined,
  seed?: string,
): string | undefined {
  const outcome = reportableDone(status, result);
  if (!outcome) return undefined;
  return humanDoneBody(outcome, seed);
}

/**
 * lateResultNotify's bounded re-check schedule: the OLD run's cancel may
 * still be in flight when startFollowThrough schedules the first check at
 * runAfter(0), so a still-active run gets a few more looks before giving up
 * for good. Index 0 is the delay before retry attempt 1, etc.
 */
export const LATE_RESULT_RETRY_DELAYS_MS = [20_000, 60_000, 120_000] as const;

/**
 * Delay before the next lateResultNotify attempt, or undefined once the
 * schedule is exhausted (the caller should give up and return delivered:false).
 * `attempt` is the attempt that just ran (0 for the first, runAfter(0) call).
 */
export function lateRetryDelayMs(attempt: number): number | undefined {
  return LATE_RESULT_RETRY_DELAYS_MS[attempt];
}
