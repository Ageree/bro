import { defineTool } from "eve/tools";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { chatgptAgentCall } from "../lib/chatgpt-tool";

type ConnectResult =
  | { status: "unavailable"; error: string }
  | {
      status: "ok";
      url: string;
      userCode: string;
      interval: number;
      expiresAt: number;
      message: string;
    };

export default defineTool({
  description:
    "Start ChatGPT / Codex device login. Returns a URL and one-time code. Group chats: refuse. Do not invent a code.",
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    chatgptAgentCall<ConnectResult>({
      ctx,
      sharedFallback: {
        status: "unavailable",
        error: "ChatGPT вход только в личке, не в local-dev.",
      },
      envFallback: { status: "unavailable", error: "ChatGPT вход сейчас недоступен" },
      errorLabel: "chatgpt startLogin failed",
      catchFallback: (err) => ({
        status: "unavailable",
        error: err instanceof Error ? err.message : "ChatGPT вход сейчас недоступен",
      }),
      call: async (client, secret, phoneE164) => {
        const started = await client.action(api.chatgptSecrets.startLoginForAgent, {
          secret,
          phoneE164,
        });
        if (!started.ok) {
          return { status: "unavailable", error: started.reason };
        }
        return {
          status: "ok" as const,
          url: started.url,
          userCode: started.userCode,
          interval: started.interval,
          expiresAt: started.expiresAt,
          message:
            `Открой ${started.url} и введи код ${started.userCode}. ` +
            "Я сам проверю вход.",
        };
      },
    }),
});
