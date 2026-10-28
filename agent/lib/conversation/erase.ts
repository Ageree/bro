import { z } from "zod";
import { forgetConversationLines } from "@db/services/conversation-log";
import { forgetLocation } from "@db/services/location";
import { forgetWorkLines } from "@db/services/work-log";

/** What of a failed erase is safe to log: the error's kind and SQLSTATE. */
const eraseFailureSchema = z.object({
  cause: z.object({ code: z.string() }).optional().catch(undefined),
  name: z.string(),
});

/**
 * Erases the person's lines the recap keeps and what the work log keeps of
 * Bro's work (`agent/lib/work-log/`), for both `forget_all` tools (profile
 * and workstreams). A failure costs the call nothing — the memories are
 * already forgotten, and a failed call would leave the rest of «забудь всё»
 * to the model's retry — and the lines go on the next call or with their
 * age (14 and 30 days). Only the error's kind and SQLSTATE are logged:
 * drizzle's message quotes the query's parameters.
 */
export async function eraseConversationLines(workspaceId: string) {
  for (const [log, forget] of [
    ["conversation", forgetConversationLines],
    ["work", forgetWorkLines],
  ] as const) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One log after the other; one failing leaves the other.
      await forget(workspaceId);
    } catch (error) {
      const failure = eraseFailureSchema.safeParse(error).data;
      console.error(`[cross-channel] the ${log} log was not erased`, {
        error: failure?.name,
        sqlState: failure?.cause?.code,
      });
    }
  }
}

/**
 * Erases the person's shared locations and the reminders at places that are
 * over, for «забудь всё» (`docs/location.md`), whether or not geolocation
 * is on now: points kept from the pilot go too. A live reminder is one of
 * their schedules and stays. A failure is logged like the lines'.
 */
export async function eraseLocationHistory(workspaceId: string) {
  try {
    await forgetLocation(workspaceId);
  } catch (error) {
    const failure = eraseFailureSchema.safeParse(error).data;
    console.error("[location] the shared locations were not erased", {
      error: failure?.name,
      sqlState: failure?.cause?.code,
    });
  }
}
