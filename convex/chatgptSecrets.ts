"use node";

import { v, type Infer } from "convex/values";
import type { FunctionReference } from "convex/server";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertSecret } from "./secret";
import {
  decryptVaultSecret,
  encryptVaultSecret,
  vaultMasterKey,
} from "../shared/vaultCrypto";
import { shouldRefresh } from "./lib/chatgptPolicy";
import {
  CHATGPT_OAUTH_HANDLE,
  parseChatgptOAuthJson,
  refreshChatgptAccessToken,
} from "../agent/lib/chatgpt-oauth";

const tokenResult = v.union(
  v.object({
    status: v.literal("connected"),
    accessToken: v.string(),
    accountId: v.optional(v.string()),
    accessExpiresAt: v.optional(v.number()),
  }),
  v.object({ status: v.literal("none") }),
  v.object({ status: v.literal("quarantined") }),
);

type TokenResult = Infer<typeof tokenResult>;

type ChatgptInternal = {
  secretForTenant: FunctionReference<
    "query",
    "internal",
    { tenantId: Id<"tenants"> },
    {
      ciphertext: string;
      version: number;
      accessExpiresAt?: number;
      accountId?: string;
      quarantinedAt?: number;
    } | null
  >;
  putSecret: FunctionReference<
    "mutation",
    "internal",
    {
      tenantId: Id<"tenants">;
      ciphertext: string;
      version: number;
      now: number;
    },
    { ok: boolean; version: number }
  >;
  upsertAccount: FunctionReference<
    "mutation",
    "internal",
    {
      tenantId: Id<"tenants">;
      accountId?: string;
      email?: string;
      planType?: string;
      version: number;
      accessExpiresAt?: number;
      now: number;
    },
    { ok: boolean; version: number }
  >;
  quarantine: FunctionReference<
    "mutation",
    "internal",
    { tenantId: Id<"tenants">; now: number; reason: string },
    boolean
  >;
  clearAccount: FunctionReference<
    "mutation",
    "internal",
    { tenantId: Id<"tenants"> },
    null
  >;
};

function chatgptInternal(): ChatgptInternal {
  return (internal as unknown as { chatgpt: ChatgptInternal }).chatgpt;
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

function requireJson(json: string): string {
  const text = json.trim();
  if (!text) throw new Error("json required");
  parseChatgptOAuthJson(text);
  return text;
}

async function tenantIdForPhone(
  ctx: { runQuery: (ref: typeof internal.vault.tenantIdForPhone, args: { phoneE164: string }) => Promise<Id<"tenants"> | null> },
  phoneE164: string,
): Promise<Id<"tenants"> | null> {
  return await ctx.runQuery(internal.vault.tenantIdForPhone, { phoneE164 });
}

export const saveTokens = internalAction({
  args: {
    tenantId: v.id("tenants"),
    json: v.string(),
    version: v.number(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean(), version: v.number() }),
  handler: async (ctx, args) => {
    const tenantId = requireTenantId(args.tenantId);
    const version = requireVersion(args.version);
    if (!Number.isFinite(args.now)) throw new Error("now must be finite");
    const json = requireJson(args.json);
    const tokens = parseChatgptOAuthJson(json);
    const ciphertext = encryptVaultSecret(
      vaultMasterKey(),
      tenantId,
      CHATGPT_OAUTH_HANDLE,
      json,
    );
    const api = chatgptInternal();
    const stored = await ctx.runMutation(api.putSecret, {
      tenantId,
      ciphertext,
      version,
      now: args.now,
    });
    if (stored.ok) {
      await ctx.runMutation(api.upsertAccount, {
        tenantId,
        version,
        now: args.now,
        ...(tokens.account_id ? { accountId: tokens.account_id } : {}),
        accessExpiresAt: tokens.expires_at,
      });
    }
    return stored;
  },
});

export const tokenForAgent = action({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
    forceRefresh: v.optional(v.boolean()),
  },
  returns: tokenResult,
  handler: async (ctx, { secret, phoneE164, forceRefresh }): Promise<TokenResult> => {
    assertSecret(secret);
    const phone = requirePhone(phoneE164);
    const tenantId = await tenantIdForPhone(ctx, phone);
    if (!tenantId) return { status: "none" };
    const api = chatgptInternal();
    const stored = await ctx.runQuery(api.secretForTenant, { tenantId });
    if (!stored) return { status: "none" };
    if (stored.quarantinedAt != null) return { status: "quarantined" };
    const plaintext = decryptVaultSecret(
      vaultMasterKey(),
      tenantId,
      CHATGPT_OAUTH_HANDLE,
      stored.ciphertext,
    );
    let tokens = parseChatgptOAuthJson(plaintext);
    const now = Date.now();
    const expiresAt = stored.accessExpiresAt ?? tokens.expires_at;
    if (forceRefresh === true || shouldRefresh(expiresAt, now)) {
      const refreshed = await refreshChatgptAccessToken({
        refreshToken: tokens.refresh_token,
        now,
      });
      if (!refreshed.ok) {
        if (refreshed.invalidGrant) {
          await ctx.runMutation(api.quarantine, {
            tenantId,
            now,
            reason: "invalid_grant",
          });
          return { status: "quarantined" };
        }
        throw new Error(refreshed.message);
      }
      tokens = refreshed.tokens;
      const nextVersion = stored.version + 1;
      const json = JSON.stringify(tokens);
      const ciphertext = encryptVaultSecret(
        vaultMasterKey(),
        tenantId,
        CHATGPT_OAUTH_HANDLE,
        json,
      );
      const cas = await ctx.runMutation(api.putSecret, {
        tenantId,
        ciphertext,
        version: nextVersion,
        now,
      });
      if (cas.ok) {
        await ctx.runMutation(api.upsertAccount, {
          tenantId,
          version: nextVersion,
          now,
          ...(tokens.account_id ? { accountId: tokens.account_id } : {}),
          accessExpiresAt: tokens.expires_at,
        });
      }
    }
    return {
      status: "connected",
      accessToken: tokens.access_token,
      ...(tokens.account_id ? { accountId: tokens.account_id } : {}),
      accessExpiresAt: tokens.expires_at,
    };
  },
});

export const disconnect = action({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
  },
  returns: v.object({
    status: v.union(v.literal("ok"), v.literal("none")),
  }),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const phone = requirePhone(phoneE164);
    const tenantId = await tenantIdForPhone(ctx, phone);
    if (!tenantId) return { status: "none" as const };
    const api = chatgptInternal();
    const stored = await ctx.runQuery(api.secretForTenant, { tenantId });
    await ctx.runMutation(api.clearAccount, { tenantId });
    return { status: stored ? ("ok" as const) : ("none" as const) };
  },
});
