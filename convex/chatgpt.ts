import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertSecret } from "./secret";
import {
  nextLoginStatus,
  snapshotStatus,
  type ChatgptLoginStatus,
  type ChatgptLoginStatusInput,
  type ChatgptSnapshotStatus,
} from "./lib/chatgptPolicy";

const loginStatus = v.union(
  v.literal("pending"),
  v.literal("done"),
  v.literal("expired"),
  v.literal("failed"),
);

const snapshot = v.union(
  v.literal("none"),
  v.literal("pending"),
  v.literal("connected"),
  v.literal("quarantined"),
);

const statusResult = v.object({
  status: snapshot,
  email: v.optional(v.string()),
  planType: v.optional(v.string()),
  loginStatus: v.optional(loginStatus),
});

type ChatgptAccountRow = {
  _id: string;
  tenantId: Id<"tenants">;
  accountId?: string;
  email?: string;
  planType?: string;
  connectedAt: number;
  version: number;
  accessExpiresAt?: number;
  quarantinedAt?: number;
};

type ChatgptSecretRow = {
  _id: string;
  tenantId: Id<"tenants">;
  ciphertext: string;
  version: number;
  updatedAt: number;
};

type ChatgptLoginRow = {
  _id: string;
  tenantId: Id<"tenants">;
  deviceAuthId: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  status: ChatgptLoginStatusInput;
  createdAt?: number;
};

type Indexed<T> = {
  withIndex: (
    name: string,
    fn: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
  ) => {
    first: () => Promise<T | null>;
    collect: () => Promise<T[]>;
  };
};

type ChatgptDb = {
  query: (table: string) => Indexed<
    ChatgptAccountRow & ChatgptSecretRow & ChatgptLoginRow
  >;
  insert: (table: string, value: Record<string, unknown>) => Promise<string>;
  patch: (id: string, value: Record<string, unknown>) => Promise<void>;
  delete: (id: string) => Promise<void>;
};

function chatgptDb(ctx: { db: unknown }): ChatgptDb {
  return ctx.db as ChatgptDb;
}

function requireTenantId(tenantId: Id<"tenants">): Id<"tenants"> {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("tenantId required");
  }
  return tenantId;
}

function requirePhone(phoneE164: string): string {
  const phone = phoneE164.trim();
  if (!phone) throw new Error("phoneE164 required");
  return phone;
}

function requireVersion(version: number): number {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("version must be a non-negative integer");
  }
  return version;
}

async function tenantIdByPhone(
  ctx: QueryCtx | MutationCtx,
  phoneE164: string,
): Promise<Id<"tenants"> | null> {
  const tenant = await ctx.db
    .query("tenants")
    .withIndex("by_phone", (q) => q.eq("phoneE164", phoneE164))
    .first();
  return tenant?._id ?? null;
}

async function accountForTenant(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
): Promise<ChatgptAccountRow | null> {
  const rows = (await chatgptDb(ctx)
    .query("chatgptAccounts")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .collect()) as ChatgptAccountRow[];
  return rows.slice().sort((a, b) => a.connectedAt - b.connectedAt)[0] ?? null;
}

async function secretForTenantRow(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
): Promise<ChatgptSecretRow | null> {
  const rows = (await chatgptDb(ctx)
    .query("chatgptSecrets")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .collect()) as ChatgptSecretRow[];
  return rows.slice().sort((a, b) => a.updatedAt - b.updatedAt)[0] ?? null;
}

async function loginsForTenant(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
): Promise<ChatgptLoginRow[]> {
  return (await chatgptDb(ctx)
    .query("chatgptLogins")
    .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
    .collect()) as ChatgptLoginRow[];
}

