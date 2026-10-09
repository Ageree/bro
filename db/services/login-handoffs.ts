import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, loginHandoffs } from "@db";

type Handoff = typeof loginHandoffs.$inferSelect;
type HandoffEnd = Exclude<Handoff["state"], "claimed" | "pending">;

/** How long a delivery of the report holds its claim before another may try. */
const reportLeaseMs = 2 * 60_000;
/** Deliveries tried before the report is given up on. */
const reportAttempts = 5;
const openStates = ["pending", "claimed"] as const;

/**
 * A new link for the workspace. A link sent before and never opened is
 * withdrawn (a person who asks twice has the newer one); one that is open
 * in a viewer blocks the new one until it ends.
 */
export async function createLoginHandoff(
  input: Omit<
    typeof loginHandoffs.$inferInsert,
    "createdAt" | "id" | "state" | "workerId"
  > & { readonly id: string },
  now: Date
) {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`login-handoff:${input.workspaceId}`}))`
    );
    const open = await transaction
      .select()
      .from(loginHandoffs)
      .where(
        and(
          eq(loginHandoffs.workspaceId, input.workspaceId),
          eq(loginHandoffs.state, "claimed"),
          gt(loginHandoffs.viewUntil, now)
        )
      )
      .limit(1);
    if (open[0] !== undefined) return { kind: "busy" as const };
    await transaction
      .update(loginHandoffs)
      .set({ finishedAt: now, reportDeliveredAt: now, state: "cancelled" })
      .where(
        and(
          eq(loginHandoffs.workspaceId, input.workspaceId),
          inArray(loginHandoffs.state, openStates)
        )
      );
    const [row] = await transaction
      .insert(loginHandoffs)
      .values({ ...input, createdAt: now })
      .returning();
    if (row === undefined) throw new Error("The sign-in link was not saved.");
    return { kind: "created" as const, row };
  });
}

export async function readLoginHandoff(id: string) {
  const [row] = await db
    .select()
    .from(loginHandoffs)
    .where(eq(loginHandoffs.id, id))
    .limit(1);
  return row;
}

/**
 * The person opens the link: the first device to do so owns it. The same
 * device asking again (the page reloaded, the browser was still starting)
 * gets it back; another device, an expired link or an ended one gets the
 * reason.
 */
export async function claimLoginHandoff(
  input: {
    readonly deviceHash: string;
    readonly id: string;
    readonly viewMs: number;
    readonly workerId: string;
  },
  now: Date
) {
  const [claimed] = await db
    .update(loginHandoffs)
    .set({
      claimedAt: now,
      deviceHash: input.deviceHash,
      state: "claimed",
      viewUntil: new Date(now.getTime() + input.viewMs),
      workerId: input.workerId,
    })
    .where(
      and(
        eq(loginHandoffs.id, input.id),
        eq(loginHandoffs.state, "pending"),
        gt(loginHandoffs.expiresAt, now)
      )
    )
    .returning();
  if (claimed !== undefined) return { kind: "claimed" as const, row: claimed };
  const row = await readLoginHandoff(input.id);
  if (row === undefined) return { kind: "missing" as const };
  if (
    row.state === "claimed" &&
    row.deviceHash === input.deviceHash &&
    row.viewUntil !== null &&
    row.viewUntil > now
  ) {
    return { kind: "again" as const, row };
  }
  if (row.state === "claimed") return { kind: "taken" as const };
  return { kind: row.state === "pending" ? "expired" : "ended" } as const;
}

/**
 * The handoff is over. Only the first to say so counts, so the viewer's own
 * finish and the settling tick cannot both write a report. `report` is the
 * message the conversation is owed, or null when the person asked for the
 * end themselves and needs no word of it.
 */
export async function endLoginHandoff(
  id: string,
  input: {
    readonly report: string | null;
    readonly resultHost?: string | null;
    readonly signedIn?: boolean | null;
    readonly state: HandoffEnd;
  },
  now: Date
) {
  const [row] = await db
    .update(loginHandoffs)
    .set({
      finishedAt: now,
      report: input.report,
      reportDeliveredAt: input.report === null ? now : null,
      resultHost: input.resultHost ?? null,
      signedIn: input.signedIn ?? null,
      state: input.state,
    })
    .where(
      and(eq(loginHandoffs.id, id), inArray(loginHandoffs.state, openStates))
    )
    .returning();
  return row;
}

/** Links nobody opened in time: ended without a word. */
export async function expireLoginHandoffs(now: Date) {
  await db
    .update(loginHandoffs)
    .set({ finishedAt: now, reportDeliveredAt: now, state: "expired" })
    .where(
      and(eq(loginHandoffs.state, "pending"), lt(loginHandoffs.expiresAt, now))
    );
}

/** The handoffs open on a browser, which only the worker can say the end of. */
export async function listClaimedLoginHandoffs() {
  return db
    .select()
    .from(loginHandoffs)
    .where(eq(loginHandoffs.state, "claimed"));
}

/**
 * The reports owed, each claimed for a delivery: one tick's delivery is not
 * repeated by the next while its lease lasts, and a report that failed
 * `reportAttempts` times is given up on.
 */
export async function claimLoginHandoffReports(now: Date, limit = 10) {
  const due = await db
    .select({ id: loginHandoffs.id })
    .from(loginHandoffs)
    .where(
      and(
        sql`${loginHandoffs.report} is not null`,
        isNull(loginHandoffs.reportDeliveredAt),
        lt(loginHandoffs.reportAttempts, reportAttempts),
        or(
          isNull(loginHandoffs.reportClaimedAt),
          lt(
            loginHandoffs.reportClaimedAt,
            new Date(now.getTime() - reportLeaseMs)
          )
        )
      )
    )
    .limit(limit);
  if (due.length === 0) return [];
  return db
    .update(loginHandoffs)
    .set({
      reportAttempts: sql`${loginHandoffs.reportAttempts} + 1`,
      reportClaimedAt: now,
    })
    .where(
      and(
        inArray(
          loginHandoffs.id,
          due.map((row) => row.id)
        ),
        isNull(loginHandoffs.reportDeliveredAt),
        or(
          isNull(loginHandoffs.reportClaimedAt),
          lt(
            loginHandoffs.reportClaimedAt,
            new Date(now.getTime() - reportLeaseMs)
          )
        )
      )
    )
    .returning();
}

export async function markLoginHandoffReportDelivered(id: string, now: Date) {
  await db
    .update(loginHandoffs)
    .set({ reportDeliveredAt: now })
    .where(eq(loginHandoffs.id, id));
}

/** Give the report back to the next tick, a delivery having failed. */
export async function releaseLoginHandoffReport(id: string) {
  await db
    .update(loginHandoffs)
    .set({ reportClaimedAt: null })
    .where(
      and(eq(loginHandoffs.id, id), isNull(loginHandoffs.reportDeliveredAt))
    );
}
