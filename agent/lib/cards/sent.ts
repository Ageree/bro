import type { ToolResultPart } from "ai";
import { z } from "zod";

export const sendCardToolName = "send_card";

/**
 * What `send_card` returns once the card and its button are in the chat. The
 * person has read the card's message then: the delivery guards count it as a
 * reply (`agent/lib/delivery/pending.ts`, `turn-sends.ts`), and the Telegram
 * channel does not post the model's closing text over it.
 */
const cardSentSchema = z.object({ status: z.literal("sent") });

/** The channel's view of that result (`action.result`). */
export const sendCardToolResultSchema = z.object({
  kind: z.literal("tool-result"),
  output: cardSentSchema,
  toolName: z.literal(sendCardToolName),
});

/** Whether a `send_card` result in the history is a card that reached the chat. */
export function cardSentInHistory(output: ToolResultPart["output"]) {
  return (
    output.type === "json" && cardSentSchema.safeParse(output.value).success
  );
}
