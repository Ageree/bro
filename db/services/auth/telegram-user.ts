import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { channelIdentities, db, user } from "@db";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { ensureScope } from "@db/services/scope";

/**
 * The mail domain of accounts that began in Telegram. Better Auth needs an
 * email; such an account has none and no phone, so the session check
 * (`getAuthSession`) knows it by this domain. No route sets an email: change
 * and sign-up by email are disabled (`db/services/auth/index.ts`).
 */
export const telegramUserEmailDomain = "telegram.local-vault.invalid";

function telegramUserEmail(telegramUserId: string) {
  return `telegram-${createHash("sha256")
    .update(telegramUserId)
    .digest("hex")}@${telegramUserEmailDomain}`;
}

/**
 * The account behind a Telegram user, created on their first message or
 * sign-in when there is none: Telegram is Bro's main channel, and writing to
 * the bot is all it takes to start (owner, 21.10). Someone with a phone
 * account binds Telegram to it with «Привязать Telegram» before writing to
 * the bot; an account made here keeps its Telegram until it is unbound in
 * its own cabinet (`redeemChannelLinkToken`). Two first messages at once
 * converge on one account through the unique email; `created` is true for
 * one of them.
 */
export async function ensureTelegramUser({
  chatId,
  name,
  telegramUserId,
  username,
}: {
  readonly chatId: string;
  readonly name?: string;
  readonly telegramUserId: string;
  readonly username?: string;
}) {
  const bound = await boundUser(telegramUserId);
  if (bound) return { created: false, userId: bound };

  const email = telegramUserEmail(telegramUserId);
  const given = name?.trim() ?? "";
  const [created] = await db
    .insert(user)
    .values({
      email,
      emailVerified: true,
      id: randomUUID(),
      name: given === "" ? "Telegram user" : given,
    })
    .onConflictDoNothing()
    .returning({ id: user.id });
  const userId =
    created?.id ??
    (
      await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, email))
        .limit(1)
    )[0]?.id;
  if (userId === undefined) return undefined;

  const scope = accessScopeForUser(`better-auth:${userId}`);
  await ensureScope(scope);
  // An identity that is already someone's stays theirs: nothing is
  // overwritten here.
  await db
    .insert(channelIdentities)
    .values({
      channel: "telegram",
      chatId,
      externalUserId: telegramUserId,
      userId,
      username: username ?? null,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoNothing();
  const owner = await boundUser(telegramUserId);
  if (owner === undefined) return undefined;
  return { created: created !== undefined && owner === userId, userId: owner };
}

async function boundUser(telegramUserId: string) {
  const [identity] = await db
    .select({ userId: channelIdentities.userId })
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channel, "telegram"),
        eq(channelIdentities.externalUserId, telegramUserId)
      )
    )
    .limit(1);
  return identity?.userId;
}
