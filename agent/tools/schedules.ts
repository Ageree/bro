import { parseInputResponses, resolveTextToResponses } from "eve/client";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import {
  ownTurnApproval,
  resolveModeValue,
  startedByPerson,
} from "@agent/lib/mode";
import { reportCardHold } from "@agent/lib/delivery/report-cards";
import { answerableThisTurn } from "@agent/lib/schedules/question";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import {
  scheduleConfirmation,
  scheduleDelivery,
  scheduleListSummary,
  scheduleOwner,
  scheduleReplyAnchor,
  scheduleScope,
  scheduleSummary,
} from "@agent/lib/schedules/tools";
import { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import { skillsLayout } from "@agent/lib/skills/pilot";
import {
  localRunLabel,
  resolveScheduleTiming,
  scheduleTimingInputSchema,
  shortScheduleTimingInputSchema,
} from "@shared/schedules/timing";
import {
  createScheduledAgentJob,
  getScheduledAgentJob,
  getScheduledAgentRunInput,
  listScheduledAgentJobs,
  queueScheduledAgentRunNow,
  submitScheduledAgentRunAnswer,
  updateScheduledAgentJob,
} from "@db/services/scheduled-agent-jobs";
import {
  listLiveSubscriptions,
  setSubscriptionStatus,
} from "@db/services/subscriptions";
import { readWorkspaceTimeZone } from "@db/services/user-profile";

export function scheduleApproval(
  context: Parameters<typeof startedByPerson>[0]
): ApprovalStatus {
  return ownTurnApproval(context);
}

/**
 * The task each run does. RU d12 (25.09): «сколько ехать до работы на
 * машине» became «во сколько выезжать, чтобы быть к 10:00» — a time the
 * person never named, which every morning's run would have held to.
 */
const schedulePromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_000)
  .describe(
    "The task each run does, as the person asked it, with every input it needs. No condition the person did not state: no arrival time, deadline, threshold or filter you made up."
  );

/** What `schedules-create` takes, with the timing's words given. */
function createScheduleInput(timingSchema: typeof scheduleTimingInputSchema) {
  return z.object({
    missedRunPolicy: z.enum(["run_latest", "catch_up"]).default("run_latest"),
    // Weak models fill every optional field: an empty or «*» entry means
    // nothing is missing, and must never fail the schedule.
    missingInputs: z
      .array(z.string().max(200))
      .max(10)
      .optional()
      .describe(
        "Inputs each run needs that you found nowhere — not in the conversation, Personal Info or memory — named for the person, such as «адрес работы». Leave it out when nothing is missing."
      ),
    prompt: schedulePromptSchema,
    timing: timingSchema,
  });
}

const createScheduleInputSchema = createScheduleInput(
  scheduleTimingInputSchema
);

/**
 * A browser report's later step is set up after its message
 * (`reportCardHold`), and a schedule in a turn the person did not start
 * waits for their card.
 */
async function createScheduleApproval({
  session,
}: Pick<ApprovalContext<unknown>, "session">) {
  const held = await reportCardHold(session);
  return held === undefined
    ? scheduleApproval({ session })
    : { reason: held, type: "denied" as const };
}

async function runCreateSchedule(
  input: z.infer<typeof createScheduleInputSchema>,
  context: ToolContext
) {
  const held = await reportCardHold(context.session);
  if (held !== undefined) throw new Error(held);
  const owner = scheduleOwner(context);
  const timeZone = await readWorkspaceTimeZone(owner.scope);
  const job = await createScheduledAgentJob(owner.scope, {
    ...owner.conversation,
    missedRunPolicy: input.missedRunPolicy,
    prompt: input.prompt,
    replyAnchorMessageId: scheduleReplyAnchor(context),
    timing: resolveScheduleTiming(input.timing, timeZone),
  });
  const delivery = await scheduleDelivery(job);
  return {
    ...scheduleSummary(job, timeZone),
    deliversTo: delivery.deliversTo,
    reply: scheduleConfirmation(job, delivery, input.missingInputs ?? []),
  };
}

