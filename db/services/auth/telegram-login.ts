import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, eq, like, lt } from "drizzle-orm";
import * as z from "zod";
import { db, verification } from "@db";
import {
  telegramLinkConfigured,
  telegramStartUrl,
} from "@shared/identity/telegram-link";

/**
 * Signing in to the website through the Telegram bot. The page asks for a
 * login (`/telegram-login/start`) and opens `t.me/<bot>?start=login_<token>`;
 * the bot answers that `/start` with a six-digit code, which the person types
 * on the page (`/telegram-login/verify`). The code, not the link, carries the
 * proof: a link someone else made and sent would otherwise sign their browser
 * in to the account of whoever pressed Start. Logins live in Better Auth's
 * `verification` table, written here on both sides, so they need no table of
 * their own.
 */
const loginLifetimeMs = 10 * 60_000;
/** A code the bot sent stays good for this long, even near the login's end. */
const codeLifetimeMs = 5 * 60_000;
const codeAttempts = 3;
export const telegramLoginPayloadPrefix = "login_";

const loginValueSchema = z.object({
  attempts: z.number().int().nonnegative(),
  codeHash: z.string().optional(),
  userId: z.string().min(1).optional(),
});

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function identifierOf(token: string) {
  return `telegram-login:${digest(token)}`;
}

/**
 * Starts a login and returns the token the bot link carries, shown once.
 * Logins nobody finished are swept here: nothing else would delete them.
 */
export async function startTelegramLogin(now = new Date()) {
  const token = randomBytes(24).toString("base64url");
  await db
    .delete(verification)
    .where(
      and(
        like(verification.identifier, "telegram-login:%"),
        lt(verification.expiresAt, now)
      )
    );
  await db.insert(verification).values({
    expiresAt: new Date(now.getTime() + loginLifetimeMs),
    id: randomUUID(),
    identifier: identifierOf(token),
    value: JSON.stringify({ attempts: 0 }),
  });
  return token;
}

/**
 * The bot's half: binds the login to the Telegram account that pressed Start
 * and returns the code to send it. Pressing Start again sends a new code and
 * forgets the old one, but keeps the wrong guesses and the deadline, and a
 * login another Telegram account already took gives this one nothing.
 */
export async function approveTelegramLogin(
  token: string,
  userId: string,
  now = new Date()
) {
  const identifier = identifierOf(token);
  return db.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .limit(1)
      .for("update");
    const value = loginValueOf(row?.value);
    if (!row || !value) return { kind: "unknown" as const };
    if (row.expiresAt.getTime() <= now.getTime()) {
      await transaction
        .delete(verification)
        .where(eq(verification.identifier, identifier));
      return { kind: "expired" as const };
    }
    if (value.userId !== undefined && value.userId !== userId) {
      return { kind: "unknown" as const };
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await transaction
      .update(verification)
      .set({
        expiresAt:
          value.userId === undefined
            ? new Date(
                Math.max(
                  row.expiresAt.getTime(),
                  now.getTime() + codeLifetimeMs
                )
              )
            : row.expiresAt,
        value: JSON.stringify({ ...value, codeHash: digest(code), userId }),
      })
      .where(eq(verification.identifier, identifier));
    return { code, kind: "code" as const };
  });
}

function loginValueOf(stored: string | undefined) {
  if (stored === undefined) return undefined;
  try {
    return loginValueSchema.safeParse(JSON.parse(stored)).data;
  } catch {
    return undefined;
  }
}

/**
 * The page's half: the account whose bot sent this code, once. Three wrong
 * codes end the login; pressing Start again does not give more.
 */
async function finishTelegramLogin(
  token: string,
  code: string,
  now = new Date()
) {
  const identifier = identifierOf(token);
  return db.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .limit(1)
      .for("update");
    const value = loginValueOf(row?.value);
    if (!row || !value || row.expiresAt.getTime() <= now.getTime()) {
      return { kind: "unknown" as const };
    }
    if (value.codeHash === undefined || value.userId === undefined) {
      return { kind: "pending" as const };
    }
    const given = Buffer.from(digest(code));
    if (timingSafeEqual(given, Buffer.from(value.codeHash))) {
      await transaction
        .delete(verification)
        .where(eq(verification.identifier, identifier));
      return { kind: "signed_in" as const, userId: value.userId };
    }
    if (value.attempts + 1 >= codeAttempts) {
      await transaction
        .delete(verification)
        .where(eq(verification.identifier, identifier));
      return { kind: "used_up" as const };
    }
    await transaction
      .update(verification)
      .set({
        value: JSON.stringify({ ...value, attempts: value.attempts + 1 }),
      })
      .where(eq(verification.identifier, identifier));
    return { kind: "wrong" as const };
  });
}

const verifyBodySchema = z.object({
  code: z.string().regex(/^\d{6}$/u),
  token: z.string().min(1).max(128),
});

const refusals = {
  pending: {
    code: "TELEGRAM_LOGIN_PENDING",
    message: "Сначала нажми «Старт» в Telegram — бот пришлёт код.",
  },
  unknown: {
    code: "TELEGRAM_LOGIN_EXPIRED",
    message: "Вход устарел. Нажми «Войти через Telegram» ещё раз.",
  },
  used_up: {
    code: "TELEGRAM_LOGIN_EXPIRED",
    message: "Три неверных кода подряд. Нажми «Войти через Telegram» ещё раз.",
  },
  wrong: {
    code: "TELEGRAM_CODE_WRONG",
    message: "Код не подошёл. Проверь цифры из сообщения бота.",
  },
} as const;

export function telegramLogin() {
  return {
    endpoints: {
      startTelegramLogin: createAuthEndpoint(
        "/telegram-login/start",
        { method: "POST" },
        async (ctx) => {
          if (!telegramLinkConfigured()) {
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "TELEGRAM_NOT_CONFIGURED",
              message: "Вход через Telegram на этом деплое не настроен.",
            });
          }
          const token = await startTelegramLogin();
          return ctx.json({
            token,
            url: telegramStartUrl(`${telegramLoginPayloadPrefix}${token}`),
          });
        }
      ),
      verifyTelegramLogin: createAuthEndpoint(
        "/telegram-login/verify",
        { body: verifyBodySchema, method: "POST" },
        async (ctx) => {
          const outcome = await finishTelegramLogin(
            ctx.body.token,
            ctx.body.code
          );
          if (outcome.kind !== "signed_in") {
            throw new APIError("BAD_REQUEST", refusals[outcome.kind]);
          }
          const user = await ctx.context.internalAdapter.findUserById(
            outcome.userId
          );
          if (!user) throw new APIError("BAD_REQUEST", refusals.unknown);
          const session = await ctx.context.internalAdapter.createSession(
            user.id
          );
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ status: true });
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
