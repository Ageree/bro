import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { db, taxiWatches } from "@db";

/** How long a watch lives: a ride that is not over by then is let go. */
const watchLifetimeMs = 3 * 60 * 60 * 1000;

/** Starts watching a booked ride; the same order is watched once. */
export async function startTaxiWatch(
  input: Pick<
    typeof taxiWatches.$inferInsert,
    | "conversationChannel"
    | "conversationId"
    | "forPassenger"
    | "orderId"
    | "userId"
    | "workspaceId"
  >,
  now: Date
) {
  await db
    .insert(taxiWatches)
    .values({
      ...input,
      expiresAt: new Date(now.getTime() + watchLifetimeMs),
      nextCheckAt: now,
    })
    .onConflictDoNothing();
}

/**
 * Takes the watches whose time has come and holds them for `leaseMs`, so the
 * next tick does not read the same ride while this one still does. Watches
 * past their life end here.
 */
export async function claimDueTaxiWatches(now: Date, leaseMs: number) {
  await db
    .update(taxiWatches)
    .set({ state: "done" })
    .where(
      and(eq(taxiWatches.state, "watching"), lte(taxiWatches.expiresAt, now))
    );
  const due = await db
    .select({ id: taxiWatches.id })
    .from(taxiWatches)
    .where(
      and(eq(taxiWatches.state, "watching"), lte(taxiWatches.nextCheckAt, now))
    )
    .limit(20);
  if (due.length === 0) return [];
  return db
    .update(taxiWatches)
    .set({ nextCheckAt: new Date(now.getTime() + leaseMs) })
    .where(
      and(
        inArray(
          taxiWatches.id,
          due.map((row) => row.id)
        ),
        eq(taxiWatches.state, "watching"),
        lte(taxiWatches.nextCheckAt, now)
      )
    )
    .returning();
}

/** What the last read of the ride found, and when to read it next. */
export async function noteTaxiWatch(
  id: string,
  seen: { readonly car: string | null; readonly status: string | null },
  nextCheckAt: Date
) {
  await db
    .update(taxiWatches)
    .set({ ...seen, nextCheckAt })
    .where(and(eq(taxiWatches.id, id), eq(taxiWatches.state, "watching")));
}

export async function finishTaxiWatch(id: string) {
  await db
    .update(taxiWatches)
    .set({ state: "done" })
    .where(eq(taxiWatches.id, id));
}

const toldColumns = {
  arrived: "arrivedToldAt",
  found: "foundToldAt",
  leave: "leaveToldAt",
} as const;

export type TaxiNotice = keyof typeof toldColumns;

/**
 * Marks a notice as told before it is sent, so two ticks never send it
 * twice; false when it was told already.
 */
export async function claimTaxiNotice(
  id: string,
  notice: TaxiNotice,
  now: Date
) {
  const column = toldColumns[notice];
  const claimed = await db
    .update(taxiWatches)
    .set({ [column]: now })
    .where(and(eq(taxiWatches.id, id), isNull(taxiWatches[column])))
    .returning({ id: taxiWatches.id });
  return claimed.length > 0;
}

/** A notice that did not land is told by the next read. */
export async function releaseTaxiNotice(id: string, notice: TaxiNotice) {
  await db
    .update(taxiWatches)
    .set({ [toldColumns[notice]]: null })
    .where(eq(taxiWatches.id, id));
}
