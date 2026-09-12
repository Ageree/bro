import { defineTool } from "eve/tools";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { chatgptAgentCall } from "../lib/chatgpt-tool";

type StatusResult =
  | { status: "unavailable" }
  | {
      status: "none" | "pending" | "connected" | "quarantined";
      email?: string;
      planType?: string;
    };

export default defineTool({
  description:
    "ChatGPT / Codex login status for this person: none, pending, connected, or quarantined. Group chats: refuse.",
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    chatgptAgentCall<StatusResult>({
      ctx,
      sharedFallback: { status: "unavailable" as const },
      envFallback: { status: "none" as const },
      errorLabel: "chatgpt status failed",
      catchFallback: () => ({ status: "none" as const }),
      call: (client, secret, phoneE164) =>
        client.query(api.chatgpt.statusForAgent, {
          secret,
          phoneE164,
          now: Date.now(),
        }),
    }),
});
