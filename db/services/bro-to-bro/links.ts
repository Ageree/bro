import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias, type PgUpdateSetSource } from "drizzle-orm/pg-core";
import * as z from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import { broInvites, broLinks, broThreads, db } from "@db";
import { lockBroPair, readLivePairLinks } from "./pairs";
import { readBroPeople } from "./people";
import { enqueueBroReport } from "./reports";
import { closeBroThread, openBroThreadStatuses } from "./transitions";

/** Words the owner wrote, or null when they wrote nothing. */
function ownerWords(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === "" ? null : value));
}

/** How an owner calls the person they are linked with: theirs alone. */
export const broLabelSchema = ownerWords(200);
const shareNotesSchema = ownerWords(2000);

/** A name as an owner says it: lower case, «ё» as «е», no «@». */
function foldName(name: string) {
  return name.trim().toLowerCase().replaceAll("ё", "е").replace(/^@/u, "");
}

/**
 * The owner's live links: who is on the other side, what the owner opens to
 * them, and whether the peer opens their calendar back.
 */
export async function listBroLinks(scope: AccessScope) {
  const peerLink = alias(broLinks, "peer_link");
  const rows = await db
    .select({
      link: broLinks,
      inviterWorkspaceId: broInvites.inviterWorkspaceId,
      peerCalendar: peerLink.calendar,
    })
    .from(broLinks)
    .innerJoin(broInvites, eq(broInvites.id, broLinks.inviteId))
    .leftJoin(
      peerLink,
      and(
        eq(peerLink.workspaceId, broLinks.peerWorkspaceId),
        eq(peerLink.peerWorkspaceId, broLinks.workspaceId),
        isNull(peerLink.removedAt)
      )
    )
    .where(
      and(
        eq(broLinks.workspaceId, scope.workspaceId),
        eq(broLinks.userId, scope.userId),
        isNull(broLinks.removedAt)
      )
    )
    .orderBy(asc(broLinks.createdAt));
  const people = await readBroPeople(
    db,
    rows.map((row) => row.link.peerWorkspaceId)
  );
  return rows.map(({ link, inviterWorkspaceId, peerCalendar }) => {
    const peer = people.get(link.peerWorkspaceId);
    return {
      id: link.id,
      status: link.status,
      // A pending link waits for its inviter to confirm who accepted.
      awaitingMyConfirmation:
        link.status === "pending" && inviterWorkspaceId === scope.workspaceId,
      label: link.peerLabel,
      peerName: peer?.name ?? null,
      peerTelegramUsername: peer?.telegramUsername ?? null,
      calendar: link.calendar,
      shareNotes: link.shareNotes,
      peerCalendar: peerCalendar ?? false,
      createdAt: link.createdAt,
    };
  });
}

/**
 * A link by its id, or by the label, name or Telegram username the owner
 * says, compared whole and without case. Two people who answer to the same
 * word are both returned, for Bro to ask which one.
 */
export async function findBroLink(scope: AccessScope, query: string) {
  const links = await listBroLinks(scope);
  const byId = links.find((link) => link.id === query.trim());
  if (byId) return { kind: "found", link: byId } as const;
  const wanted = foldName(query);
  const matches = links.filter((link) =>
    [link.label, link.peerName, link.peerTelegramUsername].some(
      (name) => name !== null && foldName(name) === wanted
    )
  );
  if (matches.length === 0) return { kind: "none" } as const;
  const [only] = matches;
  if (matches.length === 1 && only)
    return { kind: "found", link: only } as const;
  return { kind: "ambiguous", links: matches } as const;
}

/**
 * The inviter confirms that whoever accepted is the person they invited:
 * both rows turn active and both owners hear the link is ready.
 */
