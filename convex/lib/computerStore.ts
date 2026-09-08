import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const computerSize = v.union(
  v.literal("small"),
  v.literal("default"),
  v.literal("large"),
);

export type ComputerSize = Infer<typeof computerSize>;

export const DEFAULT_COMPUTER_SIZE: ComputerSize = "small";

export async function tenantByPhone(
  ctx: QueryCtx | MutationCtx,
  phoneE164: string,
): Promise<Doc<"tenants"> | null> {
  return await ctx.db
    .query("tenants")
    .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
    .first();
}

export async function computerByTenant(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
): Promise<Doc<"computers"> | null> {
  return await ctx.db
    .query("computers")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .unique();
}

export async function insertComputer(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    boxId: string;
    size: ComputerSize;
    lastState: string;
    now: number;
  },
): Promise<Doc<"computers">> {
  const existing = await computerByTenant(ctx, args.tenantId);
  if (existing) throw new Error("computer exists");
  const id = await ctx.db.insert("computers", {
    tenantId: args.tenantId,
    boxId: args.boxId,
    size: args.size,
    lastState: args.lastState,
    lastStateAt: args.now,
    createdAt: args.now,
  });
  const created = await ctx.db.get(id);
  if (!created) throw new Error("computer insert failed");
  return created;
}

export async function patchComputerState(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    lastState: string;
    now: number;
    lastActiveAt?: number;
    resumedAt?: number;
  },
): Promise<Doc<"computers">> {
  const existing = await computerByTenant(ctx, args.tenantId);
  if (!existing) throw new Error("computer not found");
  const patch: {
    lastState: string;
    lastStateAt: number;
    lastActiveAt?: number;
    resumedAt?: number;
  } = {
    lastState: args.lastState,
    lastStateAt: args.now,
  };
  if (args.lastActiveAt !== undefined) patch.lastActiveAt = args.lastActiveAt;
  if (args.resumedAt !== undefined) patch.resumedAt = args.resumedAt;
  await ctx.db.patch(existing._id, patch);
  const next = await ctx.db.get(existing._id);
  if (!next) throw new Error("computer missing after patch");
  return next;
}

export async function touchComputerActive(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; now: number },
): Promise<Doc<"computers">> {
  const existing = await computerByTenant(ctx, args.tenantId);
  if (!existing) throw new Error("computer not found");
  await ctx.db.patch(existing._id, { lastActiveAt: args.now });
  const next = await ctx.db.get(existing._id);
  if (!next) throw new Error("computer missing after patch");
  return next;
}

export async function deleteComputerForTenant(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
): Promise<boolean> {
  const existing = await computerByTenant(ctx, tenantId);
  if (!existing) return false;
  await ctx.db.delete(existing._id);
  return true;
}

export async function claimOrGetComputer(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    boxId?: string;
    size?: ComputerSize;
    lastState: string;
    now: number;
  },
): Promise<Doc<"computers">> {
  const existing = await computerByTenant(ctx, args.tenantId);
  if (existing) return existing;
  if (!args.boxId) throw new Error("boxId required to create computer");
  return await insertComputer(ctx, {
    tenantId: args.tenantId,
    boxId: args.boxId,
    size: args.size ?? DEFAULT_COMPUTER_SIZE,
    lastState: args.lastState,
    now: args.now,
  });
}
