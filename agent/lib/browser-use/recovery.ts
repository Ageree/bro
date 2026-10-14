import type { BrowserRunNeed, parseBrowserOutcome } from "./outcome";

/**
 * How an errand that was allowed to act recovers from a run that broke off:
 * a network or proxy error, a lost browser, a crash, a run that ended
 * `failed` without a report. Such a run may have pressed «Отправить»,
 * «Заказать» or «Оплатить» before it broke, so it is never simply run again
 * (that was the rule, and the person was asked to check by hand). Instead the
 * errand goes on in two steps, with nobody told until it is over:
 *
 * 1. `verify`: a read-only run in the same session and profile looks at the
 *    site's own pages for the action and reports `ACTION: done|not_done|
 *    unknown`. It is started without the saved card.
 * 2. `done` closes the errand with that run's report; `not_done` starts a
 *    `continue` run that finishes the errand under the permission the
 *    errand already carries (same `submission`, same reservation); anything
 *    else — `unknown`, no verdict, a check that broke off too — ends with the
 *    person once the cap of `maximumRecoveries` is reached.
 *
 * The step lives on the row (`recoveryPhase`, `recoveryAttempt`) and rides
 * the anti-bot retry's start (`startCaptchaRetry`), which already moves the
 * spend reservation before any outside call and finds a run it started
 * before by its reference line, so a recovery never starts twice.
 */
export const maximumRecoveries = 2;

export type RecoveryPhase = "continue" | "verify";

/**
 * Whether a broken-off run of this errand is recovered by itself: only an
 * errand that carries the person's own permission to act. One that holds a
 * reservation alone — a follow-up finishing a payment after a code — goes to
 * the person, as before.
 */
export function recoverableErrand(row: {
  readonly paymentAllowed: boolean;
  readonly submission: unknown;
}) {
  return row.paymentAllowed || row.submission !== null;
}

const verifyDelaysMinutes = [1, 3] as const;

/** When a recovery step starts: the checks back off, the finish follows at once. */
export function recoveryRetryAt(
  phase: RecoveryPhase,
  attempt: number,
  now: Date
) {
  const minutes =
    phase === "continue"
      ? 0
      : (verifyDelaysMinutes[
          Math.min(Math.max(attempt, 1), verifyDelaysMinutes.length) - 1
        ] ?? 1);
  return new Date(now.getTime() + minutes * 60_000);
}

type ActionVerdict = ReturnType<typeof parseBrowserOutcome>["action"];

/**
 * What a settled run of a recoverable errand leads to. `interrupted` is a run
 * that broke off; otherwise the verdict of a `verify` run decides. `canStart`
 * is false once the errand has no background attempt left.
 */
export function nextRecovery(input: {
  readonly action: ActionVerdict;
  readonly attempt: number;
  readonly canStart: boolean;
  readonly interrupted: boolean;
  readonly needs: BrowserRunNeed;
  readonly phase: RecoveryPhase | null;
}) {
  const { attempt, interrupted, phase } = input;
  if (interrupted) {
    return attempt < maximumRecoveries && input.canStart
      ? ({ attempt: attempt + 1, kind: "retry", phase: "verify" } as const)
      : ({ kind: "exhausted" } as const);
  }
  // A check that stopped for a code or a sign-in asks the person as any run.
  if (phase !== "verify" || input.needs !== "none") {
    return { kind: "none" } as const;
  }
  if (input.action === "done") return { kind: "verified" } as const;
  if (input.action === "not_done") {
    return input.canStart
      ? ({ attempt, kind: "retry", phase: "continue" } as const)
      : ({ kind: "unclear" } as const);
  }
  return { kind: "unclear" } as const;
}

const marker = "[Recovery after a run that broke off]";
const markerPattern =
  /\n\n\[(?:Recovery after a run that broke off|Retry after an anti-bot check)\]/u;

const verifyRules = [
  "The previous run of this errand broke off while it was allowed to act in the person's name, so nobody knows whether its last click, a submission, an order, a booking or a payment, went through. This run is a READ-ONLY check of exactly that, and it changes nothing.",
  "Look where the site itself would show the result: the order history or «my orders», the account's own list of what was submitted or booked («мои продукты», «мои заявки», «мои записи»), the page of this very item, a confirmation page, and a confirmation letter in the mailbox you have, when you have one. Check more than one place before you conclude anything.",
  "Do not press any submit, order, book, pay or confirm button, do not fill in or send a form again and do not add anything to a cart; open and read only. If the page you land on is the half-filled form, read it and leave it as it is.",
  "Report as usual, with RESULT, NEEDS and the other labelled lines, and add one more line of the footer: ACTION: done — when a place above shows the action already happened (give its number, title or date in RESULT, and ORDER, TOTAL, BOOKING or ITEMS as usual); ACTION: not_done — only when you checked those places, were signed in, and they clearly show nothing of this errand was created; ACTION: unknown — when you could not tell: not signed in, pages that would not load, a history that may lag, anything ambiguous. When in doubt, write unknown; never write not_done only because one place showed nothing.",
];

const continueRules = [
  "The previous run of this errand broke off, and a read-only check afterwards found that its action was not done: nothing of this errand was created on the site. This run finishes the errand under the permission it already has, no more.",
  "The page the previous run left may be gone, so look where the errand stands now and carry on from there. Before the final press that submits, orders, books or pays, look once more at the site's own list for this item: if it is there by now, do not do it again, report it as done with its number.",
  "Do the action once. If this run breaks off again, do not repeat it by yourself.",
];

/**
 * The previous run's instruction with a recovery step added. The step
 * replaces an earlier recovery or anti-bot note rather than piling up, and
 * the reference line names this very attempt for the start's bookkeeping.
 */
export function recoveryTask(
  previousTask: string,
  options: {
    readonly attempt: number;
    readonly onVm: boolean;
    readonly phase: RecoveryPhase;
    readonly reference: string;
  }
) {
  const base = previousTask.split(markerPattern, 1)[0] ?? previousTask;
  const where = options.onVm
    ? "Carry on in a new tab of the same browser, with the same saved profile, cookies and sign-ins."
    : "This is a fresh browser on another network address, with the same saved profile, cookies and sign-ins.";
  const rules = options.phase === "verify" ? verifyRules : continueRules;
  const step =
    options.phase === "verify"
      ? `This is check ${String(options.attempt)} of ${String(maximumRecoveries)}.`
      : `This follows check ${String(options.attempt)} of ${String(maximumRecoveries)}.`;
  return [base, [marker, step, where, ...rules].join(" "), options.reference]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
