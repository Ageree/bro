import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { db, mailAuthorizations, mailConnections, mailSends } from "@db";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { ensureScope } from "@db/services/scope";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  mailEnabled,
  mailProviderConfig,
  mailProviderConfigured,
} from "@shared/mail/providers";
import {
  mailProviderNames,
  mailServerHosts,
  type MailAccess,
  type MailCredentials,
  type MailProvider,
} from "@shared/mail/schema";

const storedTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
});
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().optional(),
  scope: z.string().optional(),
});
const oauthErrorSchema = z.object({ error: z.string() });
const mailruProfileSchema = z.object({ email: z.email() });
const yandexProfileSchema = z.object({ default_email: z.email() });
const authorizationLifetimeMs = 15 * 60_000;

class MailOAuthError extends Error {
  constructor(readonly code: "invalid_grant" | "unavailable") {
    super(
      code === "invalid_grant"
        ? "Доступ к почте истёк. Подключи ящик заново."
        : "Почтовый сервис не завершил авторизацию. Попробуй позже."
    );
  }
}

export class MailAccessError extends Error {}

function connectionWhere(scope: AccessScope, provider: MailProvider) {
  return and(
    eq(mailConnections.workspaceId, scope.workspaceId),
    eq(mailConnections.userId, scope.userId),
    eq(mailConnections.provider, provider)
  );
}

export async function readMailConnection(
  scope: AccessScope,
  provider: MailProvider
) {
  if (!mailEnabled(scope) || !mailProviderConfigured(provider)) {
    return {
      provider,
      state: "unavailable" as const,
      email: null,
      access: null,
    };
  }
  const [connection] = await db
    .select({
      email: mailConnections.email,
      access: mailConnections.access,
    })
    .from(mailConnections)
    .where(connectionWhere(scope, provider))
    .limit(1);
  return connection
    ? { provider, state: "connected" as const, ...connection }
    : { provider, state: "disconnected" as const, email: null, access: null };
}

export async function startMailAuthorization(
  scope: AccessScope,
  provider: MailProvider,
  access: MailAccess,
  origin: string
) {
  if (!mailEnabled(scope))
    throw new Error("Подключение этой почты пока недоступно.");
  const config = await mailProviderConfig(provider, access);
  await ensureScope(scope);
  const current = await readMailConnection(scope, provider);
  if (current.state === "connected") {
    throw new Error(
      "Сначала отключи текущий ящик, затем подключи его с нужным доступом."
    );
  }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = new URL(
    `/api/personal-mail/${provider}/callback`,
    origin
  ).toString();
  await db
    .delete(mailAuthorizations)
    .where(lt(mailAuthorizations.expiresAt, new Date()));
  await db.insert(mailAuthorizations).values({
    ...scope,
    provider,
    access,
    stateHash: createHash("sha256").update(state).digest("hex"),
    redirectUri,
    encryptedVerifier: await encryptMailSecret(
      scope,
      provider,
      verifier,
      "pkce"
    ),
    expiresAt: new Date(Date.now() + authorizationLifetimeMs),
  });
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  url.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url")
  );
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function finishMailAuthorization(
  scope: AccessScope,
  provider: MailProvider,
  code: string,
  state: string
) {
  if (!mailEnabled(scope))
    throw new Error("Подключение этой почты пока недоступно.");
  try {
    await db.transaction(async (transaction) => {
      const [attempt] = await transaction
        .delete(mailAuthorizations)
        .where(
          and(
            eq(
              mailAuthorizations.stateHash,
              createHash("sha256").update(state).digest("hex")
            ),
            eq(mailAuthorizations.workspaceId, scope.workspaceId),
            eq(mailAuthorizations.userId, scope.userId),
            eq(mailAuthorizations.provider, provider),
            gt(mailAuthorizations.expiresAt, new Date())
          )
        )
        .returning();
      if (!attempt)
        throw new Error(
          "Ссылка подключения истекла или уже использована. Начни подключение заново."
        );
      const config = await mailProviderConfig(provider, attempt.access);
      const token = await requestTokens(config, {
        code,
        grant_type: "authorization_code",
        redirect_uri: attempt.redirectUri,
        code_verifier: await decryptMailSecret(
          scope,
          provider,
          attempt.encryptedVerifier,
          "pkce"
        ),
      });
      let email: string;
      try {
        const url = new URL(config.userinfoUrl);
        if (provider === "yandex") url.searchParams.set("format", "json");
        const response = await fetch(url, {
          method: provider === "mailru" ? "POST" : "GET",
          headers: {
            Authorization: `${provider === "yandex" ? "OAuth" : "Bearer"} ${token.access_token}`,
          },
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
          cache: "no-store",
        });
        if (!response.ok) throw new MailOAuthError("unavailable");
        const profile: unknown = await response.json();
        email =
          provider === "mailru"
            ? mailruProfileSchema.parse(profile).email
            : yandexProfileSchema.parse(profile).default_email;
      } catch {
        throw new MailOAuthError("unavailable");
      }
      await verifyMailCredentials(provider, {
        email,
        accessToken: token.access_token,
        access: attempt.access,
      });
      const encryptedTokens = await encryptMailSecret(
        scope,
        provider,
        JSON.stringify({
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
        }),
        "tokens"
      );
      const expiresAt = token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000)
        : null;
      await transaction
        .insert(mailConnections)
        .values({
          ...scope,
          provider,
          email,
          access: attempt.access,
          encryptedTokens,
          expiresAt,
        })
        .onConflictDoNothing({
          target: [mailConnections.workspaceId, mailConnections.provider],
        });
    });
  } catch (error) {
    await cancelMailAuthorization(scope, provider, state).catch(
      () => undefined
    );
    if (error instanceof MailOAuthError || error instanceof MailAccessError)
      throw error;
    throw new MailOAuthError("unavailable");
  }
}

