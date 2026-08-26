import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tenants: defineTable({
    phoneE164: v.string(),
    displayName: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("disabled")),
    inkboxConversationId: v.optional(v.string()),
    browserSessionId: v.optional(v.string()),
    browserLiveUrl: v.optional(v.string()),
    browserRunId: v.optional(v.string()),
    browserTask: v.optional(v.string()),
    browserStatus: v.optional(v.string()),
  }).index("by_phone", ["phoneE164"]),

  memories: defineTable({
    phoneE164: v.string(),
    line: v.string(),
  }).index("by_phone", ["phoneE164"]),

  orders: defineTable({
    tenantId: v.id("tenants"),
    merchant: v.union(v.literal("wb"), v.literal("ozon"), v.literal("other")),
    merchantOrderId: v.string(),
    title: v.string(),
    priceRub: v.number(),
    status: v.union(
      v.literal("placed"),
      v.literal("cancelled"),
      v.literal("unknown"),
    ),
  }).index("by_tenant", ["tenantId"]),
});
