import { queueFollowUpRun } from "@db/services/proactive";
import { agencyPilot } from "@agent/lib/agency/pilot";
import { followUpSignal, maxRunsPerDay } from "./signals";

/**
 * Wakes the agentic worker on a finished phone call or browser run, in the
 * agency pilot only: the item is queued as a proactive run, and the worker
 * looks it up (`phone-status`, `browser_task` status) and decides the next
 * step. The run waits in the same cap as a check's run, and the report that
 * tells the person is held for their morning at night as usual
 * (`proactiveReportTiming`). A failure is logged and never fails the report.
 */
export async function wakeAgencyForOutcome(input: {
  readonly id: string;
  readonly source: "browser" | "phone";
  readonly workspaceId: string;
}) {
  if (!agencyPilot(input.workspaceId)) return;
  try {
    const queued = await queueFollowUpRun({
      maxRunsPerDay,
      now: new Date(),
      signal: followUpSignal(input.source, input.id),
      workspaceId: input.workspaceId,
    });
    console.info("[proactive] follow-up", {
      outcome: queued.status,
      source: input.source,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    console.warn("[proactive] follow-up failed", {
      cause: error,
      source: input.source,
      workspaceId: input.workspaceId,
    });
  }
}
