import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const getByPhone = query({
  args: { phoneE164: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("tenants"),
      _creationTime: v.number(),
      phoneE164: v.string(),
      displayName: v.optional(v.string()),
      status: v.union(v.literal("active"), v.literal("disabled")),
      inkboxConversationId: v.optional(v.string()),
      browserProfileId: v.optional(v.string()),
      browserSessionId: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, { phoneE164 }) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .unique();
  },
});

export const upsert = mutation({
  args: {
    phoneE164: v.string(),
    inkboxConversationId: v.optional(v.string()),
  },
  returns: v.id("tenants"),
  handler: async (ctx, { phoneE164, inkboxConversationId }) => {
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .unique();
    if (existing) {
      if (inkboxConversationId && existing.inkboxConversationId !== inkboxConversationId) {
        await ctx.db.patch(existing._id, { inkboxConversationId });
      }
      return existing._id;
    }
    return await ctx.db.insert("tenants", {
      phoneE164,
      status: "active",
      inkboxConversationId,
    });
  },
});
