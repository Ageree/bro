import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import schema from "./schema";
import { assertSecret } from "./secret";
import {
  bindComputerBox,
  claimOrGetComputer,
  computerByTenant,
  computerSize,
  deleteComputersForTenant,
  patchComputerState,
  touchComputerActive,
} from "./lib/computerStore";
import { computerStartAllowance } from "./lib/computerPolicy";
import {
  dayKey,
  isPaid,
  rateLimitPeriodKey,
  usedCount,
} from "./lib/billingPolicy";
import { periodConfig, rateLimiter } from "./lib/rateLimits";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const computerDoc = doc(schema, "computers");

export const getByTenant = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.union(computerDoc, v.null()),
  handler: async (ctx, args) => computerByTenant(ctx, args.tenantId),
});

export const claimOrGet = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    size: v.optional(computerSize),
    now: v.number(),
  },
  returns: computerDoc,
  handler: async (ctx, args) => claimOrGetComputer(ctx, args),
});

export const bindBox = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    boxId: v.string(),
    lastState: v.string(),
    now: v.number(),
  },
  returns: computerDoc,
  handler: async (ctx, args) => bindComputerBox(ctx, args),
});

export const setState = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    lastState: v.string(),
    now: v.number(),
  },
  returns: computerDoc,
  handler: async (ctx, args) =>
    patchComputerState(ctx, {
      tenantId: args.tenantId,
      lastState: args.lastState,
      now: args.now,
    }),
});

export const touchActive = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    now: v.number(),
  },
  returns: computerDoc,
  handler: async (ctx, args) =>
    touchComputerActive(ctx, {
      tenantId: args.tenantId,
      now: args.now,
    }),
});

export const deleteForTenant = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteComputersForTenant(ctx, args.tenantId);
    return null;
  },
});

async function tenantByPhone(
  ctx: QueryCtx | MutationCtx,
  phoneE164: string,
): Promise<Id<"tenants"> | null> {
  const phone = phoneE164.trim();
  if (!phone) throw new Error("phoneE164 required");
  const tenant = await ctx.db
    .query("tenants")
    .withIndex("by_phone", (q) => q.eq("phoneE164", phone))
    .first();
  return tenant?._id ?? null;
}

export const getForAgent = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(computerDoc, v.null()),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantByPhone(ctx, args.phoneE164);
    if (!tenantId) return null;
    return await computerByTenant(ctx, tenantId);
  },
});

export const claimForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    size: v.optional(computerSize),
    now: v.number(),
  },
  returns: v.union(computerDoc, v.null()),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantByPhone(ctx, args.phoneE164);
    if (!tenantId) return null;
    return await claimOrGetComputer(ctx, {
      tenantId,
      size: args.size,
      now: args.now,
    });
  },
});

export const bindForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    boxId: v.string(),
    lastState: v.string(),
    now: v.number(),
  },
  returns: v.union(computerDoc, v.null()),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantByPhone(ctx, args.phoneE164);
    if (!tenantId) return null;
    return await bindComputerBox(ctx, {
      tenantId,
      boxId: args.boxId,
      lastState: args.lastState,
      now: args.now,
    });
  },
});

export const setStateForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    lastState: v.string(),
    now: v.number(),
  },
  returns: v.union(computerDoc, v.null()),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantByPhone(ctx, args.phoneE164);
    if (!tenantId) return null;
    return await patchComputerState(ctx, {
      tenantId,
      lastState: args.lastState,
      now: args.now,
    });
  },
});

export const deleteForAgent = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantByPhone(ctx, args.phoneE164);
    if (!tenantId) return false;
    return await deleteComputersForTenant(ctx, tenantId);
  },
});

export const spendStartForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    const phone = args.phoneE164.trim();
    if (!phone) throw new Error("phoneE164 required");
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_phone", (q) => q.eq("phoneE164", phone))
      .first();
    if (!tenant) return false;
    const paid = isPaid(tenant.paidUntil, args.now);
    const allowance = computerStartAllowance(paid, {
      free: process.env.BRO_FREE_COMPUTER_STARTS_PER_DAY,
      paid: process.env.BRO_PAID_COMPUTER_STARTS_PER_DAY,
    });
    const periodKey = rateLimitPeriodKey(tenant._id, dayKey(args.now, tenant.tz));
    const config = periodConfig();
    const { value } = await rateLimiter.getValue(ctx, "computerStartsPerDay", {
      key: periodKey,
      config,
    });
    if (usedCount(value) >= allowance) return false;
    await rateLimiter.limit(ctx, "computerStartsPerDay", {
      key: periodKey,
      config,
    });
    return true;
  },
});

export const touchForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    now: v.number(),
  },
  returns: v.union(computerDoc, v.null()),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantByPhone(ctx, args.phoneE164);
    if (!tenantId) return null;
    return await touchComputerActive(ctx, {
      tenantId,
      now: args.now,
    });
  },
});
