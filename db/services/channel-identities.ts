import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { channelIdentities, channelLinkTokens, db } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";

/** A conversation channel an account can bind after it already exists. */
export type LinkableChannel =
  (typeof channelIdentities.$inferSelect)["channel"];

/** How long a minted deep link stays redeemable. */
export const channelLinkTokenLifetimeMs = 30 * 60_000;

const betterAuthPrincipalPrefix = "better-auth:";

/**
 * Mints a single-use link token for the signed-in account and returns the
 * plaintext once. Only its SHA-256 digest is stored, so a leaked database
 * snapshot cannot be replayed against the bot.
 */
export async function mintChannelLinkToken(
  scope: AccessScope,
  channel: LinkableChannel,
  now = new Date()
) {
  const token = randomBytes(32).toString("base64url");
  await db.insert(channelLinkTokens).values({
    channel,
    createdAt: now,
    expiresAt: new Date(now.getTime() + channelLinkTokenLifetimeMs),
    tokenHash: hashChannelLinkToken(token),
    userId: betterAuthUserId(scope),
    workspaceId: scope.workspaceId,
  });
  return token;
}

/**
 * Consumes a link token and binds the external conversation account to the
 * token's owner. The token is only marked used when the identity is written,
 * so a rejected attempt leaves the link usable for the intended account.
 */
export async function redeemChannelLinkToken(
  channel: LinkableChannel,
  token: string,
  externalUser: {
    readonly chatId: string;
    readonly externalUserId: string;
    readonly username?: string;
  },
  now = new Date()
) {
  const tokenHash = hashChannelLinkToken(token);
  return await db.transaction(async (transaction) => {
    const [claim] = await transaction
      .select()
      .from(channelLinkTokens)
      .where(
        and(
          eq(channelLinkTokens.tokenHash, tokenHash),
          eq(channelLinkTokens.channel, channel)
        )
      )
      .limit(1)
      .for("update");
    if (!claim || claim.usedAt) return "unknown" as const;
    if (claim.expiresAt.getTime() <= now.getTime()) return "expired" as const;

    const [boundExternalUser] = await transaction
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channel, channel),
          eq(channelIdentities.externalUserId, externalUser.externalUserId)
        )
      )
      .limit(1);
    if (boundExternalUser && boundExternalUser.userId !== claim.userId) {
      return "already_linked_other_user" as const;
    }

    const [boundAccount] = await transaction
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channel, channel),
          eq(channelIdentities.userId, claim.userId)
        )
      )
      .limit(1);
    if (
      boundAccount &&
      boundAccount.externalUserId !== externalUser.externalUserId
    ) {
      return "already_linked_other_account" as const;
    }

    await transaction
      .insert(channelIdentities)
      .values({
        channel,
        chatId: externalUser.chatId,
        externalUserId: externalUser.externalUserId,
        linkedAt: now,
        userId: claim.userId,
        username: externalUser.username ?? null,
        workspaceId: claim.workspaceId,
      })
      .onConflictDoUpdate({
        set: {
          chatId: externalUser.chatId,
          linkedAt: now,
          username: externalUser.username ?? null,
        },
        target: [channelIdentities.channel, channelIdentities.externalUserId],
      });
    await transaction
      .update(channelLinkTokens)
      .set({ usedAt: now })
      .where(eq(channelLinkTokens.tokenHash, tokenHash));
    return "linked" as const;
  });
}

/** Resolves the account behind an inbound external conversation account. */
export async function findChannelIdentity(
  channel: LinkableChannel,
  externalUserId: string
) {
  const [identity] = await db
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channel, channel),
        eq(channelIdentities.externalUserId, externalUserId)
      )
    )
    .limit(1);
  return identity;
}

/** Reads the signed-in account's own identity for one channel, when linked. */
export async function readChannelIdentity(
  scope: AccessScope,
  channel: LinkableChannel
) {
  const [identity] = await db
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channel, channel),
        eq(channelIdentities.userId, betterAuthUserId(scope)),
        eq(channelIdentities.workspaceId, scope.workspaceId)
      )
    )
    .limit(1);
  return identity;
}

function hashChannelLinkToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Channel identities reference the Better Auth `user` row, while an access
 * scope carries the prefixed principal the agent runtime authenticates with.
 */
function betterAuthUserId(scope: AccessScope) {
  if (!scope.userId.startsWith(betterAuthPrincipalPrefix)) {
    throw new Error("Channel linking requires a Better Auth account.");
  }
  return scope.userId.slice(betterAuthPrincipalPrefix.length);
}
