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
 * check runs right at the end (`agent/schedules/proactive.ts`), and the report
 * of its run takes the night's held reports along (`absorbHeldProactiveReports`),
 * so the person gets one morning message; this is that run's head start.
 */
const morningHoldMs = 10 * 60_000;

/**
 * When a finished proactive run may write:
 * - `held`: not now. The person turned proactive messages off after the run
 *   started (the report is dropped), or is asleep (held for the morning).
 * - `night`: now, alone, during the night: the worker marked it as unable to
 *   wait, and the run could have carried such news — a night check's own
 *   run, or one handed a calendar event (a flight). A day run over ordinary
 *   mail that finished after 22:00 cannot wake anyone, whatever a letter made
 *   the worker write.
 * - `day`: now, taking the reports held over the night along.
 */
export async function proactiveReportTiming(
  report: {
    readonly carriesEvent: boolean;
    readonly runId: string;
    readonly scheduledFor: Date;
    readonly scope: AccessScope;
    readonly timeSensitive: boolean;
  },
  now = new Date()
): Promise<"day" | "held" | "night"> {
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
    return "held";
  }
  const quietUntil = quietHoursEnd(now, timeZone);
  if (!quietUntil) return "day";
  const mayWake =
    report.carriesEvent ||
    quietHoursEnd(report.scheduledFor, timeZone) !== undefined;
  if (report.timeSensitive && mayWake) return "night";
  await deferScheduledReport(
    report.runId,
    new Date(quietUntil.getTime() + morningHoldMs),
    now
  );
  return "held";
}
