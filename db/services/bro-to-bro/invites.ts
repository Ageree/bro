import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { BroInviteChannel } from "@shared/bro-to-bro/contract";
import type { AccessScope } from "@shared/identity/access-scope";
import { broInvites, broLinks, db } from "@db";
import { broLabelSchema } from "./links";
import { lockBroPair, lockBroWorkspace, readLivePairLinks } from "./pairs";
import { readBroPeople } from "./people";
import { enqueueBroReport } from "./reports";

const dayMs = 24 * 60 * 60_000;
const inviteLifetimeMs = 7 * dayMs;
/** How long an opened invite waits for the person's yes. */
export const openedInviteMs = dayMs;
const invitesPerDay = 10;

function hashBroInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Creates a single-use invite and returns its token once: 24 random bytes,
 * base64url, so `bro_<token>` fits Telegram's 64-character start parameter.
 * Only the token's SHA-256 is stored. A workspace invites at most ten times
 * a day.
 */
export async function createBroInvite(
  scope: AccessScope,
  input: { readonly label: string | null },
  now = new Date()
) {
  const label = broLabelSchema.parse(input.label);
  return db.transaction(async (transaction) => {
    await lockBroWorkspace(transaction, scope.workspaceId);
    const [today] = await transaction
      .select({ value: count() })
      .from(broInvites)
      .where(
        and(
          eq(broInvites.inviterWorkspaceId, scope.workspaceId),
          gt(broInvites.createdAt, new Date(now.getTime() - dayMs))
        )
      );
    if ((today?.value ?? 0) >= invitesPerDay)
      return { kind: "refused", reason: "daily_limit" } as const;
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(now.getTime() + inviteLifetimeMs);
    await transaction.insert(broInvites).values({
      tokenHash: hashBroInviteToken(token),
      inviterWorkspaceId: scope.workspaceId,
      inviterUserId: scope.userId,
      label,
      expiresAt,
      createdAt: now,
    });
    return { kind: "created", token, expiresAt } as const;
  });
}

/**
 * Records that this account opened an invite link and says who invites.
 * Opening decides nothing (link previews open URLs without a person): the
 * person accepts with their own yes, through `acceptOpenedBroInvite`.
 */
export async function openBroInvite(
  token: string,
  scope: AccessScope,
  now = new Date()
) {
  const opened = await db.transaction(async (transaction) => {
    const [invite] = await transaction
      .select()
      .from(broInvites)
      .where(eq(broInvites.tokenHash, hashBroInviteToken(token)))
      .limit(1)
      .for("update");
    if (!invite) return { kind: "unknown" } as const;
    if (invite.inviterWorkspaceId === scope.workspaceId)
      return { kind: "self" } as const;
    if (invite.redeemedAt !== null) return { kind: "used" } as const;
    if (invite.expiresAt <= now) return { kind: "expired" } as const;
    const live = await readLivePairLinks(
      transaction,
      scope.workspaceId,
      invite.inviterWorkspaceId
    );
    if (live.length > 0) return { kind: "already_linked" } as const;
    await transaction
      .update(broInvites)
      .set({ openedByWorkspaceId: scope.workspaceId, openedAt: now })
      .where(eq(broInvites.id, invite.id));
    return { kind: "opened", invite } as const;
  });
  if (opened.kind !== "opened") return opened;
  const people = await readBroPeople(db, [opened.invite.inviterWorkspaceId]);
  return {
    kind: "opened",
    inviterName: people.get(opened.invite.inviterWorkspaceId)?.name ?? null,
    expiresAt: opened.invite.expiresAt,
  } as const;
}

/**
 * The invite this account opened in the last 24 hours and may still accept
 * — the one `acceptOpenedBroInvite` takes — and who sends it, for the
 * person's Bro to ask «Принять?» naming them; null when there is none.
 */
