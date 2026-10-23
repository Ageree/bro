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

/**
 * Keeps a card that was already checked against `cardSchema`, sent to this
 * chat, and returns its link id and its ref.
 */
export async function createCard(
  scope: AccessScope,
  card: Card,
  chat: {
    readonly conversationChannel: NonNullable<CardRow["conversationChannel"]>;
    readonly conversationId: string;
  },
  now = new Date()
) {
  const id = randomBytes(32).toString("base64url");
  const ref = Array.from(
    { length: 8 },
    () => refAlphabet[randomInt(refAlphabet.length)]
  ).join("");
  await db.delete(cards).where(lt(cards.expiresAt, now));
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
 * Replaces what the person's card shows, under the same link, with its
 * revision one up; only a card of theirs sent to this chat, while it opens.
 * Undefined when there is no such card.
 */
export async function updateCard(
  scope: AccessScope,
  target: { readonly conversationId: string; readonly ref: string },
  card: Card,
  now = new Date()
) {
  if (!refPattern.test(target.ref)) return undefined;
  const [row] = await db
    .update(cards)
    .set({
      payload: card,
      revision: sql`${cards.revision} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(cards.ref, target.ref),
        eq(cards.workspaceId, scope.workspaceId),
        eq(cards.userId, scope.userId),
        eq(cards.conversationId, target.conversationId),
        gt(cards.expiresAt, now)
      )
    )
    .returning({ id: cards.id, revision: cards.revision });
  return row;
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
