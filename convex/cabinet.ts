import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { timingSafeEqual } from "./secret";
import {
  browserAllowance,
  dayKey,
  effectiveUsedCount,
  isPaid,
  legacyUsedForPeriod,
  monthKey,
  msgAllowance,
  rateLimitPeriodKey,
  usedCount,
} from "./lib/billingPolicy";
import {
  buildSnapshot,
  challengeExpiry,
  loginStartDecision,
  loginVerifyDecision,
  paymentsOwnedBy,
  sessionExpiry,
  sessionLive,
  type CabinetSnapshot,
  type PaymentRow,
} from "./lib/cabinetPolicy";
import {
  normalizeBrowserProfileId,
  profileSyncCommand,
  profileSyncStatus,
} from "./lib/browserProfilePolicy";
import { getProfile } from "./lib/browseruse";
import { periodConfig, rateLimiter } from "./lib/rateLimits";

const snapshotValidator = v.object({
  handle: v.string(),
  phoneBound: v.boolean(),
  phoneLast4: v.optional(v.string()),
  plan: v.union(v.literal("free"), v.literal("paid")),
  paidUntil: v.optional(v.number()),
  msgsUsed: v.number(),
  msgsAllowance: v.number(),
  msgsDayKey: v.string(),
  browserUsed: v.number(),
  browserAllowance: v.number(),
  browserMonthKey: v.string(),
  payments: v.array(
    v.object({
      createdAt: v.number(),
      amountRub: v.number(),
      status: v.union(
        v.literal("pending"),
        v.literal("succeeded"),
        v.literal("canceled"),
      ),
    }),
  ),
  browserProfileId: v.optional(v.string()),
  browserCookieDomains: v.array(v.string()),
  browserProfileStatus: v.union(
    v.literal("missing"),
    v.literal("empty"),
    v.literal("synced"),
  ),
  profileSyncCommand: v.string(),
});

function apiKey(): string {
  const k = process.env.INKBOX_API_KEY;
  if (!k) throw new Error("INKBOX_API_KEY missing");
  return k;
}

export const getSessionTenant = internalQuery({
  args: { tokenHash: v.string(), now: v.number() },
  returns: v.union(
    v.object({ tenantId: v.id("tenants") }),
    v.null(),
  ),
  handler: async (ctx, { tokenHash, now }) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!row || !sessionLive(row.expiresAt, now)) return null;
    return { tenantId: row.tenantId };
  },
});

export const issueSession = internalMutation({
  args: { tenantId: v.id("tenants"), tokenHash: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { tenantId, tokenHash, now }) => {
    await ctx.db.insert("sessions", {
      tokenHash,
      tenantId,
      expiresAt: sessionExpiry(now),
    });
    return null;
  },
});

export const revokeSession = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { tokenHash }) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

const startResult = v.union(
  v.object({
    ok: v.literal(true),
    identityId: v.string(),
    conversationId: v.string(),
    handle: v.string(),
  }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("unknown"),
      v.literal("unbound"),
      v.literal("cooldown"),
    ),
  }),
);

export const beginLogin = internalMutation({
  args: {
    handle: v.string(),
    codeHash: v.string(),
    now: v.number(),
  },
  returns: startResult,
  handler: async (ctx, { handle, codeHash, now }) => {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_handle", (q) => q.eq("inkboxHandle", handle))
      .unique();
    const prior = await ctx.db
      .query("loginChallenges")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    const decision = loginStartDecision({
      tenant,
      lastChallengeAt: prior?.createdAt,
      now,
    });
    if (decision !== "ok" || !tenant) {
      return { ok: false as const, code: decision === "ok" ? "unknown" : decision };
    }
    if (prior) await ctx.db.delete(prior._id);
    await ctx.db.insert("loginChallenges", {
      handle,
      codeHash,
      expiresAt: challengeExpiry(now),
      attempts: 0,
      createdAt: now,
    });
    return {
      ok: true as const,
      identityId: tenant.inkboxIdentityId!,
      conversationId: tenant.inkboxConversationId!,
      handle,
    };
  },
});

