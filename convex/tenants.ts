import { v, type Infer } from "convex/values";
import { doc } from "convex-helpers/validators";
import schema from "./schema";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertSecret } from "./secret";
import { isValidHandle, makeHandle } from "./lib/accessPolicy";
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
  isValidIanaTimeZone,
  normalizeTz,
  sessionTzChangeDecision,
} from "./lib/tzPolicy";
import {
  browserWakeupClaimKey,
  claimMatchesRunPhase,
  decideWakeupClaim,
  parseWakeupClaim,
  type WakeupPhase,
} from "./lib/browserFollowPolicy";
import { periodConfig, rateLimiter } from "./lib/rateLimits";
import {
  bindTelegramDecision,
  lastChannelOf,
  newTelegramBindToken,
  telegramBindExpiry,
  type HumanChannel,
} from "./lib/telegramPolicy";

/** Never write a group conversation onto the 1:1 wakeup/mail lane. */
async function oneToOneConversationIdOrUndefined(
  ctx: MutationCtx,
  conversationId: string | undefined,
): Promise<string | undefined> {
  const id = conversationId?.trim();
  if (!id) return undefined;
  const group = await ctx.db
    .query("groupChats")
    .withIndex("by_conversation", (q) => q.eq("conversationId", id))
    .first();
  return group ? undefined : id;
}

/** Full tenant document. Derived from the schema so a new column (e.g.
 *  `archiveSyncedAt`) can never be missing here: a hand-copied list once
 *  made every tenant read throw `ReturnsValidationError` in production
 *  and Bro went silent for that person. */
export const tenantDoc = doc(schema, "tenants");

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

export const attachCabinetLoginForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    identityId: v.string(),
    handle: v.optional(v.string()),
  },
  returns: v.object({
    handle: v.string(),
    attached: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const phone = args.phoneE164.trim();
    const identityId = args.identityId.trim();
    if (!phone) throw new Error("phoneE164 required");
    if (!identityId) throw new Error("identityId required");
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phone))
      .first();
    if (!tenant) throw new Error("unknown tenant");
    if (tenant.inkboxHandle && isValidHandle(tenant.inkboxHandle)) {
      if (!tenant.inkboxIdentityId) {
        await ctx.db.patch(tenant._id, { inkboxIdentityId: identityId });
      }
      return { handle: tenant.inkboxHandle, attached: false };
    }
    let handle = args.handle?.trim() || makeHandle();
    if (!isValidHandle(handle)) throw new Error("invalid handle");
    for (let i = 0; i < 8; i++) {
      const taken = await ctx.db
        .query("tenants")
        .withIndex("by_handle", (q) => q.eq("inkboxHandle", handle))
        .unique();
      if (!taken) break;
      handle = makeHandle();
    }
    const taken = await ctx.db
      .query("tenants")
      .withIndex("by_handle", (q) => q.eq("inkboxHandle", handle))
      .unique();
    if (taken) throw new Error("handle unavailable");
    await ctx.db.patch(tenant._id, {
      inkboxHandle: handle,
      inkboxIdentityId: tenant.inkboxIdentityId || identityId,
    });
    return { handle, attached: true };
  },
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
    const oneToOneConversationId = await oneToOneConversationIdOrUndefined(
      ctx,
      inkboxConversationId,
    );
    if (existing) {
      const patch: {
        inkboxConversationId?: string;
        emailAddress?: string;
      } = {};
      if (
        oneToOneConversationId &&
        existing.inkboxConversationId !== oneToOneConversationId
      ) {
        patch.inkboxConversationId = oneToOneConversationId;
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
      inkboxConversationId: oneToOneConversationId,
      emailAddress: email || undefined,
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("tenant insert failed");
    return created;
  },
});

export const tzChangeResult = v.union(
  v.object({ ok: v.literal(true), tz: v.string() }),
  v.object({
    ok: v.literal(false),
    code: v.union(v.literal("unbound"), v.literal("invalid")),
  }),
);

/** Counter-carry + patch. Caller already validated IANA and ownership. */
export async function applyTimezoneChange(
  ctx: MutationCtx,
  tenant: Doc<"tenants">,
  tz: string,
  now: number,
): Promise<void> {
  const prevTz = tenant.tz ?? DEFAULT_TZ;
  if (prevTz === tz) {
    await ctx.db.patch(tenant._id, { tz });
    return;
  }
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
}

export async function applyTimezoneForTenantId(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; tz: string; now: number },
): Promise<{ ok: true; tz: string } | { ok: false; code: "unbound" | "invalid" }> {
  const tenant = await ctx.db.get(args.tenantId);
  if (!tenant) return { ok: false, code: "invalid" };
  const decision = sessionTzChangeDecision({
    phoneE164: tenant.phoneE164,
    tz: args.tz,
  });
  if (!decision.ok) return decision;
  await applyTimezoneChange(ctx, tenant, decision.tz, args.now);
  return { ok: true, tz: decision.tz };
}

