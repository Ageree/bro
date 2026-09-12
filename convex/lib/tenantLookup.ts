import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** The one tenant row for a phone number, or null. Never inserts. */
export async function findTenantByPhone(
  ctx: QueryCtx | MutationCtx,
  phoneE164: string,
): Promise<Doc<"tenants"> | null> {
  return await ctx.db
    .query("tenants")
    .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
    .first();
}

/** The one tenant row for an Inkbox handle, or null. */
export async function findTenantByHandle(
  ctx: QueryCtx | MutationCtx,
  handle: string,
): Promise<Doc<"tenants"> | null> {
  return await ctx.db
    .query("tenants")
    .withIndex("by_handle", (q) => q.eq("inkboxHandle", handle))
    .unique();
}

/** Just the `_id`, for callers that never touch the rest of the row. */
export async function tenantIdByPhone(
  ctx: QueryCtx | MutationCtx,
  phoneE164: string,
): Promise<Id<"tenants"> | null> {
  const tenant = await findTenantByPhone(ctx, phoneE164);
  return tenant?._id ?? null;
}
