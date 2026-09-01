import { v, type Infer } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { assertSecret } from "./secret";
import {
  browserAllowance,
  browserAllowedOnLimitError,
  carryCountersOnTzChange,
  dayKey,
  DEFAULT_TZ,
  effectiveUsedCount,
  inboundOnAccountingError,
  isPaid,
  legacyUsedForPeriod,
  monthKey,
  msgAllowance,
  paywallDecision,
  rateLimitPeriodKey,
  usedCount,
} from "./lib/billingPolicy";
import {
  browserWakeupClaimKey,
  claimMatchesRunPhase,
  decideWakeupClaim,
  parseWakeupClaim,
  type WakeupPhase,
} from "./lib/browserFollowPolicy";
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
  browserProfileId: v.optional(v.string()),
  browserWorkflowId: v.optional(v.string()),
  browserWorkflowRunId: v.optional(v.string()),
  browserWakeupClaim: v.optional(v.string()),
  paidUntil: v.optional(v.number()),
  // deprecated: counters live in @convex-dev/rate-limiter
  msgsDayKey: v.optional(v.string()),
  msgsDayCount: v.optional(v.number()),
  browserMonthKey: v.optional(v.string()),
  browserMonthCount: v.optional(v.number()),
  paywallSentDayKey: v.optional(v.string()),
  tz: v.optional(v.string()),
  dedicatedIMessageNumber: v.optional(v.string()),
  dedicatedIMessageNumberStatus: v.optional(v.string()),
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

export const setTimezone = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    tz: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164, tz }) => {
    assertSecret(secret);
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      throw new Error("invalid timezone");
    }
    const tenant = await tenantByPhone(ctx, phoneE164);
    const prevTz = tenant.tz ?? DEFAULT_TZ;
    if (prevTz === tz) {
      await ctx.db.patch(tenant._id, { tz });
      return null;
    }
    const now = Date.now();
    const config = periodConfig();
    const prevDayKey = dayKey(now, prevTz);
    const prevMonthKey = monthKey(now, prevTz);
    // Component keys are tz-scoped; read old-window used so a tz flip
    // does not drop the component half of effectiveUsedCount.
    const { value: msgsRemaining } = await rateLimiter.getValue(
      ctx,
      "msgsPerDay",
      { key: rateLimitPeriodKey(tenant._id, prevDayKey), config },
    );
    const { value: browserRemaining } = await rateLimiter.getValue(
      ctx,
      "browserJobsPerMonth",
      { key: rateLimitPeriodKey(tenant._id, prevMonthKey), config },
    );
    const carry = carryCountersOnTzChange({
      now,
      prevTz,
      nextTz: tz,
      msgsDayKey: tenant.msgsDayKey,
      msgsDayCount: tenant.msgsDayCount,
      browserMonthKey: tenant.browserMonthKey,
      browserMonthCount: tenant.browserMonthCount,
      paywallSentDayKey: tenant.paywallSentDayKey,
      msgsComponentUsed: usedCount(msgsRemaining),
      browserComponentUsed: usedCount(browserRemaining),
    });
    await ctx.db.patch(tenant._id, { tz, ...carry });
    return null;
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
    browserProfileId: v.optional(v.string()),
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
      ...(args.browserProfileId !== undefined
        ? { browserProfileId: args.browserProfileId }
        : {}),
    });
    return null;
  },
});

export const countProvisioned = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    // Table is ~BRO_IDENTITY_CAP (~100) plus a few unbound rows. A take(N)
    // on raw docs undercounts when unbound tenants sit in the first page
    // (by_handle is optional, so missing handles are not a cheap range).
    // Full collect + TS filter is enough at this scale.
    // eslint-disable-next-line @convex-dev/no-query-collect
    const rows = await ctx.db.query("tenants").collect();
    return rows.filter((r) => typeof r.inkboxHandle === "string" && r.inkboxHandle.length > 0)
      .length;
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

export const patchBrowserInternal = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    browserStatus: v.optional(v.string()),
    browserSessionId: v.optional(v.string()),
    browserLiveUrl: v.optional(v.string()),
  },
  returns: v.object({ stale: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .first();
    if (!existing || existing.browserRunId !== args.runId) {
      return { stale: true };
    }
    const patch: {
      browserStatus?: string;
      browserSessionId?: string;
      browserLiveUrl?: string;
    } = {};
    if (args.browserStatus !== undefined) patch.browserStatus = args.browserStatus;
    if (args.browserSessionId !== undefined) {
      patch.browserSessionId = args.browserSessionId;
    }
    if (args.browserLiveUrl !== undefined) patch.browserLiveUrl = args.browserLiveUrl;
    if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
    return { stale: false };
  },
});

const wakeupPhase = v.union(v.literal("done"), v.literal("giveup"));

const wakeupClaimResult = v.union(
  v.object({
    ok: v.literal(false),
    reason: v.union(
      v.literal("stale_run"),
      v.literal("duplicate"),
      v.literal("pending_in_flight"),
    ),
  }),
  v.object({
    ok: v.literal(true),
    conversationId: v.optional(v.string()),
    inkboxHandle: v.optional(v.string()),
  }),
);