export async function cancelMailAuthorization(
  scope: AccessScope,
  provider: MailProvider,
  state: string
) {
  await db
    .delete(mailAuthorizations)
    .where(
      and(
        eq(
          mailAuthorizations.stateHash,
          createHash("sha256").update(state).digest("hex")
        ),
        eq(mailAuthorizations.workspaceId, scope.workspaceId),
        eq(mailAuthorizations.userId, scope.userId),
        eq(mailAuthorizations.provider, provider)
      )
    );
}

export async function getMailCredentials(
  scope: AccessScope,
  provider: MailProvider
): Promise<MailCredentials> {
  if (!mailEnabled(scope) || !mailProviderConfigured(provider)) {
    throw new Error("Подключение этой почты на сервере не настроено.");
  }
  const result = await db.transaction(async (transaction) => {
    const [connection] = await transaction
      .select()
      .from(mailConnections)
      .where(connectionWhere(scope, provider))
      .limit(1)
      .for("update");
    if (!connection)
      return {
        refused: `${mailProviderNames[provider]} не подключена. Подключи ящик в кабинете.`,
      };
    const tokens = storedTokensSchema.parse(
      JSON.parse(
        await decryptMailSecret(
          scope,
          provider,
          connection.encryptedTokens,
          "tokens"
        )
      )
    );
    if (
      !connection.expiresAt ||
      connection.expiresAt.getTime() > Date.now() + 60_000
    ) {
      return {
        credentials: {
          email: connection.email,
          accessToken: tokens.accessToken,
          access: connection.access,
        },
      };
    }
    if (!tokens.refreshToken) {
      await transaction
        .delete(mailConnections)
        .where(connectionWhere(scope, provider));
      return { refused: "Доступ к почте истёк. Подключи ящик заново." };
    }
    let refreshed: z.infer<typeof tokenResponseSchema>;
    try {
      refreshed = await requestTokens(
        await mailProviderConfig(provider, connection.access),
        {
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        }
      );
    } catch (error) {
      if (error instanceof MailOAuthError && error.code === "invalid_grant") {
        await transaction
          .delete(mailConnections)
          .where(connectionWhere(scope, provider));
        return { refused: error.message };
      }
      throw new MailOAuthError("unavailable");
    }
    await transaction
      .update(mailConnections)
      .set({
        encryptedTokens: await encryptMailSecret(
          scope,
          provider,
          JSON.stringify({
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
          }),
          "tokens"
        ),
        expiresAt: refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000)
          : null,
        updatedAt: new Date(),
      })
      .where(connectionWhere(scope, provider));
    return {
      credentials: {
        email: connection.email,
        accessToken: refreshed.access_token,
        access: connection.access,
      },
    };
  });
  if (!result.credentials) throw new Error(result.refused);
  return result.credentials;
}

