import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { assertSecret } from "./secret";
import {
  backoffAt,
  canClaim,
  canFinish,
  giveUp,
  isSingletonKind,
  LIVE_STATUSES,
  liveOfKind,
  nextAfterRun,
  nextGen,
  rescheduleLive,
  shouldApplyFinish,
} from "./lib/wakeupPolicy";
import { hasCron, scheduleCron, unscheduleCron } from "./lib/wakeupCrons";

const kind = v.union(
  v.literal("reminder"),
  v.literal("browser_poll"),
  v.literal("brief"),
  v.literal("watcher"),
  v.literal("job_check"),
  v.literal("computer_poll"),
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
  gen: v.optional(v.number()),
});

async function liveForTenant(
  ctx: QueryCtx | MutationCtx,
  tenantPhone: string,
): Promise<Doc<"wakeups">[]> {
  const out: Doc<"wakeups">[] = [];
  for (const s of LIVE_STATUSES) {
    const rows = await ctx.db
      .query("wakeups")
      .withIndex("by_tenant_status", (q) =>
        q.eq("tenantPhone", tenantPhone).eq("status", s),
      )
      .collect();
    out.push(...rows);
  }
  return out;
}

async function claimRow(
  ctx: MutationCtx,
  row: Doc<"wakeups">,
  ticket: { gen: number },
): Promise<Doc<"wakeups"> | null> {
  if (!canClaim(row, ticket)) return null;
  await ctx.db.patch(row._id, { status: "running" });
  await unscheduleCron(ctx, row._id);
  return { ...row, status: "running" };
}

async function deliverOne(
  ctx: ActionCtx,
  w: Doc<"wakeups">,
  eveUrl: string,
  secret: string,
  gen: number,
): Promise<void> {
  try {
    const tenant = await ctx.runQuery(internal.tenants.getByPhoneInternal, {
      phoneE164: w.tenantPhone,
    });
    if (!tenant?.inkboxConversationId) {
      await ctx.runMutation(internal.wakeups.finish, { id: w._id, ok: false, gen });
      return;
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
      await ctx.runMutation(internal.wakeups.finish, { id: w._id, ok: false, gen });
      return;
    }
    try {
      const json = (await res.json()) as { lastSeen?: unknown };
      if (typeof json.lastSeen === "string" && w.kind === "watcher") {
        await ctx.runMutation(internal.wakeups.setLastSeenInternal, {
          tenantPhone: w.tenantPhone,
          lastSeen: json.lastSeen,
        });
      }
    } catch {
      // 2xx without JSON lastSeen is still success
    }
    await ctx.runMutation(internal.wakeups.finish, { id: w._id, ok: true, gen });
  } catch {
    await ctx.runMutation(internal.wakeups.finish, { id: w._id, ok: false, gen });
  }
}

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
    const now = Date.now();
    if (isSingletonKind(args.kind)) {
      const existing = liveOfKind(await liveForTenant(ctx, args.tenantPhone), args.kind);
      if (existing) {
        const next = rescheduleLive(existing, args.at);
        await ctx.db.patch(existing._id, {
          at: next.at,
          payload: args.payload,
          recurMinutes: args.recurMinutes,
          recurDailyHour: args.recurDailyHour,
          tz: args.tz,
          attempts: 0,
          gen: next.gen,
          status: next.status,
        });
        await scheduleCron(ctx, existing._id, next.at, now, next.gen);
        return existing._id;
      }
    }
    const id = await ctx.db.insert("wakeups", {
      tenantPhone: args.tenantPhone,
      at: args.at,
      kind: args.kind,
      payload: args.payload,
      status: "scheduled",
      recurMinutes: args.recurMinutes,
      recurDailyHour: args.recurDailyHour,
      tz: args.tz,
      gen: 0,
    });
    await scheduleCron(ctx, id, args.at, now, 0);
    return id;
  },
});

export const cancel = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    id: v.optional(v.id("wakeups")),
    kind: v.optional(kind),
    payloadContains: v.optional(v.string()),
  },
  returns: v.number(),
  handler: async (ctx, { secret, tenantPhone, id, kind: k, payloadContains }) => {
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
      await unscheduleCron(ctx, id);
      await ctx.db.patch(id, {
        status: "cancelled",
        recurMinutes: undefined,
        recurDailyHour: undefined,
      });
      return 1;
    }
    if (!k) return 0;
    const rows = await liveForTenant(ctx, tenantPhone);
    let n = 0;
    for (const row of rows) {
      if (row.kind !== k) continue;
      if (payloadContains && !row.payload.includes(payloadContains)) continue;
      await unscheduleCron(ctx, row._id);
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
    return await liveForTenant(ctx, tenantPhone);
  },
});

