import { anyApi } from "convex/server";
import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { extendPaidUntil } from "./lib/billingPolicy";

// ponytail: anyApi до codegen; после convex deploy можно вернуть typed api
const billing = anyApi.billing;

function shopCreds(): { shopId: string; secret: string } {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secret = process.env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secret) throw new Error("billing disabled");
  return { shopId, secret };
}

function basic(shopId: string, secret: string): string {
  return `Basic ${btoa(`${shopId}:${secret}`)}`;
}

function priceRub(): number {
  const n = Number(process.env.BRO_PRICE_RUB ?? 2000);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 2000;
}

export const applyPayment = internalMutation({
  args: { tenantId: v.string() },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId as Id<"tenants">);
    if (!tenant) return null;
    await ctx.db.patch(tenant._id, {
      paidUntil: extendPaidUntil(tenant.paidUntil, Date.now()),
    });
    return null;
  },
});

export const createPaymentFor = internalAction({
  args: { tenantId: v.string() },
  returns: v.object({ confirmationUrl: v.string() }),
  handler: async (_ctx, { tenantId }) => {
    const { shopId, secret } = shopCreds();
    const res = await fetch("https://api.yookassa.ru/v3/payments", {
      method: "POST",
      headers: {
        Authorization: basic(shopId, secret),
        "Idempotence-Key": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: { value: `${priceRub()}.00`, currency: "RUB" },
        capture: true,
        confirmation: {
          type: "redirect",
          return_url:
            process.env.BRO_PAY_RETURN_URL ?? "https://bro-agent.vercel.app",
        },
        description: "Bro — месяц",
        metadata: { tenantId },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      confirmation?: { confirmation_url?: unknown };
    };
    const url = json.confirmation?.confirmation_url;
    if (!res.ok || typeof url !== "string" || !url) {
      throw new Error("yookassa create failed");
    }
    return { confirmationUrl: url };
  },
});

export const verifyAndApply = internalAction({
  args: { paymentId: v.string() },
  returns: v.null(),
  handler: async (ctx, { paymentId }) => {
    const { shopId, secret } = shopCreds();
    // ponytail: authenticity = our re-fetch, not the webhook body
    const res = await fetch(
      `https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`,
      {
        headers: { Authorization: basic(shopId, secret) },
        signal: AbortSignal.timeout(20_000),
      },
    );
    const json = (await res.json()) as {
      status?: unknown;
      metadata?: { tenantId?: unknown };
    };
    if (!res.ok) throw new Error(`yookassa get ${res.status}`);
    const tenantId = json.metadata?.tenantId;
    if (json.status === "succeeded" && typeof tenantId === "string" && tenantId) {
      await ctx.runMutation(billing.applyPayment, { tenantId });
    }
    return null;
  },
});
