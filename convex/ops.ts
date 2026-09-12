import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertSecret } from "./secret";
import { dayKey, isPaid } from "./lib/billingPolicy";
import {
  BROWSER_JOB_RUNNING,
  BROWSER_JOB_SECURE,
  browserJobForSnapshot,
} from "./lib/browserJobPolicy";
import { phoneLast4 } from "./lib/cabinetPolicy";
import { snapshotStatus } from "./lib/chatgptPolicy";
import { computerByTenant } from "./lib/computerStore";
import {
  boardTotals,
  browserIsStuck,
  clipOpsDetail,
  compareOpsRows,
  DAY_MS,
  jobIsStuck,
  OPS_EVENT_TTL_MS,
  tenantFlags,
  tenantHasChat,
  tenantProvisioned,
  type OpsEventKind,
} from "./lib/opsPolicy";
import { insertOpsEvent } from "./lib/opsStore";

const opsKind = v.union(
  v.literal("access_ok"),
  v.literal("access_not_ios"),
  v.literal("access_need_phone"),
  v.literal("access_closed"),
  v.literal("access_error"),
  v.literal("first_bind"),
  v.literal("first_message"),
  v.literal("paywall"),
  v.literal("turn_failed"),
  v.literal("job_failed"),
  v.literal("wakeup_failed"),
  v.literal("payment_ok"),
  v.literal("telegram_bound"),
  v.literal("cabinet_login"),
);

const eventRow = v.object({
  kind: opsKind,
  at: v.number(),
  detail: v.optional(v.string()),
  handle: v.optional(v.string()),
});

const totalsValidator = v.object({
  provisioned: v.number(),
  bound: v.number(),
  wrote: v.number(),
  wrote24h: v.number(),
  neverWrote: v.number(),
  paywalled: v.number(),
  stuckJobs: v.number(),
  failedWakeups: v.number(),
  accessOk24h: v.number(),
  accessClosed24h: v.number(),
  accessNeedPhone24h: v.number(),
  accessNotIos24h: v.number(),
});

const personRow = v.object({
  handle: v.optional(v.string()),
  phoneLast4: v.optional(v.string()),
  phoneE164: v.optional(v.string()),
  status: v.union(v.literal("active"), v.literal("disabled")),
  plan: v.union(v.literal("free"), v.literal("paid")),
  lastChannel: v.optional(
    v.union(v.literal("imessage"), v.literal("telegram")),
  ),
  lastHumanAt: v.optional(v.number()),
  createdAt: v.number(),
  telegram: v.boolean(),
  flags: v.array(v.string()),
});

function groupByTenant<T extends { tenantId: Id<"tenants"> }>(
  rows: T[],
): Map<Id<"tenants">, T[]> {
  const map = new Map<Id<"tenants">, T[]>();
  for (const row of rows) {
    const list = map.get(row.tenantId) ?? [];
    list.push(row);
    map.set(row.tenantId, list);
  }
  return map;
}

function handleOf(t: Doc<"tenants">): string | undefined {
  return tenantProvisioned(t.inkboxHandle) ? t.inkboxHandle : undefined;
}

export const record = internalMutation({
  args: {
    kind: opsKind,
    at: v.number(),
    tenantId: v.optional(v.id("tenants")),
    detail: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await insertOpsEvent(ctx, {
      kind: args.kind,
      at: args.at,
      tenantId: args.tenantId,
      detail: args.detail,
    });
    return null;
  },
});

export const noteTurnFailed = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    code: v.optional(v.string()),
    message: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", args.phoneE164))
      .first();
    if (!tenant) return null;
    const detail = clipOpsDetail(
      [args.code, args.message].filter(Boolean).join(" "),
    );
    await insertOpsEvent(ctx, {
      kind: "turn_failed",
      at: Date.now(),
      tenantId: tenant._id,
      detail,
    });
    return null;
  },
});

