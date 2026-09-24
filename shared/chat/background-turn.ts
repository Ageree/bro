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
