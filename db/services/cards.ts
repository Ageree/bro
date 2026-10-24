import { randomBytes, randomInt } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  not,
  or,
  sql,
} from "drizzle-orm";
import { browserRuns, cardResponses, cards, db } from "@db";
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

/** An intent that became no turn within this is dropped: the person moved on. */
const intentLifetimeMs = 10 * 60_000;

/** The turn of a card's press holds the card's next press back for at most this. */
const openTurnMs = 5 * 60_000;

/** A browser run a press started counts as the card's search for at most this. */
const searchMs = 30 * 60_000;

/** The page's ask marks the card watched again only once this passed. */
const watchWriteMs = 10_000;

/** A card the page asked about within this is open in front of the person. */
const watchFreshMs = 45_000;

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
 * `watchedAt` says when the card's page last asked how it stands
 * (`cardWatched`).
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
      .select({
        id: cards.id,
        payload: cards.payload,
        watchedAt: cards.watchedAt,
      })
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
      return {
        change: changed,
        id: row.id,
        previous,
        revision: undefined,
        watchedAt: row.watchedAt,
      };
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
        watchedAt: row.watchedAt,
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
        eq(cardResponses.revision, revision),
        eq(cardResponses.kind, "submit")
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
 * Holds the card's presses for the rest of the transaction: two presses of
 * one card are kept one after the other. Not the card's row lock, which an
 * update holds while it copies photos.
 */
async function lockCardPresses(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  cardId: string
) {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`card-presses:${cardId}`}, 0))`
  );
}

/** An intent of the card that waits for a turn and no caller has taken yet. */
const waitingIntent = and(
  eq(cardResponses.kind, "intent"),
  eq(cardResponses.state, "received"),
  isNull(cardResponses.claimedAt)
);

type PressedCard = Pick<CardRow, "id" | "revision" | "userId" | "workspaceId">;

interface Press {
  readonly answer: CardAnswer;
  readonly summary: string;
  readonly telegramUserId: string;
}

/**
 * Keeps the person's answer to the card at its revision, once. The same
 * answer sent again — a second press, a reload, a retry after a lost
 * response — is a `repeat` of the one kept; another answer to a revision
 * already answered is turned away as `answered`, with the answer kept. An
 * answer is the person's last word on the card: an intent of theirs still
 * waiting for a turn goes, and one Bro took up stays.
 */
export async function saveCardResponse(
  card: PressedCard,
  response: Press,
  now = new Date()
) {
  const kept = await db.transaction(async (transaction) => {
    await lockCardPresses(transaction, card.id);
    const [row] = await transaction
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
        where: sql`kind = 'submit'`,
      })
      .returning({ state: cardResponses.state });
    if (row) {
      await transaction
        .delete(cardResponses)
        .where(and(eq(cardResponses.cardId, card.id), waitingIntent));
    }
    return row;
  });
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

/**
 * Keeps an intent the person pressed on the card: a question to Bro the
 * card stays open for. The person's last word wins: an intent of the card
 * still waiting for a turn, which no caller took yet, takes this one's
 * button, values and time instead of a second one waiting beside it —
 * `repeat` when it already was this one, `replaced` otherwise. One Bro took
 * up stays as it is, and this one waits after it.
 */
export async function saveCardIntent(
  card: PressedCard,
  press: Press & { readonly item: string | undefined },
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`card-intents:${card.workspaceId}`}, 0))`
    );
    await lockCardPresses(transaction, card.id);
    const [waiting] = await transaction
      .select({
        action: cardResponses.action,
        id: cardResponses.id,
        item: cardResponses.item,
        values: cardResponses.values,
      })
      .from(cardResponses)
      .where(and(eq(cardResponses.cardId, card.id), waitingIntent))
      .orderBy(desc(cardResponses.createdAt))
      .limit(1);
    const fields = {
      action: press.answer.action,
      item: press.item ?? null,
      revision: card.revision,
      summary: press.summary,
      telegramUserId: press.telegramUserId,
      values: press.answer.values,
    };
    if (waiting) {
      if (
        waiting.action === press.answer.action &&
        waiting.item === fields.item &&
        canonical(waiting.values) === canonical(press.answer.values)
      ) {
        return "repeat" as const;
      }
      await transaction
        .update(cardResponses)
        .set({ ...fields, attempts: 0, createdAt: now })
        .where(eq(cardResponses.id, waiting.id));
      return "replaced" as const;
    }
    const [counts] = await transaction
      .select({
        card: count(
          sql`case when ${cardResponses.cardId} = ${card.id} then 1 end`
        ),
        workspace: count(),
      })
      .from(cardResponses)
      .where(
        and(
          eq(cardResponses.workspaceId, card.workspaceId),
          eq(cardResponses.kind, "intent"),
          gte(
            cardResponses.createdAt,
            new Date(now.getTime() - intentLifetimeMs)
          )
        )
      );
    if (counts && (counts.card >= 6 || counts.workspace >= 20))
      return "busy" as const;
    await transaction.insert(cardResponses).values({
      ...fields,
      cardId: card.id,
      createdAt: now,
      kind: "intent",
      userId: card.userId,
      workspaceId: card.workspaceId,
    });
    return "received" as const;
  });
}

