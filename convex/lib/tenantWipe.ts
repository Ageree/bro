import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { findTenantByHandle, findTenantByPhone } from "./tenantLookup";
import { unscheduleCron } from "./wakeupCrons";
import { wipeDecision, wipeRefuseMessage, type WipeRefuse } from "./wipePolicy";

const PAGE = 64;

export type WipeCounts = {
  tenant: number;
  jobs: number;
  orders: number;
  sessions: number;
  payments: number;
  vaultItems: number;
  vaultSecrets: number;
  browserCharges: number;
  browserSessions: number;
  files: number;
  wakeups: number;
  watchers: number;
  loginChallenges: number;
};

export const emptyWipeCounts = (): WipeCounts => ({
  tenant: 0,
  jobs: 0,
  orders: 0,
  sessions: 0,
  payments: 0,
  vaultItems: 0,
  vaultSecrets: 0,
  browserCharges: 0,
  browserSessions: 0,
  files: 0,
  wakeups: 0,
  watchers: 0,
  loginChallenges: 0,
});

type TenantChildTable =
  | "jobs"
  | "orders"
  | "sessions"
  | "payments"
  | "vaultItems"
  | "vaultSecrets"
  | "browserCharges"
  | "browserSessions";

const TENANT_CHILD_TABLES: readonly TenantChildTable[] = [
  "jobs",
  "orders",
  "sessions",
  "payments",
  "vaultItems",
  "vaultSecrets",
  "browserCharges",
  "browserSessions",
];

export type ResolvedWipeTenant =
  | { ok: true; tenant: Doc<"tenants"> }
  | { ok: false; reason: WipeRefuse };

export async function resolveWipeTenant(
  ctx: QueryCtx | MutationCtx,
  phoneE164: string,
  handle: string,
): Promise<ResolvedWipeTenant> {
  const tenant = await findTenantByPhone(ctx, phoneE164);
  const byHandle = await findTenantByHandle(ctx, handle);
  const decision = wipeDecision({
    phoneE164,
    handle,
    tenant,
    handleTenantId: byHandle?._id ?? null,
  });
  if (!decision.ok || !tenant) return { ok: false, reason: decision.ok ? "missing" : decision.reason };
  return { ok: true, tenant };
}

async function takeByTenant(
  ctx: QueryCtx | MutationCtx,
  table: TenantChildTable,
  tenantId: Id<"tenants">,
): Promise<{ _id: Id<TenantChildTable> }[]> {
  return await ctx.db
    .query(table)
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .take(PAGE);
}

async function countByTenant(
  ctx: QueryCtx | MutationCtx,
  table: TenantChildTable,
  tenantId: Id<"tenants">,
): Promise<number> {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .take(PAGE * 16);
  return rows.length;
}

export type WipePreview = {
  tenantId: Id<"tenants">;
  phoneE164: string;
  handle: string;
  hasBrowserProfile: boolean;
  hasPhotonConversation: boolean;
  hasInkboxConversation: boolean;
  hasTelegram: boolean;
  counts: WipeCounts;
};

async function countFiles(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
): Promise<number> {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .take(PAGE * 16);
  return rows.length;
}

async function countWakeups(
  ctx: QueryCtx | MutationCtx,
  phone: string,
): Promise<number> {
  const rows = await ctx.db
    .query("wakeups")
    .withIndex("by_tenant", (q) => q.eq("tenantPhone", phone))
    .take(PAGE * 16);
  return rows.length;
}

async function countWatchers(
  ctx: QueryCtx | MutationCtx,
  phone: string,
): Promise<number> {
  const rows = await ctx.db
    .query("watchers")
    .withIndex("by_tenant", (q) => q.eq("tenantPhone", phone))
    .take(PAGE * 16);
  return rows.length;
}

async function countChallenges(
  ctx: QueryCtx | MutationCtx,
  handle: string,
): Promise<number> {
  const rows = await ctx.db
    .query("loginChallenges")
    .withIndex("by_handle", (q) => q.eq("handle", handle))
    .take(8);
  return rows.length;
}

