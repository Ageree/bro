import { z } from "zod";
import { forgetConversationLines } from "@db/services/conversation-log";

/** What of a failed erase is safe to log: the error's kind and SQLSTATE. */
const eraseFailureSchema = z.object({
  cause: z.object({ code: z.string() }).optional().catch(undefined),
  name: z.string(),
});

/**
 * Erases the person's lines the recap keeps, for both `forget_all` tools
 * (profile and workstreams). A failure costs the call nothing — the
 * memories are already forgotten, and a failed call would leave the rest of
 * «забудь всё» to the model's retry — and the lines go on the next call or
 * in 14 days. Only the error's kind and SQLSTATE are logged: drizzle's
 * message quotes the query's parameters.
 */
export async function eraseConversationLines(workspaceId: string) {
  try {
    await forgetConversationLines(workspaceId);
  } catch (error) {
    const failure = eraseFailureSchema.safeParse(error).data;
    console.error("[cross-channel] the conversation log was not erased", {
      error: failure?.name,
      sqlState: failure?.cause?.code,
    });
  }
}
