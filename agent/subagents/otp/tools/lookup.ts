import { defineTool } from "eve/tools";
import { z } from "zod";
import { upsertTenant } from "../../../lib/convex";
import { groupPersonalBlock } from "../../../lib/group-guard";
import { agentHandle } from "../../../lib/inkbox";
import { findFreshOtp } from "../../../lib/otp-lookup.ts";
import { tenantId } from "../../../lib/tenant";

export default defineTool({
  description:
    "Deterministic OTP lookup: Bro inbox first, then archive. Prefer this over guessing.",
  inputSchema: z.object({
    hint: z.string().min(1).max(120).optional(),
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
