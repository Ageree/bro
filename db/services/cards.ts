import { randomBytes, randomInt } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { cardResponses, cards, db } from "@db";
import { deleteCardPhotos, keptPhotoNumbers } from "@shared/cards/photos";
import type { CardAnswer } from "@shared/cards/response";
import { type Card, cardSchema } from "@shared/cards/schema";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Cards Bro sends to a chat (`docs/cards.md`), kept behind a link whose id is
 * the secret: 32 random bytes, so it cannot be guessed. The link opens the
 * card for 30 days; a card that has expired and one that never was look the
 * same to whoever opens it. An interactive card keeps the person's answer,
 * one per revision, until it becomes a turn of the chat it was sent to.
 */

type CardRow = typeof cards.$inferSelect;
type ResponseRow = typeof cardResponses.$inferSelect;

const lifetimeMs = 30 * 86_400_000;

const linkPattern = /^[A-Za-z0-9_-]{43}$/u;

/** A ref's letters: no 0/o or 1/l, which a model or a person mixes up. */
const refAlphabet = "abcdefghijkmnpqrstuvwxyz23456789";
const refPattern = /^[a-z2-9]{8}$/u;

/** A claimed answer not sent within this goes back to the queue. */
const leaseMs = 2 * 60_000;

/** Claims an answer gets before it is given up on. */
const attemptLimit = 3;

/** An answer that waited longer than this no longer starts a turn. */
const answerLifetimeMs = 86_400_000;

/** Expired cards one new card clears away, each with a request per photo. */
const expiredPerCreate = 10;

/**
 * The link id of a card about to be kept. It may come first, because the
 * card's photos are kept under it before the card is (`keepCardPhotos`).
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
 * Keeps a card that was already checked against `cardSchema`, sent to this
 * chat, and returns its link id and its ref; `id` is the one `newCardId`
 * gave when its photos were kept first. Cards that expired are cleared away.
 */
export async function createCard(
  scope: AccessScope,
  card: Card,
  chat: {
    readonly conversationChannel: NonNullable<CardRow["conversationChannel"]>;
    readonly conversationId: string;
  },
  now = new Date(),
  id = newCardId()
) {
  const ref = Array.from(
    { length: 8 },
    () => refAlphabet[randomInt(refAlphabet.length)]
  ).join("");
  await dropExpiredCards(now);
  await db.insert(cards).values({
    ...scope,
    ...chat,
    createdAt: now,
    expiresAt: new Date(now.getTime() + lifetimeMs),
    id,
    payload: card,
    ref,
  });
  return { id, ref };
}

/**
 * The card this link opens, while it does: what it shows at its current
 * revision, whose it is and the chat it was sent to.
 */
export async function readCardByLink(id: string, now = new Date()) {
  if (!linkPattern.test(id)) return undefined;
  const [row] = await db
    .select()
    .from(cards)
    .where(and(eq(cards.id, id), gt(cards.expiresAt, now)))
    .limit(1);
  const card = cardSchema.safeParse(row?.payload).data;
  if (!row || !card) return undefined;
  return {
    card,
    conversationChannel: row.conversationChannel,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
    id: row.id,
    revision: row.revision,
    updatedAt: row.updatedAt,
    userId: row.userId,
    workspaceId: row.workspaceId,
  };
}

/**
 * Removes the copies of photos `card` showed that `next` does not; the
 * store refusing is only logged, as the card is what the person sees.
 */
