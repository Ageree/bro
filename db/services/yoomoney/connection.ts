import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db, yoomoneyAuthorizations, yoomoneyConnections } from "@db";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { ensureScope } from "@db/services/scope";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  exchangeYoomoneyCode,
  readYoomoneyAccount,
  revokeYoomoneyToken,
  YoomoneyError,
  yoomoneyAuthorizeUrl,
  yoomoneyEnabled,
  yoomoneyScope,
} from "@shared/yoomoney/api";

/**
 * The person's YooMoney wallet: the consent that connects it (a link from
 * Bro, opened in the browser where the person is signed in to the cabinet,
 * as personal mail does) and the token Bro reads it with.
 */

const authorizationLifetimeMs = 15 * 60_000;

const stateHash = (state: string) =>
  createHash("sha256").update(state).digest("hex");

/** The Redirect URI of one consent: the registered one plus its state. */
function redirectWithState(redirectUri: string, state: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function readYoomoneyConnection(scope: AccessScope) {
  if (!yoomoneyEnabled(scope)) return { state: "unavailable" as const };
  const [connection] = await db
    .select({
      account: yoomoneyConnections.account,
      connectedAt: yoomoneyConnections.createdAt,
    })
    .from(yoomoneyConnections)
    .where(eq(yoomoneyConnections.workspaceId, scope.workspaceId))
    .limit(1);
  return connection
    ? { state: "connected" as const, ...connection }
    : { state: "disconnected" as const };
}

/** The consent page for this person; the state lives 15 minutes. */
export async function startYoomoneyAuthorization(
  scope: AccessScope,
  origin: string
) {
  if (!yoomoneyEnabled(scope))
    throw new Error("Подключение ЮMoney пока недоступно.");
  await ensureScope(scope);
  if ((await readYoomoneyConnection(scope)).state === "connected")
    throw new Error("Кошелёк уже подключён: сначала отключи его.");
  const state = randomBytes(32).toString("base64url");
  const redirectUri = new URL("/api/yoomoney/callback", origin).toString();
  await db
    .delete(yoomoneyAuthorizations)
    .where(lt(yoomoneyAuthorizations.expiresAt, new Date()));
  await db.insert(yoomoneyAuthorizations).values({
    ...scope,
    stateHash: stateHash(state),
    redirectUri,
    expiresAt: new Date(Date.now() + authorizationLifetimeMs),
  });
  return yoomoneyAuthorizeUrl(redirectWithState(redirectUri, state));
}

/**
 * The code YooMoney sent back for this person's state, for a token, then
 * the wallet's number: the first call under the token, which proves it.
 * The state is spent first, so a code is tried once.
 */
export async function finishYoomoneyAuthorization(
  scope: AccessScope,
  code: string,
  state: string
) {
  if (!yoomoneyEnabled(scope))
    throw new Error("Подключение ЮMoney пока недоступно.");
  const [attempt] = await db
    .delete(yoomoneyAuthorizations)
    .where(
      and(
        eq(yoomoneyAuthorizations.stateHash, stateHash(state)),
        eq(yoomoneyAuthorizations.workspaceId, scope.workspaceId),
        eq(yoomoneyAuthorizations.userId, scope.userId),
        gt(yoomoneyAuthorizations.expiresAt, new Date())
      )
    )
    .returning();
  if (!attempt)
    throw new Error(
      "Ссылка подключения истекла или уже использована. Начни подключение заново."
    );
  const token = await exchangeYoomoneyCode(
    code,
    redirectWithState(attempt.redirectUri, state)
  );
  try {
    const { account } = await readYoomoneyAccount(token);
    const [connection] = await db
      .insert(yoomoneyConnections)
      .values({
        ...scope,
        account,
        scope: yoomoneyScope,
        encryptedToken: await encryptToken(scope, token),
      })
      .onConflictDoNothing({ target: yoomoneyConnections.workspaceId })
      .returning({ account: yoomoneyConnections.account });
    if (!connection)
      throw new Error("Кошелёк уже подключён: сначала отключи его.");
    return connection;
  } catch (error) {
    await revokeYoomoneyToken(token);
    throw error;
  }
}

export async function cancelYoomoneyAuthorization(
  scope: AccessScope,
  state: string
) {
  await db
    .delete(yoomoneyAuthorizations)
    .where(
      and(
        eq(yoomoneyAuthorizations.stateHash, stateHash(state)),
        eq(yoomoneyAuthorizations.workspaceId, scope.workspaceId),
        eq(yoomoneyAuthorizations.userId, scope.userId)
      )
    );
}

/** Forgets the wallet here and ends its token at YooMoney. */
export async function disconnectYoomoney(scope: AccessScope) {
  const [connection] = await db
    .delete(yoomoneyConnections)
    .where(eq(yoomoneyConnections.workspaceId, scope.workspaceId))
    .returning({ encryptedToken: yoomoneyConnections.encryptedToken });
  if (!connection) return { disconnected: false, revoked: false };
  const token = await decryptToken(scope, connection.encryptedToken).catch(
    () => undefined
  );
  return {
    disconnected: true,
    revoked: token !== undefined && (await revokeYoomoneyToken(token)),
  };
}

/**
 * Runs a read of the wallet under its token. A token YooMoney no longer
 * takes (revoked in the wallet's settings, or expired) drops the
 * connection, so the next ask offers to connect again.
 */
export async function withYoomoneyToken<T>(
  scope: AccessScope,
  read: (token: string) => Promise<T>
) {
  const [connection] = await db
    .select({ encryptedToken: yoomoneyConnections.encryptedToken })
    .from(yoomoneyConnections)
    .where(eq(yoomoneyConnections.workspaceId, scope.workspaceId))
    .limit(1);
  if (!connection) return { connected: false as const };
  try {
    return {
      connected: true as const,
      result: await read(await decryptToken(scope, connection.encryptedToken)),
    };
  } catch (error) {
    // Only this token's row: the person may have connected anew meanwhile.
    if (error instanceof YoomoneyError && error.code === "revoked") {
      await db
        .delete(yoomoneyConnections)
        .where(
          and(
            eq(yoomoneyConnections.workspaceId, scope.workspaceId),
            eq(yoomoneyConnections.encryptedToken, connection.encryptedToken)
          )
        );
    }
    throw error;
  }
}

function tokenAad(scope: AccessScope) {
  return Buffer.from(JSON.stringify(["yoomoney", scope.workspaceId]));
}

async function encryptToken(scope: AccessScope, token: string) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    iv
  );
  cipher.setAAD(tokenAad(scope));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

async function decryptToken(scope: AccessScope, value: string) {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error("The stored YooMoney token uses an unsupported format.");
  const { secretEncryptionKey } = await getInstallationSecrets();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    Buffer.from(iv, "base64url")
  );
  decipher.setAAD(tokenAad(scope));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
