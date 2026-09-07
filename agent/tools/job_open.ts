import { defineTool } from "eve/tools";
import { z } from "zod";
import { openJob, upsertTenant } from "../lib/convex";
import { groupPersonalBlock } from "../lib/group-guard";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Open a long-running job for this person when the work must wait (email reply, yes/no, browser). goal and doneWhen are one line each. Do not open for ordinary chat.",
  inputSchema: z.object({
    goal: z.string().min(1).max(280),
    doneWhen: z.string().min(1).max(280),
  }),
  async execute({ goal, doneWhen }, ctx) {
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { error: blocked };
    const phone = tenantId(ctx);
    await upsertTenant(phone);
    return openJob(phone, goal, doneWhen);
  },
});
