import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { cards, db } from "@db";
import { type Card, cardSchema } from "@shared/cards/schema";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Cards Bro sends to a chat (`docs/cards.md`), kept behind a link whose id is
 * the secret: 32 random bytes, so it cannot be guessed. The link opens the
 * card for 30 days; a card that has expired and one that never was look the
 * same to whoever opens it.
 */

const lifetimeMs = 30 * 86_400_000;

const linkPattern = /^[A-Za-z0-9_-]{43}$/u;

/** Keeps a card that was already checked against `cardSchema`, and returns its link id. */
export async function createCard(
  scope: AccessScope,
  card: Card,
  now = new Date()
) {
  const id = randomBytes(32).toString("base64url");
  await db.delete(cards).where(lt(cards.expiresAt, now));
  await db.insert(cards).values({
    ...scope,
    createdAt: now,
    expiresAt: new Date(now.getTime() + lifetimeMs),
    id,
    payload: card,
  });
  return id;
}

/** The card this link opens, while it does. */
export async function readCardByLink(id: string, now = new Date()) {
  if (!linkPattern.test(id)) return undefined;
  const [row] = await db
    .select({ payload: cards.payload })
    .from(cards)
    .where(and(eq(cards.id, id), gt(cards.expiresAt, now)))
    .limit(1);
  return cardSchema.safeParse(row?.payload).data;
}
