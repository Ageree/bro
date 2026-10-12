import type { SessionContext } from "eve/context";
import { z } from "zod";
import { agencyPilot } from "@agent/lib/agency/pilot";

const scheduledReportIdentitySchema = z.object({
  photonReplyAnchorMessageId: z.string().min(1).optional(),
  telegramReplyAnchorMessageId: z.string().min(1).optional(),
  scheduleId: z.uuid(),
  scheduledReportLeaseToken: z.uuid(),
  scheduledReportSequence: z.coerce.number().int().positive(),
  scheduledRunId: z.uuid(),
  scheduledRunSessionId: z.string().min(1).optional(),
});
const scheduledRunIdentitySchema = z.object({
  scheduledRunId: z.uuid(),
  scheduledRunKind: z.enum(["agentic", "proactive"]).optional(),
  scheduledRunLeaseToken: z.uuid(),
});

/**
 * The kind a proactive run starts as, read when it is dispatched: `agentic` in
 * the agency pilot. The worker's mode reads the pilot again on every step, so
 * turning the pilot off moves a run already started to the proactive worker.
 */
export function proactiveRunKind(workspaceId: string) {
  return agencyPilot(workspaceId)
    ? ("agentic" as const)
    : ("proactive" as const);
}

export function scheduledRunIdentity(auth: SessionContext["session"]["auth"]) {
  const caller =
    auth.current?.authenticator === "scheduled-worker"
      ? auth.current
      : auth.initiator?.authenticator === "scheduled-worker"
        ? auth.initiator
        : undefined;
  if (caller?.authenticator !== "scheduled-worker") return undefined;
  const identity = scheduledRunIdentitySchema.safeParse(caller.attributes);
  return identity.success
    ? {
        leaseToken: identity.data.scheduledRunLeaseToken,
        // The agentic worker is the proactive check upgraded: same limits.
        proactive: identity.data.scheduledRunKind !== undefined,
        runId: identity.data.scheduledRunId,
      }
    : undefined;
}

export function scheduledReportIdentity(
  auth: SessionContext["session"]["auth"]
) {
  const caller = auth.current ?? auth.initiator;
  if (caller?.authenticator !== "scheduled-result") return undefined;
  const identity = scheduledReportIdentitySchema.safeParse(caller.attributes);
  return identity.success
    ? {
        replyAnchorMessageId:
          identity.data.photonReplyAnchorMessageId ??
          identity.data.telegramReplyAnchorMessageId,
        scheduleId: identity.data.scheduleId,
        leaseToken: identity.data.scheduledReportLeaseToken,
        runId: identity.data.scheduledRunId,
        sequence: identity.data.scheduledReportSequence,
        workerSessionId: identity.data.scheduledRunSessionId,
      }
    : undefined;
}