/** How many answers the workspace's cards took since then: for the rate limit. */
export async function countCardResponses(workspaceId: string, since: Date) {
  const [row] = await db
    .select({ total: count() })
    .from(cardResponses)
    .where(
      and(
        eq(cardResponses.workspaceId, workspaceId),
        eq(cardResponses.kind, "submit"),
        gte(cardResponses.createdAt, since)
      )
    );
  return row?.total ?? 0;
}

/**
 * Whether another press of the same card is on its way to Bro or at work
 * there: claimed and being sent, or delivered with its turn not over yet —
 * for `openTurnMs` at most, so a turn whose end went unrecorded does not
 * hold the card for good.
 */
function cardBusy(now: Date) {
  const leaseEdge = new Date(now.getTime() - leaseMs).toISOString();
  const openEdge = new Date(now.getTime() - openTurnMs).toISOString();
  return sql`exists (
    select 1 from ${cardResponses} as other
    where other.card_id = ${cardResponses.cardId}
      and other.id <> ${cardResponses.id}
      and (
        (other.state = 'received' and other.claimed_at >= ${leaseEdge}::timestamptz)
        or (
          other.state = 'delivered'
          and other.finished_at is null
          and other.delivered_at >= ${openEdge}::timestamptz
        )
      )
  )`;
}

/**
 * The presses due to become a turn of their chat, claimed: each is taken by
 * one caller for `leaseMs`, and counts one attempt. One whose claim ran out
 * — the process went down mid-send — is due again; one out of attempts, an
 * answer older than a day or an intent older than `intentLifetimeMs` fails
 * instead. A card has one turn of its presses at a time: a press of a card
 * whose earlier press is still on its way or at work waits, and of two due
 * at once the older goes first. Each comes with its card's ref, title and
 * chat.
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
          and(
            eq(cardResponses.kind, "intent"),
            lte(
              cardResponses.createdAt,
              new Date(now.getTime() - intentLifetimeMs)
            )
          ),
          and(gte(cardResponses.attempts, attemptLimit), unclaimed)
        )
      )
    );
  const due = await db
    .select({ cardId: cardResponses.cardId, id: cardResponses.id })
    .from(cardResponses)
    .where(
      and(
        eq(cardResponses.state, "received"),
        lt(cardResponses.attempts, attemptLimit),
        unclaimed,
        not(cardBusy(now))
      )
    )
    .orderBy(asc(cardResponses.createdAt))
    .limit(limit);
  const candidates = [...new Set(due.map((row) => row.cardId))];
  const claimed = (
    await Promise.all(
      candidates.map((cardId) =>
        db.transaction(async (transaction) => {
          await lockCardPresses(transaction, cardId);
          const [next] = await transaction
            .select({ id: cardResponses.id })
            .from(cardResponses)
            .where(
              and(
                eq(cardResponses.cardId, cardId),
                eq(cardResponses.state, "received"),
                lt(cardResponses.attempts, attemptLimit),
                unclaimed,
                not(cardBusy(now))
              )
            )
            .orderBy(asc(cardResponses.createdAt), asc(cardResponses.id))
            .limit(1);
          if (!next) return [];
          return transaction
            .update(cardResponses)
            .set({
              attempts: sql`${cardResponses.attempts} + 1`,
              claimedAt: now,
            })
            .where(eq(cardResponses.id, next.id))
            .returning({ id: cardResponses.id });
        })
      )
    )
  ).flat();
  if (claimed.length === 0) return [];
  return db
    .select({
      action: cardResponses.action,
      cardId: cards.id,
      conversationChannel: cards.conversationChannel,
      conversationId: cards.conversationId,
      id: cardResponses.id,
      item: cardResponses.item,
      kind: cardResponses.kind,
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

/**
 * The turn a press became is over, and the card's next press may go. Only
 * once: eve keeps a turn's caller for a later delivery that brings none, so
 * a later turn may end under the same press.
 */
