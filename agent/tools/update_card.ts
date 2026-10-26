import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { cardsOffered } from "@agent/lib/cards/enabled";
import { cardUpdateTarget } from "@agent/lib/cards/caller";
import { keepCardPhotos, photosResult } from "@agent/lib/cards/photos/keep";
import { updateCardToolName } from "@agent/lib/cards/sent";
import { sendCardButton } from "@agent/lib/cards/telegram";
import { markTurnDelivered } from "@agent/lib/delivery/holds";
import { cardWithPartnerLinks } from "@agent/lib/partner-links/rewrite";
import {
  cardsPerTurn,
  cardsThisTurn,
  cardTurnCaller,
  cardTurnOpener,
  checkCard,
  pickRefusal,
} from "@agent/lib/cards/tools";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { conversationOf } from "@agent/lib/yoomoney/onboarding";
import { cardWatched, updateCard } from "@db/services/cards";
import { cardsEnabled } from "@shared/cards/pilot";
import { submitActions } from "@shared/cards/response";
import { cardSchema } from "@shared/cards/schema";
import { applicationOrigin } from "@shared/environment/origin";

/**
 * A card's new content under its same link (`docs/cards.md`): the plan
 * rebuilt from what the person marked, other options after «Показать
 * другие». Offered where `send_card` is, under the same checks, and only for
 * a card of the person's sent to this chat; its revision goes one up, so the
 * page says it was updated and an answer to the old one is turned away. The
 * chat gets a line of what changed, with the card's button, which is the
 * turn's message as `send_card`'s is.
 */

const inputSchema = cardSchema.extend({
  ref: z
    .string()
    .regex(/^[a-z2-9]{8}$/u)
    .describe(
      "The card's ref, as send_card's result or the card's answer named it."
    ),
  message: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "One or two lines for the chat, in the person's language and your chat voice: what changed on the card. Not the card's data."
    ),
});

const description =
  "Change what a card you sent shows, under its same link: pass its ref and the whole new card, built from the same catalog and by the same rules as send_card. The page marks it updated. An open card updates silently in place; otherwise the chat gets your message with its button again. A short note explains the result on the card. Use it when the person's answer or words change the card — the plan rebuilt from what they marked, other options after «Показать другие», a corrected date — not for a new subject, which is a new send_card. Only a card sent to this chat. On invalid or refused, the reason is in the result: fix it and call again.";

const notThePerson =
  "Nothing changed: a card is updated only in its Telegram chat, in a turn the person's own message, their answer to a card or the report of an errand they gave opened.";

export default defineDynamic({
  events: {
    "step.started": (event, context) => {
      if (!cardsOffered(context)) return null;
      const opener = cardTurnOpener(event, context);
      if (opener === undefined) return null;
      const sent = cardsThisTurn(context.messages);
      return {
        [updateCardToolName]: defineTool({
          availableInSubagents: false,
          description,
          inputSchema,
          async execute({ message, ref, ...input }, toolContext) {
            const current = toolContext.session.auth.current;
            const target = cardUpdateTarget(current);
            if (target && target !== ref)
              return {
                status: "refused" as const,
                reply: `This interaction may update only its original card ${target}.`,
              };
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
                reply: `This turn already put ${String(cardsPerTurn)} cards in the chat, the most one reply may take. Do not update another.`,
              };
            }
            const checked = checkCard(input, message, "Nothing changed");
            if (checked.refusal) return checked.refusal;
            const pick = pickRefusal(
              checked.card,
              opener,
              context.messages,
              "Nothing changed"
            );
            if (pick) return pick;
            // Before the card's row is locked: Travelpayouts may take a while.
            const linked = await cardWithPartnerLinks(checked.card, scope);
            const updated = await updateCard(
              scope,
              { conversationId: chat.conversationId, ref },
              (kept) => keepCardPhotos(kept.id, linked, kept.card)
            );
            if (updated === undefined) {
              return {
                status: "refused" as const,
                reply: `Nothing changed: no card ${ref} of the person's was sent to this chat, or it no longer opens. Send a new one with send_card.`,
              };
            }
            const { card } = updated.change;
            if (updated.revision === undefined || !card) {
              return {
                status: "invalid" as const,
                reply:
                  "Nothing changed: no photo of the new card could be kept, and it has nothing but photos. Compose it with the data as text, or answer in the chat.",
              };
            }
            const { note, ...counts } = photosResult(updated.change);
            const quiet = cardWatched(updated.watchedAt, new Date());
            try {
              if (!quiet)
                await sendCardButton(
                  chat.conversationId,
                  new URL(
                    `/card/${updated.id}`,
                    applicationOrigin()
                  ).toString(),
                  message
                );
            } catch (error) {
              console.warn("[cards] the updated card's message did not land", {
                name: error instanceof Error ? error.name : "unknown",
              });
              return {
                status: "failed" as const,
                reply:
                  "The card was updated, but its message did not reach the chat. Tell the person in a short line what changed.",
              };
            }
            markTurnDelivered(toolContext.session);
            return {
              status: "updated" as const,
              card: ref,
              revision: updated.revision,
              quiet,
              ...counts,
              reply: `${
                quiet
                  ? "The open card updated in place. The person has it; send no chat acknowledgement and end the turn."
                  : submitActions(card).length > 0
                    ? "The card is updated under its link, and its button is in the chat with your message. It asks the person again: their answer comes back by itself as a new turn of this chat, so end the turn now without writing."
                    : "The card is updated under its link, and its button is in the chat with your message. Send nothing more about it. End the turn unless the person asked for something else too."
              }${note}`,
            };
          },
        }),
      };
    },
  },
});
