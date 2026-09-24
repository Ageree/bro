import { parseInputResponses, resolveTextToResponses } from "eve/client";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
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
import { scheduleTimingSchema } from "@shared/schedules/timing";
import {
  createScheduledAgentJob,
  getScheduledAgentRunInput,
  listScheduledAgentJobs,
  submitScheduledAgentRunAnswer,
  updateScheduledAgentJob,
} from "@db/services/scheduled-agent-jobs";

export const createSchedule = defineTool({
  description:
    "Create a one-time, fixed-interval, or timezone-aware calendar job for the person. Human recurrence is a calendar rule in the person's timezone, which stays on the same wall-clock time across daylight saving time and months of different length: «каждое 5-е число» is frequency monthly with dayOfMonth 5, «в последний день месяца» dayOfMonth \"last\", «каждое второе воскресенье» monthly_weekday with occurrence 2 and weekday 0, «по понедельникам и средам» weekly with weekdays [1, 3], «каждый будний день» weekdays, «каждый год 12 марта» yearly. Use interval only for a fixed count of minutes or hours, never for months or years. Summarize the exact requested work in prompt. A scheduled run can never act in the user's name or pay — no booking, appointment, application, job application, receipt or order: it only checks, searches and stages up to the final step, and its report asks the user to confirm in the conversation. So for «записывай, как только появится слот» schedule the check and say the booking itself waits for the user's confirmation.",
  inputSchema: z.object({
    missedRunPolicy: z.enum(["run_latest", "catch_up"]).default("run_latest"),
    prompt: z.string().trim().min(1).max(8_000),
    timing: scheduleTimingSchema,
  }),
  async execute(input, context) {
    const owner = scheduleOwner(context);
    return scheduleSummary(
      await createScheduledAgentJob(owner.scope, {
        ...owner.conversation,
        missedRunPolicy: input.missedRunPolicy,
        prompt: input.prompt,
        replyAnchorMessageId: scheduleReplyAnchor(context),
        timing: input.timing,
      })
    );
  },
});

export const listSchedules = defineTool({
  description:
    "List all of the authenticated user's one-time and recurring jobs, whichever chat or channel each was made in. Use this before changing a schedule when the target is ambiguous.",
  inputSchema: z.object({}),
  async execute(_input, context) {
    return (await listScheduledAgentJobs(scheduleScope(context))).map(
      scheduleListSummary
    );
  },
});

const updateScheduleInputSchema = z
  .object({
    id: z.uuid(),
    prompt: z.string().trim().min(1).max(8_000).optional(),
    status: z.enum(["active", "paused", "deleted"]).optional(),
    timing: scheduleTimingSchema.optional(),
  })
  .refine(
    ({ prompt, status, timing }) =>
      prompt !== undefined || status !== undefined || timing !== undefined,
    { message: "Provide at least one schedule change." }
  );

export const updateSchedule = defineTool({
  description:
    "Update, pause, resume, or delete one of the authenticated user's scheduled jobs, whichever chat it was made in. Set status paused or active to pause or resume it. List schedules first when the target is ambiguous.",
  inputSchema: updateScheduleInputSchema,
  async execute({ id, ...patch }, context) {
    const job = await updateScheduledAgentJob(
      scheduleScope(context),
      id,
      patch
    );
    if (!job) throw new Error("Schedule not found.");
    return scheduleSummary(job);
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
