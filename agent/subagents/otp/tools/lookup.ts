import { defineTool } from "eve/tools";
import { z } from "zod";
import { groupPersonalBlock } from "../../../lib/group-guard";
import { otpLookupExecute } from "../../../lib/otp-lookup.ts";

export default defineTool({
  description:
    "Deterministic OTP lookup: Bro inbox first, then archive. Prefer this over guessing.",
  inputSchema: z.object({
    hint: z.string().min(1).max(120).optional(),
    sinceMinutes: z.number().min(1).max(180).optional(),
  }),
  async execute(input, ctx) {
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { error: blocked };
    return otpLookupExecute(input, ctx);
  },
});
