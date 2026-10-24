import { and, desc, eq, or, sql } from "drizzle-orm";
import * as z from "zod";
import type {
  broClosedThreadStatuses,
  BroReportKind,
  BroSide,
  BroThreadStatus,
} from "@shared/bro-to-bro/contract";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  broLinks,
  broThreadSides,
  broThreads,
  type BroReportPayload,
  type db,
} from "@db";
import { readBroPeople } from "./people";
import { enqueueBroReport } from "./reports";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Statuses a thread still moves from. */
export const openBroThreadStatuses = [
  "negotiating",
  "agreed",
] as const satisfies readonly BroThreadStatus[];

export function otherBroSide(side: BroSide) {
  return side === "initiator" ? "responder" : "initiator";
}

/**
 * The thread, locked, when the scope's owner is one of its sides, and which
 * side that is.
 */
export async function lockOwnBroThread(
  transaction: Transaction,
  scope: AccessScope,
  threadId: string
) {
  if (!z.uuid().safeParse(threadId).success) return undefined;
  const [row] = await transaction
    .select({ thread: broThreads, side: broThreadSides.side })
    .from(broThreads)
    .innerJoin(
      broThreadSides,
      and(
        eq(broThreadSides.threadId, broThreads.id),
        eq(broThreadSides.workspaceId, scope.workspaceId),
        eq(broThreadSides.userId, scope.userId)
      )
    )
    .where(eq(broThreads.id, threadId))
    .limit(1)
    .for("update", { of: broThreads });
  return row;
}

/** Both sides of a thread, locked after the thread itself. */
export async function lockBroThreadSides(
  transaction: Transaction,
  threadId: string
) {
  const rows = await transaction
    .select()
    .from(broThreadSides)
    .where(eq(broThreadSides.threadId, threadId))
    .for("update");
  const initiator = rows.find((row) => row.side === "initiator");
  const responder = rows.find((row) => row.side === "responder");
  if (!initiator || !responder)
    throw new Error("A Bro thread is missing one of its sides.");
  return { initiator, responder };
}

/**
 * Closes a thread for good: no envoy moves again and nothing waits for an
 * owner, so an unsent draft and an unanswered question go with it.
 */
export async function closeBroThread(
  transaction: Transaction,
  threadId: string,
  status: (typeof broClosedThreadStatuses)[number],
  now: Date
) {
  await transaction
    .update(broThreads)
    .set({
      status,
      closedAt: now,
      updatedAt: now,
      nextSide: null,
      nextAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      version: sql`${broThreads.version} + 1`,
    })
    .where(eq(broThreads.id, threadId));
  await transaction
    .update(broThreadSides)
    .set({ waitingOwner: false, pendingQuestion: null, heldMessage: null })
    .where(eq(broThreadSides.threadId, threadId));
}

/**
 * Queues a thread's reports to its sides. Each names the peer the way the
 * receiving owner knows them, goes where that side's reports go, and is
 * keyed by its event, so the same event is never reported twice.
 */
export async function broThreadReporter(
  transaction: Transaction,
  thread: Pick<
    typeof broThreads.$inferSelect,
    "id" | "initiatorWorkspaceId" | "responderWorkspaceId" | "topic"
  >,
  sides: Awaited<ReturnType<typeof lockBroThreadSides>>
) {
  const [people, labels] = await Promise.all([
    readBroPeople(transaction, [
      thread.initiatorWorkspaceId,
      thread.responderWorkspaceId,
    ]),
    transaction
      .select({
        workspaceId: broLinks.workspaceId,
        peerLabel: broLinks.peerLabel,
      })
      .from(broLinks)
      .where(
        or(
          and(
            eq(broLinks.workspaceId, thread.initiatorWorkspaceId),
            eq(broLinks.peerWorkspaceId, thread.responderWorkspaceId)
          ),
          and(
            eq(broLinks.workspaceId, thread.responderWorkspaceId),
            eq(broLinks.peerWorkspaceId, thread.initiatorWorkspaceId)
          )
        )
      )
      .orderBy(desc(broLinks.createdAt)),
  ]);
  return async (
    side: BroSide,
    kind: BroReportKind,
    details: Omit<BroReportPayload, "peerLabel" | "peerName" | "topic"> = {},
    event: string = kind
  ) => {
    const owner = sides[side];
    const peer = sides[otherBroSide(side)];
    await enqueueBroReport(transaction, {
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      threadId: thread.id,
      kind,
      payload: {
        peerName: people.get(peer.workspaceId)?.name ?? null,
        peerLabel:
          labels.find((label) => label.workspaceId === owner.workspaceId)
            ?.peerLabel ?? null,
        topic: thread.topic,
        ...details,
      },
      target: owner.reportTarget,
      dedupeKey: `bro:thread:${thread.id}:${side}:${event}`,
    });
  };
}
