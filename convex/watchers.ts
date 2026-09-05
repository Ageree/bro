import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import schema from "./schema";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertSecret } from "./secret";
import {
  deliveryBackoffMs,
  EVENT_TTL_MS,
  eventPayload,
  ownsEvent,
  shouldRetryDelivery,
} from "./lib/watcherPolicy";

const source = v.union(v.literal("gmail"), v.literal("calendar"));
const status = v.union(v.literal("active"), v.literal("stopped"));
const watcherDoc = doc(schema, "watchers");

export const create = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    source,
    triggerId: v.string(),
    triggerSlug: v.string(),
    about: v.string(),
    filter: v.optional(v.string()),
  },
  returns: v.id("watchers"),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const active = await ctx.db
      .query("watchers")
      .withIndex("by_tenant_status", (q) =>
        q.eq("tenantPhone", args.tenantPhone).eq("status", "active"),
      )
      .collect();
    const existing = active.find((row) => row.triggerId === args.triggerId);
    if (existing) {
      await ctx.db.patch(existing._id, {
        about: args.about,
        filter: args.filter,
      });
      return existing._id;
    }
    return await ctx.db.insert("watchers", {
      tenantPhone: args.tenantPhone,
      source: args.source,
      triggerId: args.triggerId,
      triggerSlug: args.triggerSlug,
      about: args.about,
      filter: args.filter,
      status: "active",
      createdAt: Date.now(),
    });
  },
});

export const listActive = query({
  args: { secret: v.string(), tenantPhone: v.string() },
  returns: v.array(watcherDoc),
  handler: async (ctx, { secret, tenantPhone }) => {
    assertSecret(secret);
    return await ctx.db
      .query("watchers")
      .withIndex("by_tenant_status", (q) =>
        q.eq("tenantPhone", tenantPhone).eq("status", "active"),
      )
      .collect();
  },
});

export const stop = mutation({
  args: {
    secret: v.string(),
    tenantPhone: v.string(),
    id: v.optional(v.id("watchers")),
  },
  returns: v.array(v.object({ id: v.id("watchers"), triggerId: v.string() })),
  handler: async (ctx, { secret, tenantPhone, id }) => {
    assertSecret(secret);
    const rows: Doc<"watchers">[] = [];
    if (id) {
      const row = await ctx.db.get(id);
      if (row && row.tenantPhone === tenantPhone && row.status === "active") {
        rows.push(row);
      }
    } else {
      const active = await ctx.db
        .query("watchers")
        .withIndex("by_tenant_status", (q) =>
          q.eq("tenantPhone", tenantPhone).eq("status", "active"),
        )
        .collect();
      rows.push(...active);
    }
    const result: { id: Id<"watchers">; triggerId: string }[] = [];
    for (const row of rows) {
      await ctx.db.patch(row._id, { status: "stopped" });
      result.push({ id: row._id, triggerId: row.triggerId });
    }
    return result;
  },
});

export const get = internalQuery({
  args: { id: v.id("watchers") },
  returns: v.union(watcherDoc, v.null()),
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const ingest = internalMutation({
  args: {
    eventId: v.string(),
    triggerId: v.string(),
    userId: v.optional(v.string()),
    text: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.literal("queued"),
    v.literal("duplicate"),
    v.literal("unknown_trigger"),
    v.literal("foreign_user"),
    v.literal("stopped"),
  ),
  handler: async (ctx, args) => {
    const watcher = await ctx.db
      .query("watchers")
      .withIndex("by_trigger", (q) => q.eq("triggerId", args.triggerId))
      .first();
    if (!watcher) return "unknown_trigger";
    if (!ownsEvent(watcher, { userId: args.userId })) {
      return watcher.status !== "active" ? "stopped" : "foreign_user";
    }
    const existing = await ctx.db
      .query("composioEvents")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .first();
    if (existing) return "duplicate";
    await ctx.db.insert("composioEvents", {
      eventId: args.eventId,
      receivedAt: args.now,
    });
    await ctx.db.patch(watcher._id, {
      lastEventAt: args.now,
      events: (watcher.events ?? 0) + 1,
    });
    await ctx.scheduler.runAfter(0, internal.watchers.deliverEvent, {
      watcherId: watcher._id,
      eventId: args.eventId,
      payload: eventPayload(watcher.about, args.text),
      attempt: 0,
    });
    return "queued";
  },
});

export const deliverEvent = internalAction({
  args: {
    watcherId: v.id("watchers"),
    eventId: v.string(),
    payload: v.string(),
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const eveUrl = process.env.EVE_URL;
    // ponytail: no EVE_URL on this deployment → silent no-op
    if (!eveUrl) return null;
    const watcher = await ctx.runQuery(internal.watchers.get, { id: args.watcherId });
    if (!watcher || watcher.status !== "active") return null;
    const tenant = await ctx.runQuery(internal.tenants.getByPhoneInternal, {
      phoneE164: watcher.tenantPhone,
    });
    if (!tenant?.inkboxConversationId) return null;
    const body = {
      secret: process.env.BRO_INTERNAL_SECRET ?? "",
      wakeupId: args.watcherId,
      tenantPhone: watcher.tenantPhone,
      conversationId: tenant.inkboxConversationId,
      inkboxHandle: tenant.inkboxHandle,
      kind: "event" as const,
      payload: args.payload,
      idempotencyKey: args.eventId,
    };
    try {
      const res = await fetch(`${eveUrl}/internal/wakeup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`wakeup ${res.status}`);
    } catch (err) {
      if (shouldRetryDelivery(args.attempt)) {
        await ctx.scheduler.runAfter(
          deliveryBackoffMs(args.attempt),
          internal.watchers.deliverEvent,
          {
            watcherId: args.watcherId,
            eventId: args.eventId,
            payload: args.payload,
            attempt: args.attempt + 1,
          },
        );
      } else {
        console.error("watcher delivery gave up", args.watcherId, args.eventId, err);
      }
    }
    return null;
  },
});

export const pruneEvents = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - EVENT_TTL_MS;
    const rows = await ctx.db
      .query("composioEvents")
      .withIndex("by_receivedAt", (q) => q.lt("receivedAt", cutoff))
      .take(200);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return rows.length;
  },
});
