import type { ModelMessage } from "ai";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { startsTurn } from "@agent/lib/delivery/turn-sends";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

/**
 * The turn a card's answer opens (`agent/lib/cards/answers.ts`), as the
 * tools that act on it tell it apart: by its caller, which only Bro's code
 * writes, and by the opening of its message.
 */

/** The caller of the turn a card's answer opens. */
export const cardAnswerAuthenticator = "card-answer";

/** How the message of a card's answer opens. */
export const cardAnswerOpening = `${backgroundTurnMarker}\n\n[Card answer] `;

const callerSchema = z.object({
  attributes: z.object({ cardRef: z.string() }),
  authenticator: z.literal(cardAnswerAuthenticator),
});

/** The ref of the card whose answer the caller brings, if it brings one. */
export function answeredCardRef(
  caller: ToolContext["session"]["auth"]["current"]
) {
  return callerSchema.safeParse(caller).data?.attributes.cardRef;
}

function openingText(message: ModelMessage) {
  return Array.isArray(message.content)
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : message.content;
}

/**
 * Whether a card's answer opened this turn. eve keeps a turn's caller for a
 * later delivery that brings none (a task's report, `turn-step.js`), so the
 * caller alone would let such a turn pass for the answer's: only the
 * message's exact opening counts.
 */
export function openedByCardAnswer(messages: readonly ModelMessage[]) {
  const opener = messages.findLast(startsTurn);
  return (
    opener !== undefined && openingText(opener).startsWith(cardAnswerOpening)
  );
}
