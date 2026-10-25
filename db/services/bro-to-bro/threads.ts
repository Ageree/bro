import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import * as z from "zod";
import {
  broMandateSchema,
  type BroMandate,
  type BroSide,
} from "@shared/bro-to-bro/contract";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  broLinks,
  broMessages,
  broThreadSides,
  broThreads,
  db,
  type BroReportTarget,
} from "@db";
import { lockBroPair, lockBroWorkspace, readLivePairLinks } from "./pairs";
import { readBroPeople } from "./people";
import {
  broThreadReporter,
  closeBroThread,
  lockBroThreadSides,
  lockOwnBroThread,
  openBroThreadStatuses,
  otherBroSide,
} from "./transitions";

const dayMs = 24 * 60 * 60_000;
/** From a thread's start to the owners' last yes. */
const threadLifetimeMs = 3 * dayMs;
const openThreadsPerPair = 3;
const newThreadsPerPairDaily = 6;
const newThreadsPerWorkspaceDaily = 20;

const ownerAnswerSchema = z.string().trim().min(1).max(2000);

function refused<const Reason extends string>(reason: Reason) {
  return { kind: "refused", reason } as const;
}

function betweenPair(left: string, right: string) {
  return or(
    and(
      eq(broThreads.initiatorWorkspaceId, left),
      eq(broThreads.responderWorkspaceId, right)
    ),
    and(
      eq(broThreads.initiatorWorkspaceId, right),
      eq(broThreads.responderWorkspaceId, left)
    )
  );
}

/**
 * Starts a thread on an active link; the initiator's envoy speaks first, at
 * once. Between one pair at most three threads are open and six start a day,
 * and a workspace starts at most twenty a day, so that nobody maps someone's
 * calendar by asking again and again.
 */
export async function startBroThread(
  scope: AccessScope,
  input: {
    readonly linkId: string;
    readonly mandate: BroMandate;
    readonly reportTarget: BroReportTarget | null;
  },
  now = new Date()
) {
  const mandate = broMandateSchema.parse(input.mandate);
  if (!z.uuid().safeParse(input.linkId).success) return refused("no_link");
  return db.transaction(async (transaction) => {
    const [link] = await transaction
      .select()
      .from(broLinks)
      .where(
        and(
          eq(broLinks.id, input.linkId),
          eq(broLinks.workspaceId, scope.workspaceId),
          eq(broLinks.userId, scope.userId),
          isNull(broLinks.removedAt)
        )
      )
      .limit(1);
    if (!link) return refused("no_link");
    if (link.status !== "active") return refused("link_pending");
    await lockBroWorkspace(transaction, scope.workspaceId);
    await lockBroPair(transaction, scope.workspaceId, link.peerWorkspaceId);
    const dayAgo = new Date(now.getTime() - dayMs);
    const pair = betweenPair(scope.workspaceId, link.peerWorkspaceId);
    const [[open], [pairToday], [workspaceToday]] = await Promise.all([
      transaction
        .select({ value: count() })
        .from(broThreads)
        .where(
          and(pair, inArray(broThreads.status, [...openBroThreadStatuses]))
        ),
      transaction
        .select({ value: count() })
        .from(broThreads)
        .where(and(pair, gt(broThreads.createdAt, dayAgo))),
      transaction
        .select({ value: count() })
        .from(broThreads)
        .where(
          and(
            eq(broThreads.initiatorWorkspaceId, scope.workspaceId),
            gt(broThreads.createdAt, dayAgo)
          )
        ),
    ]);
    if ((open?.value ?? 0) >= openThreadsPerPair)
      return refused("pair_open_limit");
    if ((pairToday?.value ?? 0) >= newThreadsPerPairDaily)
      return refused("pair_daily_limit");
    if ((workspaceToday?.value ?? 0) >= newThreadsPerWorkspaceDaily)
      return refused("daily_limit");
    const [thread] = await transaction
      .insert(broThreads)
      .values({
        initiatorWorkspaceId: scope.workspaceId,
        responderWorkspaceId: link.peerWorkspaceId,
        nextSide: "initiator",
        nextAt: now,
        deadlineAt: new Date(now.getTime() + threadLifetimeMs),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: broThreads.id });
    if (!thread) throw new Error("A Bro thread was not written.");
    await transaction.insert(broThreadSides).values([
      {
        threadId: thread.id,
        side: "initiator",
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        mandate,
        reportTarget: input.reportTarget,
      },
      {
        threadId: thread.id,
        side: "responder",
        workspaceId: link.peerWorkspaceId,
        userId: link.peerUserId,
      },
    ]);
    return { kind: "started", threadId: thread.id } as const;
  });
}

