import { env } from "@shared/environment";

/**
 * Whether the workspace has /talk, the voice conversation with Bro
 * (VOICE_WORKSPACES, ids or `*`): read by the page, its session route and the
 * web channel, decided without a lookup. GPT-Live needs OpenAI's key.
 */
export function voiceTalkEnabled(workspaceId: string) {
  const list = env.VOICE_WORKSPACES ?? [];
  return (
    (list.includes("*") || list.includes(workspaceId)) &&
    env.OPENAI_API_KEY !== undefined
  );
}

/**
 * Whether /talk's voice knows its person and waits less (VOICE_FAST_WORKSPACES,
 * ids or `*`, within the voice pilot): the session carries a brief of the
 * person (`agent/lib/voice/brief.ts`), the voice says no filler before a quick
 * answer, and Bro's turns from the voice skip the heads-up and the tool
 * router (`agent/lib/voice/turn.ts`).
 */
export function voiceFastEnabled(workspaceId: string) {
  return voiceTalkEnabled(workspaceId) && voiceFastListed(workspaceId);
}

/**
 * Whether VOICE_FAST_WORKSPACES names the workspace, whatever its other
 * pilots: a GPT-Live call reads its answers ahead and says no filler before
 * a quick one (`agent/lib/phone/live/place.ts`).
 */
export function voiceFastListed(workspaceId: string) {
  const list = env.VOICE_FAST_WORKSPACES ?? [];
  return list.includes("*") || list.includes(workspaceId);
}

/**
 * Whether a question of /talk the web answers is answered by one small model
 * call with a search before Bro's turn (VOICE_QUICK_WORKSPACES, ids or `*`,
 * within the fast voice): `agent/lib/voice/quick.ts`.
 */
export function voiceQuickEnabled(workspaceId: string) {
  const list = env.VOICE_QUICK_WORKSPACES ?? [];
  return (
    voiceFastEnabled(workspaceId) &&
    (list.includes("*") || list.includes(workspaceId))
  );
}
