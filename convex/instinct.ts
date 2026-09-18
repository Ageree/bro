/**
 * Durable state behind the proactivity budget (`convex/lib/instinctPolicy.ts`).
 *
 * The policy is pure and holds no memory, so someone has to remember how many
 * unprompted messages this person already got today, when the last one went
 * out, and what has already been said. That has to survive an eve restart and
 * be shared by every instance — an in-memory map would reset the daily cap on
 * every deploy, which is exactly how a "three a day" budget turns into a feed.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";
import { findTenantByPhone } from "./lib/tenantLookup";
import { dayKey } from "./lib/billingPolicy";
import { pruneSpoken } from "./lib/instinctPolicy";

const spokenRecord = v.object({ sourceId: v.string(), at: v.number() });

/** Everything `instinctAllowed` + `alreadySpoken` need, in one read. */
export const state = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(
    v.object({
      tz: v.optional(v.string()),
      sentToday: v.number(),
      lastSentAt: v.optional(v.number()),
      lastHumanAt: v.optional(v.number()),
      spoken: v.array(spokenRecord),
    }),
    v.null(),
  ),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await findTenantByPhone(ctx, phoneE164);
    if (!tenant || tenant.status !== "active") return null;
    const now = Date.now();
    const key = dayKey(now, tenant.tz);
    return {
      tz: tenant.tz,
      // A counter from another local day is not this day's spend. Rolling it
      // over here (rather than clearing it on a timer) keeps the budget honest
      // across a tz change too: the key is recomputed in the person's zone.
      sentToday: tenant.instinctDayKey === key ? (tenant.instinctDayCount ?? 0) : 0,
      ...(tenant.instinctLastAt !== undefined
        ? { lastSentAt: tenant.instinctLastAt }
        : {}),
      ...(tenant.lastHumanAt !== undefined
        ? { lastHumanAt: tenant.lastHumanAt }
        : {}),
      spoken: pruneSpoken(tenant.instinctSpoken ?? [], now),
    };
  },
});

/**
 * Record one unprompted message: it costs a slot and marks its sources said.
 *
 * Called when the initiative turn actually produced a bubble, not when the
 * scan started — a scan that ends in `[SILENT]` interrupted nobody and must
 * not burn a slot. The sources are marked either way by the caller passing
 * them here, because a thing Bro looked at and chose not to mention should not
 * be re-offered every half hour.
 */
export const noteSpoken = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    sourceIds: v.array(v.string()),
    /** False for a scan that stayed silent: mark the sources, keep the slot. */
    spent: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164, sourceIds, spent }) => {
    assertSecret(secret);
    const tenant = await findTenantByPhone(ctx, phoneE164);
    if (!tenant) return null;
    const now = Date.now();
    const key = dayKey(now, tenant.tz);
    const kept = pruneSpoken(tenant.instinctSpoken ?? [], now);
    const seen = new Set(kept.map((s) => s.sourceId));
    for (const id of sourceIds) {
      const trimmed = id.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      kept.push({ sourceId: trimmed, at: now });
    }
    const sameDay = tenant.instinctDayKey === key;
    await ctx.db.patch(tenant._id, {
      instinctSpoken: kept,
      ...(spent
        ? {
            instinctDayKey: key,
            instinctDayCount: (sameDay ? (tenant.instinctDayCount ?? 0) : 0) + 1,
            instinctLastAt: now,
          }
        : {}),
    });
    return null;
  },
});