export const createSchedule = defineTool({
  approval: createScheduleApproval,
  description:
    "Create a one-time, fixed-interval, or timezone-aware calendar job for the person. «Напомни в 9», «напомни завтра в 10 позвонить маме», «через час» are one reminder: kind once, with at as the person's wall-clock time YYYY-MM-DDTHH:MM counted from their current local time. Human recurrence is a calendar rule in the person's timezone, which stays on the same wall-clock time across daylight saving time and months of different length: «каждое 5-е число» is frequency monthly with dayOfMonth 5, «в последний день месяца» dayOfMonth \"last\", «каждое второе воскресенье» monthly_weekday with occurrence 2 and weekday 0, «по понедельникам и средам» weekly with weekdays [1, 3], «каждый будний день» weekdays, «каждый год 12 марта» yearly. A daily, weekdays or weekly rule runs on public holidays too; only when the person asks to skip them («на праздники не присылай», «кроме праздников») set skipHolidays true, and in a Russian time zone the runs then skip the holidays and days off of the production calendar. Leave timezone out: the person's own zone from their profile is used. Use interval only for a fixed count of minutes or hours, never for months or years. Write into prompt, once, the exact requested work and every input each run needs — addresses (home, work, where to go), the city for the weather, which mailbox, calendar or site to look at, names and thresholds — taken from the conversation, Personal Info and memory: a run cannot see this conversation and must never ask for them again. Add nothing the person did not state: no arrival time («быть к 10:00»), deadline, threshold, filter or extra step of your own — a run treats every line of prompt as the person's wish. Name the parts of a daily summary in the person's own words («письма, на которые я не ответил», «сколько ехать до работы»), without your own definition of how to collect them: each run knows how. An input found nowhere does not hold the schedule up: create it, name it in missingInputs, ask for it in the same reply, and put the answer into prompt with schedules-update. The result's nextRunLocal is the first run on the person's clock: name exactly that day and time in the reply, and say what the result's reply asks. A scheduled run can never act in the user's name or pay — no booking, appointment, application, job application, receipt or order: it only checks, searches and stages up to the final step, and its report asks the user to confirm in the conversation. So for «записывай, как только появится слот» schedule the check and say the booking itself waits for the user's confirmation.",
  inputSchema: createScheduleInputSchema,
  execute: runCreateSchedule,
});

/**
 * `schedules-create` in the skills pilot's turns (`skillsLayout`): the rules
 * its description held are in the schedules skill's body, which comes with
 * the tool (`agent/lib/skills/tools.ts`).
 */
const shortCreateSchedule = defineTool({
  approval: createScheduleApproval,
  description:
    "Create a one-time, fixed-interval or calendar job for the person; the rules are in the schedules block. «Напомни завтра в 10» is kind once with at on their wall clock; a human recurrence is a calendar rule in their zone («каждое 5-е» monthly with dayOfMonth 5, «по будням» weekdays, «каждое второе воскресенье» monthly_weekday); interval only for a count of minutes or hours. Write into prompt the exact work and every input each run needs (addresses, city, mailbox, names), and nothing the person did not state. An input found nowhere goes into missingInputs and your reply asks for it. Name the result's nextRunLocal exactly. A run never acts or pays in the user's name: it checks and stages.",
  inputSchema: createScheduleInput(shortScheduleTimingInputSchema),
  execute: runCreateSchedule,
});

export const listSchedules = defineTool({
  description:
    "List all of the authenticated user's one-time and recurring jobs, whichever chat or channel each was made in. Use this before changing a schedule when the target is ambiguous. nextRunLocal is each next run on the person's clock.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const scope = scheduleScope(context);
    const [jobs, timeZone, watches] = await Promise.all([
      listScheduledAgentJobs(scope),
      readWorkspaceTimeZone(scope),
      // Only the pilot makes watches, but one made before a workspace left
      // the pilot is still listed, paused and deleted here.
      listLiveSubscriptions(scope),
    ]);
    return [
      ...jobs.map((job) => scheduleListSummary(job, timeZone)),
      ...watches.map((watch) => watchSummary(watch, timeZone)),
    ];
  },
});

/** A watch as the schedule tools show it: an id that pauses or deletes it. */
function watchSummary(
  watch: Awaited<ReturnType<typeof listLiveSubscriptions>>[number],
  timeZone: string
) {
  return {
    id: watch.id,
    kind: "price watch, checked by code every few hours",
    nextCheckLocal:
      watch.status === "active"
        ? localRunLabel(watch.nextCheckAt, timeZone)
        : null,
    // A deleted watch is kept as `cancelled`; the tools speak of deleting.
    status: watch.status === "cancelled" ? "deleted" : watch.status,
    untilLocal: localRunLabel(watch.expiresAt, timeZone),
    watch: watch.source,
    when: watch.condition,
  };
}

const watchChangeRefusal =
  "That is a price watch: it can only be paused, resumed or deleted (status). For a new threshold or term, call watch-create again with the same link.";
