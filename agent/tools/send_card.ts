import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { cardsOffered } from "@agent/lib/cards/enabled";
import { sendCardToolName } from "@agent/lib/cards/sent";
import { sendCardButton } from "@agent/lib/cards/telegram";
import {
  cardsPerTurn,
  cardsThisTurn,
  cardTurnCaller,
  cardTurnOpener,
  checkCard,
} from "@agent/lib/cards/tools";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { conversationOf } from "@agent/lib/yoomoney/onboarding";
import { createCard } from "@db/services/cards";
import { cardsEnabled } from "@shared/cards/pilot";
import { submitActions } from "@shared/cards/response";
import { cardSchema } from "@shared/cards/schema";
import { applicationOrigin } from "@shared/environment/origin";

/**
 * A card, in the pilot `CARDS_WORKSPACES` (`docs/cards.md`): a page the model
 * composes from the fixed catalog of blocks, kept behind a secret link and
 * sent to the Telegram chat as a button that opens it. Only in a turn the
 * person opened — by their message or by their answer to a card — since the
 * model's own words are enough to fill a card, and a report's or a page's
 * text must not become one the person reads as Bro's. A card that asks
 * (choice and field with a submit button) brings the answer back as a turn
 * of this chat (`agent/lib/cards/answers.ts`).
 */

const inputSchema = cardSchema.extend({
  message: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "One or two lines for the chat, in the person's language and your chat voice: the answer itself in short (what was done, the main number or date), or what the card asks. Not the card's data."
    ),
});

const description =
  "Send the person a card: one page opened in Telegram from a button under your message. Compose it from the catalog of blocks in the input; anything outside it is rejected. A card is for data, not a remark: a confirmed ticket or booking, a comparison of three or more options, a route or a plan, a list to keep. It may also ask: choice (one or several of 2–8 options) and field (text, longtext, number, date, time) with a submit button { label, submit } — for a pick among three or more options to compare, or two or more things to fill in at once, never one question with two answers. A submit button's label says exactly what its press does («Подобрать варианты», «Отключить отмеченные»): a press allows exactly that and what the card says, nothing else, and never pays, buys, calls or signs — those still wait for the person's «да» in the chat. Fields never ask for a password, a code, a card number, a passport or SNILS. Never a card for a short reply, one fact, a yes/no question or a payment's confirmation: those stay in the chat. Compose: the first block answers the question (route, stat, table or list) or asks it (choice), then details (facts, timeline, checklist), then a callout with what must not be missed; one tone per card (success: done; warning: needs a decision or has a deadline; danger: failed; info: plans; neutral: comparisons); at most one stat and one image; text in Russian with a capital letter, no Markdown or emoji, sums as «7 450 ₽»; never a password, a one-time code or a full card number (last four digits at most). The message is not the card's data, and after the card you send nothing about it. On invalid or refused, the reason is in the result: fix the card and call again.";

const notThePerson =
  "Nothing was sent: a card goes only to a Telegram chat, in a turn the person's own message or their answer to a card opened.";

export default defineDynamic({
  events: {
    "step.started": (event, context) => {
      if (!cardsOffered(context)) return null;
      const opener = cardTurnOpener(event, context);
      if (opener === undefined) return null;
      const sent = cardsThisTurn(context.messages);
      return {
        [sendCardToolName]: defineTool({
          availableInSubagents: false,
          description,
          inputSchema,
          async execute({ message, ...input }, toolContext) {
            const current = toolContext.session.auth.current;
            const chat = conversationOf(toolContext);
            if (
              current?.principalType !== "user" ||
              toolContext.session.parent != null ||
              !cardTurnCaller(opener, toolContext) ||
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
                reply: `This turn already put ${String(cardsPerTurn)} cards in the chat, the most one reply may take. Do not send another.`,
              };
            }
            const checked = checkCard(input, message, "Nothing was sent");
            if (checked.refusal) return checked.refusal;
            const { card } = checked;
            try {
              const { id, ref } = await createCard(scope, card, {
                conversationChannel: "telegram",
                conversationId: chat.conversationId,
              });
              await sendCardButton(
                chat.conversationId,
                new URL(`/card/${id}`, applicationOrigin()).toString(),
                message
              );
              return {
                status: "sent" as const,
                card: ref,
                reply:
                  submitActions(card).length > 0
                    ? `The card with its button is in the chat, sent by Bro's code together with your message, and it asks the person. Their answer comes back to you by itself, as a new turn of this chat that names card ${ref}: end the turn now without writing, ask nothing of it in the chat, and do nothing the answer decides before it comes.`
                    : `The card with its button is in the chat, sent by Bro's code together with your message. The person has it: send nothing more about it, no repeat and no link. It is card ${ref}, for update_card. End the turn unless the person asked for something else too.`,
              };
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
          },
        }),
      };
    },
  },
});
