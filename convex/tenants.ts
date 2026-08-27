import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { assertSecret } from "./secret";
import {
  browserAllowance,
  browserAllowedOnLimitError,
  dayKey,
  inboundDecisionOnLimitError,
  isPaid,
  monthKey,
  msgAllowance,
  paywallDecision,
  rateLimitPeriodKey,
  usedCount,
} from "./lib/billingPolicy";
import { periodConfig, rateLimiter } from "./lib/rateLimits";

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
  browserStartedAt: v.optional(v.number()),
  paidUntil: v.optional(v.number()),
  // deprecated: counters live in @convex-dev/rate-limiter
  msgsDayKey: v.optional(v.string()),
  msgsDayCount: v.optional(v.number()),
  browserMonthKey: v.optional(v.string()),
  browserMonthCount: v.optional(v.number()),
  paywallSentDayKey: v.optional(v.string()),
});

async function tenantByPhone(ctx: MutationCtx, phoneE164: string) {
  const existing = await ctx.db
    .query("tenants")
    .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
    .first();
  if (existing) return existing;
  const id = await ctx.db.insert("tenants", {
    phoneE164,
    status: "active",
  });
  const created = await ctx.db.get(id);
  if (!created) throw new Error("tenant insert failed");
  return created;
}

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

export const getByEmail = query({
  args: { secret: v.string(), emailAddress: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, emailAddress }) => {
    assertSecret(secret);
    const email = emailAddress.trim().toLowerCase();
    if (!email) return null;
    const rows = await ctx.db
      .query("tenants")
      .withIndex("by_email", (q) => q.eq("emailAddress", email))
      .take(2);
    // Fail closed: zero or two matches never wake a person.
    if (rows.length !== 1) return null;
    return rows[0]!;
  },
});

export const upsert = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    inkboxConversationId: v.optional(v.string()),
    emailAddress: v.optional(v.string()),
  },
  returns: tenantDoc,
  handler: async (ctx, { secret, phoneE164, inkboxConversationId, emailAddress }) => {
    assertSecret(secret);
    const email = emailAddress?.trim().toLowerCase();
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (existing) {
      const patch: {
        inkboxConversationId?: string;
        emailAddress?: string;
      } = {};
      if (
        inkboxConversationId &&
        existing.inkboxConversationId !== inkboxConversationId
      ) {
        patch.inkboxConversationId = inkboxConversationId;
      }
      if (email && existing.emailAddress !== email) patch.emailAddress = email;
      if (Object.keys(patch).length) {
        await ctx.db.patch(existing._id, patch);
        return { ...existing, ...patch };
      }
      return existing;
    }
    const id = await ctx.db.insert("tenants", {
      phoneE164,
      status: "active",
      inkboxConversationId,
      emailAddress: email || undefined,
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
    browserStartedAt: v.optional(v.number()),
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
      ...(args.browserSessionId !== undefined
        ? { browserSessionId: args.browserSessionId }
        : {}),
      ...(args.browserLiveUrl !== undefined
        ? { browserLiveUrl: args.browserLiveUrl }
        : {}),
      ...(args.browserRunId !== undefined ? { browserRunId: args.browserRunId } : {}),
      ...(args.browserTask !== undefined ? { browserTask: args.browserTask } : {}),
      ...(args.browserStatus !== undefined
        ? { browserStatus: args.browserStatus }
        : {}),
      ...(args.browserStartedAt !== undefined
        ? { browserStartedAt: args.browserStartedAt }
        : {}),
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

export const getByPhoneInternal = internalQuery({
  args: { phoneE164: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { phoneE164 }) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
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
    const email = args.emailAddress?.trim().toLowerCase();
    const id = await ctx.db.insert("tenants", {
      inkboxHandle: args.inkboxHandle,
      inkboxIdentityId: args.inkboxIdentityId,
      emailAddress: email || undefined,
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

export const countInboundMessage = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.object({
    decision: v.union(
      v.literal("allow"),
      v.literal("paywall"),
      v.literal("drop"),
    ),
    payUrl: v.optional(v.string()),
  }),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    const now = Date.now();
    const key = dayKey(now);
    const paid = isPaid(tenant.paidUntil, now);
    const allowance = msgAllowance(paid, {
      free: process.env.BRO_FREE_MSGS_PER_DAY,
      paid: process.env.BRO_PAID_MSGS_PER_DAY,
    });
    try {
      const periodKey = rateLimitPeriodKey(tenant._id, key);
      const config = periodConfig();
      await rateLimiter.limit(ctx, "msgsPerDay", { key: periodKey, config });
      const { value } = await rateLimiter.getValue(ctx, "msgsPerDay", {
        key: periodKey,
        config,
      });
      const decision = paywallDecision({
        count: usedCount(value),
        allowance,
        paywallSentDayKey: tenant.paywallSentDayKey,
        dayKey: key,
      });
      let payUrl: string | undefined;
      if (decision === "paywall") {
        await ctx.db.patch(tenant._id, { paywallSentDayKey: key });
        const base = (process.env.BRO_PAY_BASE ?? "").replace(/\/$/, "");
        if (base) payUrl = `${base}/pay?tid=${tenant._id}`;
      }
      return payUrl ? { decision, payUrl } : { decision };
    } catch (err) {
      console.error("billing count failed", err);
      return inboundDecisionOnLimitError();
    }
  },
});

export const countBrowserJobStart = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    const now = Date.now();
    const key = monthKey(now);
    const paid = isPaid(tenant.paidUntil, now);
    const allowance = browserAllowance(paid, {
      free: process.env.BRO_FREE_BROWSER_JOBS_PER_MONTH,
      paid: process.env.BRO_PAID_BROWSER_JOBS_PER_MONTH,
    });
    try {
      const periodKey = rateLimitPeriodKey(tenant._id, key);
      const config = periodConfig();
      const { value } = await rateLimiter.getValue(ctx, "browserJobsPerMonth", {
        key: periodKey,
        config,
      });
      if (usedCount(value) >= allowance) return { allowed: false };
      const { ok } = await rateLimiter.limit(ctx, "browserJobsPerMonth", {
        key: periodKey,
        config,
      });
      return { allowed: ok };
    } catch (err) {
      console.error("billing browser count failed", err);
      return browserAllowedOnLimitError();
    }
  },
});
