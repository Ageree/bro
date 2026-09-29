import { randomUUID } from "node:crypto";
import { isBrowserVmId } from "@agent/lib/browser-vm/ids";
import { env } from "@shared/environment";
import {
  handOffBrowserRunRetry,
  parkBrowserRunForRetry,
  readBrowserRun,
} from "@db/services/browser-runs";
import {
  BrowserUseError,
  browserUseBusy,
  cancelBrowserUseRun,
  createBrowserUseRun,
  findRecentBrowserUseRunByTaskLine,
  readBrowserUseRun,
} from "./client";
import { retryProxySettings } from "./proxy";
import { resolveBrowserSecretBindings, signsInByPhone } from "./secrets";

type BrowserRunRow = NonNullable<Awaited<ReturnType<typeof readBrowserRun>>>;

/**
 * How long an errand keeps trying a site that walls it off before the person
 * hears about it. Attempt 1 is the run they started; the waits between the
 * attempts after it grow, so a wall that lifts in a couple of minutes costs a
 * couple of minutes and one that does not is given about half an hour.
 */
export const maximumCaptchaAttempts = 5;
const retryDelaysMinutes = [2, 5, 9, 14] as const;
// On the workspace's own VM a retry goes out through another residential
// exit, and a site that blocked the address (Avito's «Доступ ограничен:
// проблема с IP») lets the next one in at once: waiting buys nothing there.
const vmRetryDelaysMinutes = [1, 2, 5, 9] as const;

export const captchaRetryWindowMinutes = retryDelaysMinutes.reduce(
  (sum, minutes) => sum + minutes,
  0
);

/**
 * When the next attempt runs after attempt `failedAttempt` lost to an
 * anti-bot check, or nothing when the errand is out of attempts.
 */
export function captchaRetryAt(failedAttempt: number, now: Date, onVm = false) {
  if (failedAttempt >= maximumCaptchaAttempts) return undefined;
  const delays = onVm ? vmRetryDelaysMinutes : retryDelaysMinutes;
  const index = Math.min(Math.max(failedAttempt, 1), delays.length);
  const minutes = delays[index - 1] ?? 1;
  return new Date(now.getTime() + minutes * 60_000);
}

const retryMarker = "[Retry after an anti-bot check]";

/**
 * The previous attempt's instruction with a note about where this one
 * stands. The note replaces the one before it rather than piling up. The
 * waiting advice is Browser Use's own: its solver works a challenge by
 * itself, and a reload or a click in the middle restarts it. On the
 * workspace's own browser VM (`onVm`) the attempt gets a new tab of the one
 * browser there, whose address stays unless the VM's exit went bad.
 */
export function captchaRetryTask(
  previousTask: string,
  attempt: number,
  reference: string,
  onVm = false
) {
  const base = previousTask.split(`\n\n${retryMarker}`, 1)[0] ?? previousTask;
  const fresh = onVm
    ? "a new tab of the same browser, with the same saved profile, cookies and sign-ins, through another network address when one could be had"
    : "a fresh browser on a different network address, with the same saved profile, cookies and sign-ins";
  const start = onVm
    ? "Go straight back to the site and carry on from where the previous attempt stopped: what it already found is in your memory, so do not check those pages again."
    : "Go straight to the site and do the errand.";
  return [
    base,
    [
      retryMarker,
      `An anti-bot check, or a connection that would not load the site, stopped the previous attempt, so this is attempt ${String(attempt)} of ${String(maximumCaptchaAttempts)}: ${fresh}.`,
      start,
      "When a check appears, first give the browser's built-in solver about ten seconds without reloading or clicking into it; then solve whatever is still there yourself.",
    ].join(" "),
    reference,
  ].join("\n\n");
}

/**
 * The line that names one attempt of one errand in the retry's task. The
 * claim on a parked run is a lease, so a poller that died between starting
 * the retry and handing the errand to it leaves the row to be claimed again;
 * this line is how the next claim finds that run and adopts it instead of
 * starting a second browser beside it.
 */
function retryReference(runId: string, attempt: number) {
  return `(Background retry ${String(attempt)} of errand ${runId}; for bookkeeping only.)`;
}

const uncertainStartRetryMs = 60_000;
/** Past this an outage counts against the attempts, so the errand ends. */
const uncertainStartWindowMs = 30 * 60_000;

/**
 * Whether the attempt that hit the wall did so recently enough for a start
 * of unknown outcome to keep its number. An errand walled longer ago counts
 * it as a failed attempt, so an outage cannot keep it retrying forever.
 */
function recentlyWalled(row: Pick<BrowserRunRow, "completedAt">, now: Date) {
  return (
    row.completedAt !== null &&
    now.getTime() - row.completedAt.getTime() < uncertainStartWindowMs
  );
}

/**
 * Stop a run that was started but could not be handed the errand. Never
 * fatal: the caller is already on its way out with a better error.
 */
async function abandonRetryRun(runId: string) {
  try {
    await cancelBrowserUseRun(runId);
  } catch (error) {
    console.warn("[browser-use] the orphaned retry could not be cancelled", {
      cause: error,
      runId,
    });
  }
}

/**
 * Start the next attempt of an errand parked on an anti-bot wall: a new run on
 * the same profile, with no session so it gets a new browser, through another
 * exit. The conversation keeps the old run id and is followed to this one.
 *
 * The person may stop the errand at any moment, so the row is read again
 * before anything starts, and the handoff to the new run only lands while the
 * old row is still waiting; a run started for an errand that was stopped
 * meanwhile is cancelled at once. A start Browser Use refused counts as a
 * failed attempt and is parked again, until the attempts run out and the
 * caller reports the wall; the workspace's own VM starting, or busy, ran
 * no attempt and costs none while the wall is recent. A run this attempt
 * already started before its poller died is found by its reference line and
 * adopted, not started again; any other failure up to and including the
 * start keeps the attempt's number while the wall is recent, so the next
 * claim looks for that very line.
 */