const verifyResult = v.union(
  v.object({ ok: v.literal(true), tenantId: v.id("tenants") }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("unknown"),
      v.literal("expired"),
      v.literal("locked"),
      v.literal("wrong"),
    ),
    attemptsLeft: v.optional(v.number()),
  }),
);

export const finishLogin = internalMutation({
  args: {
    handle: v.string(),
    codeHash: v.string(),
    now: v.number(),
  },
  returns: verifyResult,
  handler: async (ctx, { handle, codeHash, now }) => {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_handle", (q) => q.eq("inkboxHandle", handle))
      .unique();
    const challenge = await ctx.db
      .query("loginChallenges")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (!tenant || !challenge) {
      return { ok: false as const, code: "unknown" as const };
    }
    const match = timingSafeEqual(codeHash, challenge.codeHash);
    const decision = loginVerifyDecision({
      now,
      expiresAt: challenge.expiresAt,
      attempts: challenge.attempts,
      codeMatch: match,
    });
    if (decision.kind === "ok") {
      await ctx.db.delete(challenge._id);
      return { ok: true as const, tenantId: tenant._id };
    }
    if (decision.kind === "wrong") {
      await ctx.db.patch(challenge._id, { attempts: challenge.attempts + 1 });
      return {
        ok: false as const,
        code: "wrong" as const,
        attemptsLeft: decision.attemptsLeft,
      };
    }
    await ctx.db.delete(challenge._id);
    return { ok: false as const, code: decision.kind };
  },
});

export const sendLoginCode = internalAction({
  args: {
    identityId: v.string(),
    conversationId: v.string(),
    code: v.string(),
  },
  returns: v.null(),
  handler: async (_ctx, { identityId, conversationId, code }) => {
    const q = new URLSearchParams({ agent_identity_id: identityId });
    const res = await fetch(
      `https://inkbox.ai/api/v1/imessage/messages?${q}`,
      {
        method: "POST",
        headers: {
          "X-API-Key": apiKey(),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversation_id: conversationId,
          text: `Код входа в кабинет bro: ${code}`,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`inkbox send ${res.status}: ${text.slice(0, 200)}`);
    }
    return null;
  },
});

export const snapshotForTenant = internalQuery({
  args: { tenantId: v.id("tenants"), now: v.number() },
  returns: v.union(snapshotValidator, v.null()),
  handler: async (ctx, { tenantId, now }): Promise<CabinetSnapshot | null> => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant?.inkboxHandle) return null;
    const paid = isPaid(tenant.paidUntil, now);
    const day = dayKey(now, tenant.tz);
    const month = monthKey(now, tenant.tz);
    const config = periodConfig();
    const { value: msgsRemaining } = await rateLimiter.getValue(
      ctx,
      "msgsPerDay",
      { key: rateLimitPeriodKey(tenant._id, day), config },
    );
    const { value: browserRemaining } = await rateLimiter.getValue(
      ctx,
      "browserJobsPerMonth",
      { key: rateLimitPeriodKey(tenant._id, month), config },
    );
    const msgsUsed = effectiveUsedCount(
      usedCount(msgsRemaining),
      legacyUsedForPeriod(tenant.msgsDayKey, tenant.msgsDayCount, day),
    );
    const browserUsed = effectiveUsedCount(
      usedCount(browserRemaining),
      legacyUsedForPeriod(
        tenant.browserMonthKey,
        tenant.browserMonthCount,
        month,
      ),
    );
    const raw = await ctx.db
      .query("payments")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
      .order("desc")
      .take(20);
    const mine = paymentsOwnedBy(
      tenant._id,
      raw.map((p) => ({
        tenantId: p.tenantId,
        createdAt: p.createdAt,
        amountRub: p.amountRub,
        status: p.status,
      })),
    );
    const payments: PaymentRow[] = mine.map((p) => ({
      createdAt: p.createdAt,
      amountRub: p.amountRub,
      status: p.status,
    }));
    return buildSnapshot({
      handle: tenant.inkboxHandle,
      phoneE164: tenant.phoneE164,
      paid,
      paidUntil: tenant.paidUntil,
      msgsUsed,
      msgsAllowance: msgAllowance(paid, {
        free: process.env.BRO_FREE_MSGS_PER_DAY,
        paid: process.env.BRO_PAID_MSGS_PER_DAY,
      }),
      msgsDayKey: day,
      browserUsed,
      browserAllowance: browserAllowance(paid, {
        free: process.env.BRO_FREE_BROWSER_JOBS_PER_MONTH,
        paid: process.env.BRO_PAID_BROWSER_JOBS_PER_MONTH,
      }),
      browserMonthKey: month,
      payments,
      browserProfileId: tenant.browserProfileId,
      browserCookieDomains: tenant.browserCookieDomains ?? [],
      browserProfileStatus: profileSyncStatus({
        profileId: tenant.browserProfileId,
        cookieDomains: tenant.browserCookieDomains,
      }),
      profileSyncCommand: profileSyncCommand(),
    });
  },
});

