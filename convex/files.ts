import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertSecret } from "./secret";
import {
  deleteFileByName,
  deleteFileForTenant,
  fileByIdForTenant,
  fileByTenantAndName,
  FILE_BINARY_MAX,
  listedFile,
  listFilesForTenant,
  tenantIdByPhone,
  upsertFile,
  type FileListItem,
} from "./lib/fileStore";
import { requirePhone } from "./lib/chatgptPolicy";

const sourceChannel = v.union(
  v.literal("imessage"),
  v.literal("telegram"),
  v.literal("sandbox"),
  v.literal("agent"),
);

const listedFileValidator = v.object({
  id: v.id("files"),
  name: v.string(),
  mimeType: v.string(),
  size: v.number(),
  createdAt: v.number(),
  sourceChannel: v.optional(sourceChannel),
});

const fileWithUrl = v.object({
  id: v.id("files"),
  name: v.string(),
  mimeType: v.string(),
  size: v.number(),
  createdAt: v.number(),
  sourceChannel: v.optional(sourceChannel),
  url: v.union(v.string(), v.null()),
});

export const tenantIdInternal = internalQuery({
  args: { phoneE164: v.string() },
  returns: v.union(v.id("tenants"), v.null()),
  handler: async (ctx, args) => tenantIdByPhone(ctx, requirePhone(args.phoneE164)),
});

export const saveInternal = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    sourceChannel: v.optional(sourceChannel),
    now: v.number(),
  },
  returns: listedFileValidator,
  handler: async (ctx, args) => {
    const row = await upsertFile(ctx, {
      tenantId: args.tenantId,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      createdAt: args.now,
      sourceChannel: args.sourceChannel,
    });
    return listedFile(row);
  },
});

export const listForAgent = query({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.array(listedFileValidator),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantIdByPhone(ctx, requirePhone(args.phoneE164));
    if (!tenantId) return [];
    const rows = await listFilesForTenant(ctx, tenantId);
    return rows.map(listedFile);
  },
});

export const getForAgent = query({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    fileId: v.optional(v.id("files")),
    name: v.optional(v.string()),
  },
  returns: v.union(fileWithUrl, v.null()),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantIdByPhone(ctx, requirePhone(args.phoneE164));
    if (!tenantId) return null;
    const row = args.fileId
      ? await fileByIdForTenant(ctx, tenantId, args.fileId)
      : args.name
        ? await fileByTenantAndName(ctx, tenantId, args.name.trim().split("/").pop() ?? args.name)
        : null;
    if (!row) return null;
    const url = await ctx.storage.getUrl(row.storageId);
    return { ...listedFile(row), url };
  },
});

export const generateUploadUrlForAgent = mutation({
  args: { secret: v.string(), phoneE164: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantIdByPhone(ctx, requirePhone(args.phoneE164));
    if (!tenantId) return null;
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    sourceChannel: v.optional(sourceChannel),
    now: v.number(),
  },
  returns: v.union(listedFileValidator, v.null()),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    const tenantId = await tenantIdByPhone(ctx, requirePhone(args.phoneE164));
    if (!tenantId) return null;
    const row = await upsertFile(ctx, {
      tenantId,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      createdAt: args.now,
      sourceChannel: args.sourceChannel,
    });
    return listedFile(row);
  },
});

export const deleteForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    fileId: v.optional(v.id("files")),
    name: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantIdByPhone(ctx, requirePhone(args.phoneE164));
    if (!tenantId) return false;
    if (args.fileId) return await deleteFileForTenant(ctx, tenantId, args.fileId);
    if (args.name) return await deleteFileByName(ctx, tenantId, args.name);
    throw new Error("fileId or name required");
  },
});

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const storeBytesForAgent = action({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    name: v.string(),
    mimeType: v.string(),
    bytesBase64: v.string(),
    sourceChannel: v.optional(sourceChannel),
    now: v.number(),
  },
  returns: v.union(listedFileValidator, v.null()),
  handler: async (ctx, args): Promise<FileListItem | null> => {
    assertSecret(args.secret);
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    const bytes = bytesFromBase64(args.bytesBase64);
    if (bytes.byteLength > FILE_BINARY_MAX) throw new Error("file exceeds 8MB");
    const tenantId: Id<"tenants"> | null = await ctx.runQuery(
      internal.files.tenantIdInternal,
      { phoneE164: requirePhone(args.phoneE164) },
    );
    if (!tenantId) return null;
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const blob = new Blob([copy], {
      type: args.mimeType.trim() || "application/octet-stream",
    });
    const storageId = await ctx.storage.store(blob);
    const saved: FileListItem = await ctx.runMutation(internal.files.saveInternal, {
      tenantId,
      storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: bytes.byteLength,
      sourceChannel: args.sourceChannel,
      now: args.now,
    });
    return saved;
  },
});
