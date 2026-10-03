import { quietHoursEnd } from "@agent/lib/proactive/quiet-hours";
import { deferScheduledReport } from "@db/services/scheduled-agent-jobs";
import { readSubscriptionWake } from "@db/services/subscriptions";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import type { AccessScope } from "@shared/identity/access-scope";

/** A held report goes out this long after the night ends, not on the dot. */
const morningHoldMs = 10 * 60_000;

/**
 * Whether a watch's report may go out now: the watch's wake rule
 * (`subscriptions.wake`). By day it always may. In the person's quiet hours
 * only a watch that may wake them (`urgent_at_night`) gets through, and only
 * with news marked time-sensitive; anything else — a price that dropped at
 * 03:00 — is held for the morning. Returns whether to send now.
 */
export async function subscriptionReportDue(
  report: {
    readonly jobId: string;
    readonly runId: string;
    readonly scope: AccessScope;
    readonly timeSensitive: boolean;
  },
  now = new Date()
) {
  const timeZone = await readWorkspaceTimeZone(report.scope);
  const quietUntil = quietHoursEnd(now, timeZone);
  if (!quietUntil) return true;
  if (report.timeSensitive) {
    const wake = await readSubscriptionWake(report.jobId);
    if (wake === "urgent_at_night") return true;
  }
  await deferScheduledReport(
    report.runId,
    new Date(quietUntil.getTime() + morningHoldMs),
    now
  );
  return false;
}
