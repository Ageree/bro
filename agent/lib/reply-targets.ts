import { defineState, type SessionAuth } from "eve/context";
import { z } from "zod";
import { scheduledReportIdentity } from "@agent/lib/schedules/identity";
import type { ReplyReference } from "@shared/chat/message-delivery";

// Photon encodes its iMessage conversations as `imessage:<chat guid>`.
const photonConversationIdSchema = z.string().startsWith("imessage:");
const photonReplyTargetSchema = z.strictObject({
  conversationId: photonConversationIdSchema,
  messageId: z.string().min(1),
});

type PhotonReplyTarget = z.infer<typeof photonReplyTargetSchema>;

const backgroundReplyTargets = defineState<Record<string, PhotonReplyTarget>>(
  "open-instinct.background-reply-targets",
  () => ({})
);

const maximumBackgroundReplyTargets = 100;

export function registerBackgroundReplyTarget(
  taskId: string,
  auth: SessionAuth
) {
  const target = currentPhotonReplyTarget(auth);
  if (!target) return;

  backgroundReplyTargets.update((current) =>
    Object.fromEntries(
      [
        ...Object.entries(current).filter(([id]) => id !== taskId),
        [taskId, target] as const,
      ].slice(-maximumBackgroundReplyTargets)
    )
  );
}

export function resolvePhotonReplyTarget(
  reference: ReplyReference | undefined,
  auth: SessionAuth
) {
  if (!reference) return undefined;

  const conversationId = currentPhotonConversationId(auth);
  if (!conversationId) return undefined;

  if (reference.kind === "current") {
    return currentPhotonReplyTarget(auth);
  }

  if (reference.kind === "task") {
    const target = backgroundReplyTargets.get()[reference.id];
    return target?.conversationId === conversationId ? target : undefined;
  }

  const report = scheduledReportIdentity(auth);
  if (report?.scheduleId !== reference.id || !report.replyAnchorMessageId) {
    return undefined;
  }
  return {
    conversationId,
    messageId: report.replyAnchorMessageId,
  } satisfies PhotonReplyTarget;
}

function currentPhotonConversationId(auth: SessionAuth) {
  const caller = auth.current ?? auth.initiator;
  if (caller?.attributes.conversationChannel !== "photon") return undefined;
  const parsed = photonConversationIdSchema.safeParse(
    caller.attributes.conversationId
  );
  return parsed.success ? parsed.data : undefined;
}

function currentPhotonReplyTarget(auth: SessionAuth) {
  const caller = auth.current;
  if (caller?.attributes.conversationChannel !== "photon") return undefined;
  const parsed = photonReplyTargetSchema.safeParse({
    conversationId: caller.attributes.conversationId,
    messageId: caller.attributes.photonMessageId,
  });
  return parsed.success ? parsed.data : undefined;
}