async function deleteLeftCopies(
  id: string,
  card: Card,
  next: Card | undefined
) {
  const shown = new Set(next ? keptPhotoNumbers(id, next) : []);
  const left = keptPhotoNumbers(id, card).filter(
    (number) => !shown.has(number)
  );
  if (left.length === 0) return;
  try {
    await deleteCardPhotos(id, left);
  } catch (error) {
    console.warn("[cards] copies of photos the card no longer shows stayed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Replaces what the person's card shows, under the same link, with its
 * revision one up; only a card of theirs sent to this chat, while it opens.
 * `change` builds the new card from the one kept now, and keeps its photos
 * (`keepCardPhotos`), while the card is held: two updates of one card go one
 * after the other and never number a photo the same, and an answer to the
 * card is not held up meanwhile. A change that gives no card leaves the card
 * as it was. Once the new card is kept, the copies of photos only the old one
 * showed go; if keeping it failed, the new copies go instead. Undefined when
 * there is no such card; `revision` is undefined when the change gave none.
 */
export async function updateCard<
  Change extends { readonly card: Card | undefined },
>(
  scope: AccessScope,
  target: { readonly conversationId: string; readonly ref: string },
  change: (current: {
    readonly card: Card;
    readonly id: string;
  }) => Promise<Change>,
  now = new Date()
) {
  if (!refPattern.test(target.ref)) return undefined;
  const updated = await db.transaction(async (transaction) => {
    const [row] = await transaction
      .select({ id: cards.id, payload: cards.payload })
      .from(cards)
      .where(
        and(
          eq(cards.ref, target.ref),
          eq(cards.workspaceId, scope.workspaceId),
          eq(cards.userId, scope.userId),
          eq(cards.conversationId, target.conversationId),
          gt(cards.expiresAt, now)
        )
      )
      .limit(1)
      .for("no key update");
    const previous = cardSchema.safeParse(row?.payload).data;
    if (!row || !previous) return undefined;
    const changed = await change({ card: previous, id: row.id });
    if (!changed.card) {
      return { change: changed, id: row.id, previous, revision: undefined };
    }
    try {
      const [kept] = await transaction
        .update(cards)
        .set({
          payload: changed.card,
          revision: sql`${cards.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(cards.id, row.id))
        .returning({ revision: cards.revision });
      return {
        change: changed,
        id: row.id,
        previous,
        revision: kept?.revision,
      };
    } catch (error) {
      await deleteLeftCopies(row.id, changed.card, previous);
      throw error;
    }
  });
  if (!updated) return undefined;
  const { previous, ...result } = updated;
  if (result.revision !== undefined) {
    await deleteLeftCopies(result.id, previous, result.change.card);
  }
  return result;
}

/** The answer kept for the card at this revision, if any. */
export async function readCardResponse(cardId: string, revision: number) {
  const [row] = await db
    .select({
      action: cardResponses.action,
      state: cardResponses.state,
      values: cardResponses.values,
    })
    .from(cardResponses)
    .where(
      and(
        eq(cardResponses.cardId, cardId),
        eq(cardResponses.revision, revision)
      )
    )
    .limit(1);
  return row;
}

/** An answer's values in one order of keys, as jsonb does not keep theirs. */
const canonical = (values: CardAnswer["values"]) =>
  JSON.stringify(
    Object.entries(values).toSorted(([x], [y]) => (x < y ? -1 : 1))
  );

/**
 * Keeps the person's answer to the card at its revision, once. The same
 * answer sent again — a second press, a reload, a retry after a lost
 * response — is a `repeat` of the one kept; another answer to a revision
 * already answered is turned away as `answered`, with the answer kept.
 */
export async function saveCardResponse(
  card: Pick<CardRow, "id" | "revision" | "userId" | "workspaceId">,
  response: {
    readonly answer: CardAnswer;
    readonly summary: string;
    readonly telegramUserId: string;
  },
  now = new Date()
) {
  const [kept] = await db
    .insert(cardResponses)
    .values({
      action: response.answer.action,
      cardId: card.id,
      createdAt: now,
      revision: card.revision,
      summary: response.summary,
      telegramUserId: response.telegramUserId,
      userId: card.userId,
      values: response.answer.values,
      workspaceId: card.workspaceId,
    })
    .onConflictDoNothing({
      target: [cardResponses.cardId, cardResponses.revision],
    })
    .returning({ state: cardResponses.state });
  if (kept) {
    return {
      answer: response.answer,
      outcome: "received" as const,
      state: kept.state,
    };
  }
  const earlier = await readCardResponse(card.id, card.revision);
  if (!earlier) throw new Error("The card's answer is neither new nor kept.");
  const same =
    earlier.action === response.answer.action &&
    canonical(earlier.values) === canonical(response.answer.values);
  return {
    answer: { action: earlier.action, values: earlier.values },
    outcome: same ? ("repeat" as const) : ("answered" as const),
    state: earlier.state,
  };
}

/** How many answers the workspace's cards took since then: for the rate limit. */
export async function countCardResponses(workspaceId: string, since: Date) {
  const [row] = await db
    .select({ total: count() })
    .from(cardResponses)
    .where(
      and(
        eq(cardResponses.workspaceId, workspaceId),
        gte(cardResponses.createdAt, since)
      )
    );
  return row?.total ?? 0;
}

/**
 * The answers due to become a turn of their chat, claimed: each is taken by
 * one caller for `leaseMs`, and counts one attempt. One whose claim ran out
 * — the process went down mid-send — is due again; one out of attempts, or
 * older than a day, fails instead. Each comes with its card's ref, title
 * and chat.
 */
export async function claimCardResponses(now: Date, limit = 10) {
  const leaseEdge = new Date(now.getTime() - leaseMs);
  const unclaimed = or(
    isNull(cardResponses.claimedAt),
    lt(cardResponses.claimedAt, leaseEdge)
  );
  await db
    .update(cardResponses)
    .set({ state: "failed" })
    .where(
      and(
        eq(cardResponses.state, "received"),
        or(
          lt(
            cardResponses.createdAt,
            new Date(now.getTime() - answerLifetimeMs)
          ),
          and(gte(cardResponses.attempts, attemptLimit), unclaimed)
        )
      )
    );
  const due = await db
    .select({ id: cardResponses.id })
    .from(cardResponses)
    .where(
      and(
        eq(cardResponses.state, "received"),
        lt(cardResponses.attempts, attemptLimit),
        unclaimed
      )
    )
    .orderBy(asc(cardResponses.createdAt))
    .limit(limit);
  if (due.length === 0) return [];
  const claimed = await db
    .update(cardResponses)
    .set({ attempts: sql`${cardResponses.attempts} + 1`, claimedAt: now })
    .where(
      and(
        inArray(
          cardResponses.id,
          due.map(({ id }) => id)
        ),
        eq(cardResponses.state, "received"),
        unclaimed
      )
    )
    .returning({ id: cardResponses.id });
  if (claimed.length === 0) return [];
  return db
    .select({
      action: cardResponses.action,
      cardId: cards.id,
      conversationChannel: cards.conversationChannel,
      conversationId: cards.conversationId,
      id: cardResponses.id,
      payload: cards.payload,
      ref: cards.ref,
      revision: cardResponses.revision,
      summary: cardResponses.summary,
      userId: cardResponses.userId,
      values: cardResponses.values,
      workspaceId: cardResponses.workspaceId,
    })
    .from(cardResponses)
    .innerJoin(cards, eq(cardResponses.cardId, cards.id))
    .where(
      inArray(
        cardResponses.id,
        claimed.map(({ id }) => id)
      )
    )
    .orderBy(asc(cardResponses.createdAt));
}

/** The answer became a turn of its chat. */
export async function markCardResponseDelivered(
  id: ResponseRow["id"],
  now: Date
) {
  await db
    .update(cardResponses)
    .set({ deliveredAt: now, state: "delivered" })
    .where(and(eq(cardResponses.id, id), eq(cardResponses.state, "received")));
}

/**
 * A claimed answer that could not be sent goes back to the queue, or fails
 * once it is out of attempts.
 */
export async function releaseCardResponse(id: ResponseRow["id"]) {
  await db
    .update(cardResponses)
    .set({
      claimedAt: null,
      state: sql`case when ${cardResponses.attempts} >= ${attemptLimit} then 'failed' else 'received' end`,
    })
    .where(and(eq(cardResponses.id, id), eq(cardResponses.state, "received")));
}

/** An answer that can never be sent: its card lost its chat. */
export async function failCardResponse(id: ResponseRow["id"]) {
  await db
    .update(cardResponses)
    .set({ state: "failed" })
    .where(and(eq(cardResponses.id, id), eq(cardResponses.state, "received")));
}
