import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { startDeviceAuth } from "../lib/chatgpt-oauth";
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

    const started = await startDeviceAuth();
    const url = process.env.CONVEX_URL?.trim();
    const secret = process.env.BRO_INTERNAL_SECRET?.trim();
    if (url && secret) {
      try {
        const client = new ConvexHttpClient(url);
        await client.mutation(anyApi.chatgpt.beginLoginForAgent, {
          secret,
          phoneE164: phone,
          deviceAuthId: started.deviceAuthId,
          userCode: started.userCode,
          interval: started.interval,
          expiresAt: started.expiresAt,
          now: Date.now(),
        });
      } catch (err) {
        console.error("chatgpt startLogin persist failed", err);
      }
    }

    return {
      status: "ok" as const,
      url: started.url,
      userCode: started.userCode,
      interval: started.interval,
      expiresAt: started.expiresAt,
      message:
        `Открой ${started.url} и введи код ${started.userCode}. ` +
        "Поллинг подтверждения ещё не подключён — напиши, когда код принят.",
    };
  },
});
