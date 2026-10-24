import type { DynamicResolveContext } from "eve";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { personWordsThisTurn } from "@agent/lib/browser-use/said";
import { currentTurnMessages } from "@agent/lib/delivery/turn-sends";
import { startedByPerson } from "@agent/lib/mode";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import { secretAsked, secretInCard } from "@shared/cards/safety";
import { type Card, cardSchema } from "@shared/cards/schema";
import { personErrandRunId } from "@agent/lib/browser-use/report-caller";
import {
  answeredCardRef,
  openedByCardAnswer,
  openedByPersonErrandReport,
} from "./caller";
import { cardSentInHistory, cardToolNames } from "./sent";

/**
 * What `send_card` and `update_card` share: the turns they act in, how many
 * cards a turn may put in the chat, and the checks a card passes first.
 */

/**
 * Who opened the turn, as the card tools ask it at a step's start: the
 * person's own message; a card's answer, which carries their input; or the
 * report of a browser errand they gave, whose outcome — the hotels or
 * goods found, a plan — is the data a card shows. The report's text is a
 * page's, so its card is only a view of that data: its links are https, its
 * photos Bro's own copies, and its button brings an answer that is no
 * consent (`card-answer`). Nothing else opens a card turn — a background
 * errand's report, a schedule, a phone call, a page — whose text must not
 * become a card the person reads as Bro's.
 */
export function cardTurnOpener(
  event: Parameters<typeof stepStartedEventSchema.safeParse>[0],
  context: DynamicResolveContext
) {
  const turn = personWordsThisTurn(
    context.messages,
    stepIdentity(
      stepStartedEventSchema.safeParse(event).data,
      context.session.id
    )
  );
  if (turn.said !== null) return "person" as const;
  const caller = context.session.auth.current;
  if (
    openedByCardAnswer(context.messages) &&
    answeredCardRef(caller) !== undefined
  ) {
    return "card-answer" as const;
  }
  return openedByPersonErrandReport(context.messages, caller)
    ? ("report" as const)
    : undefined;
}

/** Whether the call runs under the caller of the turn's opener still. */
export function cardTurnCaller(
  opener: NonNullable<ReturnType<typeof cardTurnOpener>>,
  context: ToolContext
) {
  const caller = context.session.auth.current;
  if (opener === "person") return startedByPerson(context);
  if (opener === "card-answer") return answeredCardRef(caller) !== undefined;
  return personErrandRunId(caller) !== undefined;
}

/**
 * What a card tool answers, once in a report's turn, to a card that lists
 * options to pick from and asks nothing: the person could not choose a hotel
 * from the owner's first such card, nor book it (24.10).
 */
const pickReply =
  "these options are for the person to pick from, so the card asks. Make them a choice block (carousel when every option has a photo, otherwise list) with each option's page in more.href and the photos the report gives in photo and more.photos, and one primary submit button that names the action («Выбрать и забронировать», «Заказать выбранное») plus «Показать другие». The press books and pays nothing. A comparison decided by numbers alone (flights, tariffs) may stay as it is: then call again with the same card.";

const actionsReply =
  "the choice is ready, but its actions are incomplete. Keep this card, its choice and all its photos unchanged. In actions set primary: true on exactly one submit button for the pick, and add a second submit button labelled «Показать другие» (for example, submit: more_options). Nothing went to the chat. Call the card tool again with these actions; do not replace the card with send_message.";

/** Whether a card tool of this turn already answered with `pickReply`. */
function pickAsked(messages: DynamicResolveContext["messages"]) {
  return currentTurnMessages(messages).some(
    (message) =>
      message.role === "tool" &&
      message.content.some(
        (part) =>
          part.type === "tool-result" &&
          cardToolNames.has(part.toolName) &&
          "value" in part.output &&
          (JSON.stringify(part.output.value).includes(pickReply) ||
            JSON.stringify(part.output.value).includes(actionsReply))
      )
  );
}

/**
 * The refusal of a card in a report's turn that lists three or more options
 * with their pages and has no choice, or a choice without both actions.
 * Once per turn: the same card sent again goes out.
 */
