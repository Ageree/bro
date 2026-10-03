import type { SessionContext } from "eve/context";
import { z } from "zod";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { startedByPerson } from "@agent/lib/mode";

type SessionAuth = SessionContext["session"]["auth"];

const workspaceCallerSchema = z.object({
  attributes: z.object({ workspaceId: z.string().min(1) }),
});

const scheduledCallerSchema = z.object({
  attributes: z.object({ scheduledRunId: z.string().min(1) }),
});

/**
 * Whose turn a model step belongs to, as the accounting splits it: the
 * person's own message on any channel, the report of a browser run, or a
 * turn Bro opened for itself (a schedule's worker or its report, a mail
 * check). It is decided by the caller that opened the turn, as
 * `startedByPerson` decides it for permissions. A turn of Bro's own carries
 * its scheduled run as `runId`, so what a schedule or a watch cost the model
 * is a sum over its job's runs: a watch that found nothing costs none.
 */
export function turnCostSource(auth: SessionAuth) {
  const runId = reportedBrowserRunId(auth.current);
  if (runId !== undefined) {
    return { runId, source: "browser-report" as const };
  }
  if (startedByPerson({ session: { auth } })) {
    return { runId: undefined, source: "chat" as const };
  }
  return {
    // A resumed worker's turn may carry its run only on the caller that
    // opened the session.
    runId:
      scheduledCallerSchema.safeParse(auth.current).data?.attributes
        .scheduledRunId ??
      scheduledCallerSchema.safeParse(auth.initiator).data?.attributes
        .scheduledRunId,
    source: "background" as const,
  };
}

/**
 * The workspace a turn is for. Every caller Bro admits carries it — the
 * person's sign-in, a schedule's worker, a browser report — and a turn
 * without one is not recorded. Subagents' steps never reach Bro's hooks
 * (eve `guides/hooks.md`, "Subagent isolation"), so they are not counted.
 */
export function turnWorkspaceId(auth: SessionAuth) {
  return (
    workspaceCallerSchema.safeParse(auth.current).data?.attributes
      .workspaceId ??
    workspaceCallerSchema.safeParse(auth.initiator).data?.attributes.workspaceId
  );
}
