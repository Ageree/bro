import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import schema from "./schema";
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
import { chatConversationId } from "./lib/tenantConversation";

const kind = v.union(
  v.literal("reminder"),
  v.literal("browser_poll"),
  v.literal("brief"),
  v.literal("watcher"),
  v.literal("job_check"),
);
const status = v.union(
  v.literal("scheduled"),
  v.literal("running"),
  v.literal("done"),
  v.literal("cancelled"),
  v.literal("failed"),
);
const wakeupDoc = doc(schema, "wakeups");

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
    const conversationId = chatConversationId(tenant);
    if (!conversationId) {
      await ctx.runMutation(internal.wakeups.finish, { id: w._id, ok: false, gen });
      return;
    }
    const res = await fetch(`${eveUrl}/internal/wakeup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        wakeupId: w._id,
        idempotencyKey: `${w._id}:${gen}`,
        tenantPhone: w.tenantPhone,
        conversationId,
        inkboxHandle: tenant?.inkboxHandle,
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

// Lease-based, not permanent: mirrors agent/lib/wakeup-dedupe.ts's in-memory
// TTL so a genuinely stuck delivery (not just a lost HTTP ack) can still be
// retried once Convex's own wakeup-claim retries (~64s worst case) are long
// past. A row is durable across eve instances; the in-memory Map stays as a
// same-instance fast path in front of this.
const DELIVERY_LEASE_MS = 15 * 60_000;

/** Durable /internal/wakeup delivery dedupe — insert-if-absent-or-expired. */
export const takeDelivery = mutation({
  args: { secret: v.string(), key: v.string() },
  returns: v.object({ taken: v.boolean() }),
  handler: async (ctx, { secret, key }) => {
    assertSecret(secret);
    if (!key) return { taken: true };
    const now = Date.now();
    // .first(), not .unique(): two instances can race an insert for the same
    // key (both see "absent") — .unique() throws on the resulting duplicate
    // key, and this route fails OPEN on an exception (a lost dedupe check
    // must never cost the human their wakeup), which is exactly backwards
    // for a dedupe check that is supposed to fail closed on a real race.
    const existing = await ctx.db
      .query("wakeupDeliveries")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (existing && now - existing.at < DELIVERY_LEASE_MS) {
      return { taken: false };
    }
    if (existing) {
      await ctx.db.patch(existing._id, { at: now });
    } else {
      await ctx.db.insert("wakeupDeliveries", { key, at: now });
    }
    return { taken: true };
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
    // Piggyback the durable wakeup-delivery dedupe prune on the same 15-min
    // sweep this mutation already runs on — no need for a second cron.
    const stale = await ctx.db.query("wakeupDeliveries").take(200);
    for (const row of stale) {
      if (now - row.at > 2 * 24 * 60 * 60_000) await ctx.db.delete(row._id);
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