export function pickRefusal(
  card: Card,
  opener: ReturnType<typeof cardTurnOpener>,
  messages: DynamicResolveContext["messages"],
  nothing = "Nothing was sent"
) {
  if (opener !== "report") return undefined;
  const asks = card.blocks.some((block) => block.type === "choice");
  const options = card.blocks.some(
    (block) =>
      block.type === "list" &&
      block.rows.filter((row) => row.href ?? row.more?.href).length >= 3
  );
  const submits = card.actions.filter((action) => "submit" in action);
  const incompleteChoice = card.blocks.some(
    (block) =>
      block.type === "choice" &&
      block.options.filter((option) => option.more?.href).length >= 3 &&
      (submits.length < 2 ||
        submits.filter((action) => action.primary).length !== 1)
  );
  const needsChoice = !asks && options;
  if ((!needsChoice && !incompleteChoice) || pickAsked(messages))
    return undefined;
  return {
    reply: `${nothing}: ${incompleteChoice ? actionsReply : pickReply}`,
    status: "refused" as const,
  };
}

/** Cards one turn may put in the chat, sent or updated: a loop would post one after another. */
export const cardsPerTurn = 2;

/** How many cards this turn put in the chat, sent or updated. */
export function cardsThisTurn(messages: DynamicResolveContext["messages"]) {
  return currentTurnMessages(messages).flatMap((message) =>
    message.role === "tool"
      ? message.content.filter(
          (part) =>
            part.type === "tool-result" &&
            cardToolNames.has(part.toolName) &&
            cardSentInHistory(part.output)
        )
      : []
  ).length;
}

type Item = Extract<
  Card["blocks"][number],
  { type: "choice" }
>["options"][number];

/**
 * A row or an option without the photos behind «Подробнее» that repeat its
 * own photo or each other: the model puts the main photo there too, and the
 * person would leaf through it twice.
 */
function withoutRepeatedItemPhotos<Each extends Pick<Item, "more" | "photo">>(
  item: Each
): Each {
  if (!item.more?.photos) return item;
  const seen = new Set(item.photo ? [item.photo.url] : []);
  const photos = item.more.photos.filter((photo) => {
    if (seen.has(photo.url)) return false;
    seen.add(photo.url);
    return true;
  });
  const { photos: _repeated, ...rest } = item.more;
  const more = photos.length > 0 ? { ...rest, photos } : rest;
  return { ...item, more: Object.keys(more).length > 0 ? more : undefined };
}

/** The card with no photo shown twice by the same row or option. */
function withoutRepeatedPhotos(card: Card): Card {
  return {
    ...card,
    blocks: card.blocks.map((block) => {
      if (block.type === "list") {
        return { ...block, rows: block.rows.map(withoutRepeatedItemPhotos) };
      }
      if (block.type === "choice") {
        return {
          ...block,
          options: block.options.map(withoutRepeatedItemPhotos),
        };
      }
      return block;
    }),
  };
}

const secretNames = {
  "card-number": "a full card number",
  document: "a passport or SNILS number",
  secret: "a password, a key or a one-time code",
} as const;

/**
 * The card as it may be kept, or the tool's refusal, opening with what was
 * not done: a card outside the catalog, a field that asks for what a card
 * never takes, or a text of the card or its message that shows one.
 */
export function checkCard(card: Card, message: string, nothing: string) {
  const checked = cardSchema.safeParse(withoutRepeatedPhotos(card));
  if (!checked.success) {
    return {
      refusal: {
        status: "invalid" as const,
        reply: `${nothing}: the card does not fit the catalog. Fix these and call again (links are https://, a button may also be tel: or mailto:).\n${z.prettifyError(checked.error)}`,
      },
    };
  }
  const asked = secretAsked(checked.data);
  if (asked !== undefined) {
    return {
      refusal: {
        status: "refused" as const,
        reply: `${nothing}: the field ${asked.path} asks for ${secretNames[asked.kind]}, which a card never takes. Ask for it in the chat if it is needed at all, and call again without that field.`,
      },
    };
  }
  const secret = secretInCard(checked.data, message);
  if (secret !== undefined) {
    return {
      refusal: {
        status: "refused" as const,
        reply: `${nothing}: ${secret.path} shows ${secretNames[secret.kind]}. A card never carries these (a card number only as its last four digits); say it in the chat if the person needs it. Compose the card without it and call again.`,
      },
    };
  }
  return { card: checked.data };
}
