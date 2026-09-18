import { defineState, type SessionAuth } from "eve/context";
import { z } from "zod";
import { scheduledReportIdentity } from "@agent/lib/schedules/identity";
import { telegramConversationIdSchema } from "@agent/lib/telegram-conversation";
import type { ReplyReference } from "@shared/chat/message-delivery";

// Photon encodes its iMessage conversations as `imessage:<chat guid>`, and
// Telegram as eve's `<chatId>:<threadId>:<anchorId>` continuation token.
const conversationIdSchema = {
  photon: z.string().startsWith("imessage:"),
  telegram: telegramConversationIdSchema,
};

type ConversationChannel = keyof typeof conversationIdSchema;

const messageIdAttribute = {
  photon: "photonMessageId",
  telegram: "telegramMessageId",
} as const satisfies Record<ConversationChannel, string>;

const replyTargetSchema = z.strictObject({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
});

type ReplyTarget = z.infer<typeof replyTargetSchema>;

const backgroundReplyTargets = defineState<Record<string, ReplyTarget>>(
  "open-instinct.background-reply-targets",
  () => ({})
);

const maximumBackgroundReplyTargets = 100;

export function registerBackgroundReplyTarget(
  taskId: string,
  auth: SessionAuth
) {
  const target =
    currentReplyTarget("photon", auth) ?? currentReplyTarget("telegram", auth);
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
  return resolveReplyTarget("photon", reference, auth);
}

export function resolveTelegramReplyTarget(
  reference: ReplyReference | undefined,
  auth: SessionAuth
) {
  return resolveReplyTarget("telegram", reference, auth);
}

function resolveReplyTarget(
  channel: ConversationChannel,
  reference: ReplyReference | undefined,
  auth: SessionAuth
) {
  if (!reference) return undefined;

  const conversationId = currentConversationId(channel, auth);
  if (!conversationId) return undefined;

  if (reference.kind === "current") {
    return currentReplyTarget(channel, auth);
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
  } satisfies ReplyTarget;
}

function currentConversationId(
  channel: ConversationChannel,
  auth: SessionAuth
) {
  const caller = auth.current ?? auth.initiator;
  if (caller?.attributes.conversationChannel !== channel) return undefined;
  const parsed = conversationIdSchema[channel].safeParse(
    caller.attributes.conversationId
  );
  return parsed.success ? parsed.data : undefined;
}

function currentReplyTarget(channel: ConversationChannel, auth: SessionAuth) {
  const caller = auth.current;
  if (caller?.attributes.conversationChannel !== channel) return undefined;
  const conversationId = conversationIdSchema[channel].safeParse(
    caller.attributes.conversationId
  );
  if (!conversationId.success) return undefined;
  const parsed = replyTargetSchema.safeParse({
    conversationId: conversationId.data,
    messageId: caller.attributes[messageIdAttribute[channel]],
  });
  return parsed.success ? parsed.data : undefined;
}
