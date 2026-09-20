import { defineTool } from "eve/tools";
import { z } from "zod";
import { defaultCheckInMinutes } from "../../convex/lib/jobNudgePolicy.ts";
import {
  cancelWakeup,
  finishJob,
  openJob,
  scheduleWakeup,
  upsertTenant,
  waitJob,
} from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "A long-running job for this person, when the work must wait (email reply, yes/no, browser). action=open: goal and doneWhen, one line each; do not open for ordinary chat. action=wait: park the job until the next event — human iMessage, inbound email to Bro's mailbox, or the cloud browser finishing — include a short note of where you left off; always schedules a job_check, and if checkInMinutes is omitted Bro uses human 20 / email 45 / browser 8 (waiting on an OTP email: pass checkInMinutes=3). action=done: close it when doneWhen is true, or the human cancelled; failed=true if it died.",
  inputSchema: z.object({
    action: z.enum(["open", "wait", "done"]),
    goal: z.string().min(1).max(280).optional(),
    doneWhen: z.string().min(1).max(280).optional(),
    jobId: z.string().min(1).optional(),
    waitingFor: z.enum(["human", "email", "browser"]).optional(),
    note: z.string().max(280).optional(),
    emailThreadId: z.string().optional(),
    emailMessageId: z.string().optional(),
    checkInMinutes: z.number().min(2).max(10080).optional(),
    outcome: z.string().min(1).max(280).optional(),
    failed: z.boolean().optional(),
  }),
  async execute(args, ctx) {
    const phone = tenantId(ctx);

    if (args.action === "open") {
      const { goal, doneWhen } = args;
      if (!goal || !doneWhen) return { error: "open needs goal, doneWhen" };
      await upsertTenant(phone);
      return openJob(phone, goal, doneWhen);
    }

    if (args.action === "wait") {
      const {
        jobId,
        waitingFor,
        note,
        emailThreadId,
        emailMessageId,
        checkInMinutes,
      } = args;
      if (!jobId || !waitingFor) return { error: "wait needs jobId, waitingFor" };
      const job = await waitJob(phone, jobId, waitingFor, {
        note,
        emailThreadId,
        emailMessageId,
      });
      if ("error" in job) return job;
      const minutes = checkInMinutes ?? defaultCheckInMinutes(waitingFor);
      const goal = job.goal || job.note || jobId;
      const at = Date.now() + minutes * 60_000;
      try {
        await scheduleWakeup({
          tenantPhone: phone,
          at,
          kind: "job_check",
          payload: `джоб ${jobId}: ${goal}`,
          recurMinutes: minutes,
        });
        return { ...job, checkAt: new Date(at).toISOString() };
      } catch (err) {
        console.error("job_check wakeup failed", err);
        return job;
      }
    }

    const { jobId, outcome, failed } = args;
    if (!jobId || !outcome) return { error: "done needs jobId, outcome" };
    const result = await finishJob(phone, jobId, outcome, failed);
    if (!("error" in result)) {
      try {
        await cancelWakeup(phone, {
          kind: "job_check",
          payloadContains: `джоб ${jobId}`,
        });
      } catch (err) {
        console.error("job_check cancel failed", err);
      }
    }
    return result;
  },
});
