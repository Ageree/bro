import { ConvexHttpClient } from "convex/browser";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { groupPersonalBlock } from "../lib/group-guard";
import { tenantId } from "../lib/tenant";

const SHARED = new Set(["local-dev", "unknown", "default", "eve:app"]);

export default defineTool({
  description:
    "Start ChatGPT / Codex device login. Returns a URL and one-time code. Group chats: refuse. Do not invent a code.",
  inputSchema: z.object({}),
  async execute(_args, ctx) {
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { status: "group", error: blocked };
    const phone = tenantId(ctx);
    if (SHARED.has(phone)) {
      return {
        status: "unavailable",
        error: "ChatGPT вход только в личке, не в local-dev.",
      };
    }

    const url = process.env.CONVEX_URL?.trim();
    const secret = process.env.BRO_INTERNAL_SECRET?.trim();
    if (!url || !secret) {
      return { status: "unavailable", error: "ChatGPT вход сейчас недоступен" };
    }

    try {
      const client = new ConvexHttpClient(url);
      const started = await client.action(api.chatgptSecrets.startLoginForAgent, {
        secret,
        phoneE164: phone,
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
    } catch (err) {
      console.error("chatgpt startLogin failed", err);
      return {
        status: "unavailable",
        error: err instanceof Error ? err.message : "ChatGPT вход сейчас недоступен",
      };
    }
  },
});
