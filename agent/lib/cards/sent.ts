import type { ToolResultPart } from "ai";
import { z } from "zod";

export const sendCardToolName = "send_card";
export const updateCardToolName = "update_card";
export const patchCardToolName = "patch_card";

/** The card tools whose message, with its button, is a reply in the chat. */
export const cardToolNames: ReadonlySet<string> = new Set([
  sendCardToolName,
  updateCardToolName,
  patchCardToolName,
]);

/**
 * What `send_card` and `update_card` return once the card's message and
 * its button are in the chat. The person has read that message then: the
 * delivery guards count it as a reply (`agent/lib/delivery/pending.ts`,
 * `turn-sends.ts`), and the Telegram channel does not post the model's
 * closing text over it.
 */
const cardInChatSchema = z.object({ status: z.enum(["sent", "updated"]) });

/** The channel's view of that result (`action.result`). */
export const cardToolResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: cardInChatSchema,
  toolName: z.enum([sendCardToolName, updateCardToolName, patchCardToolName]),
});

/** Whether a card tool's result in the history put its message in the chat. */
export function cardSentInHistory(output: ToolResultPart["output"]) {
  return (
    output.type === "json" && cardInChatSchema.safeParse(output.value).success
  );
}
