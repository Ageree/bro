import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, eq, like, lt } from "drizzle-orm";
import * as z from "zod";
import { db, verification } from "@db";

/**
 * Signing in to the website through the Telegram bot. «Войти через Telegram»
 * on the site opens the bot with `/start login`; the bot answers with a
 * button holding a one-time link (`/telegram-login/open`), and that link
 * signs in whichever browser opens it. Only the person's own chat with the
 * bot ever sees the link, so a code typed on the page is not needed (owner,
 * 21.10: «упростить вход»). A link lives in Better Auth's `verification`
 * table, written here on both sides.
 */
const linkLifetimeMs = 10 * 60_000;
const identifierPrefix = "telegram-login:";
export const telegramLoginPath = "/telegram-login/open";

const linkValueSchema = z.object({ userId: z.string().min(1) });

function identifierOf(token: string) {
  return `${identifierPrefix}${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * The bot's half: a one-time sign-in link for this account, shown once.
 * Links nobody opened are swept here: nothing else would delete them.
 */
export async function mintTelegramLoginLink(userId: string, now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  await db
    .delete(verification)
    .where(
      and(
        like(verification.identifier, `${identifierPrefix}%`),
        lt(verification.expiresAt, now)
      )
    );
  await db.insert(verification).values({
    expiresAt: new Date(now.getTime() + linkLifetimeMs),
    id: randomUUID(),
    identifier: identifierOf(token),
    value: JSON.stringify({ userId }),
  });
  return token;
}

/** The account a link signs in, once; an opened or stale link gives none. */
async function redeemTelegramLoginLink(token: string, now = new Date()) {
  const identifier = identifierOf(token);
  const [row] = await db
    .delete(verification)
    .where(eq(verification.identifier, identifier))
    .returning();
  if (!row || row.expiresAt.getTime() <= now.getTime()) return undefined;
  try {
    return linkValueSchema.safeParse(JSON.parse(row.value)).data?.userId;
  } catch {
    return undefined;
  }
}

export function telegramLogin() {
  return {
    endpoints: {
      openTelegramLogin: createAuthEndpoint(
        telegramLoginPath,
        {
          method: "GET",
          query: z.object({ t: z.string().min(1).max(128) }),
        },
        async (ctx) => {
          const site = new URL("/", ctx.context.baseURL);
          const userId = await redeemTelegramLoginLink(ctx.query.t);
          const user =
            userId === undefined
              ? undefined
              : await ctx.context.internalAdapter.findUserById(userId);
          if (!user) {
            throw ctx.redirect(
              new URL("/sign-in?telegram=expired", site).toString()
            );
          }
          const session = await ctx.context.internalAdapter.createSession(
            user.id
          );
          await setSessionCookie(ctx, { session, user });
          throw ctx.redirect(new URL("/workspace", site).toString());
        }
      ),
    },
    id: "telegram-login",
    rateLimit: [
      {
        max: 10,
        pathMatcher: (path) => path.startsWith("/telegram-login/"),
        window: 60,
      },
    ],
  } satisfies BetterAuthPlugin;
}
