import { randomUUID } from "node:crypto";
import { env } from "@shared/environment";
import {
  handOffBrowserRunRetry,
  parkBrowserRunForRetry,
  readBrowserRun,
} from "@db/services/browser-runs";
import {
  cancelBrowserUseRun,
  createBrowserUseRun,
  findRecentBrowserUseRunByTaskLine,
  readBrowserUseRun,
} from "./client";
import { retryProxySettings } from "./proxy";
import { resolveBrowserSecretBindings } from "./secrets";

type BrowserRunRow = NonNullable<Awaited<ReturnType<typeof readBrowserRun>>>;

/**
 * How long an errand keeps trying a site that walls it off before the person
 * hears about it. Attempt 1 is the run they started; the waits between the
 * attempts after it grow, so a wall that lifts in a couple of minutes costs a
 * couple of minutes and one that does not is given about half an hour.
 */
export const maximumCaptchaAttempts = 5;
const retryDelaysMinutes = [2, 5, 9, 14] as const;

export const captchaRetryWindowMinutes = retryDelaysMinutes.reduce(
  (sum, minutes) => sum + minutes,
  0
);

/**
 * When the next attempt runs after attempt `failedAttempt` lost to an
 * anti-bot check, or nothing when the errand is out of attempts.
 */
export function captchaRetryAt(failedAttempt: number, now: Date) {
  if (failedAttempt >= maximumCaptchaAttempts) return undefined;
  const index = Math.min(Math.max(failedAttempt, 1), retryDelaysMinutes.length);
  const minutes = retryDelaysMinutes[index - 1] ?? 1;
  return new Date(now.getTime() + minutes * 60_000);
}

const retryMarker = "[Retry after an anti-bot check]";

/**
 * The previous attempt's instruction with a note about where this one
 * stands. The note replaces the one before it rather than piling up. The
 * waiting advice is Browser Use's own: its solver works a challenge by
 * itself, and a reload or a click in the middle restarts it.
 */
export function captchaRetryTask(
  previousTask: string,
  attempt: number,
  reference: string
) {
  const base = previousTask.split(`\n\n${retryMarker}`, 1)[0] ?? previousTask;
  return [
    base,
    [
      retryMarker,
      `An anti-bot check stopped the previous attempt, so this is attempt ${String(attempt)} of ${String(maximumCaptchaAttempts)}: a fresh browser on a different network address, with the same saved profile, cookies and sign-ins.`,
      "Go straight to the site and do the errand. When a check appears, first give the browser's built-in solver about ten seconds without reloading or clicking into it; then solve whatever is still there yourself.",
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
 * meanwhile is cancelled at once. A start that fails counts as a failed
 * attempt and is parked again, until the attempts run out and the caller
 * reports the wall. A run this attempt already started before its poller
 * died is found by its reference line and adopted, not started again.
 */
export async function startCaptchaRetry(row: BrowserRunRow, now = new Date()) {
  if (row.captchaAttempt >= maximumCaptchaAttempts) {
    return { status: "exhausted" as const };
  }
  const attempt = row.captchaAttempt + 1;
  try {
    const current = await readBrowserRun(row.id);
    if (current?.status !== "waiting" || current.retriedAsRunId) {
      return { status: "stopped" as const };
    }
    const scope = { userId: row.createdByUserId, workspaceId: row.workspaceId };
    const [previous, secrets] = await Promise.all([
      readBrowserUseRun(row.id),
      resolveBrowserSecretBindings(scope, {
        allowPayment: row.paymentAllowed,
        site: row.site ?? undefined,
      }),
    ]);
    const reference = retryReference(row.id, attempt);
    const run =
      (await findRecentBrowserUseRunByTaskLine(reference)) ??
      (await createBrowserUseRun({
        ...retryProxySettings(attempt, randomUUID().replaceAll("-", "")),
        maxCostUsd: env.BROWSER_USE_MAX_COST_USD,
        model: env.BROWSER_USE_MODEL,
        profileId: row.profileId ?? undefined,
        secretBindings: secrets.bindings,
        task: captchaRetryTask(previous.task, attempt, reference),
      }));
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
        task: row.task,
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
    const retryAt = captchaRetryAt(attempt, now);
    if (retryAt === undefined) return { status: "exhausted" as const };
    await parkBrowserRunForRetry(row.id, { captchaAttempt: attempt, retryAt });
    return { status: "parked" as const };
  }
}
