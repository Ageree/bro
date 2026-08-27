import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { cardLinkUrl, linkFresh, makeCardToken } from "./lib/cardPolicy";
import { assertSecret } from "./secret";

const LINK_TTL_MS = 15 * 60 * 1000;

const cardBrand = v.union(v.literal("mir"), v.literal("visa"), v.literal("mc"));

export const mintLink = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const origin = process.env.BRO_PUBLIC_ORIGIN?.replace(/\/+$/, "");
    if (!origin) throw new Error("BRO_PUBLIC_ORIGIN is not set");
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (!tenant) throw new Error("unknown tenant");
    const token = makeCardToken(crypto.getRandomValues(new Uint8Array(24)));
    const expiresAt = Date.now() + LINK_TTL_MS;
    await ctx.db.insert("cardLinks", {
      tenantId: tenant._id,
      token,
      expiresAt,
      used: false,
    });
    return { url: cardLinkUrl(origin, token), expiresAt };
  },
});

export const last4 = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(
    v.object({
      status: v.literal("active"),
      last4: v.string(),
      brand: cardBrand,
      expMonth: v.number(),
      expYear: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (
      !tenant ||
      tenant.cardStatus !== "active" ||
      !tenant.cardLast4 ||
      !tenant.cardBrand ||
      tenant.cardExpMonth == null ||
      tenant.cardExpYear == null
    ) {
      return null;
    }
    return {
      status: "active" as const,
      last4: tenant.cardLast4,
      brand: tenant.cardBrand,
      expMonth: tenant.cardExpMonth,
      expYear: tenant.cardExpYear,
    };
  },
});

export const forget = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.null(),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (!tenant) throw new Error("unknown tenant");
    await ctx.db.patch(tenant._id, {
      cardStatus: "removed",
      cardBlob: undefined,
      cardLast4: undefined,
      cardBrand: undefined,
      cardExpMonth: undefined,
      cardExpYear: undefined,
    });
    return null;
  },
});

export const consumeLink = internalMutation({
  args: {
    token: v.string(),
    last4: v.string(),
    brand: cardBrand,
    expMonth: v.number(),
    expYear: v.number(),
    blob: v.string(),
  },
  returns: v.object({ last4: v.string(), brand: v.string() }),
  handler: async (ctx, { token, last4, brand, expMonth, expYear, blob }) => {
    const link = await ctx.db
      .query("cardLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!link || !linkFresh(link.expiresAt, link.used, Date.now())) {
      throw new Error("invalid or expired link");
    }
    await ctx.db.patch(link._id, { used: true });
    const tenant = await ctx.db.get(link.tenantId);
    if (!tenant) throw new Error("unknown tenant");
    await ctx.db.patch(tenant._id, {
      cardLast4: last4,
      cardBrand: brand,
      cardExpMonth: expMonth,
      cardExpYear: expYear,
      cardBlob: blob,
      cardStatus: "active",
    });
    return { last4, brand };
  },
});

export const blobForPay = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(
    v.object({
      blob: v.string(),
      expMonth: v.number(),
      expYear: v.number(),
      last4: v.string(),
      brand: cardBrand,
    }),
    v.null(),
  ),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
      .first();
    if (
      !tenant ||
      tenant.cardStatus !== "active" ||
      !tenant.cardBlob ||
      !tenant.cardLast4 ||
      !tenant.cardBrand ||
      tenant.cardExpMonth == null ||
      tenant.cardExpYear == null
    ) {
      return null;
    }
    return {
      blob: tenant.cardBlob,
      expMonth: tenant.cardExpMonth,
      expYear: tenant.cardExpYear,
      last4: tenant.cardLast4,
      brand: tenant.cardBrand,
    };
  },
});
