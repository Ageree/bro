import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { personWordsThisTurn } from "@agent/lib/browser-use/said";
import { cardsEnabled, cardsOffered } from "@agent/lib/cards/enabled";
import { secretInCard } from "@agent/lib/cards/safety";
import { cardSentInHistory, sendCardToolName } from "@agent/lib/cards/sent";
import { sendCardButton } from "@agent/lib/cards/telegram";
import { currentTurnMessages } from "@agent/lib/delivery/turn-sends";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import { conversationOf } from "@agent/lib/yoomoney/onboarding";
import { createCard } from "@db/services/cards";
import { cardSchema } from "@shared/cards/schema";
import { applicationOrigin } from "@shared/environment/origin";

/**
 * A card, in the pilot `CARDS_WORKSPACES` (`docs/cards.md`): a page the model
 * composes from the fixed catalog of blocks, kept behind a secret link and
 * sent to the Telegram chat as a button that opens it. Only in a turn the
 * person's own message opened: the model's own words are enough to fill a
 * card, and a report's or a page's text must not become one the person
 * reads as Bro's.
 */

/** Cards one turn may send: a loop would post one to the chat after another. */
const cardsPerTurn = 2;

const inputSchema = cardSchema.extend({
  message: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "One or two lines for the chat, in the person's language and your chat voice: why the card is sent. Not the card's data."
    ),
});

const description =
  "Send the person a card: one page with the ready answer, opened in Telegram from a button under your message. Compose it from the catalog of blocks in the input; anything outside it is rejected. Use it only when the answer is data, not a remark: a confirmed ticket or booking, a comparison of options, a route or a plan, a list to keep. Never for a short reply, one fact, a question, or a consent or payment confirmation: those stay in the chat, a card only shows. Compose: the first block answers the question (route, stat, table or list), then details (facts, timeline, checklist), then a callout with what must not be missed; one tone per card (success: done; warning: needs a decision or has a deadline; danger: failed; info: plans; neutral: comparisons); at most one stat and one image; text in Russian with a capital letter, no Markdown or emoji, sums as «7 450 ₽»; never a password, a one-time code or a full card number (last four digits at most). The message is not the card's data, and after the card you send nothing about it. On invalid or refused, the reason is in the result: fix the card and call again.";

const secretNames = {
  "card-number": "a full card number",
  document: "a passport or SNILS number",
  secret: "a password, a key or a one-time code",
} as const;

const notThePerson =
  "Nothing was sent: a card goes only to a Telegram chat, in a turn the person's own message opened.";

function sentCards(messages: Parameters<typeof currentTurnMessages>[0]) {
  return currentTurnMessages(messages).flatMap((message) =>
    message.role === "tool"
      ? message.content.filter(
          (part) =>
            part.type === "tool-result" &&
            part.toolName === sendCardToolName &&
            cardSentInHistory(part.output)
        )
      : []
  ).length;
}

export default defineDynamic({
  events: {
    "step.started": (event, context) => {
      if (!cardsOffered(context)) return null;
      const turn = personWordsThisTurn(
        context.messages,
        stepIdentity(
          stepStartedEventSchema.safeParse(event).data,
          context.session.id
        )
      );
      if (turn.said === null) return null;
      const sent = sentCards(context.messages);
      return {
        [sendCardToolName]: defineTool({
          availableInSubagents: false,
          description,
          inputSchema,
          async execute({ message, ...card }, toolContext) {
            const current = toolContext.session.auth.current;
            const chat = conversationOf(toolContext);
            if (
              current?.principalType !== "user" ||
              toolContext.session.parent != null ||
              !startedByPerson(toolContext) ||
              chat.conversationChannel !== "telegram"
            ) {
              return { status: "refused" as const, reply: notThePerson };
            }
            const scope = scopeFromPrincipal(current);
            if (!cardsEnabled(scope)) {
              return { status: "refused" as const, reply: notThePerson };
            }
            if (sent >= cardsPerTurn) {
              return {
                status: "refused" as const,
                reply: `This turn already sent ${String(cardsPerTurn)} cards, the most one reply may take. Do not send another.`,
              };
            }
            const checked = cardSchema.safeParse(card);
            if (!checked.success) {
              return {
                status: "invalid" as const,
                reply: `Nothing was sent: the card does not fit the catalog. Fix these and call again (links are https://, a button may also be tel: or mailto:).\n${z.prettifyError(checked.error)}`,
              };
            }
            const secret = secretInCard(checked.data, message);
            if (secret !== undefined) {
              return {
                status: "refused" as const,
                reply: `Nothing was sent: ${secret.path} shows ${secretNames[secret.kind]}. A card never carries these (a card number only as its last four digits); say it in the chat if the person needs it. Compose the card without it and call again.`,
              };
            }
            try {
              const id = await createCard(scope, checked.data);
              const url = new URL(
                `/card/${id}`,
                applicationOrigin()
              ).toString();
              await sendCardButton(chat.conversationId, url, message);
            } catch (error) {
              console.warn("[cards] the card did not land", {
                name: error instanceof Error ? error.name : "unknown",
              });
              return {
                status: "failed" as const,
                reply:
                  "The card did not reach the chat. Tell the person in a short line and give the answer in text.",
              };
            }
            return {
              status: "sent" as const,
              reply:
                "The card with its button is in the chat, sent by Bro's code together with your message. The person has it: send nothing more about it, no repeat and no link. End the turn unless the person asked for something else too.",
            };
          },
        }),
      };
    },
  },
});