/** For a workspace whose watches are switched off (no `watch-create`). */
const heldWatchRefusal =
  "That is a price watch, and watches are switched off here now: it is not checked, and can only be paused or deleted (status). Say so plainly; offer a daily browser check (schedules-create) instead.";

/**
 * A change to one of the person's price watches, which schedules-update
 * also reaches by id. Undefined when the id is no live watch of theirs.
 */
async function updateWatch(
  scope: ReturnType<typeof scheduleScope>,
  id: string,
  status: "active" | "deleted" | "paused" | undefined
) {
  const watches = await listLiveSubscriptions(scope);
  if (!watches.some((watch) => watch.id === id)) return undefined;
  // Outside the pilot a watch is held by the tick, and stays so.
  const inPilot = await subscriptionsPilot(scope);
  if (status === undefined || (status === "active" && !inPilot)) {
    throw new Error(inPilot ? watchChangeRefusal : heldWatchRefusal);
  }
  const [watch, timeZone] = await Promise.all([
    setSubscriptionStatus(scope, id, status),
    readWorkspaceTimeZone(scope),
  ]);
  if (!watch) throw new Error("Schedule not found.");
  return watchSummary(watch, timeZone);
}

/** What `schedules-update` takes, with the timing's words given. */
function updateScheduleInput(timingSchema: typeof scheduleTimingInputSchema) {
  return z
    .object({
      id: z.uuid(),
      prompt: schedulePromptSchema.optional(),
      runNow: z
        .boolean()
        .optional()
        .describe(
          "true runs the schedule once right now, beside its regular runs: a trial the person agreed to, or «пришли сводку сейчас». Its report arrives in a few minutes where the schedule's reports go."
        ),
      status: z.enum(["active", "paused", "deleted"]).optional(),
      timing: timingSchema.optional(),
    })
    .refine(
      ({ prompt, runNow, status, timing }) =>
        prompt !== undefined ||
        runNow === true ||
        status !== undefined ||
        timing !== undefined,
      { message: "Provide at least one schedule change." }
    );
}

const updateScheduleInputSchema = updateScheduleInput(
  scheduleTimingInputSchema
);

async function runUpdateSchedule(
  { id, runNow, timing, ...patch }: z.infer<typeof updateScheduleInputSchema>,
  context: ToolContext
) {
  const scope = scheduleScope(context);
  // A call with only runNow changes nothing about the schedule itself.
  const changes =
    timing !== undefined ||
    patch.prompt !== undefined ||
    patch.status !== undefined;
  const [timeZone, current] = await Promise.all([
    readWorkspaceTimeZone(scope),
    timing || !changes ? getScheduledAgentJob(scope, id) : undefined,
  ]);
  if ((timing || !changes) && !current) {
    const watch = await updateWatch(
      scope,
      id,
      timing || runNow === true ? undefined : patch.status
    );
    if (watch) return watch;
    throw new Error("Schedule not found.");
  }
  // The new timing keeps what it leaves out: the rule's zone and its
  // holiday setting, not the profile's.
  const job = changes
    ? await updateScheduledAgentJob(scope, id, {
        ...patch,
        timing:
          timing && resolveScheduleTiming(timing, timeZone, current?.timing),
      })
    : current;
  if (!job) {
    const watch = await updateWatch(
      scope,
      id,
      patch.prompt === undefined && runNow !== true ? patch.status : undefined
    );
    if (watch) return watch;
    throw new Error("Schedule not found.");
  }
  // A call that pauses or deletes the schedule runs nothing, whatever a
  // model that fills every field put into runNow.
  if (
    runNow !== true ||
    patch.status === "paused" ||
    patch.status === "deleted"
  ) {
    return scheduleSummary(job, timeZone);
  }
  const [trial, delivery] = await Promise.all([
    queueScheduledAgentRunNow(scope, id),
    scheduleDelivery(job),
  ]);
  if (!trial) throw new Error("Schedule not found.");
  return {
    ...scheduleSummary(job, timeZone),
    runNow: trial.queued
      ? `One run starts within a minute; its report arrives in a few minutes in ${delivery.deliversTo}. Say so, and nothing more about it until it comes.`
      : "A run of this schedule is already on its way; its report comes when it ends. Nothing new was started.",
  };
}

