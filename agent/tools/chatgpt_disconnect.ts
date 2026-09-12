import { defineTool } from "eve/tools";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { chatgptAgentCall } from "../lib/chatgpt-tool";

type DisconnectResult =
  | { status: "unavailable"; error: string }
  | { status: "ok" | "none" };

export default defineTool({
  description:
    "Disconnect ChatGPT / Codex for this person. Next turns use OpenRouter. Group chats: refuse.",
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    chatgptAgentCall<DisconnectResult>({
      ctx,
      sharedFallback: {
        status: "unavailable",
        error: "ChatGPT отключение только в личке, не в local-dev.",
      },
      envFallback: { status: "ok" as const },
      errorLabel: "chatgpt disconnect failed",
      catchFallback: () => ({ status: "ok" as const }),
      call: (client, secret, phoneE164) =>
        client.action(api.chatgptSecrets.disconnect, { secret, phoneE164 }),
    }),
});
