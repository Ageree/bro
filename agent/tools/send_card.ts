import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { cardsOffered } from "@agent/lib/cards/enabled";
import { cardUpdateTarget } from "@agent/lib/cards/caller";
import { keepCardPhotos, photosResult } from "@agent/lib/cards/photos/keep";
import { sendCardToolName } from "@agent/lib/cards/sent";
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
import { createCard, newCardId } from "@db/services/cards";
import { deleteCardPhotos, keptPhotoNumbers } from "@shared/cards/photos";
import { cardsEnabled } from "@shared/cards/pilot";
import { submitActions } from "@shared/cards/response";
import { cardSchema } from "@shared/cards/schema";
import { applicationOrigin } from "@shared/environment/origin";

/**
 * A card, in the pilot `CARDS_WORKSPACES` (`docs/cards.md`): a page the model
 * composes from the fixed catalog of blocks, kept behind a secret link and
 * sent to the Telegram chat as a button that opens it. Only in a turn the
 * person opened — by their message, by their answer to a card, or by an
 * errand they gave whose browser report came back (`cardTurnOpener`) — and
 * never in one a schedule, a background errand or a page opened, whose text
 * must not become a card the person reads as Bro's. A card that asks
 * (choice and field with a submit button) brings the answer back as a turn
 * of this chat (`agent/lib/cards/answers.ts`). A card in the chat is the
 * turn's message for the report's card steps (`markTurnDelivered`), as a
 * `send_message` is.
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

const description = [
  "Send the person a card: one page opened in Telegram from a button under your message. Compose it from the catalog of blocks in the input; anything outside it is rejected. A card is for data, not a remark: a confirmed ticket or booking, a comparison of three or more options, a route or a plan, a list to keep. It may also ask: choice (one or several of 2–8 options) and field (text, longtext, number, date, time, count, slider) with a final submit button { label, submit } and repeatable buttons { label, intent } for another search or a question on the same page — for a pick among three or more options to compare, or two or more things to fill in at once, never one question with two answers. Options to book, order or buy are such a choice; each option or list row may carry more (its page as href, facts, a short text, its other photos), which the card shows behind «Подробнее». An option takes value, title, detail, side, price, photo and more, a list row only title, subtitle, side, chip, href, photo and more: an option's page and text go in more. A submit button's label says exactly what its press does («Подобрать варианты», «Отключить отмеченные»): a press allows exactly that and what the card says, nothing else, and never pays, buys, calls or signs — those still wait for the person's «да» in the chat. count and slider require min and max; step and initial must align. An optional target names a choice with a numeric price in rubles on every option: slider filters it by price, count multiplies the selected prices into an estimated total. Only one count may target a choice; guests must not multiply a room price. Fields never ask for a password, a code, a card number, a passport or SNILS. Never a card for a short reply, one fact, a yes/no question or a payment's confirmation: those stay in the chat. Compose: the first block answers the question (route, stat, table or list) or asks it (choice), then details (facts, timeline, checklist), then a callout with what must not be missed; one tone per card (success: done; warning: needs a decision or has a deadline; danger: failed; info: plans; neutral: comparisons); at most one stat and one image; text in Russian with a capital letter, no Markdown or emoji, sums as «7 450 ₽»; never a password, a one-time code or a full card number (last four digits at most). The message is not the card's data, and after the card you send nothing about it. A browser report's outcome (hotels or goods found, options to compare, a plan) goes as this card when these rules call for one, the message its one- or two-line answer. On invalid or refused, the reason is in the result: fix the card and call again.",
  "Photos only where how the thing looks is part of the choice or helps to find it (a hotel, a flat, a product, a gift, a place, a venue, an entrance), never where numbers, dates and terms decide (flights, tickets, tariffs, insurance, subscriptions, payments, schedules, mail). Ask: with the pictures covered, would the choice change? If not, no photos. Only real photos of this very object from its own page (a listing, a product card, the place's site): call find_images on that page, once per object, and put the URLs it returns, or take the direct photo links a browser report gives for that very option (the main one as photo, the rest in more.photos); a page with none or behind a block means no photos, not a search for others. Never a stock, drawn or look-alike picture, a person, a document, test results, a map or a receipt. Lay them out by the task: image for one photo; gallery for five or six of one object (the main shot, then the whole and the useful details); list rows with a photo for thumbnails; list layout carousel for options to swipe and compare, one photo each; choice tiles or carousel to pick by the photo. A set has a photo on every row or on none. Bro keeps its own copy of each photo; a set where one photo fails shows none, and the result counts the photos kept and dropped: never mention dropped ones.",
].join("\n\n");

const notThePerson =
  "Nothing was sent: a card goes only to a Telegram chat, in a turn the person's own message, their answer to a card or the report of an errand they gave opened.";

export default defineDynamic({
  events: {
    "step.started": (event, context) => {
      if (!cardsOffered(context)) return null;
      if (cardUpdateTarget(context.session.auth.current)) return null;
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
            const target = cardUpdateTarget(current);
            if (target)
              return {
                status: "refused" as const,
                reply: `This interaction belongs to card ${target}. Update that same card with patch_card or update_card; do not create another card.`,
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
                reply: `This turn already put ${String(cardsPerTurn)} cards in the chat, the most one reply may take. Do not send another.`,
              };
            }
            const checked = checkCard(input, message, "Nothing was sent");
            if (checked.refusal) return checked.refusal;
            const pick = pickRefusal(checked.card, opener, context.messages);
            if (pick) return pick;
            const id = newCardId();
            const photos = await keepCardPhotos(
              id,
              await cardWithPartnerLinks(checked.card, scope)
            );
            const { card } = photos;
            if (!card) {
              return {
                status: "invalid" as const,
                reply:
                  "Nothing was sent: no photo of the card could be kept, and it has nothing but photos. Compose it with the data as text, or answer in the chat.",
              };
            }
            const { note, ...counts } = photosResult(photos);
            let kept = false;
            try {
              const { ref } = await createCard(
                scope,
                card,
                {
                  conversationChannel: "telegram",
                  conversationId: chat.conversationId,
                },
                new Date(),
                id
              );
              kept = true;
              await sendCardButton(
                chat.conversationId,
                new URL(`/card/${id}`, applicationOrigin()).toString(),
                message
              );
              markTurnDelivered(toolContext.session);
              return {
                status: "sent" as const,
                card: ref,
                ...counts,
                reply: `${
                  submitActions(card).length > 0
                    ? `The card with its button is in the chat, sent by Bro's code together with your message, and it asks the person. Their answer comes back to you by itself, as a new turn of this chat that names card ${ref}: end the turn now without writing, ask nothing of it in the chat, and do nothing the answer decides before it comes.`
                    : `The card with its button is in the chat, sent by Bro's code together with your message. The person has it: send nothing more about it, no repeat and no link. It is card ${ref}, for update_card. End the turn unless the person asked for something else too.`
                }${note}`,
              };
            } catch (error) {
              console.warn("[cards] the card did not land", {
                name: error instanceof Error ? error.name : "unknown",
              });
              if (!kept) {
                await deleteCardPhotos(id, keptPhotoNumbers(id, card)).catch(
                  () => undefined
                );
              }
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
