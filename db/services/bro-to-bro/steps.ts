import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  broProposalSchema,
  broSides,
  type BroSide,
  type BroThreadStatus,
} from "@shared/bro-to-bro/contract";
import {
  broMessages,
  broReports,
  broThreadSides,
  broThreads,
  db,
  type BroEnvoyPackage,
} from "@db";
import { readLivePairLinks } from "./pairs";
import {
  broThreadReporter,
  closeBroThread,
  lockBroThreadSides,
  otherBroSide,
} from "./transitions";

/** Messages the two envoys may exchange before the thread stalls. */
export const envoyMessageLimit = 12;
/** Envoy steps that may fail in a row before the thread stalls. */
const failedStepLimit = 3;
/** Alerts one owner hears in one thread, however much the peer fishes. */
const alertLimit = 3;
const topicLength = 140;

function rejected<const Reason extends string>(reason: Reason) {
  return { kind: "rejected", reason } as const;
}

/**
 * The greeting an envoy opens a thread with (`agent/lib/bro-to-bro/envoy.ts`):
 * «Привет! Бро Ани на связи.» says nothing of what the thread is about.
 */
const greeting =
  /^(?:привет|здравствуй(?:те)?)[!,.]?\s+бро\s+[\p{L}'-]+(?:\s+[\p{L}'-]+)?\s+на\s+связи[.!]?\s*/iu;

/**
 * What both sides see a thread is about: its first message that went out,
 * the proposal's summary or the words past the envoy's greeting.
 */
function topicOf(message: BroEnvoyPackage) {
  const said = message.body.trim();
  const words = (
    message.proposal?.summary ??
    (said.replace(greeting, "") || said)
  )
    .replaceAll(/\s+/gu, " ")
    .trim();
  return words.length <= topicLength
    ? words
    : `${words.slice(0, topicLength - 1).trimEnd()}…`;
}

/**
 * Whether a package may go out now: a proposal is well formed, and an accept
 * agrees to the latest proposal of the thread, made by the other side.
 */
function packageAllowed(
  message: BroEnvoyPackage,
  side: BroSide,
  latestProposal: { readonly id: string; readonly side: BroSide } | undefined
) {
  if (message.body.trim() === "") return false;
  if (message.action === "propose")
    return broProposalSchema.safeParse(message.proposal).success;
  if (message.action === "accept")
    return (
      latestProposal !== undefined &&
      latestProposal.side !== side &&
      message.acceptsMessageId === latestProposal.id
    );
  return true;
}

/**
 * Leases threads whose envoy has a move now: negotiating, due, within their
 * deadline, with no side waiting for its owner, and no live lease. Each comes
 * with the side to move and both workspaces.
 */
export async function claimDueBroThreads(
  input: { readonly limit: number; readonly leaseMs: number },
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const due = await transaction
      .select({
        id: broThreads.id,
        nextSide: broThreads.nextSide,
        initiatorWorkspaceId: broThreads.initiatorWorkspaceId,
        responderWorkspaceId: broThreads.responderWorkspaceId,
      })
      .from(broThreads)
      .where(
        and(
          eq(broThreads.status, "negotiating"),
          isNotNull(broThreads.nextSide),
          lte(broThreads.nextAt, now),
          gt(broThreads.deadlineAt, now),
          or(
            isNull(broThreads.leaseExpiresAt),
            lte(broThreads.leaseExpiresAt, now)
          ),
          notExists(
            transaction
              .select({ side: broThreadSides.side })
              .from(broThreadSides)
              .where(
                and(
                  eq(broThreadSides.threadId, broThreads.id),
                  eq(broThreadSides.waitingOwner, true)
                )
              )
          )
        )
      )
      .orderBy(asc(broThreads.nextAt))
      .limit(input.limit)
      .for("update", { of: broThreads, skipLocked: true });
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    const claimed = await Promise.all(
      due.map(async (thread) => {
        const leaseToken = randomUUID();
        await transaction
          .update(broThreads)
          .set({ leaseToken, leaseExpiresAt })
          .where(eq(broThreads.id, thread.id));
        if (thread.nextSide === null) return [];
        const initiator = thread.nextSide === "initiator";
        return [
          {
            threadId: thread.id,
            side: thread.nextSide,
            workspaceId: initiator
              ? thread.initiatorWorkspaceId
              : thread.responderWorkspaceId,
            peerWorkspaceId: initiator
              ? thread.responderWorkspaceId
              : thread.initiatorWorkspaceId,
            leaseToken,
          },
        ];
      })
    );
    return claimed.flat();
  });
}

