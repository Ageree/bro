/**
 * The voice page's words to Bro start with this marker (`app/(talk)/talk`):
 * the web channel then tells the model that its reply is read aloud
 * (`agent/channels/eve.ts`). A plain module, so the page imports it without
 * the server's environment.
 */
export const voiceTalkMarker = "[голосом]";

/**
 * A line of the voice's own between the person's words in such a message
 * (`_lib/hearing.ts`): context for the model, never the person's request.
 */
export function voiceLine(text: string) {
  return `(ты: «${text}»)`;
}

export const voiceLinePattern = /^\(ты: «.*»\)$/gmu;
