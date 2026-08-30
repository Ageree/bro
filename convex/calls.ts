import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { pickClaimableLeg, pickEndedCallLeg } from "./lib/callPolicy";
import { assertSecret } from "./secret";

const REASON = 2000;

const callLegDoc = v.object({
  _id: v.id("callLegs"),
  _creationTime: v.number(),
  tenantPhone: v.string(),
  destE164: v.string(),
  reason: v.string(),
  route: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("claimed"),
    v.literal("done"),
  ),
  jobId: v.optional(v.string()),
  inkboxCallId: v.optional(v.string()),
  bridgeCallId: v.optional(v.string()),
});

export const park = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    destE164: v.string(),
    reason: v.string(),
    route: v.string(),
    jobId: v.optional(v.string()),
  },
  returns: v.union(callLegDoc, v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const dest = args.destE164.trim();
    const reason = args.reason.trim().slice(0, REASON);
    if (!dest || !reason) return { error: "dest and reason required" };
    const id = await ctx.db.insert("callLegs", {
      tenantPhone: args.tenantPhone,
      destE164: dest,
      reason,
      route: args.route,
      status: "pending",
      jobId: args.jobId,
    });
    const row = await ctx.db.get(id);
    if (!row) return { error: "insert failed" };
    return row;
  },
});

export const attachInkbox = mutation({
  args: {
    secret: v.string(),
    legId: v.id("callLegs"),
    inkboxCallId: v.string(),
  },
  returns: v.union(callLegDoc, v.object({ error: v.string() })),
  handler: async (ctx, { secret, legId, inkboxCallId }) => {
    assertSecret(secret);
    const row = await ctx.db.get(legId);
    if (!row) return { error: "unknown leg" };
    await ctx.db.patch(legId, { inkboxCallId });
    const next = await ctx.db.get(legId);
    if (!next) return { error: "missing" };
    return next;
  },
});

export const attachBridge = mutation({
  args: {
    secret: v.string(),
    legId: v.id("callLegs"),
    bridgeCallId: v.string(),
  },
  returns: v.union(callLegDoc, v.object({ error: v.string() })),
  handler: async (ctx, { secret, legId, bridgeCallId }) => {
    assertSecret(secret);
    const row = await ctx.db.get(legId);
    if (!row) return { error: "unknown leg" };
    await ctx.db.patch(legId, { bridgeCallId });
    const next = await ctx.db.get(legId);
    if (!next) return { error: "missing" };
    return next;
  },
});

export const drop = mutation({
  args: {
    secret: v.string(),
    legId: v.id("callLegs"),
  },
  returns: v.null(),
  handler: async (ctx, { secret, legId }) => {
    assertSecret(secret);
    const row = await ctx.db.get(legId);
    if (row && row.status === "pending") {
      await ctx.db.patch(legId, { status: "done" });
    }
    return null;
  },
});

export const getByInkboxCall = query({
  args: { secret: v.string(), inkboxCallId: v.string() },
  returns: v.union(callLegDoc, v.null()),
  handler: async (ctx, { secret, inkboxCallId }) => {
    assertSecret(secret);
    return await ctx.db
      .query("callLegs")
      .withIndex("by_inkbox_call", (q) => q.eq("inkboxCallId", inkboxCallId))
      .first();
  },
});

export const finishByInkboxCall = mutation({
  args: { secret: v.string(), inkboxCallId: v.string() },
  returns: v.union(callLegDoc, v.null()),
  handler: async (ctx, { secret, inkboxCallId }) => {
    assertSecret(secret);
    const pending = await ctx.db
      .query("callLegs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(32);
    const claimed = await ctx.db
      .query("callLegs")
      .withIndex("by_status", (q) => q.eq("status", "claimed"))
      .take(32);
    const { matchId, staleIds } = pickEndedCallLeg(
      [...pending, ...claimed].map((row) => ({
        id: row._id,
        route: row.route,
        status: row.status,
        inkboxCallId: row.inkboxCallId,
        createdAt: row._creationTime,
      })),
      inkboxCallId,
      Date.now(),
    );
    for (const id of staleIds) {
      await ctx.db.patch(id as Id<"callLegs">, { status: "done" });
    }
    if (!matchId) return null;
    const row = [...pending, ...claimed].find((r) => r._id === matchId);
    if (!row) return null;
    await ctx.db.patch(row._id, { inkboxCallId, status: "done" });
    return await ctx.db.get(row._id);
  },
});

export const claimForBridge = internalMutation({
  args: { fromE164: v.optional(v.string()) },
  returns: v.union(
    v.object({
      destE164: v.string(),
      reason: v.string(),
      route: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, _args) => {
    const pending = await ctx.db
      .query("callLegs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(32);
    const { claimId, staleIds } = pickClaimableLeg(
      pending.map((row) => ({ id: row._id, createdAt: row._creationTime })),
      Date.now(),
    );
    for (const row of pending) {
      if (staleIds.includes(row._id)) {
        await ctx.db.patch(row._id, { status: "done" });
      }
    }
    if (!claimId) return null;
    const row = pending.find((r) => r._id === claimId);
    if (!row) return null;
    await ctx.db.patch(row._id, { status: "claimed" });
    return {
      destE164: row.destE164,
      reason: row.reason,
      route: row.route,
    };
  },
});
