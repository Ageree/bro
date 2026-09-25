import type { ModelMessage } from "ai";
import { z } from "zod";
import { startsTurn } from "@agent/lib/delivery/turn-sends";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import { type ConnectedApp, connectedApps } from "@shared/composio/catalog";

/**
 * How a person names each app in a message, in Latin or Cyrillic letters
 * and with Russian endings: «скинь в слак», «в ноушене», «задача в Трелло».
 */
const appNames = {
  airtable: /(?<!\p{L})(?:airtable|эйртейбл\p{L}{0,3})(?!\p{L})/iu,
  asana: /(?<!\p{L})(?:asana|асан[аеуы])(?!\p{L})/iu,
  calendly: /(?<!\p{L})(?:calendly|календли)(?!\p{L})/iu,
  clickup: /(?<!\p{L})(?:click\s?up|кликап\p{L}{0,3})(?!\p{L})/iu,
  discord: /(?<!\p{L})(?:discord|дискорд\p{L}{0,3})(?!\p{L})/iu,
  dropbox: /(?<!\p{L})(?:dropbox|дропбокс\p{L}{0,3})(?!\p{L})/iu,
  figma: /(?<!\p{L})(?:figma|фигм\p{L}{1,3})(?!\p{L})/iu,
  github: /(?<!\p{L})(?:github|гит\s?хаб\p{L}{0,3})(?!\p{L})/iu,
  hubspot: /(?<!\p{L})(?:hubspot|хабспот\p{L}{0,3})(?!\p{L})/iu,
  linear: /(?<!\p{L})(?:linear|линеар\p{L}{0,3})(?!\p{L})/iu,
  miro: /(?<!\p{L})(?:miro|миро)(?!\p{L})/iu,
  notion:
    /(?<!\p{L})(?:notion|но[уy]?шн\p{L}{0,3}|ноушен\p{L}{0,3}|нотион\p{L}{0,3})(?!\p{L})/iu,
  outlook: /(?<!\p{L})(?:outlook|аутлук\p{L}{0,3})(?!\p{L})/iu,
  slack: /(?<!\p{L})(?:slack|сл[аэ]к\p{L}{0,3})(?!\p{L})/iu,
  todoist:
    /(?<!\p{L})(?:todoist|тудуист\p{L}{0,3}|тодоист\p{L}{0,3})(?!\p{L})/iu,
  trello: /(?<!\p{L})(?:trello|трелл?о)(?!\p{L})/iu,
  zoom: /(?<!\p{L})(?:zoom|зум(?:а|е|ом|у)?)(?!\p{L})/iu,
} as const satisfies Record<ConnectedApp, RegExp>;

const taggedMessageSchema = z.object({ kind: z.string() });

/** The text of the person's own message that opened the current turn. */
function openingPersonText(messages: readonly ModelMessage[]) {
  const opening = messages.findLast(startsTurn);
  if (opening?.role !== "user") return "";
  if (
    (taggedMessageSchema.safeParse(opening).data?.kind ?? "user") !== "user"
  ) {
    return "";
  }
  const text = Array.isArray(opening.content)
    ? opening.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : opening.content;
  return isBackgroundTurnText(text) ? "" : text;
}

/**
 * The apps the person named in their own message that opened this turn.
 * Only for these may a tool of an app they have not connected stop the turn
 * on a sign-in card: on 25.09 (RU d18) «скинь лёше, что освобожусь не
 * раньше восьми» went to `slack-search`, and the whole turn — the calendar
 * entry and the taxi with it — waited on a Slack sign-in the person had
 * never asked for. A browser report or a scheduled prompt names none.
 */
export function appsNamedByPerson(messages: readonly ModelMessage[]) {
  const text = openingPersonText(messages);
  if (text.length === 0) return [];
  return connectedApps.filter((app) => appNames[app].test(text));
}
