import type { ModelMessage } from "ai";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { personErrandRunId } from "@agent/lib/browser-use/report-caller";
import { reportedRunOf } from "@agent/lib/delivery/browser-report";
import { startsTurn } from "@agent/lib/delivery/turn-sends";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { cardOfReport } from "./report";

/**
 * The turns Bro's code opens that the card tools act in besides the
 * person's own: the turn a card's answer opens (`agent/lib/cards/answers.ts`)
 * and the report of a browser errand the person gave. The tools tell them
 * apart by their caller, which only Bro's code writes, and by the opening of
 * their message.
 */

/** The caller of the turn a card's answer opens. */
export const cardAnswerAuthenticator = "card-answer";

/** How the message of a card's answer opens. */
export const cardAnswerOpening = `${backgroundTurnMarker}\n\n[Card answer] `;

const callerSchema = z.object({
  attributes: z.object({
    cardRef: z.string(),
    cardResponseId: z.string().optional(),
    cardEventKind: z.enum(["submit", "intent"]).optional(),
  }),
  authenticator: z.literal(cardAnswerAuthenticator),
});

/** The ref of the card whose answer the caller brings, if it brings one. */
export function answeredCardRef(
  caller: ToolContext["session"]["auth"]["current"]
) {
  return callerSchema.safeParse(caller).data?.attributes.cardRef;
}

/** The only card an intent or its browser report may change. */
export function cardUpdateTarget(
  caller: ToolContext["session"]["auth"]["current"]
) {
  const answer = callerSchema.safeParse(caller).data?.attributes;
  return answer?.cardEventKind === "intent"
    ? answer.cardRef
    : cardOfReport(caller)?.ref;
}

/** The press on a card's page (`card_responses`) the caller brings, if it brings one. */
export function cardPressOf(caller: ToolContext["session"]["auth"]["current"]) {
  return callerSchema.safeParse(caller).data?.attributes.cardResponseId;
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

/**
 * Whether the report of a browser errand the person gave opened this
 * turn: the caller names the run as theirs (`personErrandRunId`) and the
 * turn's opening message is that run's report. As with a card's answer, the
 * caller alone is not enough: eve keeps it for a later delivery that brings
 * none, such as a task's report.
 */
export function openedByPersonErrandReport(
  messages: readonly ModelMessage[],
  caller: ToolContext["session"]["auth"]["current"]
) {
  const runId = personErrandRunId(caller) ?? cardOfReport(caller)?.runId;
  const opener = messages.findLast(startsTurn);
  return (
    runId !== undefined &&
    opener !== undefined &&
    reportedRunOf(openingText(opener)) === runId
  );
}