export async function readOpenedBroInvite(
  scope: AccessScope,
  now = new Date()
) {
  const [invite] = await db
    .select({
      expiresAt: broInvites.expiresAt,
      inviterWorkspaceId: broInvites.inviterWorkspaceId,
    })
    .from(broInvites)
    .where(
      and(
        eq(broInvites.openedByWorkspaceId, scope.workspaceId),
        gt(broInvites.openedAt, new Date(now.getTime() - openedInviteMs)),
        gt(broInvites.expiresAt, now),
        isNull(broInvites.redeemedAt)
      )
    )
    .orderBy(desc(broInvites.openedAt))
    .limit(1);
  if (!invite) return null;
  const people = await readBroPeople(db, [invite.inviterWorkspaceId]);
  return {
    expiresAt: invite.expiresAt,
    inviterName: people.get(invite.inviterWorkspaceId)?.name ?? null,
  };
}

/**
 * Accepts the invite this account opened in the last 24 hours: the one
 * opened last of those still good — neither used nor expired — and when
 * none is, says why of the one opened last. Both link rows are written
 * `pending` (the person accepted opens their calendar by default), and the
 * inviter is asked to confirm it is the right person, told how it was
 * accepted (`channel`), the Telegram username, if any, and how old the
 * account is: until then nothing passes between the two. The invite is
 * redeemed by a conditional update under a lock on the pair, so two
 * accepts make one link.
 */
export async function acceptOpenedBroInvite(
  scope: AccessScope,
  channel: BroInviteChannel | null,
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const [invite] = await transaction
      .select()
      .from(broInvites)
      .where(
        and(
          eq(broInvites.openedByWorkspaceId, scope.workspaceId),
          gt(broInvites.openedAt, new Date(now.getTime() - openedInviteMs))
        )
      )
      .orderBy(
        sql`(${broInvites.redeemedAt} IS NULL AND ${broInvites.expiresAt} > ${now.toISOString()}::timestamptz) DESC`,
        desc(broInvites.openedAt)
      )
      .limit(1)
      .for("update");
    if (!invite) return { kind: "none" } as const;
    await lockBroPair(
      transaction,
      scope.workspaceId,
      invite.inviterWorkspaceId
    );
    const live = await readLivePairLinks(
      transaction,
      scope.workspaceId,
      invite.inviterWorkspaceId
    );
    if (live.length > 0) return { kind: "already_linked" } as const;
    if (invite.redeemedAt !== null) return { kind: "used" } as const;
    if (invite.expiresAt <= now) return { kind: "expired" } as const;
    await transaction
      .update(broInvites)
      .set({ redeemedAt: now, redeemedByWorkspaceId: scope.workspaceId })
      .where(eq(broInvites.id, invite.id));
    const [inviterLink, inviteeLink] = await transaction
      .insert(broLinks)
      .values([
        {
          workspaceId: invite.inviterWorkspaceId,
          userId: invite.inviterUserId,
          peerWorkspaceId: scope.workspaceId,
          peerUserId: scope.userId,
          inviteId: invite.id,
          peerLabel: invite.label,
          createdAt: now,
          updatedAt: now,
        },
        {
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          peerWorkspaceId: invite.inviterWorkspaceId,
          peerUserId: invite.inviterUserId,
          inviteId: invite.id,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: broLinks.id });
    if (!inviterLink || !inviteeLink)
      throw new Error("Bro link rows were not written.");
    const people = await readBroPeople(transaction, [
      scope.workspaceId,
      invite.inviterWorkspaceId,
    ]);
    const invitee = people.get(scope.workspaceId);
    const createdAt = invitee?.accountCreatedAt;
    await enqueueBroReport(transaction, {
      workspaceId: invite.inviterWorkspaceId,
      userId: invite.inviterUserId,
      threadId: null,
      kind: "invite_accepted",
      payload: {
        peerName: invitee?.name ?? null,
        peerLabel: invite.label,
        telegramUsername: invitee?.telegramUsername ?? null,
        channel,
        accountDays: createdAt
          ? Math.max(
              0,
              Math.floor((now.getTime() - createdAt.getTime()) / dayMs)
            )
          : null,
        linkId: inviterLink.id,
      },
      target: null,
      dedupeKey: `bro:invite:${invite.id}:accepted`,
    });
    return {
      kind: "accepted",
      linkId: inviteeLink.id,
      inviterName: people.get(invite.inviterWorkspaceId)?.name ?? null,
    } as const;
  });
}
