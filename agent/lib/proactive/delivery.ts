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
 * How long past the end of the night a held report waits. The first morning
 * check runs right at the end (`agent/schedules/proactive.ts`) and folds the
 * night's held reports into its own run, so the person gets one morning
 * message; this is the check's head start, not a delay anyone waits out.
 */
export const morningFoldWindowMs = 10 * 60_000;

/**
 * Decides whether a finished proactive run may write now. A person who turned
 * proactive messages off after the run started gets nothing; one who is
 * asleep gets it in the morning, unless the worker marked it as unable to
 * wait (a flight within hours, a real security alert). Returns true when the
 * report was held.
 */
export async function holdProactiveReport(
  report: {
    readonly runId: string;
    readonly scope: AccessScope;
    readonly timeSensitive: boolean;
  },
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
  if (!quietUntil || report.timeSensitive) return false;
  await deferScheduledReport(
    report.runId,
    new Date(quietUntil.getTime() + morningFoldWindowMs),
    now
  );
  return true;
}
