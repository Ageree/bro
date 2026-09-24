import { parseInputResponses, resolveTextToResponses } from "eve/client";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scheduledReportIdentity } from "@agent/lib/schedules/identity";
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
  getScheduledAgentRunInputForReport,
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

export const answerSchedule = defineTool({
  description:
    "Resume a scheduled task that is waiting for input. During scheduled reporting, use existing conversation context when it clearly answers the request. During an interactive turn, pass the user's answer exactly as given. The task picks the answer up within a minute or two.",
  inputSchema: z.strictObject({
    answer: z.string().trim().min(1).max(8_000),
    runId: z.uuid(),
  }),
  async execute({ answer, runId }, context) {
    const pending = await pendingScheduledRun(context, runId);
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
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: {
          "schedules-answer": answerSchedule,
          "schedules-create": createSchedule,
          "schedules-list": listSchedules,
          "schedules-update": updateSchedule,
        },
        "scheduled-report": { "schedules-answer": answerSchedule },
      }),
  },
});

async function pendingScheduledRun(context: ToolContext, runId: string) {
  const resolvePending = resolveModeValue(context, {
    interactive: () => getScheduledAgentRunInput(scheduleScope(context), runId),
    "scheduled-report": () => {
      const report = scheduledReportIdentity(context.session.auth);
      if (!report || report.runId !== runId) {
        throw new Error("This reporting turn cannot resume that run.");
      }
      return getScheduledAgentRunInputForReport(
        report.runId,
        report.leaseToken
      );
    },
  });
  return resolvePending?.();
}