/**
 * Records one envoy step of the side whose turn it is, all in one
 * transaction. The step counts only while its lease is live and the thread
 * version, the link's status and both directions' revisions are still those
 * the brief was built on; otherwise nothing is written.
 *
 * - `sent` / `sent_held` (an approved draft, word for word): the message goes
 *   to the peer. An accept of the peer's latest proposal makes the thread
 *   agreed, and both owners are asked to confirm; a decline closes it as
 *   declined for both; a close answers a simple request (the initiator
 *   hears the responder's last words); otherwise the turn passes, and the
 *   twelfth message without an agreement stalls the thread.
 * - `asked_owner`: the side waits for its owner, optionally after telling
 *   the peer it will come back; the peer is not told about the question.
 * - `held`: the gate kept the package; the side waits for its owner, who
 *   approves exactly this draft or says something else.
 *
 * What the peer's envoy fished for alerts this owner: one alert a step,
 * naming each category the owner has not heard of in this thread yet, and
 * three alerts a thread at most.
 */
export async function recordEnvoyStep(
  threadId: string,
  leaseToken: string,
  step: {
    readonly side: BroSide;
    readonly threadVersion: number;
    readonly linkRevisions: {
      readonly initiator: number;
      readonly responder: number;
    };
    readonly outcome:
      | { readonly kind: "sent"; readonly message: BroEnvoyPackage }
      | { readonly kind: "sent_held"; readonly draftId: string }
      | {
          readonly kind: "asked_owner";
          readonly question: string;
          readonly message: string | null;
        }
      | {
          readonly kind: "held";
          readonly draft: BroEnvoyPackage;
          readonly reason: string;
        };
    readonly outOfScope: readonly {
      readonly category: string;
      readonly request: string;
    }[];
  },
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const [thread] = await transaction
      .select()
      .from(broThreads)
      .where(eq(broThreads.id, threadId))
      .limit(1)
      .for("update");
    if (
      thread?.leaseToken !== leaseToken ||
      thread.leaseExpiresAt === null ||
      thread.leaseExpiresAt <= now
    )
      return rejected("lease");
    if (thread.version !== step.threadVersion) return rejected("version");
    if (thread.status !== "negotiating" || thread.nextSide !== step.side)
      return rejected("turn");
    const links = await readLivePairLinks(
      transaction,
      thread.initiatorWorkspaceId,
      thread.responderWorkspaceId,
      "share"
    );
    const linkStale = broSides.some((side) => {
      const link = links.find(
        (row) =>
          row.workspaceId ===
          (side === "initiator"
            ? thread.initiatorWorkspaceId
            : thread.responderWorkspaceId)
      );
      return (
        link?.status !== "active" || link.revision !== step.linkRevisions[side]
      );
    });
    if (linkStale) return rejected("link");
    const sides = await lockBroThreadSides(transaction, thread.id);
    const own = sides[step.side];
    const [[last], [latestProposal], [alerted]] = await Promise.all([
      transaction
        .select({ seq: sql<number>`coalesce(max(${broMessages.seq}), 0)::int` })
        .from(broMessages)
        .where(eq(broMessages.threadId, thread.id)),
      transaction
        .select({
          id: broMessages.id,
          side: broMessages.side,
          proposal: broMessages.proposal,
        })
        .from(broMessages)
        .where(
          and(
            eq(broMessages.threadId, thread.id),
            eq(broMessages.action, "propose")
          )
        )
        .orderBy(desc(broMessages.seq))
        .limit(1),
      transaction
        .select({ value: count() })
        .from(broReports)
        .where(
          and(
            eq(broReports.threadId, thread.id),
            eq(broReports.workspaceId, own.workspaceId),
            eq(broReports.kind, "alert")
          )
        ),
    ]);
    const { outcome } = step;
    const held = own.heldMessage;
    const sent =
      outcome.kind === "sent"
        ? { message: outcome.message, approvedByOwner: false }
        : outcome.kind === "sent_held" &&
            held?.id === outcome.draftId &&
            held.approved
          ? { message: held, approvedByOwner: true }
          : null;
    if (outcome.kind === "sent_held" && sent === null) return rejected("draft");
    const checked =
      sent?.message ?? (outcome.kind === "held" ? outcome.draft : null);
    if (checked && !packageAllowed(checked, step.side, latestProposal))
      return rejected("package");
    if (outcome.kind === "asked_owner" && outcome.question.trim() === "")
      return rejected("package");

    const outgoing: {
      readonly message: BroEnvoyPackage;
      readonly approvedByOwner: boolean;
    } | null =
      sent ??
      (outcome.kind === "asked_owner" && outcome.message?.trim()
        ? {
            message: { action: "message", body: outcome.message },
            approvedByOwner: false,
          }
        : null);
    const [inserted] = outgoing
      ? await transaction
          .insert(broMessages)
          .values({
            threadId: thread.id,
            seq: (last?.seq ?? 0) + 1,
            side: step.side,
            action: outgoing.message.action,
            body: outgoing.message.body.trim(),
            proposal:
              outgoing.message.action === "propose"
                ? outgoing.message.proposal
                : null,
            acceptsMessageId:
              outgoing.message.action === "accept"
                ? outgoing.message.acceptsMessageId
                : null,
            approvedByOwner: outgoing.approvedByOwner,
            createdAt: now,
          })
          .returning({ id: broMessages.id })
      : [];
    const envoyMessages = thread.envoyMessages + (outgoing ? 1 : 0);
    const topic = thread.topic ?? (sent ? topicOf(sent.message) : null);
    const action = sent?.message.action;
    const status: BroThreadStatus =
      action === "accept"
        ? "agreed"
        : action === "decline"
          ? "declined"
          : action === "close"
            ? "answered"
            : envoyMessages >= envoyMessageLimit
              ? "stalled"
              : "negotiating";
    const waits =
      status === "negotiating" &&
      (outcome.kind === "asked_owner" || outcome.kind === "held");
    const report = await broThreadReporter(
      transaction,
      { ...thread, topic },
      sides
    );

    const fresh = [
      ...new Map(
        step.outOfScope
          .map((item) => ({
            category: item.category.trim().toLowerCase(),
            request: item.request.trim(),
          }))
          .filter(
            (item) =>
              item.category !== "" &&
              !own.alertedCategories.includes(item.category)
          )
          .map((item) => [item.category, item])
      ).values(),
    ];
    const question =
      waits && outcome.kind === "asked_owner"
        ? {
            id: randomUUID(),
            at: now.toISOString(),
            text: outcome.question.trim(),
          }
        : null;
    const draft =
      waits && outcome.kind === "held"
        ? {
            ...outcome.draft,
            body: outcome.draft.body.trim(),
            id: randomUUID(),
            at: now.toISOString(),
            reason: outcome.reason,
            approved: false,
          }
        : null;
    await transaction
      .update(broThreadSides)
      .set({
        alertedCategories: [
          ...own.alertedCategories,
          ...fresh.map((item) => item.category),
        ],
        waitingOwner: waits,
        pendingQuestion: question,
        heldMessage: draft,
        declinedAt: action === "decline" ? now : own.declinedAt,
      })
      .where(
        and(
          eq(broThreadSides.threadId, thread.id),
          eq(broThreadSides.side, step.side)
        )
      );
    await transaction
      .update(broThreads)
      .set({
        topic,
        envoyMessages,
        failedSteps: 0,
        version: sql`${broThreads.version} + 1`,
        updatedAt: now,
        ...(status === "agreed"
          ? {
              status,
              agreedProposalId: latestProposal?.id,
              nextSide: null,
              nextAt: null,
              leaseToken: null,
              leaseExpiresAt: null,
            }
          : waits
            ? { nextAt: null, leaseToken: null, leaseExpiresAt: null }
            : { nextSide: otherBroSide(step.side), nextAt: now }),
      })
      .where(eq(broThreads.id, thread.id));
    if (status !== "negotiating" && status !== "agreed")
      await closeBroThread(transaction, thread.id, status, now);

    const alerts = alerted?.value ?? 0;
    if (fresh.length > 0 && alerts < alertLimit)
      await report(
        step.side,
        "alert",
        { alerts: fresh },
        `alert:${String(alerts + 1)}`
      );
    if (question)
      await report(
        step.side,
        "question",
        {
          questionId: question.id,
          text: question.text,
          // The peer's open proposal, which the question is most likely
          // about: its time on the owner's own clock, whatever clock the
          // envoy's words or the peer's give it on.
          proposal:
            latestProposal && latestProposal.side !== step.side
              ? (latestProposal.proposal ?? undefined)
              : undefined,
        },
        `question:${question.id}`
      );
    if (draft)
      await report(
        step.side,
        "held",
        {
          action: draft.action,
          draftId: draft.id,
          proposal: draft.proposal,
          reason: draft.reason,
          text: draft.body,
        },
        `held:${draft.id}`
      );
    if (status === "agreed" && latestProposal)
      await Promise.all(
        broSides.map((side) =>
          report(
            side,
            "agreed",
            {
              proposalId: latestProposal.id,
              proposal: latestProposal.proposal ?? undefined,
              // The words the peer's yes came with: what the owner who
              // proposed has not seen yet (a place named with the yes).
              text: side === step.side ? undefined : sent?.message.body.trim(),
            },
            `agreed:${latestProposal.id}`
          )
        )
      );
    if (status === "declined" && sent)
      await Promise.all(
        broSides.map((side) =>
          report(side, "declined", {
            by: side === step.side ? "self" : "peer",
            text: sent.message.body.trim(),
          })
        )
      );
    if (status === "stalled")
      await Promise.all(broSides.map((side) => report(side, "stalled")));
    if (status === "answered") {
      const [answer] = await transaction
        .select({ body: broMessages.body })
        .from(broMessages)
        .where(
          and(
            eq(broMessages.threadId, thread.id),
            eq(broMessages.side, "responder")
          )
        )
        .orderBy(desc(broMessages.seq))
        .limit(1);
      await report("initiator", "answered", { text: answer?.body ?? null });
    }
    return {
      kind: "recorded",
      status,
      messageId: inserted?.id ?? null,
    } as const;
  });
}

