import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";

export const tenantDoc = v.object({
  _id: v.id("tenants"),
  _creationTime: v.number(),
  phoneE164: v.optional(v.string()),
  inkboxHandle: v.optional(v.string()),
  inkboxIdentityId: v.optional(v.string()),
  emailAddress: v.optional(v.string()),
  webhookSigningKey: v.optional(v.string()),
  displayName: v.optional(v.string()),
  status: v.union(v.literal("active"), v.literal("disabled")),
  inkboxConversationId: v.optional(v.string()),
  browserSessionId: v.optional(v.string()),
  browserLiveUrl: v.optional(v.string()),
  browserRunId: v.optional(v.string()),
  browserTask: v.optional(v.string()),
  browserStatus: v.optional(v.string()),
});

export const getByPhone = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    return await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
  },
});

export const getByHandle = query({
  args: { secret: v.string(), handle: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, handle }) => {
    assertSecret(secret);
    return await ctx.db
      .query("tenants")
      .withIndex("by_handle", (q) => q.eq("inkboxHandle", handle))
      .unique();
  },
});

export const getByConversation = query({
  args: { secret: v.string(), conversationId: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, conversationId }) => {
    assertSecret(secret);
    return await ctx.db
      .query("tenants")
      .withIndex("by_conversation", (q) =>
        q.eq("inkboxConversationId", conversationId),
      )
      .unique();
  },
});

export const upsert = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    inkboxConversationId: v.optional(v.string()),
  },
  returns: tenantDoc,
  handler: async (ctx, { secret, phoneE164, inkboxConversationId }) => {
    assertSecret(secret);
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (existing) {
      if (
        inkboxConversationId &&
        existing.inkboxConversationId !== inkboxConversationId
      ) {
        await ctx.db.patch(existing._id, { inkboxConversationId });
        return { ...existing, inkboxConversationId };
      }
      return existing;
    }
    const id = await ctx.db.insert("tenants", {
      phoneE164,
      status: "active",
      inkboxConversationId,
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("tenant insert failed");
    return created;
  },
});

export const setBrowser = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    browserSessionId: v.optional(v.string()),
    browserLiveUrl: v.optional(v.string()),
    browserRunId: v.optional(v.string()),
    browserTask: v.optional(v.string()),
    browserStatus: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .first();
    if (!existing) throw new Error("unknown tenant");
    await ctx.db.patch(existing._id, {
      browserSessionId: args.browserSessionId,
      browserLiveUrl: args.browserLiveUrl,
      browserRunId: args.browserRunId,
      browserTask: args.browserTask,
      browserStatus: args.browserStatus,
    });
    return null;
  },
});

export const countProvisioned = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    // ponytail: table is capped at BRO_IDENTITY_CAP (~10); scan is enough.
    const rows = await ctx.db.query("tenants").take(64);
    return rows.filter((r) => r.inkboxHandle).length;
  },
});

export const getByHandleInternal = internalQuery({
  args: { handle: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { handle }) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_handle", (q) => q.eq("inkboxHandle", handle))
      .unique();
  },
});

export const insertProvisioned = internalMutation({
  args: {
    inkboxHandle: v.string(),
    inkboxIdentityId: v.string(),
    emailAddress: v.optional(v.string()),
    webhookSigningKey: v.optional(v.string()),
  },
  returns: tenantDoc,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_handle", (q) => q.eq("inkboxHandle", args.inkboxHandle))
      .unique();
    if (existing) return existing;
    const id = await ctx.db.insert("tenants", {
      inkboxHandle: args.inkboxHandle,
      inkboxIdentityId: args.inkboxIdentityId,
      emailAddress: args.emailAddress,
      webhookSigningKey: args.webhookSigningKey,
      displayName: "Bro",
      status: "active",
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("tenant insert failed");
    return created;
  },
});

export const bindInbound = mutation({
  args: {
    secret: v.string(),
    handle: v.string(),
    phoneE164: v.string(),
    inkboxConversationId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), tenant: tenantDoc }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, { secret, handle, phoneE164, inkboxConversationId }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_handle", (q) => q.eq("inkboxHandle", handle))
      .unique();
    if (!tenant) return { ok: false as const, reason: "unknown handle" };
    if (tenant.status === "disabled") {
      return { ok: false as const, reason: "disabled" };
    }
    if (tenant.phoneE164 && tenant.phoneE164 !== phoneE164) {
      return { ok: false as const, reason: "wrong phone" };
    }
    const patch: {
      phoneE164?: string;
      inkboxConversationId?: string;
    } = {};
    if (!tenant.phoneE164) patch.phoneE164 = phoneE164;
    if (
      inkboxConversationId &&
      tenant.inkboxConversationId !== inkboxConversationId
    ) {
      patch.inkboxConversationId = inkboxConversationId;
    }
    if (Object.keys(patch).length) await ctx.db.patch(tenant._id, patch);
    const next = await ctx.db.get(tenant._id);
    if (!next) return { ok: false as const, reason: "missing" };
    return { ok: true as const, tenant: next };
  },
});
