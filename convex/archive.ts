import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";

const BATCH = 128;

/** Active tenants whose connected-app archive should be refreshed. */
export const listSyncTargets = internalQuery({
  args: {},
  returns: v.array(
    v.object({ phoneE164: v.string(), sinceMs: v.optional(v.number()) }),
  ),
  handler: async (ctx) => {
    const tenants = await ctx.db.query("tenants").take(BATCH);
    return tenants
      .filter((t) => t.status === "active" && t.phoneE164)
      .map((t) => ({
        phoneE164: t.phoneE164 as string,
        ...(t.archiveSyncedAt !== undefined ? { sinceMs: t.archiveSyncedAt } : {}),
      }));
  },
});

export const markSynced = internalMutation({
  args: { phoneE164: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { phoneE164, at }) => {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (tenant) await ctx.db.patch(tenant._id, { archiveSyncedAt: at });
    return null;
  },
});

/**
 * Hourly: ask the eve app to copy each person's fresh Gmail/Calendar data
 * into their Supermemory archive. The eve route skips apps that are not
 * connected, so dispatching to every active tenant is cheap.
 */
export const dispatchSyncs = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const eveUrl = process.env.EVE_URL;
    // ponytail: no EVE_URL on this deployment → silent no-op
    if (!eveUrl) return null;
    const secret = process.env.BRO_INTERNAL_SECRET ?? "";
    const targets = await ctx.runQuery(internal.archive.listSyncTargets, {});
    const startedAt = Date.now();
    for (const t of targets) {
      try {
        const res = await fetch(`${eveUrl}/internal/memory-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret,
            tenantPhone: t.phoneE164,
            sinceMs: t.sinceMs,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        // An old eve deployment answers 200 with HTML for unknown routes;
        // only a real {ok:true} from the sync route counts as synced.
        const json = res.ok
          ? ((await res.json().catch(() => null)) as { ok?: unknown } | null)
          : null;
        if (json?.ok === true) {
          await ctx.runMutation(internal.archive.markSynced, {
            phoneE164: t.phoneE164,
            at: startedAt,
          });
        }
      } catch (err) {
        console.error("archive sync dispatch failed", t.phoneE164, err);
      }
    }
    return null;
  },
});
