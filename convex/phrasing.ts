/**
 * The phrasing call, as a Convex internal action.
 *
 * It exists so the two no-model-in-the-loop messages — the finished-errand
 * report and the progress notes — are written by Bro rather than picked out
 * of a hardcoded palette, without giving back the ~44s that skipping the
 * model turn bought (see convex/lib/broPhrasing.ts and browserFollow.ts's
 * deliverDoneNow).
 *
 * It takes the already-parsed outcome fields, never the raw Cloud run
 * result, and it cannot fail loudly: everything that goes wrong — no key, a
 * missed budget, a bad response, output the gate rejects — comes back as
 * `null`, and the caller sends the canned line it would have sent anyway.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { generatePhrase } from "./lib/broPhrasing";

/** Exactly the fields a line may be built from. Nothing else is accepted,
 *  so no call site can widen what the model sees by passing more. */
const phraseFacts = v.object({
  done: v.optional(v.string()),
  orderId: v.optional(v.string()),
  amountRub: v.optional(v.number()),
  when: v.optional(v.string()),
  options: v.optional(v.array(v.string())),
  where: v.optional(v.string()),
});

const phraseKind = v.union(
  v.literal("done"),
  v.literal("opened"),
  v.literal("slow"),
  v.literal("long"),
);

export const phraseLine = internalAction({
  args: { kind: phraseKind, facts: phraseFacts },
  returns: v.union(v.string(), v.null()),
  handler: async (_ctx, args): Promise<string | null> => {
    return await generatePhrase({ kind: args.kind, facts: args.facts });
  },
});
