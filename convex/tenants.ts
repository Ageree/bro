import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";

const tenantDoc = v.object({
  _id: v.id("tenants"),
  _creationTime: v.number(),
  phoneE164: v.string(),
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
      .unique();
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
      .unique();
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