/**
 * A thread as one side may see it: its own side whole, the other side only
 * as an outcome (confirmed, declined) and by name, and the messages that
 * actually passed between the envoys. Neither the agent nor the cabinet
 * reads a thread any other way, so another side's mandate, answers,
 * questions and drafts never leave it. Null for a workspace that is not a
 * side of the thread.
 */
export async function readBroThreadForSide(
  threadId: string,
  workspaceId: string
) {
  if (!z.uuid().safeParse(threadId).success) return null;
  const [thread] = await db
    .select()
    .from(broThreads)
    .where(eq(broThreads.id, threadId))
    .limit(1);
  if (!thread) return null;
  const side: BroSide | null =
    thread.initiatorWorkspaceId === workspaceId
      ? "initiator"
      : thread.responderWorkspaceId === workspaceId
        ? "responder"
        : null;
  if (side === null) return null;
  const peerWorkspaceId =
    side === "initiator"
      ? thread.responderWorkspaceId
      : thread.initiatorWorkspaceId;
  const [sides, links, people, messages] = await Promise.all([
    db
      .select()
      .from(broThreadSides)
      .where(eq(broThreadSides.threadId, threadId)),
    readLivePairLinks(db, workspaceId, peerWorkspaceId),
    readBroPeople(db, [peerWorkspaceId]),
    db
      .select()
      .from(broMessages)
      .where(eq(broMessages.threadId, threadId))
      .orderBy(asc(broMessages.seq)),
  ]);
  const own = sides.find((row) => row.side === side);
  const peer = sides.find((row) => row.side !== side);
  if (!own || !peer) return null;
  const ownLink = links.find((link) => link.workspaceId === workspaceId);
  const peerLink = links.find((link) => link.workspaceId === peerWorkspaceId);
  const lastProposal = messages.findLast(
    (message) => message.action === "propose"
  );
  return {
    id: thread.id,
    side,
    topic: thread.topic,
    status: thread.status,
    nextSide: thread.nextSide,
    nextAt: thread.nextAt,
    deadlineAt: thread.deadlineAt,
    agreedProposalId: thread.agreedProposalId,
    // The proposal this side stands by: its own latest offer while it is
    // the latest, or the one both agreed to.
    openProposalId:
      thread.status === "agreed"
        ? thread.agreedProposalId
        : thread.status === "negotiating" && lastProposal?.side === side
          ? lastProposal.id
          : null,
    version: thread.version,
    envoyMessages: thread.envoyMessages,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    closedAt: thread.closedAt,
    own: {
      userId: own.userId,
      mandate: own.mandate,
      ownerAnswers: own.ownerAnswers,
      waitingOwner: own.waitingOwner,
      pendingQuestion: own.pendingQuestion,
      heldMessage: own.heldMessage,
      confirmedProposalId: own.confirmedProposalId,
      confirmedAt: own.confirmedAt,
      declinedAt: own.declinedAt,
      alertedCategories: own.alertedCategories,
      reportTarget: own.reportTarget,
      calendarState: own.calendarState,
    },
    peer: {
      name: people.get(peerWorkspaceId)?.name ?? null,
      // The owner's own private note: never for an envoy's brief.
      label: ownLink?.peerLabel ?? null,
      confirmed:
        thread.agreedProposalId !== null &&
        peer.confirmedProposalId === thread.agreedProposalId,
      declined: peer.declinedAt !== null,
    },
    // What this side opens to the peer, and the revisions of both
    // directions a step must still match; null once the link is gone.
    link:
      ownLink && peerLink
        ? {
            id: ownLink.id,
            status: ownLink.status,
            calendar: ownLink.calendar,
            shareNotes: ownLink.shareNotes,
            revisions: {
              initiator: (side === "initiator" ? ownLink : peerLink).revision,
              responder: (side === "responder" ? ownLink : peerLink).revision,
            },
          }
        : null,
    messages: messages.map((message) => ({
      id: message.id,
      seq: message.seq,
      from: message.side === side ? ("self" as const) : ("peer" as const),
      action: message.action,
      body: message.body,
      proposal: message.proposal,
      acceptsMessageId: message.acceptsMessageId,
      // This owner let the text go after the gate held it.
      approvedByOwner: message.side === side && message.approvedByOwner,
      createdAt: message.createdAt,
    })),
  };
}

