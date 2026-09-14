import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";
import { findTenantByPhone as tenantByPhone } from "./lib/tenantLookup";
import { isStaleBrowserSession } from "./lib/browserSessionGc";

const WRITER_TTL_MS = 20 * 60 * 1000;
// Bound one sweep's work; a busier deployment catches the rest on the next
// 30-minute cron tick instead of reading the whole table in one call.
const GC_SWEEP_LIMIT = 500;

const sessionView = v.object({
  sessionId: v.string(),
  workerSessionId: v.optional(v.string()),
  saveChanges: v.boolean(),
  createdAt: v.number(),
});

export const register = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    sessionId: v.string(),
    workerSessionId: v.optional(v.string()),
    saveChanges: v.boolean(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({
      ok: v.literal(false),
      reason: v.literal("writer_busy"),
      sessionId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenant = await tenantByPhone(ctx, args.phoneE164);
    if (!tenant) throw new Error("unknown tenant");
    if (args.saveChanges) {
      const rows = await ctx.db
        .query("browserSessions")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
        .collect();
      const cutoff = Date.now() - WRITER_TTL_MS;
      const busy = rows.find((row) => row.saveChanges && row.createdAt > cutoff);
      if (busy) {
        return {
          ok: false as const,
          reason: "writer_busy" as const,
          sessionId: busy.sessionId,
        };
      }
    }
    await ctx.db.insert("browserSessions", {
      tenantId: tenant._id,
      sessionId: args.sessionId,
      saveChanges: args.saveChanges,
      createdAt: Date.now(),
      ...(args.workerSessionId !== undefined
        ? { workerSessionId: args.workerSessionId }
        : {}),
    });
    return { ok: true as const };
  },
});

export const drop = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    sessionId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164, sessionId }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    if (!tenant) return null;
    const row = await ctx.db
      .query("browserSessions")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (row && row.tenantId === tenant._id) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

export const get = query({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    sessionId: v.string(),
  },
  returns: v.union(sessionView, v.null()),
  handler: async (ctx, { secret, phoneE164, sessionId }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    if (!tenant) return null;
    const row = await ctx.db
      .query("browserSessions")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (!row || row.tenantId !== tenant._id) return null;
    return {
      sessionId: row.sessionId,
      workerSessionId: row.workerSessionId,
      saveChanges: row.saveChanges,
      createdAt: row.createdAt,
    };
  },
});

export const listIds = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    if (!tenant) return [];
    const rows = await ctx.db
      .query("browserSessions")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
      .collect();
    return rows.map((row) => row.sessionId);
  },
});

/**
 * Drop `browserSessions` rows a crashed worker never cleaned up (no cron
 * previously swept this table at all — Finding A4 #7). Called by the
 * `browsersGc` cron action, which also best-effort deletes the matching
 * Kernel browser when this Convex deployment holds `KERNEL_API_KEY`; when it
 * doesn't (the API key normally only lives in the worker's own hosting env),
 * this mutation still bounds how long an orphaned row lingers.
 */
export const sweepStale = internalMutation({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db.query("browserSessions").take(GC_SWEEP_LIMIT);
    const now = Date.now();
    const stale = rows.filter((row) => isStaleBrowserSession(row, now));
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    return stale.map((row) => row.sessionId);
  },
});
