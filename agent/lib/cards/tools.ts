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
import { cardOfReport } from "./report";

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
  return (
    personErrandRunId(caller) !== undefined ||
    cardOfReport(caller) !== undefined
  );
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
  const checked = cardSchema.safeParse(card);
  if (!checked.success) {
    return {
      refusal: {
        status: "invalid" as const,
        reply: `${nothing}: the card does not fit the catalog. Fix these and call again (links are https://, a button may also be tel: or mailto:).\n${z.prettifyError(checked.error)}`,
      },
    };
  }
  const payment = checked.data.actions.find(
    (action) =>
      !("href" in action) &&
      /(?:^|[^\p{L}])(?:оплатить|заплатить|купить|перевести|pay|buy)(?!\p{L})/iu.test(
        action.label
      )
  );
  if (payment) {
    return {
      refusal: {
        status: "refused" as const,
        reply: `${nothing}: a card button cannot authorize a payment. Label «${payment.label}» as preparation or a selection instead; ask for payment with the exact total and wait for the person's plain yes in the chat.`,
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
