import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { cardsOffered } from "@agent/lib/cards/enabled";
import { cardUpdateTarget } from "@agent/lib/cards/caller";
import { keepCardPhotos, photosResult } from "@agent/lib/cards/photos/keep";
import { patchCardToolName } from "@agent/lib/cards/sent";
import { sendCardButton } from "@agent/lib/cards/telegram";
import {
  cardsPerTurn,
  cardsThisTurn,
  cardTurnCaller,
  cardTurnOpener,
  checkCard,
} from "@agent/lib/cards/tools";
import { markTurnDelivered } from "@agent/lib/delivery/holds";
import { cardWithPartnerLinks } from "@agent/lib/partner-links/rewrite";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { conversationOf } from "@agent/lib/yoomoney/onboarding";
import { cardWatched, updateCard } from "@db/services/cards";
import { cardsEnabled } from "@shared/cards/pilot";
import { blockSchema, type Card } from "@shared/cards/schema";
import { applicationOrigin } from "@shared/environment/origin";

const [optionSchema] = blockSchema.options.flatMap((block) =>
  "options" in block.shape ? [block.shape.options.element] : []
);
if (optionSchema === undefined)
  throw new Error("The card catalog has no choice.");

const inputSchema = z
  .strictObject({
    ref: z.string().regex(/^[a-z2-9]{8}$/u),
    message: z.string().trim().min(1).max(200),
    note: z.string().trim().min(1).max(300).optional(),
    change: z
      .strictObject({
        choice: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
        mode: z.enum(["append", "replace"]),
        options: z.array(optionSchema).min(1).max(8),
      })
      .optional(),
  })
  .refine(
    (input) => input.note !== undefined || input.change !== undefined,
    "Give a note, a change of options, or both."
  );

function changeCardOptions(
  card: Card,
  change: NonNullable<z.infer<typeof inputSchema>["change"]>
) {
  const block = card.blocks.find(
    (each) => each.type === "choice" && each.id === change.choice
  );
  if (block?.type !== "choice")
    return {
      problem: `The card has no choice «${change.choice}». Use one of its existing question ids.`,
    };
  const given = new Map(change.options.map((option) => [option.value, option]));
  const options =
    change.mode === "replace"
      ? [...given.values()]
      : [
          ...block.options.map((option) => given.get(option.value) ?? option),
          ...[...given.values()].filter(
            (option) =>
              !block.options.some((each) => each.value === option.value)
          ),
        ];
  if (options.length > 8)
    return {
      problem:
        "A choice holds at most 8 options. Replace its options with those to keep instead.",
    };
  const values = new Set(options.map((option) => option.value));
  return {
    card: {
      ...card,
      blocks: card.blocks.map((each) =>
        each === block
          ? {
              ...block,
              options,
              initial: block.initial.filter((value) => values.has(value)),
            }
          : each
      ),
    },
  };
}

/** Updates a card without asking the model to repeat the rest of its contents. */
export default defineDynamic({
  events: {
    "step.started": (event, context) => {
      if (!cardsOffered(context)) return null;
      const opener = cardTurnOpener(event, context);
      if (opener === undefined) return null;
      const sent = cardsThisTurn(context.messages);
      return {
        [patchCardToolName]: defineTool({
          availableInSubagents: false,
          description:
            "Update the same card in place without repeating it: give its ref and a note for the person, or change one choice's options. append adds new values at the end and updates existing values; replace gives the whole new set (2–8). Keep existing option values stable. A note answers a question on the card. message is a short answer for the chat if the card is closed; an open card updates silently. New photos must show the actual option. For other blocks or a different layout use update_card. No payment or booking is authorized by a card's press.",
          inputSchema,
          async execute({ ref, message, note, change }, toolContext) {
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
              chat.conversationChannel !== "telegram" ||
              !cardsEnabled(scopeFromPrincipal(current))
            ) {
              return {
                status: "refused" as const,
                reply:
                  "Nothing changed: update a card only in its own Telegram conversation, in a turn opened by the person, their card answer, or their errand's report.",
              };
            }
            if (sent >= cardsPerTurn) {
              return {
                status: "refused" as const,
                reply:
                  "Nothing changed: this turn already updated or sent its cards. End the turn.",
              };
            }
            const updated = await updateCard(
              scopeFromPrincipal(current),
              { conversationId: chat.conversationId, ref },
              async (kept) => {
                const changed = change
                  ? changeCardOptions(kept.card, change)
                  : { card: kept.card };
                if (changed.problem !== undefined)
                  return { card: undefined, problem: changed.problem };
                const candidate =
                  note === undefined ? changed.card : { ...changed.card, note };
                const checked = checkCard(
                  candidate,
                  message,
                  "Nothing changed"
                );
                if (checked.refusal)
                  return { card: undefined, problem: checked.refusal.reply };
                // Only the new options' links are asked: the kept ones went
                // out as partner links already.
                const linked = await cardWithPartnerLinks(
                  checked.card,
                  scopeFromPrincipal(current)
                );
                return keepCardPhotos(kept.id, linked, kept.card);
              }
            );
            if (!updated)
              return {
                status: "refused" as const,
                reply: `Nothing changed: card ${ref} is not in this conversation or has expired.`,
              };
            if (updated.revision === undefined || !updated.change.card) {
              return {
                status: "invalid" as const,
                reply:
                  "problem" in updated.change
                    ? updated.change.problem
                    : "Nothing changed: the card could not be kept. Correct the options and try again.",
              };
            }
            const quiet = cardWatched(updated.watchedAt, new Date());
            if (!quiet) {
              try {
                await sendCardButton(
                  chat.conversationId,
                  new URL(
                    `/card/${updated.id}`,
                    applicationOrigin()
                  ).toString(),
                  message
                );
              } catch {
                return {
                  status: "failed" as const,
                  reply:
                    "The card changed, but its message did not reach the chat. Tell the person what changed.",
                };
              }
            }
            markTurnDelivered(toolContext.session);
            const photos =
              "kept" in updated.change
                ? photosResult(updated.change)
                : { note: "" };
            return {
              status: "updated" as const,
              card: ref,
              revision: updated.revision,
              quiet,
              reply: `The same card is updated${quiet ? " in front of the person, without a chat message" : " and its button is in the chat"}. The person has the result. End this turn without writing again.${photos.note}`,
            };
          },
        }),
      };
    },
  },
});
