import {
  claimBrowserRunBrowser,
  releaseBrowserRunBrowser,
  unclaimBrowserRunBrowser,
} from "@db/services/browser-runs";
import { BrowserUseError, stopBrowserUseSessionBrowsers } from "./client";
import { browserRunNeeds, type BrowserRunNeed } from "./outcome";

/**
 * Stopping a run's browser so the profile keeps its sign-ins. Browser Use
 * writes a browser's cookies to its profile only on a clean stop; one the
 * cloud ends itself — about twenty minutes after its last run, or at four
 * hours — loses what changed in it. Whoever stops a page claims it first
 * (`claimBrowserRunBrowser`), so a follow-up about to use the same page and
 * the poller's idle stop never both get it.
 */

/**
 * Stops where the person acts in that very page right now: a code goes into
 * it, an approval in their app or 3-D Secure completes it, a password is
 * typed in it through the live view. Such a page is theirs until it has sat
 * idle, and a second sign-in to the same account meanwhile would send a code
 * that cancels theirs.
 */
export const personStepNeeds: ReadonlySet<BrowserRunNeed> = new Set([
  "3ds",
  "email_code",
  "password",
  "push",
  "sms_code",
]);

/**
 * Whether a settled run leaves its page up for the person. Every stop does
 * but a finished errand and an anti-bot wall, as before this browser kept
 * sign-ins: a code or an approval goes into that page, a staged option
 * (`decision`, `payment`) waits there for the person's card and its
 * follow-up finishes it in the same tab — the seat, the slot, the taxi form
 * are page state no account keeps — and a question (`address`, `info`) is
 * answered where the run stopped. A finished errand and a wall close the
 * browser at once: that clean stop is what writes the sign-in to the
 * profile. A kept page is closed the same clean way by the poller's idle
 * stop if nobody follows it up (`closeIdleBrowsers`); until then it holds its
 * account (`accountInUse`).
 */
export function keepsPage(need: BrowserRunNeed) {
  return need !== "none" && need !== "captcha";
}

/** The need a settled run's row records, from the `Needs:` line of its outcome. */
export function recordedNeed(outcome: string | null | undefined) {
  const need = /^needs:[ \t]*([a-z0-9_]+)[ \t]*$/imu
    .exec(outcome ?? "")?.[1]
    ?.toLowerCase();
  return browserRunNeeds.find((candidate) => candidate === need);
}

/**
 * Stop the run's browser so the profile keeps what it earned — the sign-ins,
 * and the cookies a site hands out once a check is passed, which is what
 * makes the next check less likely. The page is claimed first
 * (`claimBrowserRunBrowser`): a follow-up that took it a moment ago keeps
 * it. True when the run holds no browser any more, which the row then
 * records. Never fatal: a browser left up is stopped by the poller's idle
 * stop instead.
 */
export async function persistProfileCookies(runId: string, sessionId: string) {
  const claimedAt = new Date();
  try {
    if (!(await claimBrowserRunBrowser(runId, claimedAt))) return false;
  } catch (error) {
    console.warn("[browser-use] the run's page could not be claimed", {
      cause: error,
      runId,
    });
    return false;
  }
  return stopClaimedBrowser(runId, sessionId, claimedAt);
}

/**
 * Stop the browser of a run whose page this caller claimed at `claimedAt`.
 * A stop that did not happen gives the page back for a later try; one that
 * did, or a session Browser Use no longer has, releases the row and its
 * dead live view.
 */
export async function stopClaimedBrowser(
  runId: string,
  sessionId: string,
  claimedAt: Date
) {
  try {
    const stopped = await stopBrowserUseSessionBrowsers(sessionId, runId);
    if (stopped !== "running") {
      await releaseBrowserRunBrowser(runId);
      return true;
    }
  } catch (error) {
    // A session Browser Use no longer has holds no browser either.
    if (error instanceof BrowserUseError && error.status === 404) {
      await releaseBrowserRunBrowser(runId).catch(() => undefined);
      return true;
    }
    console.warn("[browser-use] the run's browser could not be stopped", {
      cause: error,
      sessionId,
    });
  }
  await unclaimBrowserRunBrowser(runId, claimedAt).catch(() => undefined);
  return false;
}

/**
 * A cancelled or expired run signs in to nothing any more: its browser is
 * stopped if it can be, and its row is released either way, so the account
 * is not held for a quarter of an hour by an errand the person ended
 * (`accountInUse`). A browser whose stop did not land is left to the
 * cloud's own cleanup, which writes nothing to the profile.
 */
export async function releaseEndedRunBrowser(
  runId: string,
  sessionId: string | null
) {
  try {
    if (sessionId !== null && (await persistProfileCookies(runId, sessionId))) {
      return;
    }
    await releaseBrowserRunBrowser(runId);
  } catch (error) {
    console.warn("[browser-use] the ended run could not be released", {
      cause: error,
      runId,
    });
  }
}
