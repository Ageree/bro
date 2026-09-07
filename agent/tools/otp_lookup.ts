import { defineTool } from "eve/tools";
import { z } from "zod";
import { upsertTenant } from "../lib/convex";
import { agentHandle } from "../lib/inkbox";
import { groupPersonalBlock } from "../lib/group-guard";
import { findFreshOtp } from "../lib/otp-lookup.ts";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Fresh OTP from Bro's Inkbox inbox, then this person's mail archive. Call when worker/browser needs a code — before asking in the thread. Pass the code only to the waiting worker; never quote it.",
  inputSchema: z.object({
    hint: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe("merchant or sender hint: WB, банк, клиника"),
    sinceMinutes: z.number().min(1).max(180).optional(),
  }),
  async execute({ hint, sinceMinutes }, ctx) {
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { error: blocked };
    const phone = tenantId(ctx);
    const tenant = await upsertTenant(phone);
    return findFreshOtp({
      phone,
      handle: tenant.inkboxHandle ?? agentHandle(),
      hint,
      sinceMinutes,
    });
  },
});
