import { defineTool } from "eve/tools";
import { z } from "zod";
import { otpLookupExecute } from "../lib/otp-lookup.ts";

export default defineTool({
  description:
    "Fresh OTP from Bro's Inkbox inbox, then this person's mail archive. Call when worker/browser needs a code — before asking in the thread. Pass the code only to the waiting worker; never quote it.",
  inputSchema: z.object({
    hint: z.string().min(1).max(120).optional(),
    sinceMinutes: z.number().min(1).max(180).optional(),
  }),
  execute: otpLookupExecute,
});
