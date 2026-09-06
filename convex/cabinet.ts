import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { timingSafeEqual, assertSecret } from "./secret";
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
  loginCodeText,
  loginLinkFor,
  loginStartDecision,
  loginVerifyDecision,
  newLoginCode,
  parseLoginIdentifier,
  paymentsOwnedBy,
  sessionExpiry,
  sessionLive,
  sha256hex,
  type CabinetSnapshot,
  type LoginIdentifier,
  type PaymentRow,
} from "./lib/cabinetPolicy";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  normalizeBrowserProfileId,
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

async function findTenantByLogin(
  ctx: MutationCtx,
  id: LoginIdentifier,
): Promise<Doc<"tenants"> | null> {
  if (id.kind === "handle") {
    return await ctx.db
      .query("tenants")
      .withIndex("by_handle", (q) => q.eq("inkboxHandle", id.handle))
      .unique();
  }
  return await ctx.db
    .query("tenants")
    .withIndex("by_phone", (q) => q.eq("phoneE164", id.phoneE164))
    .first();
}

/** Shared by beginLogin and linkForPhone: apply the start decision, replace
 * any prior challenge, and insert a fresh one keyed by the tenant's handle. */
async function startChallenge(
  ctx: MutationCtx,
  tenant: Doc<"tenants"> | null,
  codeHash: string,
  now: number,
): Promise<
  | { ok: true; handle: string; identityId: string; conversationId: string }
  | { ok: false; code: "unknown" | "unbound" | "cooldown" }
> {
  const handle = tenant?.inkboxHandle;
  const prior = handle
    ? await ctx.db
        .query("loginChallenges")
        .withIndex("by_handle", (q) => q.eq("handle", handle))
        .unique()
    : null;
  const decision = loginStartDecision({
    tenant,
    lastChallengeAt: prior?.createdAt,
    now,
  });
  if (decision !== "ok" || !tenant || !handle) {
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
    handle,
    identityId: tenant.inkboxIdentityId!,
    conversationId: tenant.inkboxConversationId!,
  };
}

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
    login: v.string(),
    codeHash: v.string(),
    now: v.number(),
  },
  returns: startResult,
  handler: async (ctx, { login, codeHash, now }) => {
    const id = parseLoginIdentifier(login);
    if (!id) return { ok: false as const, code: "unknown" as const };
    const tenant = await findTenantByLogin(ctx, id);
    return await startChallenge(ctx, tenant, codeHash, now);
  },
});

const verifyResult = v.union(
  v.object({
    ok: v.literal(true),
    tenantId: v.id("tenants"),
    handle: v.string(),
  }),
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
    login: v.string(),
    codeHash: v.string(),
    now: v.number(),
  },
  returns: verifyResult,
  handler: async (ctx, { login, codeHash, now }) => {
    const id = parseLoginIdentifier(login);
    const tenant = id ? await findTenantByLogin(ctx, id) : null;
    const handle = tenant?.inkboxHandle;
    const challenge = handle
      ? await ctx.db
          .query("loginChallenges")
          .withIndex("by_handle", (q) => q.eq("handle", handle))
          .unique()
      : null;
    if (!tenant || !handle || !challenge) {
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
      return { ok: true as const, tenantId: tenant._id, handle };
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
    handle: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (_ctx, { identityId, conversationId, code, handle }) => {
    const link = handle
      ? loginLinkFor(process.env.BRO_CABINET_BASE, handle, code)
      : undefined;
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
          text: loginCodeText(code, link),
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

const linkStartResult = v.union(
  v.object({ ok: v.literal(true), handle: v.string() }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("unknown"),
      v.literal("unbound"),
      v.literal("cooldown"),
    ),
  }),
);

export const beginLoginForPhone = internalMutation({
  args: {
    phoneE164: v.string(),
    codeHash: v.string(),
    now: v.number(),
  },
  returns: linkStartResult,
  handler: async (ctx, { phoneE164, codeHash, now }) => {
    const tenant = await findTenantByLogin(ctx, { kind: "phone", phoneE164 });
    const result = await startChallenge(ctx, tenant, codeHash, now);
    if (!result.ok) return result;
    return { ok: true as const, handle: result.handle };
  },
});

const linkForPhoneResult = v.union(
  v.object({ ok: v.literal(true), handle: v.string(), code: v.string() }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("unknown"),
      v.literal("unbound"),
      v.literal("cooldown"),
    ),
  }),
);

// Public but secret-guarded: lets the trusted agent (cabinet_link tool) mint
// a fresh login code + one-tap link for a phone it already has an iMessage
// thread with, so it can hand the link straight to the person. The plaintext
// code is returned here and never stored — only its hash lives in the
// loginChallenges table. This is an action (not a mutation) because it needs
// sha256hex, which uses crypto.subtle; storage happens via an internal
// mutation, mirroring how http.ts handles /login/start.
export const linkForPhone = action({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: linkForPhoneResult,
  handler: async (
    ctx,
    { secret, phoneE164 },
  ): Promise<Infer<typeof linkForPhoneResult>> => {
    assertSecret(secret);
    // The clock is ours, never the caller's: a supplied timestamp could
    // sidestep the cooldown or stretch the challenge TTL.
    const now = Date.now();
    const code = newLoginCode();
    const result = await ctx.runMutation(internal.cabinet.beginLoginForPhone, {
      phoneE164,
      codeHash: await sha256hex(code),
      now,
    });
    if (!result.ok) return result;
    return { ok: true as const, handle: result.handle, code };
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