function latestLogin(rows: ChatgptLoginRow[]): ChatgptLoginRow | undefined {
  return rows.slice().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

function statusFromRows(
  account: ChatgptAccountRow | null,
  login: ChatgptLoginRow | undefined,
  now?: number,
): {
  status: ChatgptSnapshotStatus;
  email?: string;
  planType?: string;
  loginStatus?: ChatgptLoginStatus;
} {
  const loginStatusValue =
    login === undefined
      ? undefined
      : now === undefined
        ? login.status === "authorized"
          ? "done"
          : login.status
        : nextLoginStatus({
            status: login.status,
            expiresAt: login.expiresAt,
            now,
          });
  const status = snapshotStatus({
    hasAccount: account !== null,
    quarantinedAt: account?.quarantinedAt,
    loginStatus: loginStatusValue,
  });
  return {
    status,
    ...(account?.email ? { email: account.email } : {}),
    ...(account?.planType ? { planType: account.planType } : {}),
    ...(loginStatusValue ? { loginStatus: loginStatusValue } : {}),
  };
}

export const statusForPhone = internalQuery({
  args: {
    phoneE164: v.string(),
    now: v.optional(v.number()),
  },
  returns: statusResult,
  handler: async (ctx, { phoneE164, now }) => {
    const phone = requirePhone(phoneE164);
    const tenantId = await tenantIdByPhone(ctx, phone);
    if (!tenantId) return { status: "none" as const };
    const [account, logins] = await Promise.all([
      accountForTenant(ctx, tenantId),
      loginsForTenant(ctx, tenantId),
    ]);
    return statusFromRows(account, latestLogin(logins), now);
  },
});

export const statusForAgent = query({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    now: v.optional(v.number()),
  },
  returns: statusResult,
  handler: async (ctx, { secret, phoneE164, now }) => {
    assertSecret(secret);
    const phone = requirePhone(phoneE164);
    const tenantId = await tenantIdByPhone(ctx, phone);
    if (!tenantId) return { status: "none" as const };
    const [account, logins] = await Promise.all([
      accountForTenant(ctx, tenantId),
      loginsForTenant(ctx, tenantId),
    ]);
    return statusFromRows(account, latestLogin(logins), now);
  },
});

export const startLogin = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    deviceAuthId: v.string(),
    userCode: v.string(),
    interval: v.number(),
    expiresAt: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const tenantId = requireTenantId(args.tenantId);
    const deviceAuthId = args.deviceAuthId.trim();
    const userCode = args.userCode.trim();
    if (!deviceAuthId) throw new Error("deviceAuthId required");
    if (!userCode) throw new Error("userCode required");
    if (!Number.isFinite(args.interval) || args.interval < 0) {
      throw new Error("interval must be >= 0");
    }
    if (!Number.isFinite(args.expiresAt) || !Number.isFinite(args.now)) {
      throw new Error("expiresAt and now must be finite");
    }
    const db = chatgptDb(ctx);
    const existing = await loginsForTenant(ctx, tenantId);
    for (const row of existing) {
      if (row.status === "pending") {
        await db.patch(row._id, { status: "expired" });
      }
    }
    await db.insert("chatgptLogins", {
      tenantId,
      deviceAuthId,
      userCode,
      interval: args.interval,
      expiresAt: args.expiresAt,
      status: "pending",
    });
    await scheduleDevicePoll(ctx, {
      tenantId,
      deviceAuthId,
      interval: args.interval,
      expiresAt: args.expiresAt,
    });
    return null;
  },
});

export const beginLoginForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    deviceAuthId: v.string(),
    userCode: v.string(),
    interval: v.number(),
    expiresAt: v.number(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const phone = requirePhone(args.phoneE164);
    const tenantId = await tenantIdByPhone(ctx, phone);
    if (!tenantId) return { ok: false as const, reason: "unknown tenant" };
    const deviceAuthId = args.deviceAuthId.trim();
    const userCode = args.userCode.trim();
    if (!deviceAuthId) throw new Error("deviceAuthId required");
    if (!userCode) throw new Error("userCode required");
    if (!Number.isFinite(args.interval) || args.interval < 0) {
      throw new Error("interval must be >= 0");
    }
    if (!Number.isFinite(args.expiresAt) || !Number.isFinite(args.now)) {
      throw new Error("expiresAt and now must be finite");
    }
    const db = chatgptDb(ctx);
    const existing = await loginsForTenant(ctx, tenantId);
    for (const row of existing) {
      if (row.status === "pending") {
        await db.patch(row._id, { status: "expired" });
      }
    }
    await db.insert("chatgptLogins", {
      tenantId,
      deviceAuthId,
      userCode,
      interval: args.interval,
      expiresAt: args.expiresAt,
      status: "pending",
    });
    await scheduleDevicePoll(ctx, {
      tenantId,
      deviceAuthId,
      interval: args.interval,
      expiresAt: args.expiresAt,
    });
    return { ok: true as const };
  },
});

