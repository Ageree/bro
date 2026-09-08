import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import schema from "./schema";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  claimOrGetComputer,
  computerByTenant,
  computerSize,
  deleteComputerForTenant,
  insertComputer,
  patchComputerState,
  tenantByPhone,
  touchComputerActive,
} from "./lib/computerStore";

export const computerDoc = doc(schema, "computers");

export const getByTenant = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.union(computerDoc, v.null()),
  handler: async (ctx, { tenantId }) => {
    return await computerByTenant(ctx, tenantId);
  },
});

export const getByPhone = internalQuery({
  args: { phoneE164: v.string() },
  returns: v.union(computerDoc, v.null()),
  handler: async (ctx, { phoneE164 }) => {
    const tenant = await tenantByPhone(ctx, phoneE164);
    if (!tenant) return null;
    return await computerByTenant(ctx, tenant._id);
  },
});

export const insertForTenant = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    boxId: v.string(),
    size: computerSize,
    lastState: v.string(),
    now: v.number(),
  },
  returns: computerDoc,
  handler: async (ctx, args) => {
    return await insertComputer(ctx, args);
  },
});

export const setState = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    lastState: v.string(),
    now: v.number(),
    lastActiveAt: v.optional(v.number()),
    resumedAt: v.optional(v.number()),
  },
  returns: computerDoc,
  handler: async (ctx, args) => {
    return await patchComputerState(ctx, args);
  },
});

export const touchActive = internalMutation({
  args: { tenantId: v.id("tenants"), now: v.number() },
  returns: computerDoc,
  handler: async (ctx, args) => {
    return await touchComputerActive(ctx, args);
  },
});

export const deleteForTenant = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.boolean(),
  handler: async (ctx, { tenantId }) => {
    return await deleteComputerForTenant(ctx, tenantId);
  },
});

/** Unique by tenant: return the existing row, or insert if none. */
export const claimOrGet = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    boxId: v.optional(v.string()),
    size: v.optional(computerSize),
    lastState: v.string(),
    now: v.number(),
  },
  returns: computerDoc,
  handler: async (ctx, args) => {
    return await claimOrGetComputer(ctx, args);
  },
});