export const board = internalQuery({
  args: { now: v.number() },
  returns: v.object({
    totals: totalsValidator,
    people: v.array(personRow),
    recent: v.array(eventRow),
  }),
  handler: async (ctx, { now }) => {
    // Cap is BRO_IDENTITY_CAP (~100). Same collect as countProvisioned.
    // eslint-disable-next-line @convex-dev/no-query-collect
    const tenants = await ctx.db.query("tenants").collect();
    const jobs = await ctx.db.query("jobs").take(400);
    const wakeups = await ctx.db.query("wakeups").take(400);
    const events = await ctx.db
      .query("opsEvents")
      .withIndex("by_at")
      .order("desc")
      .take(80);

    const jobsBy = groupByTenant(jobs);
    const wakeByPhone = new Map<string, Doc<"wakeups">[]>();
    for (const w of wakeups) {
      const list = wakeByPhone.get(w.tenantPhone) ?? [];
      list.push(w);
      wakeByPhone.set(w.tenantPhone, list);
    }

    const handleById = new Map<string, string>();
    const scored = tenants.map((t) => {
      const handle = handleOf(t);
      if (handle) handleById.set(t._id, handle);
      const today = dayKey(now, t.tz);
      const tenantJobs = jobsBy.get(t._id) ?? [];
      const tenantWake = t.phoneE164
        ? (wakeByPhone.get(t.phoneE164) ?? [])
        : [];
      const browser = browserJobForSnapshot(t);
      const flags = tenantFlags({
        provisioned: Boolean(handle),
        lastHumanAt: t.lastHumanAt,
        hasChat: tenantHasChat(t.photonConversationId, t.inkboxConversationId),
        paywalledToday: t.paywallSentDayKey === today,
        stuckJob: tenantJobs.some((j) =>
          jobIsStuck({
            status: j.status,
            waitingSince: j.waitingSince,
            now,
          }),
        ),
        failedWakeup: tenantWake.some((w) => w.status === "failed"),
        browserStuck: browserIsStuck({
          live:
            browser.label === BROWSER_JOB_RUNNING ||
            browser.label === BROWSER_JOB_SECURE,
          startedAt: browser.startedAt,
          now,
        }),
      });
      const last4 = phoneLast4(t.phoneE164);
      return {
        handle,
        ...(last4 ? { phoneLast4: last4 } : {}),
        ...(t.phoneE164 ? { phoneE164: t.phoneE164 } : {}),
        status: t.status,
        plan: isPaid(t.paidUntil, now) ? ("paid" as const) : ("free" as const),
        ...(t.lastChannel ? { lastChannel: t.lastChannel } : {}),
        ...(t.lastHumanAt !== undefined ? { lastHumanAt: t.lastHumanAt } : {}),
        createdAt: t._creationTime,
        telegram: Boolean(t.telegramUserId),
        flags,
        provisioned: Boolean(handle),
        bound: Boolean(
          t.phoneE164 &&
            tenantHasChat(t.photonConversationId, t.inkboxConversationId),
        ),
      };
    });

    scored.sort(compareOpsRows);

    const dayAgo = now - DAY_MS;
    const recentKinds = events
      .filter((e) => e.at >= dayAgo)
      .map((e) => e.kind);

    const totals = boardTotals({
      people: scored,
      now,
      recentKinds,
    });

    return {
      totals,
      people: scored.map((row) => ({
        handle: row.handle,
        ...(row.phoneLast4 ? { phoneLast4: row.phoneLast4 } : {}),
        ...(row.phoneE164 ? { phoneE164: row.phoneE164 } : {}),
        status: row.status,
        plan: row.plan,
        ...(row.lastChannel ? { lastChannel: row.lastChannel } : {}),
        ...(row.lastHumanAt !== undefined ? { lastHumanAt: row.lastHumanAt } : {}),
        createdAt: row.createdAt,
        telegram: row.telegram,
        flags: row.flags,
      })),
      recent: events.map((e) => ({
        kind: e.kind,
        at: e.at,
        ...(e.detail ? { detail: e.detail } : {}),
        ...(e.tenantId && handleById.get(e.tenantId)
          ? { handle: handleById.get(e.tenantId) }
          : {}),
      })),
    };
  },
});

