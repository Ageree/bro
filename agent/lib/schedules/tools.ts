import type { ToolContext } from "eve/tools";
import { z } from "zod";
import type {
  createScheduledAgentJob,
  listScheduledAgentJobs,
} from "@db/services/scheduled-agent-jobs";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { telegramConversationIdSchema } from "@agent/lib/telegram-conversation";

function scheduleCaller(context: ToolContext) {
  const auth = context.session.auth.current;
  if (auth?.principalType !== "user") {
    throw new Error("An authenticated user is required to manage schedules.");
  }
  return auth;
}

/** Whose schedules these are: the person's, from any chat or channel. */
export function scheduleScope(context: ToolContext) {
  return scopeFromPrincipal(scheduleCaller(context));
}

/** The person and the chat a new schedule is made in. */
export function scheduleOwner(context: ToolContext) {
  const auth = scheduleCaller(context);
  const conversationChannel = z
    .enum(["eve", "photon", "telegram"])
    .parse(auth.attributes.conversationChannel);
  const conversationId =
    conversationChannel === "eve"
      ? context.session.id
      : conversationChannel === "photon"
        ? z
            .string()
            .startsWith("imessage:")
            .parse(auth.attributes.conversationId)
        : telegramConversationIdSchema.parse(auth.attributes.conversationId);
  return {
    conversation: { conversationChannel, conversationId },
    scope: scopeFromPrincipal(auth),
  };
}

export function scheduleReplyAnchor(context: ToolContext) {
  const auth = context.session.auth.current;
  const anchorAttribute =
    auth?.attributes.conversationChannel === "photon"
      ? auth.attributes.photonMessageId
      : auth?.attributes.conversationChannel === "telegram"
        ? auth.attributes.telegramMessageId
        : undefined;
  const messageId = z.string().min(1).safeParse(anchorAttribute);
  return messageId.success ? messageId.data : undefined;
}

// The chat a schedule was made in, named the way the person knows it.
const createdInLabel = {
  eve: "web chat",
  photon: "iMessage",
  telegram: "Telegram",
} as const;

export function scheduleSummary(
  job: Awaited<ReturnType<typeof createScheduledAgentJob>>
) {
  return {
    createdAt: job.createdAt.toISOString(),
    createdIn: createdInLabel[job.conversationChannel],
    id: job.id,
    lastError: job.lastError,
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    nextRunAt: job.nextRunAt?.toISOString() ?? null,
    prompt: job.prompt,
    status: job.status,
    timing: job.timing,
  };
}

export function scheduleListSummary(
  job: Awaited<ReturnType<typeof listScheduledAgentJobs>>[number]
) {
  const latestRun = job.latestRun;
  return {
    ...scheduleSummary(job),
    latestRun: latestRun
      ? {
          completedAt: latestRun.completedAt?.toISOString() ?? null,
          id: latestRun.id,
          lastError: latestRun.lastError,
          reportStatus: latestRun.reportStatus,
          scheduledFor: latestRun.scheduledFor.toISOString(),
          sessionId: latestRun.workerSessionId,
          startedAt: latestRun.startedAt?.toISOString() ?? null,
          status: latestRun.status,
        }
      : null,
  };
}
