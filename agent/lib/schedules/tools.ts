import type { ToolContext } from "eve/tools";
import { z } from "zod";
import {
  type createScheduledAgentJob,
  type listScheduledAgentJobs,
  reportConversations,
} from "@db/services/scheduled-agent-jobs";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { telegramConversationIdSchema } from "@agent/lib/telegram-conversation";
import { telegramLinkConfigured } from "@shared/identity/telegram-link";
import { localRunLabel } from "@shared/schedules/timing";

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

/**
 * A schedule as the model sees it. `nextRunLocal` is the next run on the
 * person's clock — the rule's own zone, or their profile zone for a one-off
 * or an interval — so the reply names the right day and hour.
 */
export function scheduleSummary(
  job: Awaited<ReturnType<typeof createScheduledAgentJob>>,
  personTimeZone: string
) {
  const timeZone =
    job.timing.kind === "calendar" ? job.timing.timezone : personTimeZone;
  return {
    createdAt: job.createdAt.toISOString(),
    createdIn: createdInLabel[job.conversationChannel],
    id: job.id,
    lastError: job.lastError,
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    nextRunAt: job.nextRunAt?.toISOString() ?? null,
    nextRunLocal: job.nextRunAt ? localRunLabel(job.nextRunAt, timeZone) : null,
    prompt: job.prompt,
    status: job.status,
    timing: job.timing,
  };
}

export function scheduleListSummary(
  job: Awaited<ReturnType<typeof listScheduledAgentJobs>>[number],
  personTimeZone: string
) {
  const latestRun = job.latestRun;
  return {
    ...scheduleSummary(job, personTimeZone),
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

type ScheduledJob = Awaited<ReturnType<typeof createScheduledAgentJob>>;

/**
 * Where a schedule's reports arrive, as its confirmation names it: the
 * messenger the person last wrote from, or else the web chat
 * (`reportConversations`). RU d12 (25.09): a summary set up in the web chat
 * would have gone to Telegram, and the reply did not say so.
 */
export async function scheduleDelivery(job: ScheduledJob) {
  const { delivery } = await reportConversations(job);
  const here =
    delivery.conversationChannel === job.conversationChannel &&
    delivery.conversationId === job.conversationId;
  if (delivery.conversationChannel === "eve") {
    return {
      deliversTo: here
        ? "this web chat: the person has no Telegram or iMessage chat with Bro"
        : "the person's latest web chat",
      webOnly: true,
    };
  }
  const name = createdInLabel[delivery.conversationChannel];
  return {
    deliversTo: here
      ? `${name}, this chat`
      : `${name}, the messenger the person last wrote from, not this chat`,
    webOnly: false,
  };
}

/**
 * A run that measures the way somewhere: the map knows no traffic. Travel
 * words only: «Google Drive», «My Drive» and a «driver's licence» are not a
 * drive to work.
 */
const travelTask =
  /(?:ехать|езды|в пути|пробк|маршрут|до работы|на работу|до офиса|commute|(?<!(?:google|my)\s)\bdriv(?:e|es|ing)\b|traffic)/iu;

/**
 * What the confirmation of a new schedule tells the person besides its first
 * run. RU d12 (25.09): «сводка будет приходить каждый будний день в 8:00»
 * said neither where it arrives, nor how to move or pause it, nor that the
 * drive would be missing until the work address came, and offered no trial
 * before the first Monday.
 */
export function scheduleConfirmation(
  job: ScheduledJob,
  delivery: Awaited<ReturnType<typeof scheduleDelivery>>,
  missingInputs: readonly string[]
) {
  const missing = missingInputs
    .map((input) => input.trim())
    .filter((input) => !/^(?:|\*|-|—|нет|none|n\/a)$/iu.test(input));
  return [
    `In the reply name the first run (nextRunLocal) and where each report arrives: ${delivery.deliversTo}.`,
    ...(delivery.webOnly && telegramLinkConfigured()
      ? [
          "The web chat sends no notifications: offer to link Telegram (link_telegram) so reports arrive with one.",
        ]
      : []),
    ...(job.timing.kind === "once"
      ? []
      : [
          "Say it changes in plain words: «сдвинь на 7:30», «на праздники не присылай», «поставь на паузу», «удали».",
          "If each run gathers something (a summary, a check) rather than only reminding, offer to send one right now as a trial; on the person's yes, call schedules-update with runNow true.",
        ]),
    ...(travelTask.test(job.prompt)
      ? [
          "About the way there, promise the map time without traffic, with a rush-hour margin and a map link that shows live traffic — never «с учётом пробок».",
        ]
      : []),
    ...(missing.length > 0
      ? [
          `Until the person gives ${missing.map((input) => `«${input}»`).join(", ")}, each run leaves out the part that needs it: say so plainly, ask for it in this reply, and put the answer into prompt with schedules-update.`,
        ]
      : []),
  ].join(" ");
}
