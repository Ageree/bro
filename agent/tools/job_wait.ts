import { defineTool } from "eve/tools";
import { z } from "zod";
import { defaultCheckInMinutes } from "../../convex/lib/jobNudgePolicy.ts";
import { scheduleWakeup, waitJob } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Park a job until the next event: human iMessage, inbound email to Bro's mailbox, or the cloud browser finishing. Include a short note of where you left off. Always schedules a job_check; if checkInMinutes is omitted, Bro uses human 20 / email 45 / browser 8.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    waitingFor: z.enum(["human", "email", "browser"]),
    note: z.string().max(280).optional(),
    emailThreadId: z.string().optional(),
    emailMessageId: z.string().optional(),
    checkInMinutes: z
      .number()
      .min(2)
      .max(10080)
      .optional()
      .describe(
        "schedule a background self-check to continue the chain without the human pinging; omitted → default for waitingFor",
      ),
  }),
  async execute(
    { jobId, waitingFor, note, emailThreadId, emailMessageId, checkInMinutes },
    ctx,
  ) {
    const phone = tenantId(ctx);
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
  },
});
