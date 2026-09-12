import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import schema from "./schema";
import { mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";
import { findTenantByPhone } from "./lib/tenantLookup";

const orderDoc = doc(schema, "orders");

const merchant = v.union(v.literal("wb"), v.literal("ozon"), v.literal("other"));
const orderStatus = v.union(
  v.literal("placed"),
  v.literal("cancelled"),
  v.literal("unknown"),
);

export const listForTenant = query({
  args: { secret: v.string(), tenantId: v.id("tenants") },
  returns: v.array(orderDoc),
  handler: async (ctx, { secret, tenantId }) => {
    assertSecret(secret);
    return await ctx.db
      .query("orders")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(50);
  },
});

export const listForPhone = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.array(orderDoc),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await findTenantByPhone(ctx, phoneE164);
    if (!tenant) return [];
    return await ctx.db
      .query("orders")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenant._id))
      .order("desc")
      .take(20);
  },
});

export const record = mutation({
  args: {
    secret: v.string(),
    tenantId: v.id("tenants"),
    merchant,
    merchantOrderId: v.string(),
    title: v.string(),
    priceRub: v.number(),
    status: v.optional(orderStatus),
    pickup: v.optional(v.string()),
  },
  returns: v.id("orders"),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const existing = await ctx.db
      .query("orders")
      .withIndex("by_tenant_and_merchant_order", (q) =>
        q.eq("tenantId", args.tenantId).eq("merchantOrderId", args.merchantOrderId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        merchant: args.merchant,
        title: args.title,
        priceRub: args.priceRub,
        status: args.status ?? existing.status,
        ...(args.pickup ? { pickup: args.pickup } : {}),
      });
      return existing._id;
    }
    return await ctx.db.insert("orders", {
      tenantId: args.tenantId,
      merchant: args.merchant,
      merchantOrderId: args.merchantOrderId,
      title: args.title,
      priceRub: args.priceRub,
      status: args.status ?? "placed",
      createdAt: Date.now(),
      ...(args.pickup ? { pickup: args.pickup } : {}),
    });
  },
});

export const updateStatus = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    status: orderStatus,
    merchantOrderId: v.optional(v.string()),
    orderId: v.optional(v.id("orders")),
  },
  returns: v.union(orderDoc, v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    if (!args.orderId && !args.merchantOrderId) {
      return { error: "merchantOrderId or orderId required" };
    }
    const tenant = await findTenantByPhone(ctx, args.phoneE164);
    if (!tenant) return { error: "unknown tenant" };

    let row = args.orderId ? await ctx.db.get(args.orderId) : null;
    if (row && row.tenantId !== tenant._id) return { error: "unknown order" };
    const merchantOrderId = args.merchantOrderId;
    if (!row && merchantOrderId) {
      row = await ctx.db
        .query("orders")
        .withIndex("by_tenant_and_merchant_order", (q) =>
          q.eq("tenantId", tenant._id).eq("merchantOrderId", merchantOrderId),
        )
        .first();
    }
    if (!row) return { error: "unknown order" };

    await ctx.db.patch(row._id, { status: args.status });
    const updated = await ctx.db.get(row._id);
    if (!updated) return { error: "missing" };
    return updated;
  },
});
