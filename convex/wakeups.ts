import { anyApi } from "convex/server";
import { v } from "convex/values";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertSecret } from "./secret";
import {
  backoffAt,
  giveUp,
  isSingletonKind,
  liveOfKind,
  nextAfterRun,
  shouldApplyFinish,
} from "./lib/wakeupPolicy";

// ponytail: anyApi до codegen; после convex deploy можно вернуть typed api
const wakeups = anyApi.wakeups;

const kind = v.union(
  v.literal("reminder"),
  v.literal("browser_poll"),
  v.literal("brief"),
  v.literal("watcher"),
);
const status = v.union(
  v.literal("scheduled"),
  v.literal("running"),
  v.literal("done"),
  v.literal("cancelled"),
  v.literal("failed"),
);
const wakeupDoc = v.object({
  _id: v.id("wakeups"),
  _creationTime: v.number(),
  tenantPhone: v.string(),
  at: v.number(),
  kind,
  payload: v.string(),
  status,
  recurMinutes: v.optional(v.number()),
  recurDailyHour: v.optional(v.number()),
  tz: v.optional(v.string()),
  lastSeen: v.optional(v.string()),
  attempts: v.optional(v.number()),
});

export const schedule = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    at: v.number(),
    kind,
    payload: v.string(),
    recurMinutes: v.optional(v.number()),
    recurDailyHour: v.optional(v.number()),
    tz: v.optional(v.string()),
  },
  returns: v.id("wakeups"),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    if (isSingletonKind(args.kind)) {
      // ponytail: one watcher per person; if they ask for a second — array
      // ponytail: by_tenant isn't status-filtered; 100 is enough until done-rows bury live ones
      const rows = await ctx.db
        .query("wakeups")
        .withIndex("by_tenant", (q) => q.eq("tenantPhone", args.tenantPhone))
        .take(100);
      const existing = liveOfKind(rows, args.kind);
      if (existing) {
        await ctx.db.patch(existing._id, {
          at: args.at,
          payload: args.payload,
          recurMinutes: args.recurMinutes,
          recurDailyHour: args.recurDailyHour,
          tz: args.tz,
          attempts: 0,
        });
        return existing._id;
      }
    }
    return await ctx.db.insert("wakeups", {
      tenantPhone: args.tenantPhone,
      at: args.at,
      kind: args.kind,
      payload: args.payload,
      status: "scheduled",
      recurMinutes: args.recurMinutes,
      recurDailyHour: args.recurDailyHour,
      tz: args.tz,
    });
  },
});

export const cancel = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    id: v.optional(v.id("wakeups")),
    kind: v.optional(kind),
  },
  returns: v.number(),
  handler: async (ctx, { secret, tenantPhone, id, kind: k }) => {
    assertSecret(secret);
    if (id) {
      const row = await ctx.db.get(id);
      if (
        !row ||
        row.tenantPhone !== tenantPhone ||
        (row.status !== "scheduled" && row.status !== "running")
      ) {
        return 0;
      }
      await ctx.db.patch(id, {
        status: "cancelled",
        recurMinutes: undefined,
        recurDailyHour: undefined,
      });
      return 1;
    }
    if (!k) return 0;
    const rows = await ctx.db
      .query("wakeups")
      .withIndex("by_tenant", (q) => q.eq("tenantPhone", tenantPhone))
      .take(100);
    let n = 0;
    for (const row of rows) {
      if (row.status !== "scheduled" && row.status !== "running") continue;
      if (row.kind !== k) continue;
      await ctx.db.patch(row._id, {
        status: "cancelled",
        recurMinutes: undefined,
        recurDailyHour: undefined,
      });
      n++;
    }
    return n;
  },
});

