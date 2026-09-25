import type { ToolContext } from "eve/tools";

/**
 * The context eve hands a tool in a turn the person started from iMessage:
 * an authenticated user of one workspace, and nothing a policy tool reaches
 * for besides the session. `browser-result` makes it the report of a
 * browser run instead, whose text the page writes.
 */
export function toolContext(
  toolName: string,
  authenticator: "browser-result" | "photon-imessage" = "photon-imessage"
) {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: () => {
      throw new Error(`${toolName} does not use a sandbox.`);
    },
    getSkill: () => {
      throw new Error(`${toolName} does not use a skill.`);
    },
    getToken: () => {
      throw new Error(`${toolName} does not use a token provider.`);
    },
    requireAuth: (): never => {
      throw new Error(`${toolName} does not require a token provider.`);
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "workspace:alice" },
          authenticator,
          issuer: "photon",
          principalId: "alice",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName,
  } satisfies ToolContext;
}