async function scheduleDevicePoll(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    deviceAuthId: string;
    interval: number;
    expiresAt: number;
  },
): Promise<void> {
  const delay = Math.max(1000, Math.floor(args.interval * 1000));
  const poll = (
    internal as unknown as {
      chatgptSecrets: {
        pollDeviceLogin: FunctionReference<
          "action",
          "internal",
          {
            tenantId: Id<"tenants">;
            deviceAuthId: string;
            deadline: number;
          },
          null
        >;
      };
    }
  ).chatgptSecrets.pollDeviceLogin;
  await ctx.scheduler.runAfter(delay, poll, {
    tenantId: args.tenantId,
    deviceAuthId: args.deviceAuthId,
    deadline: args.expiresAt,
  });
}

async function setLoginStatus(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    deviceAuthId?: string;
    status: ChatgptLoginStatus;
  },
): Promise<boolean> {
  const tenantId = requireTenantId(args.tenantId);
  const rows = await loginsForTenant(ctx, tenantId);
  const row = args.deviceAuthId
    ? rows.find((item) => item.deviceAuthId === args.deviceAuthId)
    : rows.find((item) => item.status === "pending") ?? latestLogin(rows);
  if (!row) return false;
  await chatgptDb(ctx).patch(row._id, { status: args.status });
  return true;
}

export const finishLogin = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    deviceAuthId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    return await setLoginStatus(ctx, {
      tenantId: args.tenantId,
      deviceAuthId: args.deviceAuthId,
      status: "done",
    });
  },
});

export const expireLogin = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    deviceAuthId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    return await setLoginStatus(ctx, {
      tenantId: args.tenantId,
      deviceAuthId: args.deviceAuthId,
      status: "expired",
    });
  },
});

export const failLogin = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    deviceAuthId: v.optional(v.string()),
    now: v.number(),
    reason: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    return await setLoginStatus(ctx, {
      tenantId: args.tenantId,
      deviceAuthId: args.deviceAuthId,
      status: "failed",
    });
  },
});

export const upsertAccount = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    accountId: v.optional(v.string()),
    email: v.optional(v.string()),
    planType: v.optional(v.string()),
    version: v.number(),
    accessExpiresAt: v.optional(v.number()),
    now: v.number(),
  },
  returns: v.object({
    ok: v.boolean(),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const tenantId = requireTenantId(args.tenantId);
    const version = requireVersion(args.version);
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    const existing = await accountForTenant(ctx, tenantId);
    if (existing && existing.version !== version - 1) {
      return { ok: false, version: existing.version };
    }
    const accountId = args.accountId?.trim() || existing?.accountId;
    if (!accountId) throw new Error("accountId required");
    const fields = {
      tenantId,
      accountId,
      version,
      connectedAt: existing?.connectedAt ?? args.now,
      ...(args.email !== undefined ? { email: args.email } : {}),
      ...(args.planType !== undefined ? { planType: args.planType } : {}),
      ...(args.accessExpiresAt !== undefined
        ? { accessExpiresAt: args.accessExpiresAt }
        : {}),
      quarantinedAt: undefined,
    };
    const db = chatgptDb(ctx);
    if (!existing) {
      await db.insert("chatgptAccounts", fields);
    } else {
      await db.patch(existing._id, fields);
    }
    return { ok: true, version };
  },
});

export const quarantine = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    now: v.number(),
    reason: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const tenantId = requireTenantId(args.tenantId);
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    if (!args.reason.trim()) throw new Error("reason required");
    const existing = await accountForTenant(ctx, tenantId);
    if (!existing) return false;
    await chatgptDb(ctx).patch(existing._id, { quarantinedAt: args.now });
    return true;
  },
});

export const clearAccount = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    const id = requireTenantId(tenantId);
    const db = chatgptDb(ctx);
    const [account, secret, logins] = await Promise.all([
      accountForTenant(ctx, id),
      secretForTenantRow(ctx, id),
      loginsForTenant(ctx, id),
    ]);
    if (account) await db.delete(account._id);
    if (secret) await db.delete(secret._id);
    for (const login of logins) await db.delete(login._id);
    return null;
  },
});

