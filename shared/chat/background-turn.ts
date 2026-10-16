/**
 * The first line of a turn message Bro writes to itself: a scheduled task's
 * result or its own check of the person's mail. A messaging chat never shows
 * the turn input, but the web chat shows every user message of its session,
 * so it hides a message that opens with this line instead of presenting the
 * internal prompt as something the person wrote.
 */
export const backgroundTurnMarker =
  "[Background turn: this message is not from the person]";

export function isBackgroundTurnText(text: string) {
  return text.startsWith(backgroundTurnMarker);
}

/**
 * Follows the marker in a notice code wrote to a web chat in Bro's name, in a
 * turn that calls no model (`agent/lib/browser-use/abandoned-notice.ts`):
 * nothing in that turn calls `send_message`, so the chat shows the text
 * after it as Bro's message, and a later turn reads it as what the person
 * was told.
 */
const backgroundNoticeHeading =
  "Shown to the person in this chat as your message:";

const backgroundNoticePrefix = `${backgroundTurnMarker}\n\n${backgroundNoticeHeading}\n\n`;

export function backgroundNoticeMessage(notice: string) {
  return `${backgroundNoticePrefix}${notice}`;
}

/** The notice a background message shows the person, if it is one. */
export function backgroundNoticeText(text: string) {
  return text.startsWith(backgroundNoticePrefix)
    ? text.slice(backgroundNoticePrefix.length)
    : undefined;
}
