import { v } from "convex/values";
import { internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertSecret } from "./secret";

const vaultKind = v.union(
  v.literal("login"),
  v.literal("payment"),
  v.literal("address"),
  v.literal("contact"),
);

const listedItem = v.object({
  handle: v.string(),
  kind: vaultKind,
  label: v.string(),
  account: v.string(),
  origin: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  available: v.boolean(),
});

const listedItemForAgent = v.object({
  handle: v.string(),
  kind: vaultKind,
  label: v.string(),
  account: v.string(),
  origin: v.optional(v.string()),
  available: v.boolean(),
});

const itemFields = v.object({
  tenantId: v.id("tenants"),
  handle: v.string(),
  kind: vaultKind,
  label: v.string(),
  account: v.string(),
  origin: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

async function tenantIdByPhone(
  ctx: QueryCtx,
  phoneE164: string,
): Promise<Id<"tenants"> | null> {
  const tenant = await ctx.db
    .query("tenants")
    .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
    .first();
  return tenant?._id ?? null;
}

async function listItemsForTenant(ctx: QueryCtx, tenantId: Id<"tenants">) {
  // One person's saved credentials: bounded by hand, never paginated.
  const items = await ctx.db
    .query("vaultItems")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .collect();
  const secrets = await ctx.db
    .query("vaultSecrets")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .collect();
  const available = new Set(secrets.map((row) => row.handle));
  return items
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((row) => ({
      handle: row.handle,
      kind: row.kind,
      label: row.label,
      account: row.account,
      origin: row.origin,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      available: available.has(row.handle),
    }));
}

export const listItems = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.array(listedItem),
  handler: async (ctx, { tenantId }) => {
    return await listItemsForTenant(ctx, tenantId);
  },
});

export const itemByHandle = internalQuery({
  args: { tenantId: v.id("tenants"), handle: v.string() },
  returns: v.union(itemFields, v.null()),
  handler: async (ctx, { tenantId, handle }) => {
    const row = await ctx.db
      .query("vaultItems")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (!row || row.tenantId !== tenantId) return null;
    return {
      tenantId: row.tenantId,
      handle: row.handle,
      kind: row.kind,
      label: row.label,
      account: row.account,
      origin: row.origin,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
});

export const ciphertextByHandle = internalQuery({
  args: { tenantId: v.id("tenants"), handle: v.string() },
  returns: v.union(v.object({ ciphertext: v.string() }), v.null()),
  handler: async (ctx, { tenantId, handle }) => {
    const row = await ctx.db
      .query("vaultSecrets")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (!row || row.tenantId !== tenantId) return null;
    return { ciphertext: row.ciphertext };
  },
});

export const insertItem = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    handle: v.string(),
    kind: vaultKind,
    label: v.string(),
    account: v.string(),
    origin: v.optional(v.string()),
    ciphertext: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vaultItems")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .unique();
    if (existing) throw new Error("handle exists");
    await ctx.db.insert("vaultItems", {
      tenantId: args.tenantId,
      handle: args.handle,
      kind: args.kind,
      label: args.label,
      account: args.account,
      createdAt: args.now,
      updatedAt: args.now,
      ...(args.origin ? { origin: args.origin } : {}),
    });
    await ctx.db.insert("vaultSecrets", {
      tenantId: args.tenantId,
      handle: args.handle,
      ciphertext: args.ciphertext,
      updatedAt: args.now,
    });
    return null;
  },
});

export const deleteItemByHandle = internalMutation({
  args: { tenantId: v.id("tenants"), handle: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { tenantId, handle }) => {
    const item = await ctx.db
      .query("vaultItems")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    const secretRow = await ctx.db
      .query("vaultSecrets")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    let deleted = false;
    if (item && item.tenantId === tenantId) {
      await ctx.db.delete(item._id);
      deleted = true;
    }
    if (secretRow && secretRow.tenantId === tenantId) {
      await ctx.db.delete(secretRow._id);
      deleted = true;
    }
    return deleted;
  },
});

export const tenantIdForPhone = internalQuery({
  args: { phoneE164: v.string() },
  returns: v.union(v.id("tenants"), v.null()),
  handler: async (ctx, { phoneE164 }) => {
    return await tenantIdByPhone(ctx, phoneE164);
  },
});

export const listForAgent = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.array(listedItemForAgent),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const tenantId = await tenantIdByPhone(ctx, phoneE164);
    if (!tenantId) return [];
    const rows = await listItemsForTenant(ctx, tenantId);
    return rows.map((row) => ({
      handle: row.handle,
      kind: row.kind,
      label: row.label,
      account: row.account,
      origin: row.origin,
      available: row.available,
    }));
  },
});
