import { ConvexHttpClient } from "convex/browser";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { groupPersonalBlock } from "../lib/group-guard";
import { tenantId } from "../lib/tenant";

const SHARED = new Set(["local-dev", "unknown", "default", "eve:app"]);

export default defineTool({
  description:
    "ChatGPT / Codex login status for this person: none, pending, connected, or quarantined. Group chats: refuse.",
  inputSchema: z.object({}),
  async execute(_args, ctx) {
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { status: "group", error: blocked };
    const phone = tenantId(ctx);
    if (SHARED.has(phone)) {
      return { status: "unavailable" as const };
    }

    const url = process.env.CONVEX_URL?.trim();
    const secret = process.env.BRO_INTERNAL_SECRET?.trim();
    if (!url || !secret) {
      return { status: "none" as const };
    }
    try {
      const client = new ConvexHttpClient(url);
      return await client.query(api.chatgpt.statusForAgent, {
        secret,
        phoneE164: phone,
        now: Date.now(),
      });
    } catch (err) {
      console.error("chatgpt status failed", err);
      return { status: "none" as const };
    }
  },
});
