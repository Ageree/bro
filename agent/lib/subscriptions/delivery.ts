import { quietHoursEnd } from "@agent/lib/proactive/quiet-hours";
import {
  claimScheduledReport,
  deferScheduledReport,
  dropScheduledReport,
} from "@db/services/scheduled-agent-jobs";
import { readSubscriptionDelivery } from "@db/services/subscriptions";
import {
  readProactiveMessages,
  readWorkspaceTimeZone,
} from "@db/services/user-profile";
import type { AccessScope } from "@shared/identity/access-scope";

/** A held report goes out this long after the night ends, not on the dot. */
const morningHoldMs = 10 * 60_000;

/**
 * Whether a watch's report may go out now: the watch's wake rule
 * (`subscriptions.wake`). By day it always may. In the person's quiet hours
 * only a watch that may wake them (`urgent_at_night`) gets through, and only
 * with news marked time-sensitive; anything else — a price that dropped at
 * 03:00 — is held for the morning. A watch Bro started unasked, from Russian
 * Post's letter, speaks as Bro's own check: once the person has turned Bro's
 * own messages off, its report reaches nobody, as the check's own reports do
 * (`proactiveReportTiming`), even one found before. Returns whether to send
 * now.
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
  const [watch, timeZone] = await Promise.all([
    readSubscriptionDelivery(report.jobId),
    readWorkspaceTimeZone(report.scope),
  ]);
  if (watch.unasked && !(await readProactiveMessages(report.scope))) {
    const claimed = await claimScheduledReport(report.runId, now);
    const leaseToken = claimed?.run.reportLeaseToken;
    if (leaseToken) {
      await dropScheduledReport(report.runId, leaseToken, now);
    }
    return false;
  }
  const quietUntil = quietHoursEnd(now, timeZone);
  if (!quietUntil) return true;
  if (report.timeSensitive && watch.wake === "urgent_at_night") return true;
  await deferScheduledReport(
    report.runId,
    new Date(quietUntil.getTime() + morningHoldMs),
    now
  );
  return false;
}
