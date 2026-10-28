/**
 * Where /talk opens its GPT-Live session and reads the person's calendar for
 * the voice (`agent/channels/voice.ts`): routes of the agent, which alone
 * reads Google through Composio. A plain module, so the page imports it
 * without the server's environment.
 */
export const voiceSessionPath = "/eve/v1/voice/session";
export const voiceCalendarPath = "/eve/v1/voice/calendar";
/** A question the web answers, for the quick answer (`agent/lib/voice/quick.ts`). */
export const voiceQuickPath = "/eve/v1/voice/quick";

/**
 * The session's answer carries it for VOICE_FAST_WORKSPACES: the page says
 * what the voice tells while Bro works and hands Bro's messages over bare
 * (`app/(talk)/talk/_lib/retell.ts`).
 */
export const voicePaceHeader = "x-bro-voice-pace";

/**
 * The session's answer carries it for VOICE_QUICK_WORKSPACES: the page asks
 * the quick answer first, and the words go to Bro when it has none.
 */
export const voiceQuickHeader = "x-bro-voice-quick";