/**
 * The owner's threads, the latest change first; open, closed, or both; with
 * one person only, by the owner's link to them (`linkId`).
 */
export async function listBroThreads(
  scope: AccessScope,
  input: {
    readonly open?: boolean;
    readonly limit: number;
    readonly linkId?: string;
  }
) {
  const open = [...openBroThreadStatuses];
  const [link] =
    input.linkId === undefined
      ? []
      : await db
          .select({ peerWorkspaceId: broLinks.peerWorkspaceId })
          .from(broLinks)
          .where(
            and(
              eq(broLinks.id, input.linkId),
              eq(broLinks.workspaceId, scope.workspaceId),
              eq(broLinks.userId, scope.userId)
            )
          )
          .limit(1);
  if (input.linkId !== undefined && !link) return [];
  const rows = await db
    .select({ thread: broThreads, own: broThreadSides })
    .from(broThreadSides)
    .innerJoin(broThreads, eq(broThreads.id, broThreadSides.threadId))
    .where(
      and(
        eq(broThreadSides.workspaceId, scope.workspaceId),
        eq(broThreadSides.userId, scope.userId),
        input.open === undefined
          ? undefined
          : input.open
            ? inArray(broThreads.status, open)
            : notInArray(broThreads.status, open),
        link ? betweenPair(scope.workspaceId, link.peerWorkspaceId) : undefined
      )
    )
    .orderBy(desc(broThreads.updatedAt))
    .limit(input.limit);
  const peerOf = (thread: (typeof rows)[number]["thread"]) =>
    thread.initiatorWorkspaceId === scope.workspaceId
      ? thread.responderWorkspaceId
      : thread.initiatorWorkspaceId;
  const peers = rows.map(({ thread }) => peerOf(thread));
  const [people, labels] = await Promise.all([
    readBroPeople(db, peers),
    peers.length === 0
      ? []
      : db
          .select({
            peerWorkspaceId: broLinks.peerWorkspaceId,
            peerLabel: broLinks.peerLabel,
          })
          .from(broLinks)
          .where(
            and(
              eq(broLinks.workspaceId, scope.workspaceId),
              inArray(broLinks.peerWorkspaceId, peers)
            )
          )
          .orderBy(desc(broLinks.createdAt)),
  ]);
  return rows.map(({ thread, own }) => {
    const peerWorkspaceId = peerOf(thread);
    return {
      id: thread.id,
      side: own.side,
      topic: thread.topic,
      status: thread.status,
      peerName: people.get(peerWorkspaceId)?.name ?? null,
      peerLabel:
        labels.find((label) => label.peerWorkspaceId === peerWorkspaceId)
          ?.peerLabel ?? null,
      waitingOwner: own.waitingOwner,
      pendingQuestion: own.pendingQuestion,
      heldDraftId: own.heldMessage?.id ?? null,
      agreedProposalId: thread.agreedProposalId,
      confirmedByMe:
        thread.agreedProposalId !== null &&
        own.confirmedProposalId === thread.agreedProposalId,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      closedAt: thread.closedAt,
    };
  });
}

