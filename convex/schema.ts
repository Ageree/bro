import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tenants: defineTable({
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
    browserStartedAt: v.optional(v.number()),
    paidUntil: v.optional(v.number()),
    msgsDayKey: v.optional(v.string()),
    msgsDayCount: v.optional(v.number()),
    browserMonthKey: v.optional(v.string()),
    browserMonthCount: v.optional(v.number()),
    paywallSentDayKey: v.optional(v.string()),
  })
    .index("by_phone", ["phoneE164"])
    .index("by_handle", ["inkboxHandle"])
    .index("by_conversation", ["inkboxConversationId"])
    .index("by_email", ["emailAddress"]),

  jobs: defineTable({
    tenantId: v.id("tenants"),
    goal: v.string(),
    doneWhen: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("waiting"),
      v.literal("done"),
      v.literal("failed"),
    ),
    waitingFor: v.optional(
      v.union(v.literal("human"), v.literal("email"), v.literal("browser")),
    ),
    note: v.optional(v.string()),
    emailThreadId: v.optional(v.string()),
    emailMessageId: v.optional(v.string()),
  }).index("by_tenant", ["tenantId"]),

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

  wakeups: defineTable({
    tenantPhone: v.string(),
    at: v.number(),
    kind: v.union(
      v.literal("reminder"),
      v.literal("browser_poll"),
      v.literal("brief"),
      v.literal("watcher"),
    ),
    payload: v.string(),
    status: v.union(
      v.literal("scheduled"),
      v.literal("running"),
      v.literal("done"),
      v.literal("cancelled"),
      v.literal("failed"),
    ),
    recurMinutes: v.optional(v.number()),
    recurDailyHour: v.optional(v.number()),
    tz: v.optional(v.string()),
    lastSeen: v.optional(v.string()),
    attempts: v.optional(v.number()),
    gen: v.optional(v.number()),
  })
    .index("by_status_at", ["status", "at"])
    .index("by_tenant", ["tenantPhone"])
    .index("by_tenant_status", ["tenantPhone", "status"]),
});