export async function confirmBroLink(
  scope: AccessScope,
  linkId: string,
  now = new Date()
) {
  if (!z.uuid().safeParse(linkId).success) return { kind: "none" } as const;
  return db.transaction(async (transaction) => {
    const [own] = await transaction
      .select({
        link: broLinks,
        inviterWorkspaceId: broInvites.inviterWorkspaceId,
      })
      .from(broLinks)
      .innerJoin(broInvites, eq(broInvites.id, broLinks.inviteId))
      .where(
        and(
          eq(broLinks.id, linkId),
          eq(broLinks.workspaceId, scope.workspaceId),
          eq(broLinks.userId, scope.userId),
          isNull(broLinks.removedAt)
        )
      )
      .limit(1)
      .for("update", { of: broLinks });
    if (!own) return { kind: "none" } as const;
    if (own.link.status === "active")
      return { kind: "already_active" } as const;
    if (own.inviterWorkspaceId !== scope.workspaceId)
      return { kind: "not_inviter" } as const;
    const rows = await transaction
      .update(broLinks)
      .set({
        status: "active",
        revision: sql`${broLinks.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(broLinks.inviteId, own.link.inviteId),
          isNull(broLinks.removedAt)
        )
      )
      .returning();
    const people = await readBroPeople(
      transaction,
      rows.map((row) => row.workspaceId)
    );
    await Promise.all(
      rows.map((row) =>
        enqueueBroReport(transaction, {
          workspaceId: row.workspaceId,
          userId: row.userId,
          threadId: null,
          kind: "link_ready",
          payload: {
            peerName: people.get(row.peerWorkspaceId)?.name ?? null,
            peerLabel: row.peerLabel,
            linkId: row.id,
          },
          target: null,
          dedupeKey: `bro:link:${row.id}:ready`,
        })
      )
    );
    return { kind: "confirmed" } as const;
  });
}

/** Changes the owner's own live row; whether there was one. */
async function updateOwnLink(
  scope: AccessScope,
  linkId: string,
  values: PgUpdateSetSource<typeof broLinks>,
  now: Date
) {
  if (!z.uuid().safeParse(linkId).success) return false;
  const rows = await db
    .update(broLinks)
    .set({ ...values, updatedAt: now })
    .where(
      and(
        eq(broLinks.id, linkId),
        eq(broLinks.workspaceId, scope.workspaceId),
        eq(broLinks.userId, scope.userId),
        isNull(broLinks.removedAt)
      )
    )
    .returning({ id: broLinks.id });
  return rows.length > 0;
}

/** Whether the peer's envoy may be offered times from this owner's calendar. */
export async function setBroLinkCalendar(
  scope: AccessScope,
  linkId: string,
  allowed: boolean,
  now = new Date()
) {
  return updateOwnLink(
    scope,
    linkId,
    { calendar: allowed, revision: sql`${broLinks.revision} + 1` },
    now
  );
}

/** Replaces what this owner's envoy may tell the peer. */
export async function setBroLinkShareNotes(
  scope: AccessScope,
  linkId: string,
  notes: string | null,
  now = new Date()
) {
  return updateOwnLink(
    scope,
    linkId,
    {
      shareNotes: shareNotesSchema.parse(notes),
      revision: sql`${broLinks.revision} + 1`,
    },
    now
  );
}

/** Renames the peer for this owner alone; nothing the envoys see changes. */
export async function setBroLinkLabel(
  scope: AccessScope,
  linkId: string,
  label: string | null,
  now = new Date()
) {
  return updateOwnLink(
    scope,
    linkId,
    { peerLabel: broLabelSchema.parse(label) },
    now
  );
}

/**
 * Removes the link for both people, pending or active. The pair's open
 * threads are cancelled with their unsent drafts, and the peer hears the
 * link is gone; what was already said stays said.
 */
export async function removeBroLink(
  scope: AccessScope,
  linkId: string,
  now = new Date()
) {
  if (!z.uuid().safeParse(linkId).success) return { kind: "none" } as const;
  const [found] = await db
    .select({ peerWorkspaceId: broLinks.peerWorkspaceId })
    .from(broLinks)
    .where(
      and(
        eq(broLinks.id, linkId),
        eq(broLinks.workspaceId, scope.workspaceId),
        eq(broLinks.userId, scope.userId),
        isNull(broLinks.removedAt)
      )
    )
    .limit(1);
  if (!found) return { kind: "none" } as const;
  return db.transaction(async (transaction) => {
    await lockBroPair(transaction, scope.workspaceId, found.peerWorkspaceId);
    const live = await readLivePairLinks(
      transaction,
      scope.workspaceId,
      found.peerWorkspaceId
    );
    const own = live.find((row) => row.id === linkId);
    const peer = live.find((row) => row.workspaceId === found.peerWorkspaceId);
    if (!own) return { kind: "none" } as const;
    // The threads first, as an envoy's step locks its thread before it
    // reads the link: the other order could deadlock with a step under way.
    const open = await transaction
      .select({ id: broThreads.id })
      .from(broThreads)
      .where(
        and(
          inArray(broThreads.status, [...openBroThreadStatuses]),
          or(
            and(
              eq(broThreads.initiatorWorkspaceId, scope.workspaceId),
              eq(broThreads.responderWorkspaceId, found.peerWorkspaceId)
            ),
            and(
              eq(broThreads.initiatorWorkspaceId, found.peerWorkspaceId),
              eq(broThreads.responderWorkspaceId, scope.workspaceId)
            )
          )
        )
      )
      .for("update");
    await transaction
      .update(broLinks)
      .set({
        removedAt: now,
        updatedAt: now,
        revision: sql`${broLinks.revision} + 1`,
      })
      .where(
        inArray(
          broLinks.id,
          live.map((row) => row.id)
        )
      );
    await Promise.all(
      open.map((thread) =>
        closeBroThread(transaction, thread.id, "cancelled", now)
      )
    );
    if (peer) {
      const people = await readBroPeople(transaction, [scope.workspaceId]);
      await enqueueBroReport(transaction, {
        workspaceId: peer.workspaceId,
        userId: peer.userId,
        threadId: null,
        kind: "link_removed",
        payload: {
          peerName: people.get(scope.workspaceId)?.name ?? null,
          peerLabel: peer.peerLabel,
          linkId: peer.id,
        },
        target: null,
        dedupeKey: `bro:link:${peer.id}:removed`,
      });
    }
    return { kind: "removed", cancelledThreads: open.length } as const;
  });
}
