import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import schema from "../schema";

export const computerSize = schema.tables.computers.validator.fields.size;

export type ComputerSize = Infer<typeof computerSize>;

export const DEFAULT_COMPUTER_SIZE: ComputerSize = "small";
export const PENDING_COMPUTER_STATE = "pending";

async function computersForTenant(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
): Promise<Doc<"computers">[]> {
  const rows = await ctx.db
    .query("computers")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .collect();
  return rows.slice().sort((a, b) => a._creationTime - b._creationTime);
}

export async function computerByTenant(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
): Promise<Doc<"computers"> | null> {
  const rows = await computersForTenant(ctx, tenantId);
  return rows[0] ?? null;
}

async function keepOldestComputer(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
): Promise<Doc<"computers"> | null> {
  const rows = await computersForTenant(ctx, tenantId);
  const keep = rows[0];
  if (!keep) return null;
  for (const extra of rows.slice(1)) {
    await ctx.db.delete(extra._id);
  }
  return keep;
}

export async function insertComputer(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    boxId?: string;
    size: ComputerSize;
    lastState: string;
    now: number;
  },
): Promise<Doc<"computers">> {
  const existing = await keepOldestComputer(ctx, args.tenantId);
  if (existing) throw new Error("computer exists");
  const id = await ctx.db.insert("computers", {
    tenantId: args.tenantId,
    ...(args.boxId ? { boxId: args.boxId } : {}),
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
  const existing = await keepOldestComputer(ctx, args.tenantId);
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
  const existing = await keepOldestComputer(ctx, args.tenantId);
  if (!existing) throw new Error("computer not found");
  await ctx.db.patch(existing._id, { lastActiveAt: args.now });
  const next = await ctx.db.get(existing._id);
  if (!next) throw new Error("computer missing after patch");
  return next;
}

export async function deleteComputersForTenant(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
): Promise<boolean> {
  const rows = await computersForTenant(ctx, tenantId);
  if (rows.length === 0) return false;
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return true;
}

/** Lock the tenant document first so parallel claims OCC-retry onto one row. */
async function lockTenantForClaim(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  now: number,
): Promise<void> {
  const tenant = await ctx.db.get(tenantId);
  if (!tenant) throw new Error("tenant not found");
  await ctx.db.patch(tenantId, { computerLockAt: now });
}

/** Lock row first (no boxId). Bind the ASCII id later with bindBox. */
export async function claimOrGetComputer(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    size?: ComputerSize;
    now: number;
  },
): Promise<Doc<"computers">> {
  await lockTenantForClaim(ctx, args.tenantId, args.now);
  const existing = await keepOldestComputer(ctx, args.tenantId);
  if (existing) return existing;
  return await insertComputer(ctx, {
    tenantId: args.tenantId,
    size: args.size ?? DEFAULT_COMPUTER_SIZE,
    lastState: PENDING_COMPUTER_STATE,
    now: args.now,
  });
}

export async function bindComputerBox(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    boxId: string;
    lastState: string;
    now: number;
  },
): Promise<Doc<"computers">> {
  const existing = await keepOldestComputer(ctx, args.tenantId);
  if (!existing) throw new Error("computer not found");
  if (existing.boxId && existing.boxId !== args.boxId) {
    return existing;
  }
  await ctx.db.patch(existing._id, {
    boxId: args.boxId,
    lastState: args.lastState,
    lastStateAt: args.now,
    resumedAt: args.now,
  });
  const next = await ctx.db.get(existing._id);
  if (!next) throw new Error("computer missing after bind");
  return next;
}