/**
 * A step that failed (the model, the gate, a decision the code refused)
 * gives the turn back with a pause that doubles; the third failure in a row
 * stalls the thread.
 */
export async function recordEnvoyFailure(
  threadId: string,
  leaseToken: string,
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const [thread] = await transaction
      .select()
      .from(broThreads)
      .where(eq(broThreads.id, threadId))
      .limit(1)
      .for("update");
    if (
      thread?.leaseToken !== leaseToken ||
      thread.leaseExpiresAt === null ||
      thread.leaseExpiresAt <= now
    )
      return rejected("lease");
    const failedSteps = thread.failedSteps + 1;
    if (failedSteps >= failedStepLimit) {
      const sides = await lockBroThreadSides(transaction, thread.id);
      await transaction
        .update(broThreads)
        .set({ failedSteps })
        .where(eq(broThreads.id, thread.id));
      await closeBroThread(transaction, thread.id, "stalled", now);
      const report = await broThreadReporter(transaction, thread, sides);
      await Promise.all(broSides.map((side) => report(side, "stalled")));
      return { kind: "stalled" } as const;
    }
    const nextAt = new Date(now.getTime() + 60_000 * 2 ** (failedSteps - 1));
    await transaction
      .update(broThreads)
      .set({
        failedSteps,
        nextAt,
        leaseToken: null,
        leaseExpiresAt: null,
        version: sql`${broThreads.version} + 1`,
        updatedAt: now,
      })
      .where(eq(broThreads.id, thread.id));
    return { kind: "retry", nextAt } as const;
  });
}

/**
 * Holds a leased thread for another `leaseMs` before its next step, while
 * the lease is still this one's and live; whether it was. An engine that
 * drives a thread for several steps renews it before each, so a late step
 * is not dropped and no other engine takes the thread meanwhile.
 */
export async function renewBroThreadLease(
  threadId: string,
  leaseToken: string,
  leaseMs: number,
  now = new Date()
) {
  const rows = await db
    .update(broThreads)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs) })
    .where(
      and(
        eq(broThreads.id, threadId),
        eq(broThreads.leaseToken, leaseToken),
        gt(broThreads.leaseExpiresAt, now)
      )
    )
    .returning({ id: broThreads.id });
  return rows.length > 0;
}

/** Gives a thread back before its lease runs out; whether it was still held. */
export async function releaseBroThread(threadId: string, leaseToken: string) {
  const rows = await db
    .update(broThreads)
    .set({ leaseToken: null, leaseExpiresAt: null })
    .where(
      and(eq(broThreads.id, threadId), eq(broThreads.leaseToken, leaseToken))
    )
    .returning({ id: broThreads.id });
  return rows.length > 0;
}