/**
 * The owner tells their envoy something: an answer to its question, or a
 * correction instead of approving a held draft (which is dropped). The
 * envoy reads it on its next turn, at once if the turn is this side's. A
 * thread that is no longer negotiating takes no answers.
 *
 * `said` is the second version's, what code read of the owner's own words
 * (`bro_talk answer`): the sums in them and what they say the owner
 * pays for, which the gate lets go, and the proposal their plain yes was to —
 * kept only while it is the peer's latest, and then, once the envoy accepts
 * exactly it, their side is confirmed (`recordEnvoyStep`).
 */
export async function appendOwnerAnswer(
  scope: AccessScope,
  threadId: string,
  text: string,
  now = new Date(),
  said: {
    readonly amountsRub?: readonly number[];
    readonly paysFor?: readonly string[];
    readonly peerPays?: readonly string[];
    readonly yesTo?: string;
  } = {}
) {
  const answer = {
    id: randomUUID(),
    at: now.toISOString(),
    text: ownerAnswerSchema.parse(text),
    ...(said.amountsRub &&
      said.amountsRub.length > 0 && { amountsRub: said.amountsRub }),
    ...(said.paysFor && said.paysFor.length > 0 && { paysFor: said.paysFor }),
    ...(said.peerPays &&
      said.peerPays.length > 0 && { peerPays: said.peerPays }),
  };
  return db.transaction(async (transaction) => {
    const own = await lockOwnBroThread(transaction, scope, threadId);
    if (!own) return { kind: "none" } as const;
    if (own.thread.status !== "negotiating")
      return refused(own.thread.status === "agreed" ? "agreed" : "closed");
    const [latest] =
      said.yesTo === undefined
        ? []
        : await transaction
            .select({ id: broMessages.id, side: broMessages.side })
            .from(broMessages)
            .where(
              and(
                eq(broMessages.threadId, own.thread.id),
                eq(broMessages.action, "propose")
              )
            )
            .orderBy(desc(broMessages.seq))
            .limit(1);
    const yesTo =
      latest && latest.id === said.yesTo && latest.side !== own.side
        ? latest.id
        : undefined;
    const sides = await lockBroThreadSides(transaction, own.thread.id);
    await transaction
      .update(broThreadSides)
      .set({
        ownerAnswers: [
          ...sides[own.side].ownerAnswers,
          yesTo === undefined ? answer : { ...answer, yesTo },
        ],
        waitingOwner: false,
        pendingQuestion: null,
        heldMessage: null,
      })
      .where(
        and(
          eq(broThreadSides.threadId, own.thread.id),
          eq(broThreadSides.side, own.side)
        )
      );
    await transaction
      .update(broThreads)
      .set({
        version: sql`${broThreads.version} + 1`,
        updatedAt: now,
        nextAt: own.thread.nextSide === own.side ? now : own.thread.nextAt,
      })
      .where(eq(broThreads.id, own.thread.id));
    return {
      kind: "answered",
      answerId: answer.id,
      yesTo: yesTo ?? null,
    } as const;
  });
}

/**
 * The owner lets exactly this held draft go. Only the id of the draft that
 * is held now approves it; the envoy's next turn sends it word for word.
 */
export async function approveHeldMessage(
  scope: AccessScope,
  threadId: string,
  draftId: string,
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const own = await lockOwnBroThread(transaction, scope, threadId);
    if (!own) return { kind: "none" } as const;
    if (own.thread.status !== "negotiating") return refused("closed");
    const sides = await lockBroThreadSides(transaction, own.thread.id);
    const held = sides[own.side].heldMessage;
    if (held?.id !== draftId) return refused("stale_draft");
    if (held.approved) return { kind: "approved" } as const;
    await transaction
      .update(broThreadSides)
      .set({ heldMessage: { ...held, approved: true }, waitingOwner: false })
      .where(
        and(
          eq(broThreadSides.threadId, own.thread.id),
          eq(broThreadSides.side, own.side)
        )
      );
    await transaction
      .update(broThreads)
      .set({
        version: sql`${broThreads.version} + 1`,
        updatedAt: now,
        nextAt: now,
      })
      .where(eq(broThreads.id, own.thread.id));
    return { kind: "approved" } as const;
  });
}

