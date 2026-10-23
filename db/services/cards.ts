import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { cards, db } from "@db";
import { deleteCardPhotos, keptPhotoNumbers } from "@shared/cards/photos";
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

/** Expired cards one new card clears away, each with a request per photo. */
const expiredPerCreate = 10;

/**
 * The link id of a card about to be kept. It comes first because the card's
 * photos are kept under it before the card is (`keepCardPhotos`).
 */
export function newCardId() {
  return randomBytes(32).toString("base64url");
}

/**
 * Removes cards that expired, and the copies of their photos first. A card
 * whose copies the store would not remove stays, opening nothing, for the
 * next card to try again: a copy never outlives the row that names it.
 */
async function dropExpiredCards(now: Date) {
  const expired = await db
    .select({ id: cards.id, payload: cards.payload })
    .from(cards)
    .where(lt(cards.expiresAt, now))
    .limit(expiredPerCreate);
  const gone: string[] = [];
  for (const card of expired) {
    const numbers = keptPhotoNumbers(card.id, card.payload);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One card's copies at a time keeps the store's load small.
      if (numbers.length > 0) await deleteCardPhotos(card.id, numbers);
      gone.push(card.id);
    } catch (error) {
      console.warn("[cards] an expired card's photos stayed", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  if (gone.length > 0) await db.delete(cards).where(inArray(cards.id, gone));
}

/**
 * Keeps a card that was already checked against `cardSchema` under the link
 * id `newCardId` gave, clearing away cards that expired.
 */
export async function createCard(
  scope: AccessScope,
  id: string,
  card: Card,
  now = new Date()
) {
  await dropExpiredCards(now);
  await db.insert(cards).values({
    ...scope,
    createdAt: now,
    expiresAt: new Date(now.getTime() + lifetimeMs),
    id,
    payload: card,
  });
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