export const claimBrowserWakeup = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    phase: wakeupPhase,
  },
  returns: wakeupClaimResult,
  handler: async (ctx, args): Promise<Infer<typeof wakeupClaimResult>> => {
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .first();
    const now = Date.now();
    const phase = args.phase as WakeupPhase;
    const decision = decideWakeupClaim({
      tenantRunId: existing?.browserRunId,
      runId: args.runId,
      phase,
      existingClaim: existing?.browserWakeupClaim,
      now,
    });
    if (decision !== "ok") {
      return { ok: false as const, reason: decision };
    }
    if (!existing) return { ok: false as const, reason: "stale_run" };
    await ctx.db.patch(existing._id, {
      browserWakeupClaim: browserWakeupClaimKey(args.runId, phase, now, "pending"),
    });
    return {
      ok: true as const,
      conversationId: existing.inkboxConversationId,
      inkboxHandle: existing.inkboxHandle,
    };
  },
});

export const releaseBrowserWakeup = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    phase: wakeupPhase,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .first();
    const phase = args.phase as WakeupPhase;
    if (!existing || !claimMatchesRunPhase(existing.browserWakeupClaim, args.runId, phase)) {
      return null;
    }
    await ctx.db.patch(existing._id, { browserWakeupClaim: undefined });
    return null;
  },
});

export const confirmBrowserWakeup = internalMutation({
  args: {
    phoneE164: v.string(),
    runId: v.string(),
    phase: wakeupPhase,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .first();
    const phase = args.phase as WakeupPhase;
    const parsed = parseWakeupClaim(existing?.browserWakeupClaim);
    if (
      !existing ||
      !parsed ||
      parsed.runId !== args.runId ||
      parsed.phase !== phase
    ) {
      return null;
    }
    await ctx.db.patch(existing._id, {
      browserWakeupClaim: browserWakeupClaimKey(
        args.runId,
        phase,
        parsed.claimedAtMs,
        "sent",
      ),
    });
    return null;
  },
});

export const insertProvisioned = internalMutation({
  args: {
    inkboxHandle: v.string(),
    inkboxIdentityId: v.string(),
    emailAddress: v.optional(v.string()),
    webhookSigningKey: v.optional(v.string()),
    dedicatedIMessageNumber: v.optional(v.string()),
    dedicatedIMessageNumberStatus: v.optional(v.string()),
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
      dedicatedIMessageNumber: args.dedicatedIMessageNumber,
      dedicatedIMessageNumberStatus: args.dedicatedIMessageNumberStatus,
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
    const key = dayKey(now, tenant.tz);
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
      const count = effectiveUsedCount(
        usedCount(value),
        legacyUsedForPeriod(tenant.msgsDayKey, tenant.msgsDayCount, key),
      );
      const decision = paywallDecision({
        count,
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
      if (tenant.paywallSentDayKey === key) {
        return inboundOnAccountingError({
          alreadySentToday: true,
          marked: false,
        });
      }
      try {
        await ctx.db.patch(tenant._id, { paywallSentDayKey: key });
        return inboundOnAccountingError({
          alreadySentToday: false,
          marked: true,
        });
      } catch (markErr) {
        console.error("paywallSentDayKey persist failed", markErr);
        return inboundOnAccountingError({
          alreadySentToday: false,
          marked: false,
        });
      }
    }
  },
});

export const markPaywallSent = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.object({ alreadySentToday: v.boolean() }),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    const key = dayKey(Date.now(), tenant.tz);
    if (tenant.paywallSentDayKey === key) return { alreadySentToday: true };
    await ctx.db.patch(tenant._id, { paywallSentDayKey: key });
    return { alreadySentToday: false };
  },
});

async function chargeBrowserJob(
  ctx: MutationCtx,
  tenant: Doc<"tenants">,
  now: number,
): Promise<boolean> {
  const key = monthKey(now, tenant.tz);
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
    const used = effectiveUsedCount(
      usedCount(value),
      legacyUsedForPeriod(tenant.browserMonthKey, tenant.browserMonthCount, key),
    );
    if (used >= allowance) return false;
    const { ok } = await rateLimiter.limit(ctx, "browserJobsPerMonth", {
      key: periodKey,
      config,
    });
    return ok;
  } catch (err) {
    console.error("billing browser count failed", err);
    return browserAllowedOnLimitError().allowed;
  }
}

export const countBrowserJobStart = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    return { allowed: await chargeBrowserJob(ctx, tenant, Date.now()) };
  },
});

const ERRAND_CHARGE_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * One worker assignment costs one browser job, however many Kernel browsers it
 * opens. A login alone needs a second, writable browser, so charging per
 * browser would eat a free month in a single errand.
 */
export const startBrowserErrand = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    workerSessionId: v.string(),
  },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, { secret, phoneE164, workerSessionId }) => {
    assertSecret(secret);
    const tenant = await tenantByPhone(ctx, phoneE164);
    const charged = await ctx.db
      .query("browserCharges")
      .withIndex("by_worker", (q) => q.eq("workerSessionId", workerSessionId))
      .first();
    if (charged && charged.tenantId === tenant._id) return { allowed: true };

    const now = Date.now();
    if (!(await chargeBrowserJob(ctx, tenant, now))) return { allowed: false };
    await ctx.db.insert("browserCharges", {
      tenantId: tenant._id,
      workerSessionId,
      chargedAt: now,
    });

    const stale = await ctx.db
      .query("browserCharges")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
      .collect();
    for (const row of stale) {
      if (now - row.chargedAt > ERRAND_CHARGE_TTL_MS) await ctx.db.delete(row._id);
    }
    return { allowed: true };
  },
});
