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
import {
  requirePhone,
  requireTenantId,
  requireVersion,
  shouldRefresh,
} from "./lib/chatgptPolicy";
import {
  CHATGPT_OAUTH_HANDLE,
  accountIdFromJwt,
  exchangeDeviceCode,
  parseChatgptOAuthJson,
  pollDeviceAuth,
  refreshChatgptAccessToken,
  startDeviceAuth,
} from "../agent/lib/chatgpt-oauth";
import { devicePollSleepMs } from "./lib/chatgptPolicy";

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

type ChatgptApi = {
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
  loginByDeviceAuthId: FunctionReference<
    "query",
    "internal",
    { deviceAuthId: string },
    {
      tenantId: Id<"tenants">;
      deviceAuthId: string;
      userCode: string;
      interval: number;
      expiresAt: number;
      status: "pending" | "done" | "expired" | "failed";
    } | null
  >;
  finishLogin: FunctionReference<
    "mutation",
    "internal",
    { tenantId: Id<"tenants">; deviceAuthId?: string; now: number },
    boolean
  >;
  expireLogin: FunctionReference<
    "mutation",
    "internal",
    { tenantId: Id<"tenants">; deviceAuthId?: string; now: number },
    boolean
  >;
  failLogin: FunctionReference<
    "mutation",
    "internal",
    {
      tenantId: Id<"tenants">;
      deviceAuthId?: string;
      now: number;
      reason?: string;
    },
    boolean
  >;
  startLogin: FunctionReference<
    "mutation",
    "internal",
    {
      tenantId: Id<"tenants">;
      deviceAuthId: string;
      userCode: string;
      interval: number;
      expiresAt: number;
      now: number;
    },
    null
  >;
};

function chatgptApi(): ChatgptApi {
  return internal.chatgpt;
}

function pollDeviceLoginRef(): FunctionReference<
  "action",
  "internal",
  { tenantId: Id<"tenants">; deviceAuthId: string; deadline: number },
  null
> {
  return internal.chatgptSecrets.pollDeviceLogin;
}

function saveTokensRef(): FunctionReference<
  "action",
  "internal",
  { tenantId: Id<"tenants">; json: string; version: number; now: number },
  { ok: boolean; version: number }
> {
  return internal.chatgptSecrets.saveTokens;
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
    const api = chatgptApi();
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
        accountId:
          tokens.account_id ??
          accountIdFromJwt(tokens.access_token) ??
          accountIdFromJwt(tokens.id_token ?? ""),
        accessExpiresAt: tokens.expires_at,
        ...(emailFromJwt(tokens.id_token ?? tokens.access_token)
          ? { email: emailFromJwt(tokens.id_token ?? tokens.access_token) }
          : {}),
        ...(planFromJwt(tokens.id_token ?? tokens.access_token)
          ? { planType: planFromJwt(tokens.id_token ?? tokens.access_token) }
          : {}),
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
    const api = chatgptApi();
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
          const again = await ctx.runQuery(api.secretForTenant, { tenantId });
          if (again && again.version !== stored.version) {
            const newer = parseChatgptOAuthJson(
              decryptVaultSecret(
                vaultMasterKey(),
                tenantId,
                CHATGPT_OAUTH_HANDLE,
                again.ciphertext,
              ),
            );
            return {
              status: "connected" as const,
              accessToken: newer.access_token,
              ...(newer.account_id ? { accountId: newer.account_id } : {}),
              accessExpiresAt: newer.expires_at,
            };
          }
          await ctx.runMutation(api.quarantine, {
            tenantId,
            now,
            reason: "invalid_grant",
          });
          return { status: "quarantined" };
        }
        if (tokens.access_token && expiresAt !== undefined && expiresAt > now) {
          return {
            status: "connected" as const,
            accessToken: tokens.access_token,
            ...(tokens.account_id ? { accountId: tokens.account_id } : {}),
            accessExpiresAt: expiresAt,
          };
        }
        return { status: "none" };
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
    const api = chatgptApi();
    const stored = await ctx.runQuery(api.secretForTenant, { tenantId });
    await ctx.runMutation(api.clearAccount, { tenantId });
    return { status: stored ? ("ok" as const) : ("none" as const) };
  },
});

export const disconnectForTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  returns: v.object({
    status: v.union(v.literal("ok"), v.literal("none")),
  }),
  handler: async (ctx, { tenantId }) => {
    const api = chatgptApi();
    const stored = await ctx.runQuery(api.secretForTenant, { tenantId });
    await ctx.runMutation(api.clearAccount, { tenantId });
    return { status: stored ? ("ok" as const) : ("none" as const) };
  },
});

