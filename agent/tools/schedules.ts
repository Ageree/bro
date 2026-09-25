import { parseInputResponses, resolveTextToResponses } from "eve/client";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import type { ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { resolveModeValue, startedByPerson } from "@agent/lib/mode";
import { answerableScheduledQuestions } from "@agent/lib/schedules/question";
import {
  scheduleListSummary,
  scheduleOwner,
  scheduleReplyAnchor,
  scheduleScope,
  scheduleSummary,
} from "@agent/lib/schedules/tools";
import {
  resolveScheduleTiming,
  scheduleTimingInputSchema,
} from "@shared/schedules/timing";
import {
  createScheduledAgentJob,
  getScheduledAgentJob,
  getScheduledAgentRunInput,
  listScheduledAgentJobs,
  submitScheduledAgentRunAnswer,
  updateScheduledAgentJob,
} from "@db/services/scheduled-agent-jobs";
import { readWorkspaceTimeZone } from "@db/services/user-profile";

/**
 * A schedule's prompt is later run by a worker as the person's own task,
 * with their mail and the web at hand. In a turn the person did not start —
 * a browser run's report, whose text the page writes — a schedule could carry
 * the page's words into that task, so it waits for the person's card showing
 * what it will do and when. In their own turn it goes ahead as asked.
 */
export function scheduleApproval(
  context: Parameters<typeof startedByPerson>[0]
): ApprovalStatus {
  return startedByPerson(context) ? "not-applicable" : "user-approval";
}

export const createSchedule = defineTool({
  approval: ({ session }) => scheduleApproval({ session }),
  description:
    "Create a one-time, fixed-interval, or timezone-aware calendar job for the person. «Напомни в 9», «напомни завтра в 10 позвонить маме», «через час» are one reminder: kind once, with at as the person's wall-clock time YYYY-MM-DDTHH:MM counted from their current local time. Human recurrence is a calendar rule in the person's timezone, which stays on the same wall-clock time across daylight saving time and months of different length: «каждое 5-е число» is frequency monthly with dayOfMonth 5, «в последний день месяца» dayOfMonth \"last\", «каждое второе воскресенье» monthly_weekday with occurrence 2 and weekday 0, «по понедельникам и средам» weekly with weekdays [1, 3], «каждый будний день» weekdays, «каждый год 12 марта» yearly. A daily, weekdays or weekly rule runs on public holidays too; only when the person asks to skip them («на праздники не присылай», «кроме праздников») set skipHolidays true, and in a Russian time zone the runs then skip the holidays and days off of the production calendar. Leave timezone out: the person's own zone from their profile is used. Use interval only for a fixed count of minutes or hours, never for months or years. Write into prompt, once, the exact requested work and every input each run needs — addresses (home, work, where to go), the city for the weather, which mailbox, calendar or site to look at, names and thresholds — taken from the conversation, Personal Info and memory: a run cannot see this conversation and must never ask for them again. An input found nowhere does not hold the schedule up: create it, ask for that input in the same reply, and put the answer into prompt with schedules-update. The result's nextRunLocal is the first run on the person's clock: name exactly that day and time in the reply. A scheduled run can never act in the user's name or pay — no booking, appointment, application, job application, receipt or order: it only checks, searches and stages up to the final step, and its report asks the user to confirm in the conversation. So for «записывай, как только появится слот» schedule the check and say the booking itself waits for the user's confirmation.",
  inputSchema: z.object({
    missedRunPolicy: z.enum(["run_latest", "catch_up"]).default("run_latest"),
    prompt: z.string().trim().min(1).max(8_000),
    timing: scheduleTimingInputSchema,
  }),
  async execute(input, context) {
    const owner = scheduleOwner(context);
    const timeZone = await readWorkspaceTimeZone(owner.scope);
    return scheduleSummary(
      await createScheduledAgentJob(owner.scope, {
        ...owner.conversation,
        missedRunPolicy: input.missedRunPolicy,
        prompt: input.prompt,
        replyAnchorMessageId: scheduleReplyAnchor(context),
        timing: resolveScheduleTiming(input.timing, timeZone),
      }),
      timeZone
    );
  },
});

export const listSchedules = defineTool({
  description:
    "List all of the authenticated user's one-time and recurring jobs, whichever chat or channel each was made in. Use this before changing a schedule when the target is ambiguous. nextRunLocal is each next run on the person's clock.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const scope = scheduleScope(context);
    const [jobs, timeZone] = await Promise.all([
      listScheduledAgentJobs(scope),
      readWorkspaceTimeZone(scope),
    ]);
    return jobs.map((job) => scheduleListSummary(job, timeZone));
  },
});

const updateScheduleInputSchema = z
  .object({
    id: z.uuid(),
    prompt: z.string().trim().min(1).max(8_000).optional(),
    status: z.enum(["active", "paused", "deleted"]).optional(),
    timing: scheduleTimingInputSchema.optional(),
  })
  .refine(
    ({ prompt, status, timing }) =>
      prompt !== undefined || status !== undefined || timing !== undefined,
    { message: "Provide at least one schedule change." }
  );

export const updateSchedule = defineTool({
  approval: ({ session }) => scheduleApproval({ session }),
  description:
    "Update, pause, resume, or delete one of the authenticated user's scheduled jobs, whichever chat it was made in. Set status paused or active to pause or resume it; «сдвинь на 7:30» is a new timing with the same rule and the new localTime; «на праздники не присылай» is the same rule with skipHolidays true. List schedules first when the target is ambiguous. The result's nextRunLocal is the next run on the person's clock: name exactly that in the reply.",
  inputSchema: updateScheduleInputSchema,
  async execute({ id, timing, ...patch }, context) {
    const scope = scheduleScope(context);
    const [timeZone, current] = await Promise.all([
      readWorkspaceTimeZone(scope),
      timing ? getScheduledAgentJob(scope, id) : undefined,
    ]);
    if (timing && !current) throw new Error("Schedule not found.");
    // The new timing keeps what it leaves out: the rule's zone and its
    // holiday setting, not the profile's.
    const job = await updateScheduledAgentJob(scope, id, {
      ...patch,
      timing:
        timing && resolveScheduleTiming(timing, timeZone, current?.timing),
    });
    if (!job) throw new Error("Schedule not found.");
    return scheduleSummary(job, timeZone);
  },
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
    "turn.started": (_event, context) => {
      const managing = {
        "schedules-create": createSchedule,
        "schedules-list": listSchedules,
        "schedules-update": updateSchedule,
      };
      // Only the person's own reply to a question put to them right before
      // it resumes a run: a model that answered for them — from the
      // conversation, from an old question they wrote past, or from
      // nothing, as one did in a turn about a message to a friend — is
      // refused.
      const answerable = answerableScheduledQuestions(context.messages);
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