async function verifyMailCredentials(
  provider: MailProvider,
  credentials: MailCredentials
) {
  const client = new ImapFlow({
    host: mailServerHosts[provider].imap,
    port: 993,
    secure: true,
    auth: { user: credentials.email, accessToken: credentials.accessToken },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  client.on("response", () => {
    if (!client.authenticated && client.secureConnection) {
      client.capabilities.delete("AUTH=OAUTHBEARER");
      client.capabilities.set("AUTH=XOAUTH2", true);
    }
  });
  client.on("error", () => {
    client.close();
  });
  const deadline = setTimeout(() => {
    client.close();
  }, 60_000);
  try {
    await client.connect();
    await client.mailboxOpen("INBOX", { readOnly: true });
  } catch {
    throw new MailAccessError("Почтовый сервер не подтвердил доступ IMAP.");
  } finally {
    await client.logout().catch(() => {
      client.close();
    });
    clearTimeout(deadline);
    client.close();
  }
  if (credentials.access === "read_only") return;
  const transport = createTransport({
    host: mailServerHosts[provider].smtp,
    port: 465,
    secure: true,
    authMethod: "XOAUTH2",
    forceAuth: true,
    auth: {
      type: "OAuth2",
      user: credentials.email,
      accessToken: credentials.accessToken,
    },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    logger: false,
    debug: false,
    dnsTimeout: 15_000,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.verify();
  } catch {
    throw new MailAccessError("Почтовый сервер не подтвердил доступ SMTP.");
  } finally {
    transport.close();
  }
}

export async function disconnectMail(
  scope: AccessScope,
  provider: MailProvider
) {
  await db.transaction(async (transaction) => {
    await transaction
      .delete(mailAuthorizations)
      .where(
        and(
          eq(mailAuthorizations.workspaceId, scope.workspaceId),
          eq(mailAuthorizations.userId, scope.userId),
          eq(mailAuthorizations.provider, provider)
        )
      );
    await transaction
      .delete(mailConnections)
      .where(connectionWhere(scope, provider));
  });
}

async function requestTokens(
  config: Awaited<ReturnType<typeof mailProviderConfig>>,
  fields:
    | {
        grant_type: "authorization_code";
        code: string;
        redirect_uri: string;
        code_verifier: string;
      }
    | { grant_type: "refresh_token"; refresh_token: string }
) {
  try {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
      cache: "no-store",
    });
    const body: unknown = await response.json();
    if (!response.ok || oauthErrorSchema.safeParse(body).success) {
      const error = oauthErrorSchema.safeParse(body);
      throw new MailOAuthError(
        error.success && error.data.error === "invalid_grant"
          ? "invalid_grant"
          : "unavailable"
      );
    }
    return tokenResponseSchema.parse(body);
  } catch (error) {
    if (error instanceof MailOAuthError) throw error;
    throw new MailOAuthError("unavailable");
  }
}

async function encryptMailSecret(
  scope: AccessScope,
  provider: MailProvider,
  plaintext: string,
  purpose: "tokens" | "pkce"
) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    iv
  );
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        "mail",
        purpose,
        scope.workspaceId,
        scope.userId,
        provider,
      ])
    )
  );
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

async function decryptMailSecret(
  scope: AccessScope,
  provider: MailProvider,
  value: string,
  purpose: "tokens" | "pkce"
) {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error(
      "Сохранённый доступ к почте повреждён. Подключи ящик заново."
    );
  const { secretEncryptionKey } = await getInstallationSecrets();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    Buffer.from(iv, "base64url")
  );
  decipher.setAAD(
    Buffer.from(
      JSON.stringify([
        "mail",
        purpose,
        scope.workspaceId,
        scope.userId,
        provider,
      ])
    )
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function sendWhere(
  scope: AccessScope,
  provider: MailProvider,
  operationId: string
) {
  return and(
    eq(mailSends.workspaceId, scope.workspaceId),
    eq(mailSends.userId, scope.userId),
    eq(mailSends.provider, provider),
    eq(mailSends.operationId, operationId)
  );
}

export async function claimMailSend(
  scope: AccessScope,
  provider: MailProvider,
  operationId: string,
  payloadHash: string
) {
  const inserted = await db
    .insert(mailSends)
    .values({ ...scope, provider, operationId, payloadHash, status: "sending" })
    .onConflictDoNothing()
    .returning({ operationId: mailSends.operationId });
  if (inserted.length > 0) return { claimed: true as const };
  const [receipt] = await db
    .select({
      status: mailSends.status,
      messageId: mailSends.messageId,
      payloadHash: mailSends.payloadHash,
    })
    .from(mailSends)
    .where(sendWhere(scope, provider, operationId))
    .limit(1);
  if (!receipt || receipt.payloadHash !== payloadHash)
    throw new Error("Повторная отправка с изменённым письмом запрещена.");
  return {
    claimed: false as const,
    status: receipt.status,
    messageId: receipt.messageId,
  };
}

export async function completeMailSend(
  scope: AccessScope,
  provider: MailProvider,
  operationId: string,
  messageId: string
) {
  await db
    .update(mailSends)
    .set({ status: "accepted", messageId })
    .where(sendWhere(scope, provider, operationId));
}

export async function uncertainMailSend(
  scope: AccessScope,
  provider: MailProvider,
  operationId: string
) {
  await db
    .update(mailSends)
    .set({ status: "uncertain" })
    .where(
      and(
        sendWhere(scope, provider, operationId),
        eq(mailSends.status, "sending")
      )
    );
}
