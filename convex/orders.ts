import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertSecret } from "./secret";

export const listForTenant = query({
  args: { secret: v.string(), tenantId: v.id("tenants") },
  returns: v.array(
    v.object({
      _id: v.id("orders"),
      _creationTime: v.number(),
      tenantId: v.id("tenants"),
      merchant: v.union(v.literal("wb"), v.literal("ozon"), v.literal("other")),
      merchantOrderId: v.string(),
      title: v.string(),
      priceRub: v.number(),
      status: v.union(
        v.literal("placed"),
        v.literal("cancelled"),
        v.literal("unknown"),
      ),
    }),
  ),
  handler: async (ctx, { secret, tenantId }) => {
    assertSecret(secret);
    return await ctx.db
      .query("orders")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(50);
  },
});

export const record = mutation({
  args: {
    secret: v.string(),
    tenantId: v.id("tenants"),
    merchant: v.union(v.literal("wb"), v.literal("ozon"), v.literal("other")),
    merchantOrderId: v.string(),
    title: v.string(),
    priceRub: v.number(),
    status: v.optional(
      v.union(v.literal("placed"), v.literal("cancelled"), v.literal("unknown")),
    ),
  },
  returns: v.id("orders"),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    return await ctx.db.insert("orders", {
      tenantId: args.tenantId,
      merchant: args.merchant,
      merchantOrderId: args.merchantOrderId,
      title: args.title,
      priceRub: args.priceRub,
      status: args.status ?? "placed",
    });
  },
});
