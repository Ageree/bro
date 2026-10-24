import {
  and,
  asc,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { broSides } from "@shared/bro-to-bro/contract";
import {
  broInvites,
  broLinks,
  broMessages,
  broReports,
  broThreadSides,
  broThreads,
  db,
} from "@db";
import {
  broThreadReporter,
  closeBroThread,
  lockBroThreadSides,
  openBroThreadStatuses,
} from "./transitions";

const dayMs = 24 * 60 * 60_000;
/** How long private words outlive their thread. */
const privateRetentionMs = 30 * dayMs;
/** How long what was actually said to a peer is kept. */
const messageRetentionMs = 180 * dayMs;

/**
 * Closes threads past their deadline, agreed ones waiting for a yes
 * included: both owners hear they ran out of time, not that anyone said no.
 */
export async function expireBroThreads(now = new Date(), limit = 100) {
  return db.transaction(async (transaction) => {
    const due = await transaction
      .select()
      .from(broThreads)
      .where(
        and(
          inArray(broThreads.status, [...openBroThreadStatuses]),
          lte(broThreads.deadlineAt, now)
        )
      )
      .orderBy(asc(broThreads.deadlineAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    await Promise.all(
      due.map(async (thread) => {
        const sides = await lockBroThreadSides(transaction, thread.id);
        await closeBroThread(transaction, thread.id, "expired", now);
        const report = await broThreadReporter(transaction, thread, sides);
        await Promise.all(broSides.map((side) => report(side, "expired")));
      })
    );
    return due.map((thread) => thread.id);
  });
}

/**
 * Erases what was private to a side (mandates, owners' answers, questions,
 * drafts, and the reports that quoted them) and the thread's topic 30 days
 * after the thread closed; what an owner opened to a peer and called them
 * («что можно рассказывать», the label) 30 days after the link was removed;
 * an invite's label 30 days after it was used or ran out; and the messages
 * the envoys exchanged after 180 days.
 */
export async function purgeBroThreads(now = new Date()) {
  const privateBefore = new Date(now.getTime() - privateRetentionMs);
  return db.transaction(async (transaction) => {
    const topics = await transaction
      .update(broThreads)
      .set({ topic: null })
      .where(
        and(lt(broThreads.closedAt, privateBefore), isNotNull(broThreads.topic))
      )
      .returning({ id: broThreads.id });
    const links = await transaction
      .update(broLinks)
      .set({ shareNotes: null, peerLabel: null })
      .where(
        and(
          lt(broLinks.removedAt, privateBefore),
          or(isNotNull(broLinks.shareNotes), isNotNull(broLinks.peerLabel))
        )
      )
      .returning({ id: broLinks.id });
    const invites = await transaction
      .update(broInvites)
      .set({ label: null })
      .where(
        and(
          isNotNull(broInvites.label),
          or(
            lt(broInvites.redeemedAt, privateBefore),
            lt(broInvites.expiresAt, privateBefore)
          )
        )
      )
      .returning({ id: broInvites.id });
    const sides = await transaction
      .update(broThreadSides)
      .set({
        mandate: null,
        ownerAnswers: [],
        pendingQuestion: null,
        heldMessage: null,
      })
      .where(
        and(
          inArray(
            broThreadSides.threadId,
            transaction
              .select({ id: broThreads.id })
              .from(broThreads)
              .where(lt(broThreads.closedAt, privateBefore))
          ),
          or(
            isNotNull(broThreadSides.mandate),
            ne(broThreadSides.ownerAnswers, sql`'[]'::jsonb`),
            isNotNull(broThreadSides.pendingQuestion),
            isNotNull(broThreadSides.heldMessage)
          )
        )
      )
      .returning({ threadId: broThreadSides.threadId });
    const reports = await transaction
      .delete(broReports)
      .where(
        and(
          inArray(broReports.status, ["delivered", "dropped"]),
          lt(broReports.createdAt, privateBefore)
        )
      )
      .returning({ id: broReports.id });
    const messages = await transaction
      .delete(broMessages)
      .where(
        lt(broMessages.createdAt, new Date(now.getTime() - messageRetentionMs))
      )
      .returning({ id: broMessages.id });
    return {
      sides: sides.length,
      topics: topics.length,
      links: links.length,
      invites: invites.length,
      reports: reports.length,
      messages: messages.length,
    };
  });
}