export const listForTenant = query({
  args: { secret: v.string(), tenantPhone: v.string() },
  returns: v.array(wakeupDoc),
  handler: async (ctx, { secret, tenantPhone }) => {
    assertSecret(secret);
    const rows = await ctx.db
      .query("wakeups")
      .withIndex("by_tenant", (q) => q.eq("tenantPhone", tenantPhone))
      .take(100);
    return rows.filter((r) => r.status === "scheduled" || r.status === "running");
  },
});

export const claimDue = internalMutation({
  args: {},
  returns: v.array(wakeupDoc),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("wakeups")
      .withIndex("by_status_at", (q) => q.eq("status", "scheduled").lte("at", now))
      .take(10);
    const out = [];
    for (const row of rows) {
      await ctx.db.patch(row._id, { status: "running" });
      out.push({ ...row, status: "running" as const });
    }
    return out;
  },
});

export const finish = internalMutation({
  args: { id: v.id("wakeups"), ok: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { id, ok }) => {
    const w = await ctx.db.get(id);
    if (!w) return null;
    if (!shouldApplyFinish(w.status)) return null;
    const now = Date.now();
    if (ok) {
      const next = nextAfterRun(
        {
          recurMinutes: w.recurMinutes,
          recurDailyHour: w.recurDailyHour,
          tz: w.tz,
        },
        now,
      );
      if (next !== null) {
        await ctx.db.patch(id, { status: "scheduled", at: next, attempts: 0 });
      } else {
        await ctx.db.patch(id, { status: "done" });
      }
      return null;
    }
    const attempts = (w.attempts ?? 0) + 1;
    if (giveUp(attempts)) {
      await ctx.db.patch(id, { status: "failed", attempts });
    } else {
      await ctx.db.patch(id, {
        status: "scheduled",
        at: backoffAt(attempts, now),
        attempts,
      });
    }
    return null;
  },
});

export const setLastSeen = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    kind: v.literal("watcher"),
    lastSeen: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { secret, tenantPhone, kind, lastSeen }) => {
    assertSecret(secret);
    const rows = await ctx.db
      .query("wakeups")
      .withIndex("by_tenant", (q) => q.eq("tenantPhone", tenantPhone))
      .take(100);
    const w = liveOfKind(rows, kind);
    if (w) await ctx.db.patch(w._id, { lastSeen });
    return null;
  },
});

export const dispatchDue = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const eveUrl = process.env.EVE_URL;
    // ponytail: no EVE_URL on this deployment → silent no-op
    if (!eveUrl) return null;
    const secret = process.env.BRO_INTERNAL_SECRET ?? "";
    const due = await ctx.runMutation(wakeups.claimDue, {});
    for (const w of due) {
      try {
        const tenant = await ctx.runQuery(internal.tenants.getByPhoneInternal, {
          phoneE164: w.tenantPhone,
        });
        if (!tenant?.inkboxConversationId) {
          await ctx.runMutation(wakeups.finish, { id: w._id, ok: false });
          continue;
        }
        const res = await fetch(`${eveUrl}/internal/wakeup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret,
            wakeupId: w._id,
            tenantPhone: w.tenantPhone,
            conversationId: tenant.inkboxConversationId,
            inkboxHandle: tenant.inkboxHandle,
            kind: w.kind,
            payload: w.payload,
            lastSeen: w.lastSeen,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          await ctx.runMutation(wakeups.finish, { id: w._id, ok: false });
          continue;
        }
        try {
          const json = (await res.json()) as { lastSeen?: unknown };
          if (typeof json.lastSeen === "string" && w.kind === "watcher") {
            await ctx.runMutation(wakeups.setLastSeen, {
              secret,
              tenantPhone: w.tenantPhone,
              kind: "watcher",
              lastSeen: json.lastSeen,
            });
          }
        } catch {
          // 2xx without JSON lastSeen is still success
        }
        await ctx.runMutation(wakeups.finish, { id: w._id, ok: true });
      } catch {
        await ctx.runMutation(wakeups.finish, { id: w._id, ok: false });
      }
    }
    return null;
  },
});