export const attachBrowserProfile = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    profileId: v.string(),
    cookieDomains: v.optional(v.array(v.string())),
    syncedAt: v.optional(v.number()),
  },
  returns: v.object({
    profileId: v.string(),
    cookieDomains: v.array(v.string()),
    status: v.union(
      v.literal("missing"),
      v.literal("empty"),
      v.literal("synced"),
    ),
  }),
  handler: async (ctx, { tenantId, profileId, cookieDomains, syncedAt }) => {
    const id = normalizeBrowserProfileId(profileId);
    if (!id) throw new Error("invalid profile id");
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("unknown tenant");
    const domains = cookieDomains ?? tenant.browserCookieDomains ?? [];
    const at = syncedAt ?? tenant.browserProfileSyncedAt;
    await ctx.db.patch(tenantId, {
      browserProfileId: id,
      browserCookieDomains: domains,
      ...(at !== undefined ? { browserProfileSyncedAt: at } : {}),
    });
    return {
      profileId: id,
      cookieDomains: domains,
      status: profileSyncStatus({ profileId: id, cookieDomains: domains }),
    };
  },
});

export const getTenantBrowserProfile = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.object({ profileId: v.union(v.string(), v.null()) }),
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    return { profileId: tenant?.browserProfileId ?? null };
  },
});

type BrowserProfileRefresh = {
  profileId: string | null;
  cookieDomains: string[];
  status: "missing" | "empty" | "synced";
};

export const refreshBrowserProfile = internalAction({
  args: { tenantId: v.id("tenants"), profileId: v.optional(v.string()) },
  returns: v.object({
    profileId: v.union(v.string(), v.null()),
    cookieDomains: v.array(v.string()),
    status: v.union(
      v.literal("missing"),
      v.literal("empty"),
      v.literal("synced"),
    ),
  }),
  handler: async (ctx, { tenantId, profileId }): Promise<BrowserProfileRefresh> => {
    if (profileId !== undefined && profileId.trim() && !normalizeBrowserProfileId(profileId)) {
      throw new Error("invalid profile id");
    }
    const snap = await ctx.runQuery(internal.cabinet.getTenantBrowserProfile, {
      tenantId,
    });
    const id = normalizeBrowserProfileId(profileId) ?? snap.profileId ?? undefined;
    if (!id) {
      return { profileId: null, cookieDomains: [], status: "missing" as const };
    }
    const profile = await getProfile(id);
    const attached: {
      profileId: string;
      cookieDomains: string[];
      status: "missing" | "empty" | "synced";
    } = await ctx.runMutation(internal.cabinet.attachBrowserProfile, {
      tenantId,
      profileId: profile.id,
      cookieDomains: profile.cookieDomains,
      syncedAt: Date.now(),
    });
    return {
      profileId: attached.profileId,
      cookieDomains: attached.cookieDomains,
      status: attached.status,
    };
  },
});

export const issueDeviceSession = internalMutation({
  args: { handle: v.string(), tokenHash: v.string(), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { handle, tokenHash, now }) => {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_handle", (q) => q.eq("inkboxHandle", handle))
      .unique();
    if (!tenant) return false;
    await ctx.db.insert("sessions", {
      tokenHash,
      tenantId: tenant._id,
      expiresAt: sessionExpiry(now),
    });
    return true;
  },
});
