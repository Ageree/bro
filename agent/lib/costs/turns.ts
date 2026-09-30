import type { SessionContext } from "eve/context";
import { z } from "zod";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { startedByPerson } from "@agent/lib/mode";

type SessionAuth = SessionContext["session"]["auth"];

const workspaceCallerSchema = z.object({
  attributes: z.object({ workspaceId: z.string().min(1) }),
});

/**
 * Whose turn a model step belongs to, as the accounting splits it: the
 * person's own message on any channel, the report of a browser run, or a
 * turn Bro opened for itself (a schedule's worker or its report, a mail
 * check). It is decided by the caller that opened the turn, as
 * `startedByPerson` decides it for permissions.
 */
export function turnCostSource(auth: SessionAuth) {
  const runId = reportedBrowserRunId(auth.current);
  if (runId !== undefined) {
    return { runId, source: "browser-report" as const };
  }
  if (startedByPerson({ session: { auth } })) {
    return { runId: undefined, source: "chat" as const };
  }
  return { runId: undefined, source: "background" as const };
}

/**
 * The workspace a turn is for. Every caller Bro admits carries it — the
 * person's sign-in, a schedule's worker, a browser report — and a turn
 * without one (a subagent's, say) is not recorded.
 */
export function turnWorkspaceId(auth: SessionAuth) {
  return (
    workspaceCallerSchema.safeParse(auth.current).data?.attributes
      .workspaceId ??
    workspaceCallerSchema.safeParse(auth.initiator).data?.attributes.workspaceId
  );
}