export const person = internalQuery({
  args: {
    now: v.number(),
    handle: v.optional(v.string()),
    phoneE164: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      handle: v.optional(v.string()),
      phoneE164: v.optional(v.string()),
      emailAddress: v.optional(v.string()),
      status: v.union(v.literal("active"), v.literal("disabled")),
      plan: v.union(v.literal("free"), v.literal("paid")),
      paidUntil: v.optional(v.number()),
      lastChannel: v.optional(
        v.union(v.literal("imessage"), v.literal("telegram")),
      ),
      lastHumanAt: v.optional(v.number()),
      createdAt: v.number(),
      telegramUsername: v.optional(v.string()),
      photonAssignedNumber: v.optional(v.string()),
      tz: v.optional(v.string()),
      flags: v.array(v.string()),
      browser: v.object({
        label: v.string(),
        task: v.optional(v.string()),
        startedAt: v.optional(v.number()),
      }),
      computer: v.object({
        state: v.string(),
        lastActiveAt: v.optional(v.number()),
      }),
      chatgpt: v.object({
        status: v.union(
          v.literal("none"),
          v.literal("pending"),
          v.literal("connected"),
          v.literal("quarantined"),
        ),
      }),
      jobs: v.array(
        v.object({
          goal: v.string(),
          status: v.string(),
          waitingFor: v.optional(v.string()),
          waitingSince: v.optional(v.number()),
          note: v.optional(v.string()),
        }),
      ),
      wakeups: v.array(
        v.object({
          kind: v.string(),
          status: v.string(),
          at: v.number(),
          payload: v.string(),
        }),
      ),
      watchers: v.array(
        v.object({
          source: v.string(),
          about: v.string(),
          status: v.string(),
          events: v.optional(v.number()),
          lastEventAt: v.optional(v.number()),
        }),
      ),
      payments: v.array(
        v.object({
          createdAt: v.number(),
          amountRub: v.number(),
          status: v.string(),
        }),
      ),
      orders: v.array(
        v.object({
          merchant: v.string(),
          title: v.string(),
          status: v.string(),
          createdAt: v.optional(v.number()),
        }),
      ),
      events: v.array(eventRow),
    }),
    v.null(),
  ),
  handler: async (ctx, { now, handle, phoneE164 }) => {
    let tenant: Doc<"tenants"> | null = null;
    const h = handle?.trim();
    const phone = phoneE164?.trim();
    if (h) {
      tenant = await ctx.db
        .query("tenants")
        .withIndex("by_handle", (q) => q.eq("inkboxHandle", h))
        .unique();
    }
    if (!tenant && phone) {
      tenant = await ctx.db
        .query("tenants")
        .withIndex("by_phone", (q) => q.eq("phoneE164", phone))
        .first();
    }
    if (!tenant) return null;

    const [jobs, wakeups, watchers, payments, orders, events] = await Promise.all([
      ctx.db
        .query("jobs")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
        .take(16),
      tenant.phoneE164
        ? ctx.db
            .query("wakeups")
            .withIndex("by_tenant", (q) => q.eq("tenantPhone", tenant.phoneE164!))
            .take(16)
        : Promise.resolve([]),
      tenant.phoneE164
        ? ctx.db
            .query("watchers")
            .withIndex("by_tenant", (q) => q.eq("tenantPhone", tenant.phoneE164!))
            .take(8)
        : Promise.resolve([]),
      ctx.db
        .query("payments")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
        .take(8),
      ctx.db
        .query("orders")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
        .take(8),
      ctx.db
        .query("opsEvents")
        .withIndex("by_tenant_at", (q) => q.eq("tenantId", tenant._id))
        .order("desc")
        .take(40),
    ]);

    const computer = await computerByTenant(ctx, tenant._id);
    const account = await ctx.db
      .query("chatgptAccounts")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
      .first();
    const browser = browserJobForSnapshot(tenant);
    const today = dayKey(now, tenant.tz);
    const flags = tenantFlags({
      provisioned: Boolean(handleOf(tenant)),
      lastHumanAt: tenant.lastHumanAt,
      hasChat: tenantHasChat(
        tenant.photonConversationId,
        tenant.inkboxConversationId,
      ),
      paywalledToday: tenant.paywallSentDayKey === today,
      stuckJob: jobs.some((j) =>
        jobIsStuck({
          status: j.status,
          waitingSince: j.waitingSince,
          now,
        }),
      ),
      failedWakeup: wakeups.some((w) => w.status === "failed"),
      browserStuck: browserIsStuck({
        live:
          browser.label === BROWSER_JOB_RUNNING ||
          browser.label === BROWSER_JOB_SECURE,
        startedAt: browser.startedAt,
        now,
      }),
    });

    return {
      ...(handleOf(tenant) ? { handle: handleOf(tenant) } : {}),
      ...(tenant.phoneE164 ? { phoneE164: tenant.phoneE164 } : {}),
      ...(tenant.emailAddress ? { emailAddress: tenant.emailAddress } : {}),
      status: tenant.status,
      plan: isPaid(tenant.paidUntil, now) ? ("paid" as const) : ("free" as const),
      ...(tenant.paidUntil !== undefined ? { paidUntil: tenant.paidUntil } : {}),
      ...(tenant.lastChannel ? { lastChannel: tenant.lastChannel } : {}),
      ...(tenant.lastHumanAt !== undefined
        ? { lastHumanAt: tenant.lastHumanAt }
        : {}),
      createdAt: tenant._creationTime,
      ...(tenant.telegramUsername
        ? { telegramUsername: tenant.telegramUsername }
        : {}),
      ...(tenant.photonAssignedNumber
        ? { photonAssignedNumber: tenant.photonAssignedNumber }
        : {}),
      ...(tenant.tz ? { tz: tenant.tz } : {}),
      flags,
      browser: {
        label: browser.label,
        ...(browser.task ? { task: browser.task } : {}),
        ...(browser.startedAt !== undefined
          ? { startedAt: browser.startedAt }
          : {}),
      },
      computer: {
        state: computer?.lastState || "none",
        ...(computer?.lastActiveAt !== undefined
          ? { lastActiveAt: computer.lastActiveAt }
          : {}),
      },
      chatgpt: {
        status: snapshotStatus({
          hasAccount: account !== undefined,
          quarantinedAt: account?.quarantinedAt,
        }),
      },
      jobs: jobs.map((j) => ({
        goal: j.goal,
        status: j.status,
        ...(j.waitingFor ? { waitingFor: j.waitingFor } : {}),
        ...(j.waitingSince !== undefined ? { waitingSince: j.waitingSince } : {}),
        ...(j.note ? { note: j.note } : {}),
      })),
      wakeups: wakeups.map((w) => ({
        kind: w.kind,
        status: w.status,
        at: w.at,
        payload: w.payload.slice(0, 160),
      })),
      watchers: watchers.map((w) => ({
        source: w.source,
        about: w.about,
        status: w.status,
        ...(w.events !== undefined ? { events: w.events } : {}),
        ...(w.lastEventAt !== undefined ? { lastEventAt: w.lastEventAt } : {}),
      })),
      payments: payments.map((p) => ({
        createdAt: p.createdAt,
        amountRub: p.amountRub,
        status: p.status,
      })),
      orders: orders.map((o) => ({
        merchant: o.merchant,
        title: o.title,
        status: o.status,
        ...(o.createdAt !== undefined ? { createdAt: o.createdAt } : {}),
      })),
      events: events.map((e) => ({
        kind: e.kind as OpsEventKind,
        at: e.at,
        ...(e.detail ? { detail: e.detail } : {}),
        ...(handleOf(tenant) ? { handle: handleOf(tenant) } : {}),
      })),
    };
  },
});

export const prune = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - OPS_EVENT_TTL_MS;
    const rows = await ctx.db
      .query("opsEvents")
      .withIndex("by_at", (q) => q.lt("at", cutoff))
      .take(200);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return rows.length;
  },
});
