import { quietHoursEnd } from "@agent/lib/proactive/quiet-hours";
import {
  claimScheduledReport,
  deferScheduledReport,
  dropScheduledReport,
} from "@db/services/scheduled-agent-jobs";
import {
  readProactiveMessages,
  readWorkspaceTimeZone,
} from "@db/services/user-profile";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Decides whether a finished proactive run may write now. A person who turned
 * proactive messages off after the run started gets nothing; one who is
 * asleep gets it after quiet hours. Returns true when the report was held.
 */
export async function holdProactiveReport(
  report: { readonly runId: string; readonly scope: AccessScope },
  now = new Date()
) {
  const [enabled, timeZone] = await Promise.all([
    readProactiveMessages(report.scope),
    readWorkspaceTimeZone(report.scope),
  ]);
  if (!enabled) {
    const claimed = await claimScheduledReport(report.runId, now);
    const leaseToken = claimed?.run.reportLeaseToken;
    if (leaseToken) {
      await dropScheduledReport(report.runId, leaseToken, now);
    }
    return true;
  }
  const quietUntil = quietHoursEnd(now, timeZone);
  if (!quietUntil) return false;
  await deferScheduledReport(report.runId, quietUntil, now);
  return true;
}
