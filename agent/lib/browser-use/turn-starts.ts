import type { ModelMessage } from "ai";
import { z } from "zod";
import { currentTurnMessages } from "@agent/lib/delivery/turn-sends";

/**
 * Errands one turn may start. A person asks for one, two, three things at
 * once; a turn that keeps starting is retrying. One benchmark turn started
 * the same errand 77 times against Browser Use's concurrency cap, each start
 * refused, each one more load on the cap it was waiting for.
 */
export const turnStartLimit = 3;

const startCallSchema = z.object({
  input: z.object({ action: z.literal("start") }),
  toolName: z.literal("browser_task"),
});

const refusedPrefix = "Not started:";

/** The tool result a start over the limit gets instead of a run. */
export const turnStartLimitNotice = `${refusedPrefix} this turn already started ${String(turnStartLimit)} browser errands, the most one reply may start. A queued or unavailable errand is not helped by starting it again: tell the user where things stand now, and use status, continue or cancel on the run ids you already have.`;

/**
 * Starts the current turn has already made, counted from their results: a
 * start still waiting on its approval card is not counted, or the card's own
 * approval would find the limit reached by itself. A start this guard refused
 * never ran and does not count either.
 */
export function turnBrowserStarts(messages: readonly ModelMessage[]) {
  const starts = new Set<string>();
  let count = 0;
  for (const message of currentTurnMessages(messages)) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (
        part.type === "tool-call" &&
        startCallSchema.safeParse(part).success
      ) {
        starts.add(part.toolCallId);
      }
      if (part.type !== "tool-result" || !starts.has(part.toolCallId)) continue;
      const refused =
        JSON.stringify(part.output).includes(refusedPrefix) ||
        part.output.type === "execution-denied";
      if (!refused) count += 1;
    }
  }
  return count;
}
