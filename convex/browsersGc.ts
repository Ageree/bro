"use node";

/**
 * 30-minute sweep for orphaned Kernel browsers / stale `browserSessions`
 * rows (Finding A4 #7 — no code path previously did this at all). Deleting
 * a Kernel browser needs the SDK, hence "use node"; the actual row query and
 * delete lives in `convex/browsers.ts` (kept free of "use node" per the
 * runtime split every other action in this repo follows, e.g.
 * `vaultSecrets.ts`).
 */
import { v } from "convex/values";
import Kernel from "@onkernel/sdk";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

export const sweep = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const staleSessionIds: string[] = await ctx.runMutation(
      internal.browsers.sweepStale,
      {},
    );
    const apiKey = process.env.KERNEL_API_KEY?.trim();
    // Without a Kernel key on this deployment, dropping the stale Convex
    // rows above is the only cleanup available — the real browser (if any)
    // still dies on its own `timeout_seconds`.
    if (apiKey && staleSessionIds.length > 0) {
      const client = new Kernel({ apiKey });
      for (const sessionId of staleSessionIds) {
        await client.browsers.deleteByID(sessionId).catch(() => undefined);
      }
    }
    return null;
  },
});
