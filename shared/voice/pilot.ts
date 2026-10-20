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