/**
 * The owner says yes to the agreed proposal, by its id: a yes to an older
 * proposal, after the thread's deadline or once the meeting has begun is
 * refused — a meeting in the past goes in no calendar. When both owners
 * said yes, the thread is confirmed, and each side's meeting waits to go
 * into that owner's own calendar: their yes to the meeting is their yes to
 * it. Each owner hears the result once their calendar was tried
 * (`finishBroCalendarWrite`).
 */
export async function confirmBroThread(
  scope: AccessScope,
  threadId: string,
  proposalId: string,
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const own = await lockOwnBroThread(transaction, scope, threadId);
    if (!own) return { kind: "none" } as const;
    const { thread, side } = own;
    if (thread.status !== "agreed") return refused("not_agreed");
    if (thread.deadlineAt <= now) return refused("expired");
    if (thread.agreedProposalId !== proposalId)
      return refused("stale_proposal");
    const [agreed] = await transaction
      .select({ proposal: broMessages.proposal })
      .from(broMessages)
      .where(
        and(eq(broMessages.id, proposalId), eq(broMessages.threadId, thread.id))
      )
      .limit(1);
    const start = agreed?.proposal?.start;
    if (start !== undefined && Date.parse(start) <= now.getTime())
      return refused("past");
    const sides = await lockBroThreadSides(transaction, thread.id);
    await transaction
      .update(broThreadSides)
      .set({ confirmedProposalId: proposalId, confirmedAt: now })
      .where(
        and(
          eq(broThreadSides.threadId, thread.id),
          eq(broThreadSides.side, side)
        )
      );
    if (sides[otherBroSide(side)].confirmedProposalId !== proposalId) {
      await transaction
        .update(broThreads)
        .set({ version: sql`${broThreads.version} + 1`, updatedAt: now })
        .where(eq(broThreads.id, thread.id));
      return { kind: "confirmed", both: false } as const;
    }
    await closeBroThread(transaction, thread.id, "confirmed", now);
    await transaction
      .update(broThreadSides)
      .set({ calendarState: "pending", calendarNextAt: now })
      .where(eq(broThreadSides.threadId, thread.id));
    return { kind: "confirmed", both: true } as const;
  });
}

/** The owner closes an open thread; the peer's owner hears who closed it. */
async function closeByOwner(
  scope: AccessScope,
  threadId: string,
  status: "cancelled" | "declined",
  now: Date
) {
  return db.transaction(async (transaction) => {
    const own = await lockOwnBroThread(transaction, scope, threadId);
    if (!own) return { kind: "none" } as const;
    const { thread, side } = own;
    if (thread.closedAt !== null) return refused("closed");
    const sides = await lockBroThreadSides(transaction, thread.id);
    if (status === "declined")
      await transaction
        .update(broThreadSides)
        .set({ declinedAt: now })
        .where(
          and(
            eq(broThreadSides.threadId, thread.id),
            eq(broThreadSides.side, side)
          )
        );
    await closeBroThread(transaction, thread.id, status, now);
    const report = await broThreadReporter(transaction, thread, sides);
    await report(otherBroSide(side), status, { by: "peer" });
    return { kind: status } as const;
  });
}

/**
 * The owner says no: to the proposal waiting for their yes, or to the
 * errand itself. The owner's own words are not passed on: they never went
 * through the gate.
 */
export async function declineBroThread(
  scope: AccessScope,
  threadId: string,
  now = new Date()
) {
  return closeByOwner(scope, threadId, "declined", now);
}

/** The owner calls the errand off. */
export async function cancelBroThread(
  scope: AccessScope,
  threadId: string,
  now = new Date()
) {
  return closeByOwner(scope, threadId, "cancelled", now);
}