export const setTimezone = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    tz: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164, tz }) => {
    assertSecret(secret);
    const nextTz = normalizeTz(tz);
    if (!isValidIanaTimeZone(nextTz)) {
      throw new Error("invalid timezone");
    }
    const tenant = await tenantByPhone(ctx, phoneE164);
    await applyTimezoneChange(ctx, tenant, nextTz, Date.now());
    return null;
  },
});

export const setTimezoneForTenantId = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    tz: v.string(),
    now: v.number(),
  },
  returns: tzChangeResult,
  handler: async (ctx, args) => applyTimezoneForTenantId(ctx, args),
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
    browserCookieDomains: v.optional(v.array(v.string())),
    browserProfileSyncedAt: v.optional(v.number()),
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
      ...(args.browserCookieDomains !== undefined
        ? { browserCookieDomains: args.browserCookieDomains }
        : {}),
      ...(args.browserProfileSyncedAt !== undefined
        ? { browserProfileSyncedAt: args.browserProfileSyncedAt }
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
    v.object({
      ok: v.literal(true),
      tenant: tenantDoc,
      firstBind: v.boolean(),
    }),
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
    const firstBind = !tenant.phoneE164;
    const oneToOneConversationId = await oneToOneConversationIdOrUndefined(
      ctx,
      inkboxConversationId,
    );
    const patch: {
      phoneE164?: string;
      inkboxConversationId?: string;
    } = {};
    if (!tenant.phoneE164) patch.phoneE164 = phoneE164;
    if (
      oneToOneConversationId &&
      tenant.inkboxConversationId !== oneToOneConversationId
    ) {
      patch.inkboxConversationId = oneToOneConversationId;
    }
    if (Object.keys(patch).length) await ctx.db.patch(tenant._id, patch);
    const next = await ctx.db.get(tenant._id);
    if (!next) return { ok: false as const, reason: "missing" };
    return { ok: true as const, tenant: next, firstBind };
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
    if (tenant.status === "disabled") return { decision: "drop" as const };
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

export const getByTelegram = query({
  args: { secret: v.string(), telegramUserId: v.string() },
  returns: v.union(tenantDoc, v.null()),
  handler: async (ctx, { secret, telegramUserId }) => {
    assertSecret(secret);
    return await ctx.db
      .query("tenants")
      .withIndex("by_telegram", (q) => q.eq("telegramUserId", telegramUserId))
      .unique();
  },
});

export const touchLastChannel = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    lastChannel: v.union(v.literal("imessage"), v.literal("telegram")),
  },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164, lastChannel }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (!tenant) return null;
    if (lastChannelOf(tenant.lastChannel) === lastChannel) return null;
    await ctx.db.patch(tenant._id, { lastChannel });
    return null;
  },
});

export const mintTelegramBind = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), token: v.string(), alreadyLinked: v.boolean() }),
    v.object({ ok: v.literal(false), reason: v.literal("unbound") }),
  ),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (!tenant?.phoneE164 || !tenant.inkboxConversationId) {
      return { ok: false as const, reason: "unbound" as const };
    }
    const token = newTelegramBindToken();
    await ctx.db.patch(tenant._id, {
      telegramBindToken: token,
      telegramBindExpiresAt: telegramBindExpiry(Date.now()),
    });
    return {
      ok: true as const,
      token,
      alreadyLinked: Boolean(tenant.telegramUserId),
    };
  },
});

export const bindTelegram = mutation({
  args: {
    secret: v.string(),
    token: v.string(),
    telegramUserId: v.string(),
    telegramChatId: v.string(),
    telegramUsername: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      tenant: tenantDoc,
      firstBind: v.boolean(),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("expired"),
        v.literal("unknown_token"),
        v.literal("unbound_phone"),
        v.literal("already_other_user"),
        v.literal("already_other_tenant"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const token = args.token.trim().toLowerCase();
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_telegram_bind", (q) => q.eq("telegramBindToken", token))
      .unique();
    const other = await ctx.db
      .query("tenants")
      .withIndex("by_telegram", (q) => q.eq("telegramUserId", args.telegramUserId))
      .unique();
    const kind = bindTelegramDecision({
      now: Date.now(),
      tokenFound: Boolean(tenant),
      expiresAt: tenant?.telegramBindExpiresAt,
      tenantPhone: tenant?.phoneE164,
      tenantTelegramUserId: tenant?.telegramUserId,
      incomingUserId: args.telegramUserId,
      otherTenantPhone: other && other._id !== tenant?._id ? other.phoneE164 : undefined,
    });
    if (kind !== "ok" || !tenant) {
      return { ok: false as const, reason: kind === "ok" ? "unknown_token" : kind };
    }
    const firstBind = !tenant.telegramUserId;
    const username = args.telegramUsername?.replace(/^@/, "").trim();
    await ctx.db.patch(tenant._id, {
      telegramUserId: args.telegramUserId,
      telegramChatId: args.telegramChatId,
      telegramUsername: username || undefined,
      telegramBindToken: undefined,
      telegramBindExpiresAt: undefined,
      lastChannel: "telegram" satisfies HumanChannel,
    });
    const next = await ctx.db.get(tenant._id);
    if (!next) return { ok: false as const, reason: "unknown_token" as const };
    return { ok: true as const, tenant: next, firstBind };
  },
});