export async function previewTenantWipe(
  ctx: QueryCtx | MutationCtx,
  tenant: Doc<"tenants">,
): Promise<WipePreview> {
  const phone = tenant.phoneE164;
  const handle = tenant.inkboxHandle;
  if (!phone || !handle) throw new Error(wipeRefuseMessage("mismatch"));
  const counts = emptyWipeCounts();
  counts.tenant = 1;
  for (const table of TENANT_CHILD_TABLES) {
    counts[table] = await countByTenant(ctx, table, tenant._id);
  }
  counts.files = await countFiles(ctx, tenant._id);
  counts.wakeups = await countWakeups(ctx, phone);
  counts.watchers = await countWatchers(ctx, phone);
  counts.loginChallenges = await countChallenges(ctx, handle);
  return {
    tenantId: tenant._id,
    phoneE164: phone,
    handle,
    hasBrowserProfile: Boolean(tenant.browserProfileId),
    hasPhotonConversation: Boolean(tenant.photonConversationId),
    hasInkboxConversation: Boolean(tenant.inkboxConversationId),
    hasTelegram: Boolean(tenant.telegramUserId),
    counts,
  };
}

async function deleteTenantChildren(
  ctx: MutationCtx,
  table: TenantChildTable,
  tenantId: Id<"tenants">,
): Promise<number> {
  let n = 0;
  for (;;) {
    const rows = await takeByTenant(ctx, table, tenantId);
    if (rows.length === 0) break;
    for (const row of rows) {
      await ctx.db.delete(row._id);
      n++;
    }
  }
  return n;
}

async function deleteFiles(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
): Promise<number> {
  let n = 0;
  for (;;) {
    const rows = await ctx.db
      .query("files")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .take(PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
      n++;
    }
  }
  return n;
}

async function deleteWakeups(ctx: MutationCtx, phone: string): Promise<number> {
  let n = 0;
  for (;;) {
    const rows = await ctx.db
      .query("wakeups")
      .withIndex("by_tenant", (q) => q.eq("tenantPhone", phone))
      .take(PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      await unscheduleCron(ctx, row._id);
      await ctx.db.delete(row._id);
      n++;
    }
  }
  return n;
}

async function deleteWatchers(ctx: MutationCtx, phone: string): Promise<number> {
  let n = 0;
  for (;;) {
    const rows = await ctx.db
      .query("watchers")
      .withIndex("by_tenant", (q) => q.eq("tenantPhone", phone))
      .take(PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      await ctx.db.delete(row._id);
      n++;
    }
  }
  return n;
}

async function deleteChallenges(ctx: MutationCtx, handle: string): Promise<number> {
  let n = 0;
  for (;;) {
    const rows = await ctx.db
      .query("loginChallenges")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .take(8);
    if (rows.length === 0) break;
    for (const row of rows) {
      await ctx.db.delete(row._id);
      n++;
    }
  }
  return n;
}

export async function deleteTenantWipeTargets(
  ctx: MutationCtx,
  tenant: Doc<"tenants">,
): Promise<WipeCounts> {
  const phone = tenant.phoneE164;
  const handle = tenant.inkboxHandle;
  if (!phone || !handle) {
    throw new Error(wipeRefuseMessage("mismatch"));
  }
  const counts = emptyWipeCounts();
  for (const table of TENANT_CHILD_TABLES) {
    counts[table] = await deleteTenantChildren(ctx, table, tenant._id);
  }
  counts.files = await deleteFiles(ctx, tenant._id);
  counts.wakeups = await deleteWakeups(ctx, phone);
  counts.watchers = await deleteWatchers(ctx, phone);
  counts.loginChallenges = await deleteChallenges(ctx, handle);
  await ctx.db.delete(tenant._id);
  counts.tenant = 1;
  return counts;
}