export async function startCaptchaRetry(row: BrowserRunRow, now = new Date()) {
  if (row.captchaAttempt >= maximumCaptchaAttempts) {
    return { status: "exhausted" as const };
  }
  const attempt = row.captchaAttempt + 1;
  const onVm = row.profileId !== null && isBrowserVmId(row.profileId);
  try {
    const reference = retryReference(row.id, attempt);
    let run: Pick<
      Awaited<ReturnType<typeof createBrowserUseRun>>,
      "id" | "sessionId"
    >;
    let starting = false;
    try {
      const current = await readBrowserRun(row.id);
      if (current?.status !== "waiting" || current.retriedAsRunId) {
        return { status: "stopped" as const };
      }
      const adopted = await findRecentBrowserUseRunByTaskLine(
        reference,
        undefined,
        undefined,
        row.profileId ?? undefined
      );
      if (adopted) {
        run = adopted;
      } else {
        const scope = {
          userId: row.createdByUserId,
          workspaceId: row.workspaceId,
        };
        const previous = await readBrowserUseRun(row.id);
        const secrets = await resolveBrowserSecretBindings(scope, {
          allowPayment: row.paymentAllowed,
          // The phone goes again only where the errand was composed with it.
          phoneSignIn: signsInByPhone(previous.task),
          site: row.site ?? undefined,
        });
        starting = true;
        run = await createBrowserUseRun({
          ...retryProxySettings(attempt, randomUUID().replaceAll("-", "")),
          // A VM profile only (cloud ignores it): the wall has already
          // judged the address the last attempt came from.
          freshExit: true,
          maxCostUsd: env.BROWSER_USE_MAX_COST_USD,
          model: env.BROWSER_USE_MODEL,
          profileId: row.profileId ?? undefined,
          secretBindings: secrets.bindings,
          // On the VM the retry goes on in the attempt's own session, whose
          // agent keeps what it found: walls there come after a while on
          // an address, and an attempt that started over spent its new one
          // on the pages the last one had already read.
          sessionId: onVm ? previous.sessionId : undefined,
          task: captchaRetryTask(previous.task, attempt, reference, onVm),
        });
      }
    } catch (error) {
      // The workspace's own VM starting, or busy with another errand of
      // its workspace, ran no attempt at all: the attempt keeps its number
      // and waits as long as the VM asked, while the wall is recent.
      const vmWaitMs =
        onVm && starting && browserUseBusy(error)
          ? Math.max(error.retryAfterMs ?? 0, uncertainStartRetryMs)
          : undefined;
      // Only a clear refusal (4xx) of the start is a failed attempt. A
      // timeout, a dropped connection or a 5xx on the start says nothing
      // about what Browser Use did, and it takes no idempotency key. Nor
      // does any failure before the start: the last claim's start may have
      // been cut off, the outage that cut it off usually fails this claim's
      // reads as well, and the next number would miss the run it started.
      const refused =
        vmWaitMs === undefined &&
        starting &&
        error instanceof BrowserUseError &&
        error.status < 500;
      if (refused || !recentlyWalled(row, now)) throw error;
      // The next claim looks for this very attempt's line and adopts what it
      // finds, instead of taking the next number and opening a second
      // browser beside it.
      console.warn("[browser-use] the anti-bot retry keeps its attempt", {
        attempt,
        cause: error,
        runId: row.id,
        stage: starting ? "start" : "before start",
      });
      await parkBrowserRunForRetry(row.id, {
        captchaAttempt: row.captchaAttempt,
        retryAt: new Date(now.getTime() + (vmWaitMs ?? uncertainStartRetryMs)),
      });
      return { status: "parked" as const };
    }
    let handedOff = false;
    try {
      handedOff = await handOffBrowserRunRetry(row.id, {
        captchaAttempt: attempt,
        conversationChannel: row.conversationChannel,
        conversationId: row.conversationId,
        id: run.id,
        paymentAllowed: row.paymentAllowed,
        profileId: row.profileId,
        replyAnchorMessageId: row.replyAnchorMessageId,
        rootSessionId: row.rootSessionId,
        sessionId: run.sessionId,
        site: row.site,
        status: "running",
        // The retry is the same errand, so it carries the person's approval
        // to submit, and nothing more: its task is the previous attempt's.
        submission: row.submission,
        task: row.task,
        // Whatever the parked row still holds unread carries to the row that
        // takes the errand over: a message queued in during an earlier
        // attempt must reach whichever attempt finally reports the errand.
        unreadMessages: row.unreadMessages,
      });
    } catch (error) {
      await abandonRetryRun(run.id);
      throw error;
    }
    if (!handedOff) {
      await abandonRetryRun(run.id);
      return { status: "stopped" as const };
    }
    return { runId: run.id, status: "started" as const };
  } catch (error) {
    console.warn("[browser-use] the anti-bot retry could not start", {
      attempt,
      cause: error,
      runId: row.id,
    });
    const retryAt = captchaRetryAt(attempt, now, onVm);
    if (retryAt === undefined) return { status: "exhausted" as const };
    await parkBrowserRunForRetry(row.id, { captchaAttempt: attempt, retryAt });
    return { status: "parked" as const };
  }
}