function emailFromJwt(token: string): string | undefined {
  const claims = jwtClaims(token);
  return typeof claims.email === "string" && claims.email.includes("@")
    ? claims.email
    : undefined;
}

function planFromJwt(token: string): string | undefined {
  const claims = jwtClaims(token);
  const nested = claims["https://api.openai.com/auth"];
  const plan =
    (typeof claims.chatgpt_plan_type === "string" && claims.chatgpt_plan_type) ||
    (nested && typeof nested === "object" && nested !== null
      ? (nested as { chatgpt_plan_type?: unknown }).chatgpt_plan_type
      : undefined);
  return typeof plan === "string" && plan.length > 0 ? plan : undefined;
}

function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export const startLoginForAgent = action({
  args: {
    secret: v.string(),
    phoneE164: v.string(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      url: v.string(),
      userCode: v.string(),
      interval: v.number(),
      expiresAt: v.number(),
    }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, { secret, phoneE164 }) => {
    assertSecret(secret);
    const phone = requirePhone(phoneE164);
    const tenantId = await tenantIdForPhone(ctx, phone);
    if (!tenantId) return { ok: false as const, reason: "unknown tenant" };
    const started = await startDeviceAuth();
    const api = chatgptApi();
    await ctx.runMutation(api.startLogin, {
      tenantId,
      deviceAuthId: started.deviceAuthId,
      userCode: started.userCode,
      interval: started.interval,
      expiresAt: started.expiresAt,
      now: Date.now(),
    });
    return {
      ok: true as const,
      url: started.url,
      userCode: started.userCode,
      interval: started.interval,
      expiresAt: started.expiresAt,
    };
  },
});

export const startDeviceLoginForTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  returns: v.object({
    url: v.string(),
    userCode: v.string(),
    interval: v.number(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, { tenantId }) => {
    const started = await startDeviceAuth();
    const api = chatgptApi();
    await ctx.runMutation(api.startLogin, {
      tenantId,
      deviceAuthId: started.deviceAuthId,
      userCode: started.userCode,
      interval: started.interval,
      expiresAt: started.expiresAt,
      now: Date.now(),
    });
    return {
      url: started.url,
      userCode: started.userCode,
      interval: started.interval,
      expiresAt: started.expiresAt,
    };
  },
});

export const pollDeviceLogin = internalAction({
  args: {
    tenantId: v.id("tenants"),
    deviceAuthId: v.string(),
    deadline: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const api = chatgptApi();
    if (now >= args.deadline) {
      await ctx.runMutation(api.expireLogin, {
        tenantId: args.tenantId,
        deviceAuthId: args.deviceAuthId,
        now,
      });
      return null;
    }
    const login = await ctx.runQuery(api.loginByDeviceAuthId, {
      deviceAuthId: args.deviceAuthId,
    });
    if (!login || login.status !== "pending") return null;
    const polled = await pollDeviceAuth({
      deviceAuthId: login.deviceAuthId,
      userCode: login.userCode,
    });
    if (polled.status === "pending" || polled.status === "slow_down") {
      const wait = devicePollSleepMs(
        login.interval,
        polled.status === "slow_down" ? 5 : undefined,
      );
      if (now + wait >= args.deadline) {
        await ctx.runMutation(api.expireLogin, {
          tenantId: args.tenantId,
          deviceAuthId: args.deviceAuthId,
          now,
        });
        return null;
      }
      await ctx.scheduler.runAfter(wait, pollDeviceLoginRef(), {
        tenantId: args.tenantId,
        deviceAuthId: args.deviceAuthId,
        deadline: args.deadline,
      });
      return null;
    }
    if (polled.status === "error") {
      await ctx.runMutation(api.failLogin, {
        tenantId: args.tenantId,
        deviceAuthId: args.deviceAuthId,
        now,
        reason: polled.message,
      });
      return null;
    }
    const tokens = await exchangeDeviceCode({
      authorizationCode: polled.authorizationCode,
      codeVerifier: polled.codeVerifier,
      now,
    });
    if (!tokens.account_id) {
      tokens.account_id =
        accountIdFromJwt(tokens.access_token) ??
        accountIdFromJwt(tokens.id_token ?? "") ??
        `codex:${args.deviceAuthId}`;
    }
    const stored = await ctx.runQuery(api.secretForTenant, {
      tenantId: args.tenantId,
    });
    const json = JSON.stringify(tokens);
    await ctx.runAction(saveTokensRef(), {
      tenantId: args.tenantId,
      json,
      version: stored ? stored.version + 1 : 1,
      now,
    });
    await ctx.runMutation(api.finishLogin, {
      tenantId: args.tenantId,
      deviceAuthId: args.deviceAuthId,
      now,
    });
    return null;
  },
});

