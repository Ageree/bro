import type { Id, Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
export { tenantIdByPhone } from "./tenantLookup.ts";

export const FILE_LIST_LIMIT = 100;
export const FILE_NAME_MAX = 200;
export const FILE_TEXT_WRITE_MAX = 256 * 1024;
export const FILE_TEXT_READ_MAX = 64 * 1024;
export const FILE_BINARY_MAX = 8 * 1024 * 1024;

export type FileSourceChannel = "imessage" | "telegram" | "sandbox" | "agent";

export type FileListItem = {
  id: Id<"files">;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  sourceChannel?: FileSourceChannel;
};

export function sanitizeFileName(raw: string): string {
  const base = raw.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\0\n\r]/g, "").slice(0, FILE_NAME_MAX).trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("invalid file name");
  }
  if (cleaned.includes("..") || cleaned.includes("/") || cleaned.includes("\\")) {
    throw new Error("invalid file name");
  }
  return cleaned;
}

export function listedFile(row: Doc<"files">): FileListItem {
  return {
    id: row._id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    ...(row.sourceChannel ? { sourceChannel: row.sourceChannel } : {}),
  };
}

export async function listFilesForTenant(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
): Promise<Doc<"files">[]> {
  return await ctx.db
    .query("files")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .order("desc")
    .take(FILE_LIST_LIMIT);
}

export async function fileByTenantAndName(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  name: string,
): Promise<Doc<"files"> | null> {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_tenant_and_name", (q) =>
      q.eq("tenantId", tenantId).eq("name", name),
    )
    .take(8);
  return rows[0] ?? null;
}

export async function fileByIdForTenant(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  fileId: Id<"files">,
): Promise<Doc<"files"> | null> {
  const row = await ctx.db.get(fileId);
  if (!row || row.tenantId !== tenantId) return null;
  return row;
}

export async function upsertFile(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    storageId: Id<"_storage">;
    name: string;
    mimeType: string;
    size: number;
    createdAt: number;
    sourceChannel?: FileSourceChannel;
  },
): Promise<Doc<"files">> {
  const name = sanitizeFileName(args.name);
  if (!Number.isFinite(args.size) || args.size < 0) {
    throw new Error("size must be a non-negative number");
  }
  if (args.size > FILE_BINARY_MAX) {
    throw new Error("file exceeds 8MB");
  }
  const mimeType = args.mimeType.trim() || "application/octet-stream";
  const existing = await fileByTenantAndName(ctx, args.tenantId, name);
  if (existing) {
    const previous = existing.storageId;
    await ctx.db.patch(existing._id, {
      storageId: args.storageId,
      mimeType,
      size: args.size,
      createdAt: args.createdAt,
      ...(args.sourceChannel ? { sourceChannel: args.sourceChannel } : {}),
    });
    if (previous !== args.storageId) {
      await ctx.storage.delete(previous);
    }
    const updated = await ctx.db.get(existing._id);
    if (!updated) throw new Error("file update vanished");
    return updated;
  }
  const id = await ctx.db.insert("files", {
    tenantId: args.tenantId,
    storageId: args.storageId,
    name,
    mimeType,
    size: args.size,
    createdAt: args.createdAt,
    ...(args.sourceChannel ? { sourceChannel: args.sourceChannel } : {}),
  });
  const created = await ctx.db.get(id);
  if (!created) throw new Error("file insert vanished");
  return created;
}

export async function deleteFileForTenant(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  fileId: Id<"files">,
): Promise<boolean> {
  const row = await fileByIdForTenant(ctx, tenantId, fileId);
  if (!row) return false;
  await ctx.storage.delete(row.storageId);
  await ctx.db.delete(row._id);
  return true;
}

export async function deleteFileByName(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  name: string,
): Promise<boolean> {
  const row = await fileByTenantAndName(ctx, tenantId, sanitizeFileName(name));
  if (!row) return false;
  return await deleteFileForTenant(ctx, tenantId, row._id);
}
