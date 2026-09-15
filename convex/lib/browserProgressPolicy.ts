/**
 * Deterministic (no LLM) decisions for the two silence gaps around a Cloud
 * browser run: short Russian progress notes while it is still in flight
 * (nextProgressNote), and the one-off report for a run that finished after
 * the human stopped hearing about it (lateResultLine — see browserFollow.ts
 * lateResultNotify for why that can happen at all: startFollowThrough's
 * cancel_then_start replaces a workflow's next poll before it ever runs).
 */

import { isPreviewHost } from "./browserLivePolicy.ts";
import { isFollowTerminal, STALLED_STATUS } from "./browserFollowPolicy.ts";
import { doneLineHint, needsHuman, parseCloudOutcome } from "./browserOutcomePolicy.ts";

export type ProgressKey = "opened" | "slow" | "long";

/** Run still active this long with no "opened" note sent → "slow". */
export const PROGRESS_SLOW_MS = 4 * 60_000;
/** Run still active this long → "long", once. */
export const PROGRESS_LONG_MS = 10 * 60_000;

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
 * Which progress note (if any) to send on this poll. At most one per run per
 * key, checked in priority order, and never once the run has gone terminal —
 * the final done/need/failed/giveup wakeup owns that moment.
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
}): { key: ProgressKey; text: string } | undefined {
  if (isFollowTerminal(opts.status)) return undefined;
  // Login-wait runs already get the login-link push once the site's login
  // page loads, and every note afterwards is about the human, not the
  // site ("waiting on you" isn't "the site is slow") — skip all of them.
  if (opts.loginWait) return undefined;
  // Defense in depth: any bro-internal scaffold marker ([bro-login],
  // [bro-vault-login], [bro-errand], [bro-inject], ...) means `task` is not
  // a human errand at all — callers should already be gating this via
  // `loginWait`, but a marked scaffold must never be shortened into a note.
  if (opts.task.trim().startsWith("[")) return undefined;

  const sent = new Set(opts.sent);
  const short = shortenTask(opts.task);
  // "opened" needs actual evidence a page loaded — `site` (the errand's
  // known start URL) is not proof of that; it fires the instant a poll sees
  // one, which for a known-start errand is the very first ~10s poll whether
  // or not anything actually rendered.
  const openedHost = realPageHost(opts.pageUrl);
  // Once opened is unavailable as proof, later notes may still name the
  // known start host as a best-effort label.
  const host = openedHost ?? opts.site?.trim();

  if (openedHost && !sent.has("opened")) {
    return { key: "opened", text: `Открыл ${openedHost}, делаю: ${short}` };
  }

  const elapsed = opts.now - opts.startedAt;
  if (elapsed >= PROGRESS_SLOW_MS && !sent.has("slow")) {
    const where = host ? ` ${host}` : "";
    return {
      key: "slow",
      text: `Ещё занимаюсь: ${short}. Сайт${where} небыстрый, напишу как будет готово.`,
    };
  }

  if (elapsed >= PROGRESS_LONG_MS && !sent.has("long")) {
    return {
      key: "long",
      text: `Всё ещё в процессе — ${short}. Если хочешь, напиши «отмени», и я остановлю.`,
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
 * A stale/abandoned run is worth one late message only when it actually
 * finished with a labelled, human-facing done and nothing left pending on
 * the human — a need on a run nobody is watching anymore is moot, and an
 * unlabelled or cancelled/failed result was never going to be reported.
 */
export function lateResultLine(
  status: string,
  result: string | null | undefined,
): string | undefined {
  const s = status.trim().toLowerCase();
  if (!isFollowTerminal(s) || NON_REPORTABLE_TERMINAL.has(s)) return undefined;
  const outcome = parseCloudOutcome(result, { status: s });
  if (!outcome.labelled || !outcome.done || needsHuman(outcome.needs)) return undefined;
  return `Кстати, прошлое поручение всё же завершилось. ${doneLineHint(outcome)}`;
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