export async function finishCardResponse(id: ResponseRow["id"], now: Date) {
  await db
    .update(cardResponses)
    .set({ finishedAt: now })
    .where(
      and(
        eq(cardResponses.id, id),
        inArray(cardResponses.state, ["received", "delivered"]),
        isNull(cardResponses.finishedAt)
      )
    );
}

/**
 * The browser run the turn of a press started, while that turn is at work:
 * the card shows it searching until the run's report is in.
 */
export async function linkCardResponseRun(
  id: ResponseRow["id"],
  runId: string
) {
  await db
    .update(cardResponses)
    .set({ runId })
    .where(and(eq(cardResponses.id, id), isNull(cardResponses.finishedAt)));
}

/**
 * The card whose press started this browser run, if one did: its report
 * belongs on that card.
 */
export async function readCardOfRun(runId: string, now = new Date()) {
  async function origin(
    id: string,
    hops: number
  ): Promise<Pick<CardRow, "id" | "ref"> | undefined> {
    if (hops >= 12) return undefined;
    const [row] = await db
      .select({ id: cards.id, ref: cards.ref })
      .from(cardResponses)
      .innerJoin(cards, eq(cardResponses.cardId, cards.id))
      .where(and(eq(cardResponses.runId, id), gt(cards.expiresAt, now)))
      .orderBy(desc(cardResponses.createdAt))
      .limit(1);
    if (row) return row;
    const [before] = await db
      .select({ id: browserRuns.id })
      .from(browserRuns)
      .where(eq(browserRuns.retriedAsRunId, id))
      .limit(1);
    return before ? origin(before.id, hops + 1) : undefined;
  }
  return origin(runId, 0);
}

/** Notes that the card's page asked how the card stands, at most every `watchWriteMs`. */
export async function markCardWatched(id: string, now: Date) {
  await db
    .update(cards)
    .set({ watchedAt: now })
    .where(
      and(
        eq(cards.id, id),
        or(
          isNull(cards.watchedAt),
          lt(cards.watchedAt, new Date(now.getTime() - watchWriteMs))
        )
      )
    );
}

/** Whether a card asked about at `watchedAt` is open in front of the person now. */
export function cardWatched(watchedAt: Date | null, now: Date) {
  return (
    watchedAt !== null && now.getTime() - watchedAt.getTime() < watchFreshMs
  );
}

const searchingRunStatuses: ReadonlySet<string> = new Set([
  "created",
  "queued",
  "running",
  "waiting",
]);

/**
 * How the card's latest press stands, for its page: `waiting` for a turn,
 * `queued` behind the turn of an earlier press, `working` in its turn,
 * `searching` while a browser run the turn started has not reported,
 * `done` once the turn is over, and `failed` when it never became one.
 */
export async function readCardPress(cardId: string, now = new Date()) {
  const [row] = await db
    .select({
      action: cardResponses.action,
      createdAt: cardResponses.createdAt,
      deliveredAt: cardResponses.deliveredAt,
      finishedAt: cardResponses.finishedAt,
      id: cardResponses.id,
      item: cardResponses.item,
      kind: cardResponses.kind,
      reportDeliveredAt: browserRuns.reportDeliveredAt,
      revision: cardResponses.revision,
      runStatus: browserRuns.status,
      state: cardResponses.state,
    })
    .from(cardResponses)
    .leftJoin(browserRuns, eq(browserRuns.id, cardResponses.runId))
    .where(eq(cardResponses.cardId, cardId))
    .orderBy(desc(cardResponses.createdAt))
    .limit(1);
  if (!row) return undefined;
  const press = {
    action: row.action,
    item: row.item ?? undefined,
    kind: row.kind,
    revision: row.revision,
  };
  const since = (date: Date | null) =>
    date === null ? Infinity : now.getTime() - date.getTime();
  if (row.state === "failed") return { ...press, stage: "failed" as const };
  if (row.state === "received") {
    if (row.kind === "intent" && since(row.createdAt) >= intentLifetimeMs) {
      return { ...press, stage: "failed" as const };
    }
    const [busy] = await db
      .select({ id: cardResponses.id })
      .from(cardResponses)
      .where(and(eq(cardResponses.id, row.id), cardBusy(now)))
      .limit(1);
    return {
      ...press,
      stage: busy ? ("queued" as const) : ("waiting" as const),
    };
  }
  const searching =
    row.runStatus !== null &&
    row.reportDeliveredAt === null &&
    since(row.deliveredAt) < searchMs &&
    (searchingRunStatuses.has(row.runStatus) || row.finishedAt !== null);
  if (searching) return { ...press, stage: "searching" as const };
  const working =
    row.finishedAt === null && since(row.deliveredAt) < openTurnMs;
  return {
    ...press,
    stage: working ? ("working" as const) : ("done" as const),
  };
}