export const updateSchedule = defineTool({
  approval: ({ session }) => scheduleApproval({ session }),
  description:
    "Update, pause, resume, or delete one of the authenticated user's scheduled jobs, whichever chat it was made in. Set status paused or active to pause or resume it; «сдвинь на 7:30» is a new timing with the same rule and the new localTime; «на праздники не присылай» is the same rule with skipHolidays true; «пришли сводку сейчас», or yes to a trial run, is runNow true. List schedules first when the target is ambiguous. The result's nextRunLocal is the next run on the person's clock: name exactly that in the reply.",
  inputSchema: updateScheduleInputSchema,
  execute: runUpdateSchedule,
});

/** `schedules-update` in the skills pilot's turns, as `shortCreateSchedule`. */
const shortUpdateSchedule = defineTool({
  approval: ({ session }) => scheduleApproval({ session }),
  description:
    "Update, pause (status paused), resume (active) or delete one of the person's schedules, whichever chat it was made in; list them first when the target is ambiguous. «Сдвинь на 7:30» is the same rule with the new localTime, a one-off a new at; «на праздники не присылай» the same rule with skipHolidays true; «пришли сводку сейчас» is runNow true. Name the result's nextRunLocal exactly in the reply.",
  inputSchema: updateScheduleInput(shortScheduleTimingInputSchema),
  execute: runUpdateSchedule,
});

const answerScheduleInputSchema = z.strictObject({
  answer: z.string().trim().min(1).max(8_000),
  runId: z.uuid(),
});

const notThePersonRefusal =
  "Nothing was sent: only the user's own reply answers a scheduled task's question, in the turn their message started. Never answer it yourself.";

const notRepliedRefusal =
  "Nothing was sent: the user's latest message is not a reply to that scheduled task's question, which was not put to them in this conversation right before they wrote it. Never answer a scheduled question yourself or guess what the user would say; if their message is about something else, just do what it asks.";

async function submitAnswer(
  context: ToolContext,
  runId: string,
  answer: string
) {
  const pending = await getScheduledAgentRunInput(
    scheduleScope(context),
    runId
  );
  if (!pending) {
    throw new Error("That scheduled task is not waiting for input.");
  }
  const responses = parseInputResponses(
    resolveTextToResponses(answer, pending.pendingInputRequests)
  );
  if (responses.length === 0) {
    throw new Error("That answer does not match the pending choices.");
  }
  const saved = await submitScheduledAgentRunAnswer(
    pending.runId,
    pending.leaseToken,
    responses
  );
  if (!saved) {
    throw new Error("That scheduled task is not waiting for input.");
  }
  return { accepted: true, runId };
}

export default defineDynamic({
  events: {
    // A scheduled report turn, a browser report or a worker speaks for
    // nobody, so only a turn the person's own message started may answer.
    "turn.started": (event, context) => {
      // The skills pilot's turns read the short descriptions.
      const short = skillsLayout(context) === "core";
      const managing = {
        "schedules-create": short ? shortCreateSchedule : createSchedule,
        "schedules-list": listSchedules,
        "schedules-update": short ? shortUpdateSchedule : updateSchedule,
      };
      // Only the person's own reply to a question put to them right before
      // it resumes a run: a model that answered for them — from the
      // conversation, from an old question they wrote past, or from
      // nothing, as one did in a turn about a message to a friend — is
      // refused.
      // `turn.started` carries the turn id where `step.started` does.
      const answerable = answerableThisTurn(
        context.messages,
        stepIdentity(
          stepStartedEventSchema.safeParse(event).data,
          context.session.id
        )
      );
      const answering = {
        ...managing,
        "schedules-answer": defineTool({
          description:
            "Resume a scheduled task whose question was put to the user in this conversation right before their latest message, with the user's own answer. Call it only when that message replies to the question, passing their answer exactly as given. Never answer for them — not from earlier context, not with a guess, not to tidy up an old task — and never call it for a question they were not just shown. The task picks the answer up within a minute or two.",
          inputSchema: answerScheduleInputSchema,
          async execute({ answer, runId }, toolContext) {
            if (!startedByPerson(toolContext)) {
              throw new Error(notThePersonRefusal);
            }
            if (!answerable.includes(runId)) {
              throw new Error(notRepliedRefusal);
            }
            return submitAnswer(toolContext, runId, answer);
          },
        }),
      };

      // Nor is the tool there without such a question: offered in every
      // turn, it drew in the answer to Bro's own `ask_question` (RU d15).
      const interactive: Partial<typeof answering> & typeof managing =
        startedByPerson(context) && answerable.length > 0
          ? answering
          : managing;
      return resolveModeValue(context, { interactive });
    },
  },
});
