import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { BroCalendarState, BroSide } from "@shared/bro-to-bro/contract";
import { broMessages, broThreadSides, broThreads, db } from "@db";
import { broThreadReporter, lockBroThreadSides } from "./transitions";

/** Tries a meeting gets before its owner hears it is not in the calendar. */
const calendarAttempts = 3;

/**
 * Leases the sides of confirmed threads whose meeting is still to go into
 * the owner's own calendar, the longest due first. The lease is the side's
 * `calendar_next_at`: nobody takes the side again before it passes, so a
 * try lost to a restart is taken up after it, and each claim counts as a
 * try.
 */
export async function claimBroCalendarWrites(
  input: { readonly limit: number; readonly leaseMs: number },
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const due = await transaction
      .select({
        threadId: broThreadSides.threadId,
        side: broThreadSides.side,
      })
      .from(broThreadSides)
      .where(
        and(
          eq(broThreadSides.calendarState, "pending"),
          lte(broThreadSides.calendarNextAt, now)
        )
      )
      .orderBy(asc(broThreadSides.calendarNextAt))
      .limit(input.limit)
      .for("update", { skipLocked: true });
    const calendarNextAt = new Date(now.getTime() + input.leaseMs);
    return Promise.all(
      due.map(async (row) => {
        const [claimed] = await transaction
          .update(broThreadSides)
          .set({
            calendarNextAt,
            calendarAttempts: sql`${broThreadSides.calendarAttempts} + 1`,
          })
          .where(
            and(
              eq(broThreadSides.threadId, row.threadId),
              eq(broThreadSides.side, row.side)
            )
          )
          .returning({
            threadId: broThreadSides.threadId,
            side: broThreadSides.side,
            workspaceId: broThreadSides.workspaceId,
            userId: broThreadSides.userId,
            attempt: broThreadSides.calendarAttempts,
          });
        if (!claimed) throw new Error("Bro calendar lease claim lost.");
        return claimed;
      })
    );
  });
}

/**
 * Settles one try at putting a confirmed meeting in its owner's calendar,
 * while the side still waits for exactly this try. A failed try is tried
 * again after a pause that doubles, three tries in all. Once the meeting is
 * in the calendar, or skipped or failed for good, the owner's report of the
 * confirmed thread is queued with what became of it: the report waits for
 * the try, and never asks whether to add the meeting. The side's state
 * after the call, or null for a try that is no longer the side's.
 */
export async function finishBroCalendarWrite(
  write: {
    readonly threadId: string;
    readonly side: BroSide;
    readonly attempt: number;
  },
  result:
    | { readonly state: "created"; readonly eventId: string }
    | {
        readonly state: Exclude<BroCalendarState, "created" | "pending">;
      },
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const [thread] = await transaction
      .select()
      .from(broThreads)
      .where(eq(broThreads.id, write.threadId))
      .limit(1)
      .for("update");
    if (!thread) return null;
    const sides = await lockBroThreadSides(transaction, thread.id);
    const own = sides[write.side];
    if (
      own.calendarState !== "pending" ||
      own.calendarAttempts !== write.attempt
    )
      return null;
    const side = and(
      eq(broThreadSides.threadId, thread.id),
      eq(broThreadSides.side, write.side)
    );
    if (result.state === "failed" && write.attempt < calendarAttempts) {
      await transaction
        .update(broThreadSides)
        .set({
          calendarNextAt: new Date(
            now.getTime() + 60_000 * 2 ** (write.attempt - 1)
          ),
        })
        .where(side);
      return "pending" as const;
    }
    await transaction
      .update(broThreadSides)
      .set({
        calendarState: result.state,
        calendarEventId: result.state === "created" ? result.eventId : null,
        calendarNextAt: null,
      })
      .where(side);
    const [agreed] = thread.agreedProposalId
      ? await transaction
          .select({ proposal: broMessages.proposal })
          .from(broMessages)
          .where(eq(broMessages.id, thread.agreedProposalId))
          .limit(1)
      : [];
    const report = await broThreadReporter(transaction, thread, sides);
    await report(write.side, "confirmed", {
      calendar: result.state,
      proposal: agreed?.proposal ?? undefined,
      proposalId: thread.agreedProposalId ?? undefined,
    });
    return result.state;
  });
}
