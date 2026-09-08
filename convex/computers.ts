import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internalMutation, internalQuery } from "./_generated/server";
import schema from "./schema";
import {
  bindComputerBox,
  claimOrGetComputer,
  computerByTenant,
  computerSize,
  deleteComputersForTenant,
  patchComputerState,
  touchComputerActive,
} from "./lib/computerStore";

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
