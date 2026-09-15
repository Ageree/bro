import { defineAgent } from "eve";
import { z } from "zod";
import { broModel } from "../../lib/model";

const outputSchema = z.object({
  status: z.enum(["found", "missing", "ambiguous"]),
  code: z.string().regex(/^\d{4,8}$/).optional(),
  source: z.enum(["bro_mail", "archive", "event"]).optional(),
  hint: z.string().optional(),
});

// Static agent config: eve requires dynamically-returned subagent configs to
// carry a string model id (see docs/guides/dynamic-capabilities.md, "Dynamic
// subagents"), but broModel() returns a live wrapLanguageModel(...) provider
// object when OPENROUTER_API_KEY is set. Wrapping this in defineDynamic to
// hide it on group turns silently dropped the subagent on every 1:1 turn in
// production instead. The 1:1-only gate now lives in each tool's
// groupPersonalBlock(ctx) check (see ./tools/*.ts) rather than at the
// subagent-visibility layer.
export default defineAgent({
  description:
    "Look up a one-time code in Bro's Inkbox inbox and this person's mail archive. Call when worker returned Needs user input for an OTP, before asking the human. Returns found/missing; never chats or writes memory. 1:1 turns only — every tool refuses on a group turn.",
  ...broModel(),
  reasoning: "low",
  outputSchema,
});