export const claimOne = internalMutation({
  args: { id: v.id("wakeups"), gen: v.number() },
  returns: v.union(wakeupDoc, v.null()),
  handler: async (ctx, { id, gen }) => {
    const row = await ctx.db.get(id);
    if (!row) return null;
    return await claimRow(ctx, row, { gen });
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
      const claimed = await claimRow(ctx, row, { gen: row.gen ?? 0 });
      if (claimed) out.push(claimed);
    }
    return out;
  },
});

export const ensureCrons = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("wakeups")
      .withIndex("by_status_at", (q) => q.eq("status", "scheduled"))
      .take(50);
    let n = 0;
    for (const row of rows) {
      if (row.at <= now) continue;
      if (await hasCron(ctx, row._id)) continue;
      await scheduleCron(ctx, row._id, row.at, now, row.gen ?? 0);
      n++;
    }
    return n;
  },
});

export const finish = internalMutation({
  args: { id: v.id("wakeups"), ok: v.boolean(), gen: v.number() },
  returns: v.null(),
  handler: async (ctx, { id, ok, gen: ticketGen }) => {
    const w = await ctx.db.get(id);
    if (!w || !canFinish(w, { gen: ticketGen })) return null;
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
        const gen = nextGen(w.gen);
        await ctx.db.patch(id, { status: "scheduled", at: next, attempts: 0, gen });
        await scheduleCron(ctx, id, next, now, gen);
      } else {
        await ctx.db.patch(id, { status: "done" });
      }
      return null;
    }
    const attempts = (w.attempts ?? 0) + 1;
    if (giveUp(attempts)) {
      await ctx.db.patch(id, { status: "failed", attempts });
    } else {
      const at = backoffAt(attempts, now);
      const gen = nextGen(w.gen);
      await ctx.db.patch(id, { status: "scheduled", at, attempts, gen });
      await scheduleCron(ctx, id, at, now, gen);
    }
    return null;
  },
});

async function applyLastSeen(
  ctx: MutationCtx,
  tenantPhone: string,
  lastSeen: string,
): Promise<void> {
  const w = liveOfKind(await liveForTenant(ctx, tenantPhone), "watcher");
  if (w) await ctx.db.patch(w._id, { lastSeen });
}

export const setLastSeen = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    kind: v.literal("watcher"),
    lastSeen: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { secret, tenantPhone, lastSeen }) => {
    assertSecret(secret);
    await applyLastSeen(ctx, tenantPhone, lastSeen);
    return null;
  },
});

export const setLastSeenInternal = internalMutation({
  args: { tenantPhone: v.string(), lastSeen: v.string() },
  returns: v.null(),
  handler: async (ctx, { tenantPhone, lastSeen }) => {
    await applyLastSeen(ctx, tenantPhone, lastSeen);
    return null;
  },
});

export const dispatchOne = internalAction({
  args: { id: v.id("wakeups"), gen: v.number() },
  returns: v.null(),
  handler: async (ctx, { id, gen }) => {
    const eveUrl = process.env.EVE_URL;
    // ponytail: no EVE_URL on this deployment → silent no-op
    if (!eveUrl) return null;
    const secret = process.env.BRO_INTERNAL_SECRET ?? "";
    const w = await ctx.runMutation(internal.wakeups.claimOne, { id, gen });
    if (!w) return null;
    await deliverOne(ctx, w, eveUrl, secret, gen);
    return null;
  },
});

export const dispatchDue = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.wakeups.ensureCrons, {});
    const eveUrl = process.env.EVE_URL;
    // ponytail: no EVE_URL on this deployment → silent no-op
    if (!eveUrl) return null;
    const secret = process.env.BRO_INTERNAL_SECRET ?? "";
    const due = await ctx.runMutation(internal.wakeups.claimDue, {});
    for (const w of due) {
      await deliverOne(ctx, w, eveUrl, secret, w.gen ?? 0);
    }
    return null;
  },
});
