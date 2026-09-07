import { defineAgent, defineDynamic } from "eve";
import { z } from "zod";
import { isGroupTurn } from "../../lib/group-guard";
import { broDurableModel } from "../../lib/model";

const outputSchema = z.object({
  status: z.enum(["found", "missing", "ambiguous"]),
  code: z.string().regex(/^\d{4,8}$/).optional(),
  source: z.enum(["bro_mail", "archive", "event"]).optional(),
  hint: z.string().optional(),
});

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      isGroupTurn(ctx)
        ? null
        : defineAgent({
            description:
              "Look up a one-time code in Bro's Inkbox inbox and this person's mail archive. Call when worker returned Needs user input for an OTP, before asking the human. Returns found/missing; never chats or writes memory.",
            ...broDurableModel(),
            reasoning: "low",
            outputSchema,
          }),
  },
});