export const secretForTenant = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.union(
    v.object({
      ciphertext: v.string(),
      version: v.number(),
      accessExpiresAt: v.optional(v.number()),
      accountId: v.optional(v.string()),
      quarantinedAt: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, { tenantId }) => {
    const id = requireTenantId(tenantId);
    const [secret, account] = await Promise.all([
      secretForTenantRow(ctx, id),
      accountForTenant(ctx, id),
    ]);
    if (!secret) return null;
    return {
      ciphertext: secret.ciphertext,
      version: secret.version,
      ...(account?.accessExpiresAt !== undefined
        ? { accessExpiresAt: account.accessExpiresAt }
        : {}),
      ...(account?.accountId ? { accountId: account.accountId } : {}),
      ...(account?.quarantinedAt !== undefined
        ? { quarantinedAt: account.quarantinedAt }
        : {}),
    };
  },
});

export const putSecret = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    ciphertext: v.string(),
    version: v.number(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean(), version: v.number() }),
  handler: async (ctx, args) => {
    const tenantId = requireTenantId(args.tenantId);
    const version = requireVersion(args.version);
    if (!args.ciphertext.trim()) throw new Error("ciphertext required");
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    const existing = await secretForTenantRow(ctx, tenantId);
    if (existing && existing.version !== version - 1) {
      return { ok: false, version: existing.version };
    }
    const db = chatgptDb(ctx);
    if (!existing) {
      await db.insert("chatgptSecrets", {
        tenantId,
        ciphertext: args.ciphertext,
        version,
        updatedAt: args.now,
      });
    } else {
      await db.patch(existing._id, {
        ciphertext: args.ciphertext,
        version,
        updatedAt: args.now,
      });
    }
    return { ok: true, version };
  },
});

export const deleteSecretsForTenant = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.boolean(),
  handler: async (ctx, { tenantId }) => {
    const id = requireTenantId(tenantId);
    const secret = await secretForTenantRow(ctx, id);
    if (!secret) return false;
    await chatgptDb(ctx).delete(secret._id);
    return true;
  },
});

export const loginByDeviceAuthId = internalQuery({
  args: { deviceAuthId: v.string() },
  returns: v.union(
    v.object({
      tenantId: v.id("tenants"),
      deviceAuthId: v.string(),
      userCode: v.string(),
      interval: v.number(),
      expiresAt: v.number(),
      status: loginStatus,
    }),
    v.null(),
  ),
  handler: async (ctx, { deviceAuthId }) => {
    const id = deviceAuthId.trim();
    if (!id) throw new Error("deviceAuthId required");
    const rows = (await chatgptDb(ctx)
      .query("chatgptLogins")
      .withIndex("by_deviceAuthId", (q) => q.eq("deviceAuthId", id))
      .collect()) as ChatgptLoginRow[];
    const row = rows[0];
    if (!row) return null;
    const rawStatus = row.status as ChatgptLoginStatusInput;
    const status: ChatgptLoginStatus =
      rawStatus === "authorized" ? "done" : rawStatus;
    return {
      tenantId: row.tenantId,
      deviceAuthId: row.deviceAuthId,
      userCode: row.userCode,
      interval: row.interval,
      expiresAt: row.expiresAt,
      status,
    };
  },
});

export const quarantineForAgent = mutation({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    now: v.number(),
    reason: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertSecret(args.secret);
    const tenantId = await tenantIdByPhone(ctx, requirePhone(args.phoneE164));
    if (!tenantId) return false;
    const existing = await accountForTenant(ctx, tenantId);
    if (!existing) return false;
    if (!args.reason.trim()) throw new Error("reason required");
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    await chatgptDb(ctx).patch(existing._id, {
      quarantinedAt: args.now,
      quarantineReason: args.reason.trim(),
    });
    return true;
  },
});

export const accountForAgent = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.union(
    v.object({
      version: v.number(),
      accountId: v.optional(v.string()),
      accessExpiresAt: v.optional(v.number()),
      quarantinedAt: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, { tenantId }) => {
    const account = await accountForTenant(ctx, requireTenantId(tenantId));
    if (!account) return null;
    return {
      version: account.version,
      ...(account.accountId ? { accountId: account.accountId } : {}),
      ...(account.accessExpiresAt !== undefined
        ? { accessExpiresAt: account.accessExpiresAt }
        : {}),
      ...(account.quarantinedAt !== undefined
        ? { quarantinedAt: account.quarantinedAt }
        : {}),
    };
  },
});
