import { v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { assertSecret } from "./secret";

const WRITER_TTL_MS = 20 * 60 * 1000;

const sessionView = v.object({
  sessionId: v.string(),
  workerSessionId: v.optional(v.string()),
  saveChanges: v.boolean(),
  createdAt: v.number(),
});

async function tenantByPhone(
  ctx: QueryCtx | MutationCtx,
  phoneE164: string,
) {
  return await ctx.db
    .query("tenants")
    .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
    .first();
}

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
