/**
 * The voice page's words to Bro start with this marker (`app/(talk)/talk`):
 * the web channel then tells the model that its reply is read aloud
 * (`agent/channels/eve.ts`). A plain constant, so the page imports it
 * without the server's environment.
 */
export const voiceTalkMarker = "[голосом]";
